// Versioned, ordered, one-way database migrations.
//
// Files in this folder named NNNN_description.js export { description, up(tx, sql) } and run once each, in order, inside a transaction.
// Applied versions are recorded in schema_migrations with a checksum of the file; changing a migration after it ran is refused
// (write a new migration instead). Version 0 is the baseline: everything setupDatabase() created before versioning existed
// (inventory phases 1-15 and the original ERP schema). setupDatabase() stays idempotent and is only for that baseline.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sql = require('mssql');

const LOCK = 'tunegen_schema_migrations';
const FILE = /^(\d{4})_[a-z0-9_]+\.js$/;

function list() {
  return fs.readdirSync(__dirname).filter(f => FILE.test(f)).sort().map(file => {
    const mod = require(path.join(__dirname, file));
    const body = fs.readFileSync(path.join(__dirname, file));
    return { version: parseInt(file.slice(0, 4), 10), file, description: mod.description || file, up: mod.up, checksum: crypto.createHash('sha256').update(body).digest('hex') };
  });
}

/** Apply every pending migration. Safe to call on every boot and from several processes at once. */
async function run(pool, log = console.log) {
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name = 'schema_migrations' AND xtype = 'U')
    CREATE TABLE schema_migrations (
      version     INT           NOT NULL PRIMARY KEY,
      name        NVARCHAR(200) NOT NULL,
      checksum    CHAR(64)      NULL,
      applied_at  DATETIME2     NOT NULL DEFAULT SYSDATETIME()
    )`);
  const migrations = list();
  const versions = migrations.map(m => m.version);
  if (new Set(versions).size !== versions.length) throw new Error('Two migrations share a version number');

  // One migrator at a time: a second server booting waits here, then finds nothing left to do.
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const lock = await new sql.Request(tx).input('r', sql.NVarChar(255), LOCK)
      .query("DECLARE @s INT; EXEC @s = sp_getapplock @Resource = @r, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 60000; SELECT @s AS status");
    if (lock.recordset[0].status < 0) throw new Error('Could not obtain the migration lock');

    await new sql.Request(tx).query("IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 0) INSERT INTO schema_migrations (version, name, checksum) VALUES (0, 'baseline: original schema and inventory phases 1-15 (setupDatabase)', NULL)");
    const done = new Map((await new sql.Request(tx).query('SELECT version, checksum FROM schema_migrations')).recordset.map(r => [r.version, r.checksum]));

    for (const m of migrations) {
      if (done.has(m.version)) {
        if (done.get(m.version) && done.get(m.version) !== m.checksum) throw new Error(`Migration ${m.file} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      await m.up(tx, sql);
      await new sql.Request(tx).input('v', sql.Int, m.version).input('n', sql.NVarChar(200), m.description).input('c', sql.Char(64), m.checksum)
        .query('INSERT INTO schema_migrations (version, name, checksum) VALUES (@v, @n, @c)');
      log(`[migrations] applied ${m.file}: ${m.description}`);
    }
    await tx.commit();
  } catch (e) { try { await tx.rollback(); } catch { /* already rolled back */ } throw e; }
}

module.exports = { run, list };
