'use strict';
/**
 * Catalog routes — manages the tire_catalog table and the catalog scraper job.
 * Mounted at: /api/catalog
 */

const express  = require('express');
const router   = express.Router();
const { getPool, sql }    = require('../db');
const { requireRole }     = require('../middleware/auth');
const P = require('../utils/permissions');
const {
  rescheduleJob, getJobStatus, triggerManualRun, SCHEDULE_OPTIONS,
} = require('../jobs/catalogScraper');

/* ─────────────────────────────────────────────────────────────────────────────
   Helper: build a parameterised request for catalog/entries queries
   ───────────────────────────────────────────────────────────────────────────── */
function buildEntriesRequest(pool, { q, brand, model, size, offset, pageSize }) {
  const conditions = [];
  const r = pool.request()
    .input('offset',   sql.Int, offset   || 0)
    .input('pageSize', sql.Int, pageSize || 50);

  if (q) {
    r.input('q', sql.NVarChar(200), `%${q}%`);
    conditions.push('(brand LIKE @q OR model LIKE @q OR size LIKE @q OR ISNULL(pattern,\'\') LIKE @q)');
  }
  if (brand) { r.input('brand', sql.NVarChar(200), `%${brand}%`); conditions.push('brand LIKE @brand'); }
  if (model) { r.input('model', sql.NVarChar(200), `%${model}%`); conditions.push('model LIKE @model'); }
  if (size)  { r.input('size',  sql.NVarChar(100), `%${size}%`);  conditions.push('size  LIKE @size');  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  return { r, where };
}

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/catalog/scraper/config
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/scraper/config', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request().query(`
      SELECT [key], value FROM settings
      WHERE [key] IN ('scraper_enabled', 'scraper_schedule')
        AND organization_id = 1
    `);
    const map = {};
    for (const row of result.recordset) map[row.key] = row.value;

    res.json({
      enabled:  map.scraper_enabled  === '1',
      schedule: map.scraper_schedule || 'daily_2am',
      scheduleOptions: Object.entries(SCHEDULE_OPTIONS).map(([k, v]) => ({
        value: k,
        label: v.label,
      })),
      ...getJobStatus(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/catalog/scraper/config
   Body: { enabled: bool, schedule: string }
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/scraper/config', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const { enabled, schedule } = req.body;
    const safeSchedule = SCHEDULE_OPTIONS[schedule] ? schedule : 'daily_2am';
    const pool = await getPool();

    for (const [key, value] of [
      ['scraper_enabled',  enabled ? '1' : '0'],
      ['scraper_schedule', safeSchedule],
    ]) {
      await pool.request()
        .input('org_id', sql.Int,          1)
        .input('key',    sql.NVarChar(100), key)
        .input('value',  sql.NVarChar(100), value)
        .query(`
          MERGE settings AS tgt
          USING (SELECT @org_id AS organization_id, @key AS [key]) AS src
            ON tgt.organization_id = src.organization_id AND tgt.[key] = src.[key]
          WHEN MATCHED     THEN UPDATE SET value = @value, updated_at = GETDATE()
          WHEN NOT MATCHED THEN INSERT (organization_id, [key], value) VALUES (@org_id, @key, @value);
        `);
    }

    rescheduleJob(!!enabled, safeSchedule);

    res.json({ success: true, enabled: !!enabled, schedule: safeSchedule, ...getJobStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   POST /api/catalog/scraper/run  — manual trigger (fire-and-forget)
   ───────────────────────────────────────────────────────────────────────────── */
router.post('/scraper/run', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const started = await triggerManualRun();
    if (!started) {
      return res.status(409).json({ error: 'A scrape job is already running. Please wait.' });
    }
    res.json({ success: true, message: 'Scrape started in the background. Check logs for progress.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/catalog/scraper/status
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/scraper/status', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const pool = await getPool();

    const [logsRes, countRes] = await Promise.all([
      pool.request().query(`
        SELECT TOP 15
          id, source, status, started_at, finished_at,
          items_found, items_added, items_updated, error_msg, triggered_by
        FROM catalog_scraper_logs
        ORDER BY started_at DESC
      `),
      pool.request().query(`
        SELECT
          COUNT(*) AS total,
          COUNT(DISTINCT brand) AS brands,
          COUNT(DISTINCT model) AS models
        FROM tire_catalog
        WHERE brand = 'General Tyre (Pakistan)'
      `),
    ]);

    res.json({
      ...getJobStatus(),
      recentLogs:  logsRes.recordset,
      gtrCounts:   countRes.recordset[0] || { total: 0, brands: 0, models: 0 },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/catalog/entries?q=&brand=&model=&size=&page=1&limit=50
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/entries', async (req, res) => {
  try {
    const pool     = await getPool();
    const { q, brand, model, size } = req.query;
    const pageNum  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset   = (pageNum - 1) * pageSize;

    const { r: dataReq, where } = buildEntriesRequest(pool, { q, brand, model, size, offset, pageSize });
    const { r: cntReq  }        = buildEntriesRequest(pool, { q, brand, model, size, offset, pageSize });

    const [dataRes, cntRes] = await Promise.all([
      dataReq.query(`
        SELECT id, brand, model, size, pattern, load_index, speed_index, tire_type
        FROM tire_catalog
        ${where}
        ORDER BY brand, model, size
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
      `),
      cntReq.query(`SELECT COUNT(*) AS total FROM tire_catalog ${where}`),
    ]);

    res.json({
      entries:  dataRes.recordset,
      total:    cntRes.recordset[0]?.total || 0,
      page:     pageNum,
      pageSize,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   DELETE /api/catalog/entries/:id   (org_admin only)
   ───────────────────────────────────────────────────────────────────────────── */
router.delete('/entries/:id', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request()
      .input('id', sql.Int, Number(req.params.id))
      .query('DELETE FROM tire_catalog WHERE id = @id');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/catalog/stats   — quick summary (used by the Settings tab header)
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/stats', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const pool = await getPool();
    const r    = await pool.request().query(`
      SELECT
        COUNT(*)              AS total_entries,
        COUNT(DISTINCT brand) AS total_brands,
        COUNT(DISTINCT model) AS total_models,
        SUM(CASE WHEN brand = 'General Tyre (Pakistan)' THEN 1 ELSE 0 END) AS gtr_entries
      FROM tire_catalog
    `);
    res.json(r.recordset[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
