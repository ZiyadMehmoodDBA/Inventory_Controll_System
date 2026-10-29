// The audit trail and the stock movement ledger are append-only. The database itself refuses to change or remove their rows, so no code path
// (and no ad-hoc query) can rewrite history. The one exception is stock_movements.unit_cost, which the costing code may fill in after the fact.
// Test clean-up and a deliberate administrator purge must set SESSION_CONTEXT 'allow_purge' = 1 on their own connection.
exports.description = 'append-only audit_logs and stock_movements (triggers)';

exports.up = async (tx, sql) => {
  const run = text => new sql.Request(tx).batch(text);
  await run(`
    CREATE OR ALTER TRIGGER trg_audit_logs_append_only ON audit_logs AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF TRY_CONVERT(INT, SESSION_CONTEXT(N'allow_purge')) = 1 RETURN;
      THROW 51000, 'audit_logs is append-only: rows cannot be changed or removed', 1;
    END`);
  // every column except id and unit_cost is immutable
  const cols = (await new sql.Request(tx).query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('stock_movements') AND name NOT IN ('id', 'unit_cost')")).recordset.map(r => `UPDATE([${r.name}])`);
  await run(`
    CREATE OR ALTER TRIGGER trg_stock_movements_append_only ON stock_movements AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF TRY_CONVERT(INT, SESSION_CONTEXT(N'allow_purge')) = 1 RETURN;
      IF NOT EXISTS (SELECT 1 FROM inserted) THROW 51000, 'stock_movements is append-only: rows cannot be removed', 1;
      IF ${cols.join(' OR ')} THROW 51000, 'stock_movements is append-only: a movement cannot be changed, post a correcting movement instead', 1;
    END`);
};
