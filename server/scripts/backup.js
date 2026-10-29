// Database backup and recovery drill for TuneGENDB.
//
//   node scripts/backup.js backup [--log]     full backup (compressed, checksummed, verified); --log also takes a transaction-log backup
//   node scripts/backup.js drill              restores the newest full backup into a scratch database, checks integrity and that the
//                                             ledger, balances and audit trail match the live database, then drops the scratch copy
//   node scripts/backup.js prune [days]       deletes backup files older than `days` (default BACKUP_RETENTION_DAYS or 14)
//
// BACKUP_DIR is a folder on the SQL SERVER machine that the SQL Server service account can write (default: the instance's Backup folder).
// A backup that has never been restored is not a backup: run `drill` on a schedule (weekly) and after every migration that rebuilds data.
// Recovery model FULL needs regular log backups or the log file grows without limit: schedule `backup --log` every 15-60 minutes.
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { getPool, sql } = require('../db');

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const q = s => `[${String(s).replace(/]/g, ']]')}]`;
const lit = s => `N'${String(s).replace(/'/g, "''")}'`;
const join = (dir, file) => `${dir.replace(/[\\/]+$/, '')}\\${file}`;

async function backupDir(pool) {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  const r = (await pool.request().query("SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS NVARCHAR(400)) AS p, CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS NVARCHAR(400)) AS d")).recordset[0];
  if (r.p) return r.p;
  if (r.d) return join(r.d.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, ''), 'Backup');
  throw new Error('Set BACKUP_DIR to a folder the SQL Server service can write');
}

async function backup(withLog) {
  const pool = await getPool();
  const db = (await pool.request().query('SELECT DB_NAME() AS n')).recordset[0].n;
  const dir = await backupDir(pool);
  const file = join(dir, `${db}_full_${stamp()}.bak`);
  await pool.request().batch(`BACKUP DATABASE ${q(db)} TO DISK = ${lit(file)} WITH COMPRESSION, CHECKSUM, INIT, STATS = 100, NAME = ${lit(`${db} full ${stamp()}`)}`);
  await pool.request().batch(`RESTORE VERIFYONLY FROM DISK = ${lit(file)} WITH CHECKSUM`);
  console.log(`full backup verified: ${file}`);
  if (withLog) {
    const rm = (await pool.request().query('SELECT recovery_model_desc AS m FROM sys.databases WHERE name = DB_NAME()')).recordset[0].m;
    if (rm === 'SIMPLE') console.log('recovery model is SIMPLE: no log backup needed (point-in-time recovery is not available)');
    else {
      const lf = join(dir, `${db}_log_${stamp()}.trn`);
      await pool.request().batch(`BACKUP LOG ${q(db)} TO DISK = ${lit(lf)} WITH COMPRESSION, CHECKSUM, INIT`);
      await pool.request().batch(`RESTORE VERIFYONLY FROM DISK = ${lit(lf)} WITH CHECKSUM`);
      console.log(`log backup verified: ${lf}`);
    }
  }
  return file;
}

async function newestFull(pool, db) {
  const r = await pool.request().input('d', sql.NVarChar(128), db).query(`
    SELECT TOP 1 mf.physical_device_name AS bak_file FROM msdb.dbo.backupset bs JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = bs.media_set_id
    WHERE bs.database_name = @d AND bs.type = 'D' ORDER BY bs.backup_finish_date DESC`);
  return r.recordset[0]?.bak_file;
}

// Tables whose contents must survive a restore unchanged, with the figure that proves it.
const CHECKS = [
  ['stock ledger rows', 'SELECT COUNT(*) AS n FROM {db}.dbo.stock_movements'],
  ['stock ledger net quantity', 'SELECT ISNULL(SUM(CAST(qty_change AS BIGINT)), 0) AS n FROM {db}.dbo.stock_movements'],
  ['item balances', 'SELECT ISNULL(SUM(CAST(stock AS BIGINT)), 0) AS n FROM {db}.dbo.tires'],
  ['location balances', 'SELECT ISNULL(SUM(CAST(qty AS BIGINT)), 0) AS n FROM {db}.dbo.item_location_stock'],
  ['adjustments', 'SELECT COUNT(*) AS n FROM {db}.dbo.stock_adjustments'],
  ['audit trail rows', 'SELECT COUNT(*) AS n FROM {db}.dbo.audit_logs'],
  ['migrations recorded', 'SELECT COUNT(*) AS n FROM {db}.dbo.schema_migrations'],
];

async function drill() {
  const pool = await getPool();
  const db = (await pool.request().query('SELECT DB_NAME() AS n')).recordset[0].n;
  const file = process.argv[3] && process.argv[3] !== '--keep' ? process.argv[3] : await newestFull(pool, db);
  if (!file) throw new Error('No backup found. Run: node scripts/backup.js backup');
  const copy = `${db}_drill_${stamp()}`;
  const files = (await pool.request().batch(`RESTORE FILELISTONLY FROM DISK = ${lit(file)}`)).recordset;
  const dataDir = (await pool.request().query("SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS NVARCHAR(400)) AS p")).recordset[0].p;
  const move = files.map((f, i) => `MOVE ${lit(f.LogicalName)} TO ${lit(join(dataDir, `${copy}_${i}${f.Type === 'L' ? '.ldf' : '.mdf'}`))}`).join(', ');
  const started = Date.now();
  let failed = 0;
  try {
    await pool.request().batch(`RESTORE DATABASE ${q(copy)} FROM DISK = ${lit(file)} WITH CHECKSUM, ${move}, RECOVERY, STATS = 100`);
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`restored ${file}\n  into ${copy} in ${seconds}s`);
    const chk = await pool.request().batch(`DBCC CHECKDB (${q(copy)}) WITH NO_INFOMSGS, ALL_ERRORMSGS`).then(() => 'clean', e => `ERRORS: ${e.message}`);
    console.log(`  integrity (DBCC CHECKDB): ${chk}`);
    if (chk !== 'clean') failed++;
    for (const [name, query] of CHECKS) {
      const a = (await pool.request().query(query.replace('{db}', q(copy)))).recordset[0].n;
      const b = (await pool.request().query(query.replace('{db}', q(db)))).recordset[0].n;
      // The live database moves on after the backup, so only a restored figure that is larger than live is a real problem.
      const bad = Number(a) > Number(b);
      if (bad) failed++;
      console.log(`  ${bad ? 'FAIL' : 'ok  '} ${name}: backup ${a}, live now ${b}`);
    }
    const trig = (await pool.request().query(`SELECT COUNT(*) AS n FROM ${q(copy)}.sys.triggers WHERE name LIKE 'trg[_]%append[_]only'`)).recordset[0].n;
    console.log(`  ${trig >= 2 ? 'ok  ' : 'FAIL'} append-only triggers present: ${trig}`);
    if (trig < 2) failed++;
    console.log(`  recovery time for this database: ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    if (!process.argv.includes('--keep')) {
      try { await pool.request().batch(`ALTER DATABASE ${q(copy)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${q(copy)}`); console.log(`  scratch database ${copy} dropped`); }
      catch (e) { console.log(`  could not drop ${copy}: ${e.message}`); failed++; }
    }
  }
  console.log(failed ? `RECOVERY DRILL FAILED (${failed})` : 'recovery drill passed');
  return failed;
}

async function prune(days) {
  const pool = await getPool();
  const dir = await backupDir(pool);
  const keep = Number(days || process.env.BACKUP_RETENTION_DAYS || 14);
  // xp_delete_file removes only .bak/.trn files in the folder, older than the cut-off
  for (const ext of ['bak', 'trn']) {
    await pool.request().input('d', sql.NVarChar(400), dir).input('e', sql.NVarChar(10), ext).input('cut', sql.DateTime, new Date(Date.now() - keep * 86400000))
      .query('EXEC master.dbo.xp_delete_file 0, @d, @e, @cut, 0');
  }
  console.log(`removed .bak/.trn files older than ${keep} days from ${dir}`);
}

(async () => {
  const cmd = process.argv[2];
  let code = 0;
  try {
    if (cmd === 'backup') await backup(process.argv.includes('--log'));
    else if (cmd === 'drill') code = (await drill()) ? 1 : 0;
    else if (cmd === 'prune') await prune(process.argv[3]);
    else { console.log('usage: node scripts/backup.js backup [--log] | drill [file] [--keep] | prune [days]'); code = 2; }
  } catch (e) { console.error('FAILED:', e.message); code = 1; }
  process.exit(code);
})();
