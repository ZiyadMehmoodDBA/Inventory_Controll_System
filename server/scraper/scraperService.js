'use strict';
/**
 * Scraper Service — orchestrates all catalog scrapers,
 * upserts into tire_catalog, and logs results.
 */

const { getPool, sql } = require('../db');
const { scrapeGTR }    = require('./gtrScraper');

const SOURCES = {
  gtr: { name: 'GTR — General Tyre Pakistan', fn: scrapeGTR },
};

/* ─── upsert entries into tire_catalog ────────────────────────────────────── */
async function upsertCatalogEntries(pool, entries) {
  let added = 0, updated = 0;

  for (const e of entries) {
    const result = await pool.request()
      .input('brand',       sql.NVarChar(100), e.brand)
      .input('model',       sql.NVarChar(100), e.model)
      .input('size',        sql.NVarChar(50),  e.size)
      .input('pattern',     sql.NVarChar(100), e.pattern     || null)
      .input('speed_index', sql.NVarChar(5),   e.speed_index || null)
      .input('load_index',  sql.NVarChar(10),  e.load_index  || null)
      .input('tire_type',   sql.NVarChar(50),  e.tire_type   || null)
      .query(`
        MERGE tire_catalog AS tgt
        USING (SELECT @brand AS brand, @model AS model, @size AS size) AS src
          ON tgt.brand = src.brand AND tgt.model = src.model AND tgt.size = src.size
        WHEN MATCHED THEN
          UPDATE SET
            pattern     = @pattern,
            speed_index = @speed_index,
            load_index  = @load_index,
            tire_type   = @tire_type
        WHEN NOT MATCHED THEN
          INSERT (brand, model, size, pattern, speed_index, load_index, tire_type)
          VALUES (@brand, @model, @size, @pattern, @speed_index, @load_index, @tire_type)
        OUTPUT $action AS action_taken;
      `);

    const action = result.recordset[0]?.action_taken;
    if (action === 'INSERT') added++;
    else if (action === 'UPDATE') updated++;
  }

  return { added, updated };
}

/* ─── create/update a log row ─────────────────────────────────────────────── */
async function initLog(pool, { source, triggeredBy }) {
  const res = await pool.request()
    .input('source',       sql.NVarChar(100), source)
    .input('status',       sql.NVarChar(20),  'running')
    .input('triggered_by', sql.NVarChar(50),  triggeredBy || 'schedule')
    .query(`
      INSERT INTO catalog_scraper_logs (source, status, started_at, triggered_by)
      OUTPUT INSERTED.id
      VALUES (@source, @status, GETDATE(), @triggered_by);
    `);
  return res.recordset[0]?.id ?? null;
}

async function finalizeLog(pool, id, { status, itemsFound, itemsAdded, itemsUpdated, errorMsg }) {
  if (!id) return;
  await pool.request()
    .input('id',            sql.Int,          id)
    .input('status',        sql.NVarChar(20), status)
    .input('items_found',   sql.Int,          itemsFound   || 0)
    .input('items_added',   sql.Int,          itemsAdded   || 0)
    .input('items_updated', sql.Int,          itemsUpdated || 0)
    .input('error_msg',     sql.NVarChar(500), (errorMsg || '').substring(0, 499) || null)
    .query(`
      UPDATE catalog_scraper_logs
      SET status        = @status,
          finished_at   = GETDATE(),
          items_found   = @items_found,
          items_added   = @items_added,
          items_updated = @items_updated,
          error_msg     = @error_msg
      WHERE id = @id
    `);
}

/* ─── public API ──────────────────────────────────────────────────────────── */
async function runScraper(sourceKey = 'gtr', triggeredBy = 'schedule') {
  const pool = await getPool();
  const src  = SOURCES[sourceKey];
  if (!src) throw new Error(`Unknown scraper source: ${sourceKey}`);

  const logId = await initLog(pool, { source: src.name, triggeredBy });

  try {
    console.log(`[ScraperService] Running ${src.name}...`);
    const entries = await src.fn();
    console.log(`[ScraperService] ${entries.length} entries to upsert`);
    const { added, updated } = await upsertCatalogEntries(pool, entries);

    await finalizeLog(pool, logId, {
      status:       'success',
      itemsFound:   entries.length,
      itemsAdded:   added,
      itemsUpdated: updated,
    });

    console.log(`[ScraperService] Done — added: ${added}, updated: ${updated}`);
    return { success: true, itemsFound: entries.length, itemsAdded: added, itemsUpdated: updated };

  } catch (err) {
    console.error('[ScraperService] Error:', err.message);
    await finalizeLog(pool, logId, { status: 'error', errorMsg: err.message });
    throw err;
  }
}

module.exports = { runScraper, SOURCES };
