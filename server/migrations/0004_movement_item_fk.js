// A ledger row must always point at an existing item, and an item with history cannot be deleted (NO ACTION): retire it with status instead.
// Skipped with a warning if orphan rows still exist; run scripts/purge-orphan-movements.js (after review) and restart.
exports.description = 'foreign key stock_movements.tire_id -> tires.id (no delete of items with history)';

exports.up = async (tx, sql) => {
  const has = (await new sql.Request(tx).query("SELECT 1 AS x FROM sys.foreign_keys WHERE name = 'FK_stock_movements_tire'")).recordset.length;
  if (has) return;
  const orphans = (await new sql.Request(tx).query('SELECT COUNT(*) AS n FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM tires t WHERE t.id = m.tire_id)')).recordset[0].n;
  if (orphans) throw new Error(`${orphans} stock movement(s) point at items that do not exist. Review and run scripts/purge-orphan-movements.js, then restart.`);
  await new sql.Request(tx).batch('ALTER TABLE stock_movements WITH CHECK ADD CONSTRAINT FK_stock_movements_tire FOREIGN KEY (tire_id) REFERENCES tires(id) ON DELETE NO ACTION');
};
