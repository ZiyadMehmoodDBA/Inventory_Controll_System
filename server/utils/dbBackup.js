// Database backup, restore drills and point-in-time recovery proof for TuneGENDB. Used by scripts/backup.js (CLI) and jobs/backupJob.js (schedule).
// Every run is recorded in backup_runs so "when did we last have a good backup / a proven restore" is a query, not a belief.
//
// BACKUP_DIR          folder on the SQL SERVER host that the SQL Server service account can write (default: the instance Backup folder)
// OFFSITE_BACKUP_DIR  optional second location on ANOTHER machine (UNC share the SQL service account can write, e.g. \\fileserver\sqlbackups).
//                     SQL Server Standard has no MIRROR TO, so the full backup is simply taken twice (the second is COPY_ONLY and does not disturb the chain).
//                     A backup that exists only on the database host is lost with the host.
const { getPool, sql } = require('../db');
const Cfg = require('./backupConfig');

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const q = s => `[${String(s).replace(/]/g, ']]')}]`;
const lit = s => `N'${String(s).replace(/'/g, "''")}'`;
const join = (dir, file) => `${dir.replace(/[\\/]+$/, '')}\\${file}`;
const dbName = async pool => (await pool.request().query('SELECT DB_NAME() AS n')).recordset[0].n;

async function backupDir(pool) {
  const cfgDir = (await Cfg.load()).backup_dir.value;
  if (cfgDir) return cfgDir;
  const r = (await pool.request().query("SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS NVARCHAR(400)) AS p, CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS NVARCHAR(400)) AS d")).recordset[0];
  if (r.p) return r.p;
  if (r.d) return join(r.d.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+$/, ''), 'Backup');
  throw new Error('Set BACKUP_DIR to a folder the SQL Server service can write');
}
const dataDir = async pool => (await pool.request().query("SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS NVARCHAR(400)) AS p")).recordset[0].p;

/** Run `fn`, record the outcome in backup_runs, rethrow on failure. */
async function recorded(kind, fn, opts = {}) {
  const pool = await getPool();
  const started = new Date();
  let out;
  try { out = await fn(pool); } catch (e) {
    await pool.request().input('k', sql.NVarChar(30), kind).input('s', sql.DateTime2, started).input('m', sql.NVarChar(sql.MAX), String(e.message).slice(0, 3000)).input('j', sql.Int, opts.jobId ?? null).input('src', sql.NVarChar(10), opts.source || 'cli')
      .query('INSERT INTO backup_runs (kind, started_at, finished_at, ok, message, job_id, source) VALUES (@k, @s, SYSUTCDATETIME(), 0, @m, @j, @src)').catch(() => {});
    throw e;
  }
  await pool.request().input('k', sql.NVarChar(30), kind).input('s', sql.DateTime2, started).input('f', sql.NVarChar(500), out.file ?? null).input('m', sql.NVarChar(sql.MAX), String(out.message ?? '').slice(0, 3000))
    .input('j', sql.Int, opts.jobId ?? null).input('src', sql.NVarChar(10), opts.source || 'cli')
    .query('INSERT INTO backup_runs (kind, started_at, finished_at, ok, [file], message, job_id, source) VALUES (@k, @s, SYSUTCDATETIME(), 1, @f, @m, @j, @src)');
  return out;
}

async function takeFull(pool, db, dir, copyOnly) {
  const file = join(dir, `${db}_full_${stamp()}${copyOnly ? '_offsite' : ''}.bak`);
  await pool.request().batch(`BACKUP DATABASE ${q(db)} TO DISK = ${lit(file)} WITH COMPRESSION, CHECKSUM, INIT${copyOnly ? ', COPY_ONLY' : ''}, NAME = ${lit(`${db} full ${stamp()}`)}`);
  await pool.request().batch(`RESTORE VERIFYONLY FROM DISK = ${lit(file)} WITH CHECKSUM`);
  return file;
}

async function backupFull(opts = {}) {
  return recorded('full', async pool => {
    const db = await dbName(pool);
    const file = await takeFull(pool, db, await backupDir(pool), false);
    let message = 'verified';
    const offsite = (await Cfg.load()).offsite_dir.value;
    if (offsite) {
      const off = await takeFull(pool, db, offsite, true);
      message = `verified; off-host copy ${off}`;
    } else message = 'verified; NO off-host copy configured (set the off-host folder in Settings > Backups)';
    return { file, message };
  }, opts);
}

async function backupLog(opts = {}) {
  return recorded('log', async pool => {
    const db = await dbName(pool);
    const rm = (await pool.request().query('SELECT recovery_model_desc AS m FROM sys.databases WHERE name = DB_NAME()')).recordset[0].m;
    if (rm === 'SIMPLE') return { file: null, message: 'recovery model SIMPLE: no log backup possible' };
    const hasFull = (await pool.request().query("SELECT COUNT(*) AS n FROM msdb.dbo.backupset WHERE database_name = DB_NAME() AND type = 'D'")).recordset[0].n;
    if (!hasFull) throw new Error('A transaction-log backup needs a full backup first');
    const file = join(await backupDir(pool), `${db}_log_${stamp()}.trn`);
    await pool.request().batch(`BACKUP LOG ${q(db)} TO DISK = ${lit(file)} WITH COMPRESSION, CHECKSUM, INIT`);
    await pool.request().batch(`RESTORE VERIFYONLY FROM DISK = ${lit(file)} WITH CHECKSUM`);
    return { file, message: 'verified' };
  }, opts);
}

// Figures that must survive a restore, with the table they come from.
const CHECKS = [
  ['stock ledger rows', 'SELECT COUNT(*) AS n FROM {db}.dbo.stock_movements'],
  ['stock ledger net quantity', 'SELECT ISNULL(SUM(CAST(qty_change AS BIGINT)), 0) AS n FROM {db}.dbo.stock_movements'],
  ['item balances', 'SELECT ISNULL(SUM(CAST(stock AS BIGINT)), 0) AS n FROM {db}.dbo.tires'],
  ['location balances', 'SELECT ISNULL(SUM(CAST(qty AS BIGINT)), 0) AS n FROM {db}.dbo.item_location_stock'],
  ['adjustments', 'SELECT COUNT(*) AS n FROM {db}.dbo.stock_adjustments'],
  ['audit trail rows', 'SELECT COUNT(*) AS n FROM {db}.dbo.audit_logs'],
  ['migrations recorded', 'SELECT COUNT(*) AS n FROM {db}.dbo.schema_migrations'],
];

/**
 * Verify a restored copy. FAILS on what must be true of any consistent database (item balances = ledger = location balances, append-only
 * triggers present). Lines comparing with the live database are information only: live legitimately moves on (or is purged) after a backup.
 */
async function verifyCopy(pool, copy, db, lines, label) {
  let failed = 0;
  const one = async s => (await pool.request().query(s)).recordset[0].n;
  const mism = await one(`SELECT COUNT(*) AS n FROM ${q(copy)}.dbo.tires t
    WHERE t.stock <> ISNULL((SELECT SUM(qty_change) FROM ${q(copy)}.dbo.stock_movements m WHERE m.tire_id = t.id), 0)
       OR t.stock <> ISNULL((SELECT SUM(qty) FROM ${q(copy)}.dbo.item_location_stock l WHERE l.tire_id = t.id), 0)`);
  lines.push(`${mism === 0 ? 'ok  ' : 'FAIL'} ${label} ledger agrees with item and location balances (${mism} mismatched items)`); if (mism) failed++;
  const trig = await one(`SELECT COUNT(*) AS n FROM ${q(copy)}.sys.triggers WHERE name LIKE 'trg[_]%append[_]only'`);
  lines.push(`${trig >= 2 ? 'ok  ' : 'FAIL'} append-only triggers present: ${trig}`); if (trig < 2) failed++;
  for (const [name, query] of CHECKS) {
    const a = (await pool.request().query(query.replace('{db}', q(copy)))).recordset[0].n;
    const b = (await pool.request().query(query.replace('{db}', q(db)))).recordset[0].n;
    lines.push(`info ${name}: ${label} ${a}, live now ${b}`);
  }
  return failed;
}

async function newestFull(pool, db) {
  return (await pool.request().input('d', sql.NVarChar(128), db).query(`
    SELECT TOP 1 mf.physical_device_name AS bak_file FROM msdb.dbo.backupset bs JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = bs.media_set_id
    WHERE bs.database_name = @d AND bs.type = 'D' AND bs.is_copy_only = 0 ORDER BY bs.backup_finish_date DESC`)).recordset[0]?.bak_file;
}
const moveClause = async (pool, file, copy) => {
  const files = (await pool.request().batch(`RESTORE FILELISTONLY FROM DISK = ${lit(file)}`)).recordset;
  const dir = await dataDir(pool);
  return files.map((f, i) => `MOVE ${lit(f.LogicalName)} TO ${lit(join(dir, `${copy}_${i}${f.Type === 'L' ? '.ldf' : '.mdf'}`))}`).join(', ');
};
const dropDb = (pool, name) => pool.request().batch(`IF DB_ID(${lit(name)}) IS NOT NULL BEGIN ALTER DATABASE ${q(name)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${q(name)} END`);

/** Restore the newest full backup into a scratch database, check integrity and that the figures match live, drop it. Returns { ok, lines }. */
async function restoreDrill({ keep = false } = {}, opts = {}) {
  const lines = []; let failed = 0;
  const res = await recorded('drill', async pool => {
    const db = await dbName(pool);
    const file = await newestFull(pool, db);
    if (!file) throw new Error('No full backup found');
    const copy = `${db}_drill_${stamp()}`;
    const started = Date.now();
    try {
      await pool.request().batch(`RESTORE DATABASE ${q(copy)} FROM DISK = ${lit(file)} WITH CHECKSUM, ${await moveClause(pool, file, copy)}, RECOVERY`);
      lines.push(`restored ${file} into ${copy}`);
      const chk = await pool.request().batch(`DBCC CHECKDB (${q(copy)}) WITH NO_INFOMSGS, ALL_ERRORMSGS`).then(() => 'clean', e => `ERRORS: ${e.message}`);
      lines.push(`integrity (DBCC CHECKDB): ${chk}`); if (chk !== 'clean') failed++;
      failed += await verifyCopy(pool, copy, db, lines, 'backup');
      lines.push(`recovery time: ${Math.round((Date.now() - started) / 1000)}s`);
    } finally { if (!keep) { try { await dropDb(pool, copy); lines.push(`scratch database ${copy} dropped`); } catch (e) { failed++; lines.push(`could not drop ${copy}: ${e.message}`); } } }
    if (failed) throw new Error(`restore drill failed: ${lines.filter(l => /^FAIL|ERRORS/.test(l)).join('; ')}`);
    return { file, message: lines.join(' | ') };
  }, opts).catch(e => ({ error: e }));
  return { ok: !res.error, lines, error: res.error?.message };
}

/**
 * Point-in-time recovery proof, in two parts.
 *  1. Synthetic (exact): a scratch database in FULL recovery gets a full backup, row A, a noted time T, row B, a log backup. Restoring the
 *     full backup plus the log STOPAT T must give A without B. This proves the server, the recovery model and the procedure.
 *  2. Production chain: the newest full backup plus every later log backup of TuneGENDB is restored into a scratch copy up to the last log
 *     backup's time; the figures must equal what the live database held at that moment (no writes since => equal, else live >= restored).
 */
async function pitrDrill(opts = {}) {
  const lines = []; let failed = 0;
  const res = await recorded('pitr', async pool => {
    const db = await dbName(pool);
    const dir = await backupDir(pool), data = await dataDir(pool);
    const id = stamp();
    // ── 1. synthetic ──
    const src = `${db}_pitr_src_${id}`, dst = `${db}_pitr_dst_${id}`;
    try {
      await pool.request().batch(`CREATE DATABASE ${q(src)} ON (NAME = ${lit(src + '_d')}, FILENAME = ${lit(join(data, src + '.mdf'))}, SIZE = 8MB) LOG ON (NAME = ${lit(src + '_l')}, FILENAME = ${lit(join(data, src + '.ldf'))}, SIZE = 8MB)`);
      await pool.request().batch(`ALTER DATABASE ${q(src)} SET RECOVERY FULL`);
      await pool.request().batch(`CREATE TABLE ${q(src)}.dbo.t (id INT PRIMARY KEY, note NVARCHAR(20))`);
      const f1 = join(dir, `${src}_full.bak`), l1 = join(dir, `${src}_log.trn`);
      await pool.request().batch(`BACKUP DATABASE ${q(src)} TO DISK = ${lit(f1)} WITH INIT, CHECKSUM`);
      await pool.request().batch(`INSERT INTO ${q(src)}.dbo.t VALUES (1, N'A')`);
      await new Promise(r => setTimeout(r, 1500));
      const T = (await pool.request().query('SELECT CONVERT(VARCHAR(23), GETDATE(), 121) AS t')).recordset[0].t;
      await new Promise(r => setTimeout(r, 1500));
      await pool.request().batch(`INSERT INTO ${q(src)}.dbo.t VALUES (2, N'B')`);
      await pool.request().batch(`BACKUP LOG ${q(src)} TO DISK = ${lit(l1)} WITH INIT, CHECKSUM`);
      const mv = await moveClause(pool, f1, dst);
      await pool.request().batch(`RESTORE DATABASE ${q(dst)} FROM DISK = ${lit(f1)} WITH ${mv}, NORECOVERY`);
      await pool.request().batch(`RESTORE LOG ${q(dst)} FROM DISK = ${lit(l1)} WITH STOPAT = ${lit(T)}, RECOVERY`);
      const rows = (await pool.request().query(`SELECT note FROM ${q(dst)}.dbo.t ORDER BY id`)).recordset.map(r => r.note);
      const good = rows.length === 1 && rows[0] === 'A';
      lines.push(`${good ? 'ok  ' : 'FAIL'} synthetic point-in-time restore to ${T}: rows = [${rows.join(',')}] (expected [A], B was written after the target time)`);
      if (!good) failed++;
    } finally { for (const n of [dst, src]) await dropDb(pool, n).catch(() => {}); }

    // ── 2. production chain ──
    const full = (await pool.request().input('d', sql.NVarChar(128), db).query(`
      SELECT TOP 1 bs.backup_set_id, bs.backup_finish_date, bs.last_lsn, mf.physical_device_name AS bak_file FROM msdb.dbo.backupset bs JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = bs.media_set_id
      WHERE bs.database_name = @d AND bs.type = 'D' AND bs.is_copy_only = 0 ORDER BY bs.backup_finish_date DESC`)).recordset[0];
    if (!full) throw new Error('No full backup found for the production chain test');
    await backupLog.call(null).catch(() => {});                 // make sure there is a log backup newer than the full one (also recorded)
    const logs = (await pool.request().input('d', sql.NVarChar(128), db).input('lsn', sql.Numeric(25, 0), full.last_lsn).query(`
      SELECT bs.backup_finish_date, bs.first_lsn, bs.last_lsn, mf.physical_device_name AS bak_file FROM msdb.dbo.backupset bs JOIN msdb.dbo.backupmediafamily mf ON mf.media_set_id = bs.media_set_id
      WHERE bs.database_name = @d AND bs.type = 'L' AND bs.backup_finish_date >= '${new Date(full.backup_finish_date).toISOString().replace('T', ' ').slice(0, 23)}' ORDER BY bs.backup_finish_date`)).recordset;
    if (!logs.length) { failed++; lines.push('FAIL no log backup after the newest full backup: the production log chain is not being backed up'); }
    else {
      const copy = `${db}_pitr_${id}`;
      try {
        await pool.request().batch(`RESTORE DATABASE ${q(copy)} FROM DISK = ${lit(full.bak_file)} WITH CHECKSUM, ${await moveClause(pool, full.bak_file, copy)}, NORECOVERY`);
        let applied = 0;
        for (const l of logs) {
          try { await pool.request().batch(`RESTORE LOG ${q(copy)} FROM DISK = ${lit(l.bak_file)} WITH NORECOVERY`); applied++; } catch (e) { if (!/too early|already|LSN/i.test(e.message)) throw e; }
        }
        const last = logs[logs.length - 1];
        const stopAt = new Date(last.backup_finish_date).toISOString().replace('T', ' ').slice(0, 23);
        await pool.request().batch(`RESTORE DATABASE ${q(copy)} WITH RECOVERY`);
        lines.push(`restored full + ${applied} log backup(s) up to ${stopAt}`);
        const chk = await pool.request().batch(`DBCC CHECKDB (${q(copy)}) WITH NO_INFOMSGS, ALL_ERRORMSGS`).then(() => 'clean', e => `ERRORS: ${e.message}`);
        lines.push(`${chk === 'clean' ? 'ok  ' : 'FAIL'} integrity (DBCC CHECKDB): ${chk}`); if (chk !== 'clean') failed++;
        failed += await verifyCopy(pool, copy, db, lines, 'recovered');
      } finally { await dropDb(pool, copy).catch(() => {}); lines.push('scratch databases dropped'); }
    }
    if (failed) throw new Error(`point-in-time recovery drill failed: ${lines.filter(l => /^FAIL/.test(l)).join('; ')}`);
    return { file: full.bak_file, message: lines.join(' | ') };
  }, opts).catch(e => ({ error: e }));
  return { ok: !res.error, lines, error: res.error?.message };
}

async function prune(days, opts = {}) {
  const r = await recorded('prune', async pool => {
    const cfg = await Cfg.load();
    const keep = Number(days || cfg.retention_days.value || 14);
    const cut = new Date(Date.now() - keep * 86400000);
    for (const dir of [await backupDir(pool), cfg.offsite_dir.value].filter(Boolean))
      for (const ext of ['bak', 'trn'])
        await pool.request().input('d', sql.NVarChar(400), dir).input('e', sql.NVarChar(10), ext).input('cut', sql.DateTime, cut).query('EXEC master.dbo.xp_delete_file 0, @d, @e, @cut, 0');
    return { message: `removed .bak/.trn files older than ${keep} days` };
  }, opts);
  return r.message;
}

/** When did each kind of run last succeed, and did the latest attempt fail? */
async function status() {
  const pool = await getPool();
  const r = (await pool.request().query(`
    SELECT kind, MAX(CASE WHEN ok = 1 THEN finished_at END) AS last_ok, MAX(finished_at) AS last_run,
           (SELECT TOP 1 ok FROM backup_runs x WHERE x.kind = b.kind ORDER BY id DESC) AS latest_ok
    FROM backup_runs b GROUP BY kind`)).recordset;
  return r;
}

// Limits an external monitor can alarm on. The log limit is three missed 30-minute runs; drills run weekly, so a day of slack.
const MAX_AGE_HOURS = { full: 26, log: 1.5, drill: 8 * 24, pitr: 8 * 24 };

/** Problems with the backup regime right now: stale or failing runs, no off-host copy. Empty list = healthy. */
async function health(now = new Date()) {
  const rows = Object.fromEntries((await status()).map(r => [r.kind, r]));
  const problems = [];
  for (const [kind, hours] of Object.entries(MAX_AGE_HOURS)) {
    const r = rows[kind];
    if (!r || !r.last_ok) { problems.push(kind + ': never succeeded'); continue; }
    const age = (now - new Date(r.last_ok)) / 3600000;
    if (age > hours) problems.push(`${kind}: last success ${age.toFixed(1)} h ago (limit ${hours} h)`);
    if (!r.latest_ok) problems.push(kind + ': the latest run failed');
  }
  const cfg = await Cfg.load();
  if (!cfg.offsite_dir.value) problems.push('no off-host copy configured (set the off-host folder in Settings > Backups)');
  if (!cfg.enabled) problems.push('scheduled backups are switched off');
  return problems;
}

module.exports = { backupFull, backupLog, restoreDrill, pitrDrill, prune, status, health, backupDir, MAX_AGE_HOURS };
