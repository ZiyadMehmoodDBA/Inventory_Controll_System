// Next document number (invoice / PO): <prefix>-<year>-<seq>.
// Uses the highest existing sequence instead of COUNT(*), so deleting a document can never cause a
// collision. invoice_no / po_no are unique across the whole table, so the sequence is global per stem;
// a concurrent clash is still stopped by that unique constraint and the request can simply be retried.
const { sql } = require('../db');

const escLike = s => s.replace(/[\\%_[]/g, ch => `\\${ch}`);
const ALLOWED = { sales: 'invoice_no', purchases: 'po_no', stock_transfers: 'transfer_no', stock_counts: 'count_no', product_recalls: 'recall_no', quality_disposals: 'disposal_no', hazard_incidents: 'incident_no', supplier_returns: 'return_no' };

/** `request` is pool.request() or new sql.Request(transaction). */
async function nextDocNumber(request, table, prefix) {
  const column = ALLOWED[table];
  if (!column) throw new Error('Unsupported document table');
  const stem = `${prefix}-${new Date().getFullYear()}-`;
  const r = await request
    .input('stem', sql.NVarChar(80), stem)
    .input('like', sql.NVarChar(120), `${escLike(stem)}%`)
    .query(`SELECT ISNULL(MAX(TRY_CAST(SUBSTRING(${column}, LEN(@stem) + 1, 20) AS INT)), 0) + 1 AS n
            FROM ${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${column} LIKE @like ESCAPE '\\'`);
  return `${stem}${String(r.recordset[0].n).padStart(3, '0')}`;
}

// Next master-data code (C001 / S001). customers.code and suppliers.code are unique across ALL organisations,
// so the sequence is global: take the highest existing number rather than a per-org count.
const CODE_TABLES = { customers: 'C', suppliers: 'S' };
async function nextEntityCode(request, table) {
  const prefix = CODE_TABLES[table];
  if (!prefix) throw new Error('Unsupported table');
  const r = await request.input('pfx', sql.NVarChar(5), prefix + '%')
    .query(`SELECT ISNULL(MAX(TRY_CAST(SUBSTRING(code, 2, 15) AS INT)), 0) + 1 AS n
            FROM ${table} WITH (UPDLOCK, HOLDLOCK) WHERE code LIKE @pfx`);
  return prefix + String(r.recordset[0].n).padStart(3, '0');
}

module.exports = { nextDocNumber, nextEntityCode };
