// Corrects the triggers of 0001: a statement that touches zero rows still fires an AFTER trigger (with empty inserted/deleted),
// which wrongly raised the "cannot be removed" error, and the one-time location back-fill (NULL -> location) must stay possible.
exports.description = 'append-only triggers: ignore zero-row statements, allow one-time location back-fill';

exports.up = async (tx, sql) => {
  const run = text => new sql.Request(tx).batch(text);
  await run(`
    CREATE OR ALTER TRIGGER trg_audit_logs_append_only ON audit_logs AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF NOT EXISTS (SELECT 1 FROM deleted) RETURN;
      IF TRY_CONVERT(INT, SESSION_CONTEXT(N'allow_purge')) = 1 RETURN;
      THROW 51000, 'audit_logs is append-only: rows cannot be changed or removed', 1;
    END`);
  const cols = (await new sql.Request(tx).query("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('stock_movements') AND name NOT IN ('id', 'unit_cost', 'location_id')")).recordset.map(r => `UPDATE([${r.name}])`);
  await run(`
    CREATE OR ALTER TRIGGER trg_stock_movements_append_only ON stock_movements AFTER UPDATE, DELETE AS
    BEGIN
      SET NOCOUNT ON;
      IF NOT EXISTS (SELECT 1 FROM deleted) RETURN;
      IF TRY_CONVERT(INT, SESSION_CONTEXT(N'allow_purge')) = 1 RETURN;
      IF NOT EXISTS (SELECT 1 FROM inserted) THROW 51000, 'stock_movements is append-only: rows cannot be removed', 1;
      IF ${cols.join(' OR ')} THROW 51000, 'stock_movements is append-only: a movement cannot be changed, post a correcting movement instead', 1;
      IF UPDATE(location_id) AND EXISTS (SELECT 1 FROM deleted d WHERE d.location_id IS NOT NULL)
        THROW 51000, 'stock_movements is append-only: a movement cannot be moved to another location', 1;
    END`);
};
