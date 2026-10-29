// Executes approved report templates. Uses a dedicated read-only SQL login when REPORT_DB_USER is set;
// otherwise falls back to the application pool (a warning is logged once). Enforces row limits,
// query timeout, and projects every row to the report's declared columns (field allow-list).
const { getPool, sql } = require('../db');

let reportPool = null;
let warned = false;

async function getReportPool() {
  const user = process.env.REPORT_DB_USER;
  if (!user) {
    if (!warned) { console.warn('[reporting] REPORT_DB_USER not set: reports run on the application DB login. Configure a read-only login for production.'); warned = true; }
    return getPool();
  }
  if (!reportPool || !reportPool.connected) {
    if (reportPool) { try { await reportPool.close(); } catch { /* ignore */ } }
    reportPool = new sql.ConnectionPool({
      server: process.env.DB_SERVER || 'localhost',
      user,
      password: process.env.REPORT_DB_PASSWORD || '',
      database: process.env.DB_NAME || 'TuneGENDB',
      options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 15000,
      requestTimeout: 30000,
    });
    reportPool.on('error', err => { console.error('Report SQL pool error:', err.message); reportPool = null; });
    await reportPool.connect();
  }
  return reportPool;
}

function coerce(value, type) {
  if (value === null || value === undefined) return null;
  if (type === 'currency' || type === 'number' || type === 'percent') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

async function executeTemplate(def, template, policy, limit) {
  const pool = await getReportPool();
  const request = pool.request();
  for (const [name, type, value] of template.inputs) request.input(name, type, value);

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { try { request.cancel(); } catch { /* ignore */ } reject(new Error('REPORT_TIMEOUT')); }, policy.timeout_ms);
  });
  let result;
  try { result = await Promise.race([request.query(template.sql), timeout]); }
  finally { clearTimeout(timer); }

  let rows = result.recordset || [];
  const truncated = rows.length > limit;
  if (truncated) rows = rows.slice(0, limit);

  // Allow-list projection + type coercion: nothing outside declared columns leaves the engine.
  rows = rows.map(r => Object.fromEntries(def.columns.map(c => [c.key, coerce(r[c.key] ?? r[c.key.toLowerCase()], c.type)])));
  return { rows, truncated };
}

module.exports = { executeTemplate };
