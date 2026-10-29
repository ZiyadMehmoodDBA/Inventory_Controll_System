// Removes stock_movements rows whose item AND organisation no longer exist (residue of deleted test organisations), with their cost layers.
//   node scripts/purge-orphan-movements.js            dry run: shows what would go
//   node scripts/purge-orphan-movements.js --apply    exports the rows to scripts/purged/, then deletes them in one transaction
// Refuses to touch a row whose organisation still exists: that would be real history with a missing item, which must be investigated, not deleted.
// Take a verified backup first (node scripts/backup.js backup). The append-only trigger is bypassed only inside this transaction.
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { getPool, sql } = require('../db');

const ORPHAN = `FROM stock_movements m WHERE NOT EXISTS (SELECT 1 FROM tires t WHERE t.id = m.tire_id)`;

(async () => {
  const pool = await getPool();
  const rows = (await pool.request().query(`SELECT m.* ${ORPHAN}`)).recordset;
  const live = (await pool.request().query(`SELECT COUNT(*) AS n ${ORPHAN} AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = m.organization_id)`)).recordset[0].n;
  const layers = (await pool.request().query(`SELECT COUNT(*) AS n FROM stock_cost_layers c WHERE c.movement_id IN (SELECT m.id ${ORPHAN})`)).recordset[0].n;
  console.log(`orphan movements: ${rows.length}, cost layers attached: ${layers}, rows whose organisation still exists: ${live}`);
  if (live > 0) { console.error('REFUSED: some orphan rows belong to an existing organisation. Investigate them; they may be real history.'); process.exit(1); }
  if (!rows.length) { console.log('nothing to do'); process.exit(0); }
  if (!process.argv.includes('--apply')) { console.log('dry run. Re-run with --apply to export and delete.'); process.exit(0); }

  const dir = path.join(__dirname, 'purged'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `orphan_stock_movements_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const cl = (await pool.request().query(`SELECT * FROM stock_cost_layers c WHERE c.movement_id IN (SELECT m.id ${ORPHAN})`)).recordset;
  fs.writeFileSync(file, JSON.stringify({ exported_at: new Date().toISOString(), movements: rows, cost_layers: cl }, null, 1));
  console.log(`exported to ${file}`);

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    await new sql.Request(tx).batch("EXEC sp_set_session_context N'allow_purge', 1");
    const a = await new sql.Request(tx).query(`DELETE c FROM stock_cost_layers c WHERE c.movement_id IN (SELECT m.id ${ORPHAN}); SELECT @@ROWCOUNT AS n`);
    const b = await new sql.Request(tx).query(`DELETE m ${ORPHAN} AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = m.organization_id); SELECT @@ROWCOUNT AS n`);
    if (b.recordset[0].n !== rows.length) throw new Error(`expected to delete ${rows.length} movements, would delete ${b.recordset[0].n}`);
    await tx.commit();
    console.log(`deleted ${b.recordset[0].n} movements and ${a.recordset[0].n} cost layers`);
  } catch (e) { await tx.rollback(); console.error('ROLLED BACK:', e.message); process.exit(1); }
  process.exit(0);
})();
