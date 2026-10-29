const express = require('express');
const router  = express.Router();
const { getPool, sql }     = require('../db');
const { getContext }       = require('../context');
const { requireRole }      = require('../middleware/auth');
const { BUSINESS_TYPES }   = require('../utils/businessTypes');

router.get('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('org_id', sql.Int, orgId)
      .query('SELECT [key], value FROM settings WHERE organization_id = @org_id');
    const map = {};
    for (const row of result.recordset) map[row.key] = row.value;
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool    = await getPool();
    const entries = Object.entries(req.body || {});
    if (!entries.length) return res.status(400).json({ error: 'No settings provided' });
    if ('business_type' in (req.body || {})) {
      if (!BUSINESS_TYPES.includes(req.body.business_type)) return res.status(400).json({ error: 'Unknown business type' });
      if (req.user.role !== 'org_admin') return res.status(403).json({ error: 'Only an administrator can change the business type' });
    }

    for (const [key, value] of entries) {
      await pool.request()
        .input('org_id', sql.Int,      orgId)
        .input('key',    sql.NVarChar, key)
        .input('value',  sql.NVarChar, String(value ?? ''))
        .query(`
          MERGE settings AS target
          USING (SELECT @org_id AS organization_id, @key AS [key]) AS source
            ON target.organization_id = source.organization_id AND target.[key] = source.[key]
          WHEN MATCHED     THEN UPDATE SET value = @value, updated_at = GETDATE()
          WHEN NOT MATCHED THEN INSERT (organization_id, [key], value) VALUES (@org_id, @key, @value);
        `);
    }

    const result = await pool.request()
      .input('org_id', sql.Int, orgId)
      .query('SELECT [key], value FROM settings WHERE organization_id = @org_id');
    const map = {};
    for (const row of result.recordset) map[row.key] = row.value;
    res.json(map);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// System info — org_admin only
router.get('/system-info', requireRole('org_admin'), async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();

    const [dbSizeResult, countsResult, sessionsResult] = await Promise.all([
      // DB file sizes (data + log) in MB
      pool.request().query(`
        SELECT
          CAST(SUM(CASE WHEN type_desc='ROWS' THEN size ELSE 0 END) * 8.0 / 1024 AS DECIMAL(10,2)) AS data_mb,
          CAST(SUM(CASE WHEN type_desc='LOG'  THEN size ELSE 0 END) * 8.0 / 1024 AS DECIMAL(10,2)) AS log_mb,
          CAST(SUM(size) * 8.0 / 1024 AS DECIMAL(10,2)) AS total_mb
        FROM sys.database_files
      `),

      // Row counts per major table (scoped to org)
      pool.request()
        .input('orgId', sql.Int, orgId)
        .query(`
          SELECT
            (SELECT COUNT(*) FROM tires     WHERE organization_id=@orgId) AS tire_skus,
            (SELECT COUNT(*) FROM sales     WHERE organization_id=@orgId) AS total_sales,
            (SELECT COUNT(*) FROM purchases WHERE organization_id=@orgId) AS total_purchases,
            (SELECT COUNT(*) FROM customers WHERE organization_id=@orgId) AS customers,
            (SELECT COUNT(*) FROM users     WHERE organization_id=@orgId) AS users_count,
            (SELECT COUNT(*) FROM tire_catalog)                           AS catalog_entries
        `),

      // Active sessions: unique users with a non-expired refresh token
      pool.request().query(`
        SELECT u.name, u.email, u.role, MAX(rt.created_at) AS last_active
        FROM refresh_tokens rt
        JOIN users u ON u.id = rt.user_id
        WHERE rt.expires_at > GETDATE()
        GROUP BY u.id, u.name, u.email, u.role
        ORDER BY last_active DESC
      `),
    ]);

    const mem  = process.memoryUsage();
    const toMB = (b) => parseFloat((b / 1024 / 1024).toFixed(1));

    res.json({
      server: {
        uptime_seconds: Math.floor(process.uptime()),
        node_version:   process.version,
        platform:       process.platform,
        memory_used_mb: toMB(mem.rss),
        memory_heap_mb: toMB(mem.heapUsed),
        timestamp:      new Date().toISOString(),
      },
      database: {
        data_mb:  Number(dbSizeResult.recordset[0]?.data_mb  || 0),
        log_mb:   Number(dbSizeResult.recordset[0]?.log_mb   || 0),
        total_mb: Number(dbSizeResult.recordset[0]?.total_mb || 0),
        counts:   countsResult.recordset[0] || {},
      },
      sessions: {
        active_count: sessionsResult.recordset.length,
        users:        sessionsResult.recordset,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
