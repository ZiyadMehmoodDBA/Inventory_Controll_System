/**
 * Automated database protection, driven by the backup_jobs table (edited in Settings > Backups) and the master switch in the console
 * (or BACKUP_JOB=on in server/.env until the console has saved a value). Default jobs, created by migration 0006:
 *   02:00 daily full backup  |  every 30 min log backup  |  Sun 03:30 restore drill  |  Sun 04:00 point-in-time drill  |  05:00 daily prune
 * Each run is written to backup_runs. Only one job runs at a time: a log backup must not overlap a full backup or a drill.
 * Changing a job or the switch calls reload(), so the new schedule applies at once without restarting the server.
 */
const cron = require('node-cron');
const B = require('../utils/dbBackup');
const Cfg = require('../utils/backupConfig');
const { getPool } = require('../db');
const { AppError } = require('../utils/errors');
const { nextRuns } = require('../utils/cronNext');

const tasks = new Map();     // job id -> scheduled cron task
let current = null;          // { jobId, kind, name, source, startedAt } while something runs

const EXEC = {
  full:  opts => B.backupFull(opts),
  log:   opts => B.backupLog(opts),
  drill: async opts => { const r = await B.restoreDrill({}, opts); if (!r.ok) throw new Error(r.error); return { message: 'passed' }; },
  pitr:  async opts => { const r = await B.pitrDrill(opts); if (!r.ok) throw new Error(r.error); return { message: 'passed' }; },
  prune: async opts => ({ message: await B.prune(undefined, opts) }),
};

const busy = () => current;

/** Run one job now. Resolves when it has finished; rejects if another job is running, or the run failed (already recorded in backup_runs). */
async function runJob(job, source = 'manual') {
  if (current) throw new AppError(`"${current.name}" is still running, try again when it has finished`, 409, 'BUSY');
  current = { jobId: job.id ?? null, kind: job.kind, name: job.name, source, startedAt: new Date().toISOString() };
  try {
    const r = await EXEC[job.kind]({ jobId: job.id ?? null, source });
    console.log(`[Backup] ${job.name} ok${r && r.message ? ': ' + r.message : ''}`);
    return r;
  } catch (e) {
    console.error(`[Backup] ${job.name} FAILED: ${e.message}`);
    throw e;
  } finally { current = null; }
}

async function loadJobs() {
  const pool = await getPool();
  return (await pool.request().query('SELECT id, name, kind, cron_expr, enabled FROM backup_jobs ORDER BY id')).recordset;
}

function stopAll() { for (const t of tasks.values()) t.stop(); tasks.clear(); }

/** (Re)build the schedule from the database. Safe to call at any time. */
async function reload() {
  stopAll();
  // BACKUP_SCHEDULER=off keeps this process from scheduling anything (test servers, a second instance); manual runs still work.
  if (String(process.env.BACKUP_SCHEDULER || '').toLowerCase() === 'off') { console.log('[Backup] scheduler disabled for this process (BACKUP_SCHEDULER=off)'); return { scheduled: 0, enabled: false }; }
  const cfg = await Cfg.load(true);
  if (!cfg.enabled) { console.log('[Backup] scheduled backups are OFF (switch them on in Settings > Backups)'); return { scheduled: 0, enabled: false }; }
  let n = 0;
  for (const job of await loadJobs()) {
    if (!job.enabled) continue;
    if (!cron.validate(job.cron_expr)) { console.warn(`[Backup] job "${job.name}" has an invalid schedule "${job.cron_expr}" and was skipped`); continue; }
    tasks.set(job.id, cron.schedule(job.cron_expr, () => { runJob(job, 'schedule').catch(e => { if (e.code === 'BUSY') console.warn(`[Backup] skipped ${job.name}: ${e.message}`); }); }));
    n++;
  }
  console.log(`[Backup] ${n} scheduled job(s) active`);
  return { scheduled: n, enabled: true };
}

/** Next scheduled time of a job, or null when it will not run (switched off, disabled, or no valid schedule). */
function nextRun(job, enabledMaster) {
  if (!enabledMaster || !job.enabled) return null;
  return nextRuns(job.cron_expr, 1)[0]?.toISOString() ?? null;
}

async function initBackupJob() {
  try { await reload(); } catch (e) { console.error('[Backup] could not start the scheduler:', e.message); }
}

module.exports = { initBackupJob, reload, runJob, busy, nextRun, loadJobs };
