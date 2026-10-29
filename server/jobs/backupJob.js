/**
 * Automated database protection. Enabled with BACKUP_JOB=on in server/.env (off by default so a developer machine does not back up by accident).
 *   02:00 daily    verified full backup (+ off-host copy when OFFSITE_BACKUP_DIR is set)
 *   every 30 min   verified transaction-log backup (recovery point objective: 30 minutes)
 *   Sun 03:30      restore drill into a scratch database
 *   Sun 04:00      point-in-time recovery drill
 *   05:00 daily    delete backups older than BACKUP_RETENTION_DAYS (default 14)
 * Each run is written to backup_runs; a failure is logged loudly and the next scheduled run retries. Wire monitoring to
 * `node scripts/backup.js status` (or the backup_runs table): alert when the last full is older than 26 h or the last log older than 90 min.
 */
const cron = require('node-cron');
const B = require('../utils/dbBackup');

let busy = false;                       // one job at a time: a log backup must not overlap a full backup or a drill
const run = (name, fn) => async () => {
  if (busy) { console.warn(`[Backup] skipped ${name}: another backup job is still running`); return; }
  busy = true;
  try { const r = await fn(); console.log(`[Backup] ${name} ok${r && r.message ? ': ' + r.message : ''}`); }
  catch (e) { console.error(`[Backup] ${name} FAILED: ${e.message}`); }
  finally { busy = false; }
};

function initBackupJob() {
  if (String(process.env.BACKUP_JOB || '').toLowerCase() !== 'on') { console.log('[Backup] scheduled backups are OFF (set BACKUP_JOB=on in server/.env)'); return; }
  cron.schedule('0 2 * * *',    run('full backup', B.backupFull));
  cron.schedule('*/30 * * * *', run('log backup', B.backupLog));
  cron.schedule('30 3 * * 0',   run('restore drill', async () => { const r = await B.restoreDrill(); if (!r.ok) throw new Error(r.error); return { message: 'passed' }; }));
  cron.schedule('0 4 * * 0',    run('point-in-time drill', async () => { const r = await B.pitrDrill(); if (!r.ok) throw new Error(r.error); return { message: 'passed' }; }));
  cron.schedule('0 5 * * *',    run('prune', async () => ({ message: await B.prune() })));
  console.log('[Backup] scheduled: full 02:00, log every 30 min, drills Sunday, prune 05:00');
}

module.exports = { initBackupJob };
