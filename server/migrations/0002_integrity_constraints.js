// Database-level guards for stock data, so a bug in application code cannot write an impossible record.
// Each constraint is added validated; if old rows already break it, it is added WITH NOCHECK (new rows are still enforced) and logged.
exports.description = 'check constraints on movements, adjustments, batches and roles';

const CHECKS = [
  ['stock_movements',    'CK_stock_movements_change',   'qty_change <> 0'],
  ['stock_movements',    'CK_stock_movements_balance',  'qty_before IS NULL OR qty_after IS NULL OR qty_after = qty_before + qty_change'],
  ['stock_adjustments',  'CK_stock_adjustments_change', 'qty_change <> 0'],
  ['stock_adjustments',  'CK_stock_adjustments_status', "status IN ('pending', 'approved', 'rejected')"],
  ['batch_location_stock', 'CK_batch_location_stock_qty', 'qty >= 0'],
  ['access_roles',       'CK_access_roles_limit',       'approval_limit IS NULL OR approval_limit >= 0'],
];

exports.up = async (tx, sql) => {
  for (const [table, name, expr] of CHECKS) {
    const exists = (await new sql.Request(tx).query(`SELECT 1 AS x FROM sys.check_constraints WHERE name = '${name}'`)).recordset.length;
    if (exists) continue;
    // a failed ALTER inside a transaction can doom it, so test the data first
    const bad = (await new sql.Request(tx).query(`SELECT COUNT(*) AS n FROM ${table} WHERE NOT (${expr})`)).recordset[0].n;
    const mode = bad === 0 ? 'WITH CHECK' : 'WITH NOCHECK';
    await new sql.Request(tx).batch(`ALTER TABLE ${table} ${mode} ADD CONSTRAINT ${name} CHECK (${expr})`);
    if (bad) console.warn(`[migrations] ${name}: ${bad} existing row(s) break this rule; added WITH NOCHECK, new rows are enforced`);
  }
};
