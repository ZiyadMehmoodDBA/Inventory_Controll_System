// Database backup and recovery CLI (logic in utils/dbBackup.js).
//   node scripts/backup.js backup [--log]   verified full backup (+ off-host copy if OFFSITE_BACKUP_DIR is set); --log adds a log backup
//   node scripts/backup.js log              verified transaction-log backup
//   node scripts/backup.js drill [--keep]   restore the newest full backup into a scratch database, check it against live, drop it
//   node scripts/backup.js pitr             point-in-time recovery proof (synthetic exact test + production full+log chain)
//   node scripts/backup.js prune [days]     delete .bak/.trn older than `days` (default BACKUP_RETENTION_DAYS or 14)
//   node scripts/backup.js status           last success of each kind
//   node scripts/backup.js check            exit 1 and list problems when a backup is stale/failed or no off-host copy is set (for a scheduler or monitor)
// Exit code 1 on any failure, so a scheduler can alert on it. See ACCEPTANCE.md for the schedule.
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const B = require('../utils/dbBackup');

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  let code = 0;
  try {
    if (cmd === 'backup') { const r = await B.backupFull(); console.log(`full backup: ${r.message}\n  ${r.file}`); if (process.argv.includes('--log')) { const l = await B.backupLog(); console.log(`log backup: ${l.message} ${l.file ?? ''}`); } }
    else if (cmd === 'log') { const r = await B.backupLog(); console.log(`log backup: ${r.message} ${r.file ?? ''}`); }
    else if (cmd === 'drill') { const r = await B.restoreDrill({ keep: process.argv.includes('--keep') }); r.lines.forEach(l => console.log('  ' + l)); console.log(r.ok ? 'restore drill passed' : `RESTORE DRILL FAILED: ${r.error}`); code = r.ok ? 0 : 1; }
    else if (cmd === 'pitr') { const r = await B.pitrDrill(); r.lines.forEach(l => console.log('  ' + l)); console.log(r.ok ? 'point-in-time recovery drill passed' : `PITR DRILL FAILED: ${r.error}`); code = r.ok ? 0 : 1; }
    else if (cmd === 'prune') console.log(await B.prune(arg));
    else if (cmd === 'status') console.table((await B.status()).map(r => ({ kind: r.kind, last_ok: r.last_ok, last_run: r.last_run, latest_run_ok: !!r.latest_ok })));
    else if (cmd === 'check') { const p = await B.health(); console.log(p.length ? 'UNHEALTHY:\n  ' + p.join('\n  ') : 'backups healthy'); code = p.length ? 1 : 0; }
    else { console.log('usage: node scripts/backup.js backup [--log] | log | drill [--keep] | pitr | prune [days] | status | check'); code = 2; }
  } catch (e) { console.error('FAILED:', e.message); code = 1; }
  process.exit(code);
})();
