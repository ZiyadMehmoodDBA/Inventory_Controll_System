'use strict';
/**
 * Diagnostic: checks vehicle_fitments table state and API endpoint health.
 * Run with: node server/scripts/check-fitments.js
 */

const sql = require('mssql');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const cfg = {
  server:   process.env.DB_SERVER   || 'localhost',
  database: process.env.DB_NAME     || 'TuneGENDB',
  user:     process.env.DB_USER     || 'sa',
  password: process.env.DB_PASSWORD || '',
  options:  { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  connectionTimeout: 10000,
  requestTimeout:    10000,
};

async function main() {
  console.log('\n=== TuneGEN Fitment Diagnostics ===\n');

  /* 1. DB connectivity */
  let pool;
  try {
    pool = new sql.ConnectionPool(cfg);
    await pool.connect();
    console.log('✅  DB connected:', cfg.server, '/', cfg.database);
  } catch (err) {
    console.error('❌  DB connection failed:', err.message);
    process.exit(1);
  }

  /* 2. Table exists? */
  const tableCheck = await pool.request().query(`
    SELECT COUNT(*) AS cnt FROM sys.objects
    WHERE name = 'vehicle_fitments' AND type = 'U'
  `);
  const tableExists = tableCheck.recordset[0].cnt > 0;
  console.log(tableExists
    ? '✅  Table vehicle_fitments EXISTS'
    : '❌  Table vehicle_fitments does NOT exist — server needs to be started once to create it');

  if (!tableExists) { await pool.close(); return; }

  /* 3. Row count */
  const rowCount = await pool.request().query('SELECT COUNT(*) AS cnt FROM vehicle_fitments');
  const rows = rowCount.recordset[0].cnt;
  console.log(rows > 0
    ? `✅  Rows in table: ${rows}`
    : '❌  Table is EMPTY — seed has not run (restart the server)');

  /* 4. Category breakdown */
  if (rows > 0) {
    const cats = await pool.request().query(`
      SELECT category, COUNT(*) AS n FROM vehicle_fitments GROUP BY category ORDER BY category
    `);
    console.log('\n   Categories:');
    for (const r of cats.recordset) {
      console.log(`     ${r.n.toString().padStart(3)} rows  →  ${r.category}`);
    }
  }

  /* 5. Column check */
  const cols = await pool.request().query(`
    SELECT name, is_nullable FROM sys.columns
    WHERE object_id = OBJECT_ID('vehicle_fitments')
    ORDER BY column_id
  `);
  console.log('\n   Columns:', cols.recordset.map(c => c.name).join(', '));

  /* 6. Check year_from nullable (old installs had NOT NULL which breaks seed) */
  const yfCol = cols.recordset.find(c => c.name === 'year_from');
  if (yfCol && !yfCol.is_nullable) {
    console.log('⚠️   year_from is NOT NULL — migration has not run. Restart the server to apply it.');
  }

  /* 7. Sample row */
  if (rows > 0) {
    const sample = await pool.request().query('SELECT TOP 3 * FROM vehicle_fitments');
    console.log('\n   Sample rows:');
    for (const r of sample.recordset) {
      console.log(`     ${r.make} ${r.model} → ${r.tire_size} (${r.category})`);
    }
  }

  /* 8. API reachability (no auth — just checks if server is up) */
  console.log('\n   Testing API endpoint (no auth — expects 401 if server is up)...');
  try {
    const res = await fetch('http://localhost:3001/api/fitments/categories');
    if (res.status === 401) {
      console.log('✅  Server is running and route /api/fitments/categories is REGISTERED (got 401 — needs auth token, that is expected)');
    } else if (res.status === 200) {
      const data = await res.json();
      console.log('✅  Route live, returned:', data);
    } else if (res.status === 404) {
      console.log('❌  Server is running but route /api/fitments/categories returned 404 — server is running OLD code, needs restart');
    } else {
      console.log(`⚠️   Got HTTP ${res.status} from API`);
    }
  } catch {
    console.log('❌  Cannot reach http://localhost:3001 — server is NOT running');
  }

  await pool.close();
  console.log('\n=== Done ===\n');
}

main().catch(err => { console.error(err); process.exit(1); });
