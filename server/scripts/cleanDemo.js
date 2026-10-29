'use strict';
/**
 * cleanDemo.js — Wipes all business/test data from TuneGENDB.
 *
 * KEEPS (reference & system data):
 *   organizations, branches, users, settings,
 *   tire_types, tire_catalog, vehicle_fitments
 *
 * DELETES (transactional / demo data):
 *   audit_logs, catalog_scraper_logs, stock_movements,
 *   ledger_entries, sale_payments, purchase_payments,
 *   sales (→ cascades sale_items), purchases (→ cascades purchase_items),
 *   products (default services re-seed on next server start),
 *   tires (inventory), customers, suppliers, refresh_tokens
 *
 * Identity counters are reseeded to 0 so next inserts start at 1.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const sql = require('mssql');

const config = {
  server:   process.env.DB_SERVER   || 'localhost',
  user:     process.env.DB_USER     || 'sa',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'TuneGENDB',
  options:  { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  connectionTimeout: 15000,
  requestTimeout:    60000,
};

// Ordered by FK dependency — safe to DELETE FROM in this sequence
const TABLES_TO_CLEAR = [
  'audit_logs',
  'catalog_scraper_logs',
  'stock_movements',
  'ledger_entries',
  'sale_payments',       // also has ON DELETE CASCADE from sales, but delete explicitly first
  'purchase_payments',   // same
  'sales',               // cascades → sale_items
  'purchases',           // cascades → purchase_items
  'products',            // cleared here; default services re-seed on next server start
  'tires',               // inventory SKUs
  'customers',
  'suppliers',
  'refresh_tokens',      // forces re-login — expected after a clean
];

async function run() {
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  console.log('✅ Connected to TuneGENDB\n');

  // ── 1. Show counts before ─────────────────────────────────────────────────
  console.log('── Before cleanup ──────────────────────────');
  for (const tbl of TABLES_TO_CLEAR) {
    try {
      const r = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${tbl}`);
      console.log(`  ${tbl.padEnd(24)} ${r.recordset[0].cnt} rows`);
    } catch { console.log(`  ${tbl.padEnd(24)} (table not found — skipped)`); }
  }
  console.log('');

  // ── 2. Delete in dependency order ────────────────────────────────────────
  console.log('── Deleting … ──────────────────────────────');
  for (const tbl of TABLES_TO_CLEAR) {
    try {
      const r = await pool.request().query(`DELETE FROM ${tbl}`);
      console.log(`  ✓ ${tbl.padEnd(24)} ${r.rowsAffected[0]} rows deleted`);
    } catch (err) {
      console.error(`  ✗ ${tbl.padEnd(24)} ERROR: ${err.message}`);
    }
  }
  console.log('');

  // ── 3. Reseed identity counters ───────────────────────────────────────────
  console.log('── Reseeding identity counters … ───────────');
  const reseedTables = [
    ...TABLES_TO_CLEAR.filter(t => !['sale_payments','purchase_payments'].includes(t)),
    // sale_payments / purchase_payments don't need explicit reseed (cascade-deleted with parent)
  ];
  for (const tbl of reseedTables) {
    try {
      await pool.request().query(`DBCC CHECKIDENT ('${tbl}', RESEED, 0) WITH NO_INFOMSGS`);
      console.log(`  ✓ ${tbl}`);
    } catch { /* table may not have identity — ignore */ }
  }
  console.log('');

  // ── 4. Verify ─────────────────────────────────────────────────────────────
  console.log('── After cleanup ───────────────────────────');
  for (const tbl of TABLES_TO_CLEAR) {
    try {
      const r = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${tbl}`);
      const cnt = r.recordset[0].cnt;
      const ok  = cnt === 0 ? '✓' : '⚠';
      console.log(`  ${ok} ${tbl.padEnd(24)} ${cnt} rows remaining`);
    } catch { console.log(`  - ${tbl.padEnd(24)} (skipped)`); }
  }

  // Confirm system data is intact
  console.log('\n── System data (must be intact) ─────────────');
  for (const tbl of ['organizations','branches','users','settings','tire_types','tire_catalog','vehicle_fitments']) {
    const r = await pool.request().query(`SELECT COUNT(*) AS cnt FROM ${tbl}`);
    console.log(`  ✓ ${tbl.padEnd(24)} ${r.recordset[0].cnt} rows kept`);
  }

  await pool.close();
  console.log('\n✅ Database is clean and ready for production use.');
  console.log('   Restart the server — default services will be re-seeded automatically.\n');
}

run().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  process.exit(1);
});
