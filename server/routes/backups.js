// Backup console API (Settings > Backups). Platform administrators only (utils/platform.js): backups hold every organisation's data.
const express = require('express');
const cron = require('node-cron');
const router = express.Router();
const { getPool, sql } = require('../db');
const { writeAudit } = require('../utils/audit');
const { AppError, handleError } = require('../utils/errors');
const { v, validate } = require('../utils/validate');
const { minGapMinutes, parse } = require('../utils/cronNext');
const Cfg = require('../utils/backupConfig');
const B = require('../utils/dbBackup');
const Jobs = require('../jobs/backupJob');

const KINDS = ['full', 'log', 'drill', 'pitr', 'prune'];
const MAX_JOBS = 30;
const fail = (res, e) => handleError(res, e, 'backups');
const audit = async (req, action, entity, entityId, before, after) =>
  writeAudit(await getPool(), { orgId: req.user.orgId, branchId: req.user.branchId ?? 1, userId: req.user.userId, action, entity, entityId, before, after });

const JOB = { name: v.string({ min: 1, max: 60 }), kind: v.enum(KINDS), cron_expr: v.string({ min: 1, max: 60 }), enabled: v.bool({ default: true }) };
const CONFIG = {
  enabled: v.bool({ optional: true }),
  backup_dir: v.string({ max: 400, optional: true, nullable: true }),
  offsite_dir: v.string({ max: 400, optional: true, nullable: true }),
  retention_days: v.int({ min: 1, max: 3650, optional: true }),
};

/** Only five numeric fields, valid for node-cron, and not so frequent that backups pile onto each other. */
function assertSchedule(expr, kind) {
  if (!/^[0-9*\/,\- ]+$/.test(expr) || !parse(expr) || !cron.validate(expr))
    throw new AppError('Not a valid schedule. Use five numeric cron fields: minute hour day-of-month month day-of-week (for example 0 2 * * *).', 400, 'INVALID_SCHEDULE');
  const min = kind === 'log' ? 5 : 15;
  if (minGapMinutes(expr) < min) throw new AppError(`That schedule runs more often than every ${min} minutes, which is too frequent for a ${kind} job.`, 400, 'INVALID_SCHEDULE');
}

async function jobRow(id) {
  const r = await (await getPool()).request().input('id', sql.Int, id).query('SELECT id, name, kind, cron_expr, enabled FROM backup_jobs WHERE id = @id');
  if (!r.recordset.length) throw new AppError('Job not found', 404, 'NOT_FOUND');
  return r.recordset[0];
}

router.get('/overview', async (req, res) => {
  try {
    const pool = await getPool();
    const cfg = await Cfg.load(true);
    const [jobs, kinds, problems, recent, totals, db, lastByJob] = await Promise.all([
      Jobs.loadJobs(), B.status(), B.health(),
      pool.request().query('SELECT TOP 12 id, kind, started_at, finished_at, ok, [file], message, job_id, source FROM backup_runs ORDER BY id DESC'),
      pool.request().query(`SELECT SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed FROM backup_runs WHERE finished_at >= DATEADD(day, -30, SYSUTCDATETIME())`),
      pool.request().query(`SELECT recovery_model_desc AS recovery_model, (SELECT SUM(CAST(size AS BIGINT)) * 8 / 1024 FROM sys.database_files) AS size_mb FROM sys.databases WHERE name = DB_NAME()`),
      pool.request().query(`SELECT r.job_id, r.finished_at, r.ok, r.message, r.source FROM backup_runs r JOIN (SELECT job_id, MAX(id) AS id FROM backup_runs WHERE job_id IS NOT NULL GROUP BY job_id) m ON m.id = r.id`),
    ]);
    const last = Object.fromEntries(lastByJob.recordset.map(r => [r.job_id, r]));
    let effective = null; try { effective = await B.backupDir(pool); } catch { /* reported by health */ }
    res.json({
      enabled: cfg.enabled,
      config: { backup_dir: cfg.backup_dir, offsite_dir: cfg.offsite_dir, retention_days: cfg.retention_days, effective_backup_dir: effective },
      health: { ok: problems.length === 0, problems },
      busy: Jobs.busy(),
      jobs: jobs.map(j => ({ ...j, next_run: Jobs.nextRun(j, cfg.enabled), last_run: last[j.id] ?? null })),
      kinds: kinds.map(k => ({ ...k, max_age_hours: B.MAX_AGE_HOURS[k.kind] ?? null })),
      recent: recent.recordset,
      last_30_days: { ok: totals.recordset[0].ok || 0, failed: totals.recordset[0].failed || 0 },
      database: db.recordset[0] ?? null,
    });
  } catch (e) { fail(res, e); }
});

router.get('/runs', async (req, res) => {
  try {
    const q = validate(req.query, { kind: v.enum(KINDS, { optional: true }), ok: v.enum(['0', '1'], { optional: true }), limit: v.int({ min: 1, max: 200, default: 25 }), offset: v.int({ min: 0, default: 0 }) });
    const pool = await getPool();
    const where = []; const rq = () => pool.request();
    let r1 = rq(), r2 = rq();
    if (q.kind) { where.push('kind = @k'); r1 = r1.input('k', sql.NVarChar(30), q.kind); r2 = r2.input('k', sql.NVarChar(30), q.kind); }
    if (q.ok) { where.push('ok = @ok'); r1 = r1.input('ok', sql.Bit, q.ok === '1'); r2 = r2.input('ok', sql.Bit, q.ok === '1'); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await r1.input('lim', sql.Int, q.limit).input('off', sql.Int, q.offset)
      .query(`SELECT id, kind, started_at, finished_at, ok, [file], message, job_id, source FROM backup_runs ${w} ORDER BY id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`);
    const total = await r2.query(`SELECT COUNT(*) AS n FROM backup_runs ${w}`);
    res.json({ rows: rows.recordset, total: total.recordset[0].n });
  } catch (e) { fail(res, e); }
});

router.put('/config', async (req, res) => {
  try {
    const body = validate(req.body, CONFIG);
    const before = await Cfg.load(true);
    for (const k of ['backup_dir', 'offsite_dir']) if (body[k] != null) { try { body[k] = Cfg.checkPath(body[k]) ?? ''; } catch (e) { throw new AppError(e.message, 400, 'INVALID_PATH', { fields: { [k]: e.message } }); } }
    const bd = body.backup_dir !== undefined ? body.backup_dir : before.backup_dir.value, od = body.offsite_dir !== undefined ? body.offsite_dir : before.offsite_dir.value;
    if (bd && od && bd.toLowerCase() === od.toLowerCase()) throw new AppError('The off-host folder must be different from the backup folder', 400, 'INVALID_PATH', { fields: { offsite_dir: 'must differ from the backup folder' } });
    if (od && !od.startsWith('\\\\')) body._warning = 'The off-host folder is not a network share (\\\\server\\share). A folder on the database server itself does not protect against losing that server.';
    const warning = body._warning; delete body._warning;
    const after = await Cfg.save(body, req.user.userId);
    await Jobs.reload();
    audit(req, 'UPDATE', 'backup_config', 0, { enabled: before.enabled, backup_dir: before.backup_dir.value, offsite_dir: before.offsite_dir.value, retention_days: before.retention_days.value },
      { enabled: after.enabled, backup_dir: after.backup_dir.value, offsite_dir: after.offsite_dir.value, retention_days: after.retention_days.value });
    res.json({ ok: true, warning: warning ?? null, config: after });
  } catch (e) { fail(res, e); }
});

router.post('/jobs', async (req, res) => {
  try {
    const b = validate(req.body, JOB);
    assertSchedule(b.cron_expr, b.kind);
    const pool = await getPool();
    const n = (await pool.request().query('SELECT COUNT(*) AS n FROM backup_jobs')).recordset[0].n;
    if (n >= MAX_JOBS) throw new AppError(`At most ${MAX_JOBS} jobs`, 400, 'LIMIT');
    const r = await pool.request().input('n', sql.NVarChar(60), b.name).input('k', sql.NVarChar(10), b.kind).input('c', sql.NVarChar(60), b.cron_expr.replace(/\s+/g, ' ')).input('e', sql.Bit, b.enabled).input('u', sql.Int, req.user.userId)
      .query('INSERT INTO backup_jobs (name, kind, cron_expr, enabled, updated_by) OUTPUT INSERTED.id VALUES (@n, @k, @c, @e, @u)');
    await Jobs.reload();
    const row = await jobRow(r.recordset[0].id);
    audit(req, 'CREATE', 'backup_job', row.id, null, row);
    res.status(201).json(row);
  } catch (e) { fail(res, e); }
});

router.put('/jobs/:id', async (req, res) => {
  try {
    const id = validate({ id: req.params.id }, { id: v.int({ min: 1 }) }).id;
    const b = validate(req.body, JOB);
    assertSchedule(b.cron_expr, b.kind);
    const before = await jobRow(id);
    await (await getPool()).request().input('id', sql.Int, id).input('n', sql.NVarChar(60), b.name).input('k', sql.NVarChar(10), b.kind).input('c', sql.NVarChar(60), b.cron_expr.replace(/\s+/g, ' ')).input('e', sql.Bit, b.enabled).input('u', sql.Int, req.user.userId)
      .query('UPDATE backup_jobs SET name = @n, kind = @k, cron_expr = @c, enabled = @e, updated_at = SYSUTCDATETIME(), updated_by = @u WHERE id = @id');
    await Jobs.reload();
    const row = await jobRow(id);
    audit(req, 'UPDATE', 'backup_job', id, before, row);
    res.json(row);
  } catch (e) { fail(res, e); }
});

router.delete('/jobs/:id', async (req, res) => {
  try {
    const id = validate({ id: req.params.id }, { id: v.int({ min: 1 }) }).id;
    const before = await jobRow(id);
    await (await getPool()).request().input('id', sql.Int, id).query('DELETE FROM backup_jobs WHERE id = @id');
    await Jobs.reload();
    audit(req, 'DELETE', 'backup_job', id, before, null);
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// Start a job now. It runs in the background (a restore drill takes minutes); the console polls /overview for progress.
router.post('/jobs/:id/run', async (req, res) => {
  try {
    const id = validate({ id: req.params.id }, { id: v.int({ min: 1 }) }).id;
    const job = await jobRow(id);
    if (Jobs.busy()) throw new AppError(`"${Jobs.busy().name}" is still running, try again when it has finished`, 409, 'BUSY');
    audit(req, 'UPDATE', 'backup_job_run', id, null, { job: job.name, kind: job.kind });
    Jobs.runJob(job, 'manual').catch(() => { /* recorded in backup_runs and logged */ });
    res.status(202).json({ started: true, job });
  } catch (e) { fail(res, e); }
});

module.exports = router;
