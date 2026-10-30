// Backup console API: only platform administrators get in, nothing a tenant admin sends can promote them or reach the backup settings,
// configuration is validated (paths especially), jobs can be added / changed / disabled / run / removed, every change is audited.
// The suite touches the shared backup_jobs table and the backup configuration: it removes what it creates and restores the configuration.
process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const Cfg = require('../../utils/backupConfig');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 400)}`); };

(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG21', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'general_store')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const mkUser = async (name, role, platform) => (await pool.request().input('o', sql.Int, org).input('n', sql.NVarChar(100), name).input('e', sql.NVarChar(100), `${name}${Date.now()}@smoke21.test`).input('r', sql.NVarChar(30), role).input('p', sql.Bit, platform)
    .query("INSERT INTO users (name, email, password_hash, role, organization_id, is_platform_admin) OUTPUT INSERTED.id VALUES (@n, @e, 'x', @r, @o, @p)")).recordset[0].id;
  const platformId = await mkUser('platform21', 'org_admin', 1), tenantId = await mkUser('tenant21', 'org_admin', 0), staffId = await mkUser('staff21', 'staff', 0);
  const tok = (id, role) => jwt.sign({ userId: id, orgId: org, branchId: role === 'org_admin' ? null : br, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const T = { platform: tok(platformId, 'org_admin'), tenant: tok(tenantId, 'org_admin'), staff: tok(staffId, 'staff') };
  const call = async (m, p, body, t = T.platform) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}), 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const bad = (r, code = 'VALIDATION_FAILED') => r.status === 400 && r.body.code === code;
  const created = [];
  let original = null;
  try {
    // ── access ──
    check('anonymous caller is refused', (await call('GET', '/backups/overview', null, null)).status === 401);
    let r = await call('GET', '/backups/overview', null, T.staff);
    check('staff cannot open the console', r.status === 403 && r.body.code === 'PLATFORM_ONLY', JSON.stringify(r));
    r = await call('GET', '/backups/overview', null, T.tenant);
    check("an organisation administrator who is not a platform administrator cannot open it", r.status === 403 && r.body.code === 'PLATFORM_ONLY', JSON.stringify(r));
    for (const [m, p, b] of [['PUT', '/backups/config', { retention_days: 3 }], ['POST', '/backups/jobs', { name: 'x', kind: 'log', cron_expr: '0 * * * *' }], ['POST', '/backups/jobs/1/run', null], ['DELETE', '/backups/jobs/1', null]]) {
      const x = await call(m, p, b, T.tenant);
      check(`tenant admin cannot ${m} ${p}`, x.status === 403 && x.body.code === 'PLATFORM_ONLY', JSON.stringify(x));
    }
    check('/access/me tells a platform admin so', (await call('GET', '/access/me')).body.platform_admin === true);
    check('/access/me tells a tenant admin they are not', (await call('GET', '/access/me', null, T.tenant)).body.platform_admin === false);
    r = await call('PUT', `/users/${tenantId}`, { name: 'tenant21', role: 'org_admin', is_platform_admin: true }, T.tenant);
    const flag = (await pool.request().input('i', sql.Int, tenantId).query('SELECT is_platform_admin AS f FROM users WHERE id = @i')).recordset[0].f;
    check('a tenant admin cannot promote themselves through the users API', flag === false, `status ${r.status} flag ${flag}`);

    // a platform admin's account cannot be taken over by an ordinary admin of the same organisation
    const plat2 = await mkUser('platformtwo21', 'org_admin', 1);
    const dbFlag = async id => (await pool.request().input('i', sql.Int, id).query('SELECT is_platform_admin AS f, is_active AS a FROM users WHERE id = @i')).recordset[0];
    r = await call('PATCH', '/users/' + plat2 + '/password', { password: 'Hacked-Password-1' }, T.tenant);
    check('a tenant admin cannot reset a platform admin password', r.status === 403 && r.body.code === 'PLATFORM_ONLY', JSON.stringify(r));
    r = await call('PATCH', '/users/' + plat2 + '/status', { is_active: false }, T.tenant);
    check('a tenant admin cannot deactivate a platform admin', r.status === 403 && r.body.code === 'PLATFORM_ONLY' && (await dbFlag(plat2)).a === true, JSON.stringify(r));
    r = await call('PUT', '/users/' + plat2, { name: 'x', role: 'staff' }, T.tenant);
    check('a tenant admin cannot edit or demote a platform admin', r.status === 403 && r.body.code === 'PLATFORM_ONLY' && (await dbFlag(plat2)).f === true, JSON.stringify(r));
    r = await call('PATCH', '/users/' + staffId + '/password', { password: 'Another-Password-1' }, T.tenant);
    check('the same admin can still manage ordinary users', r.status === 200, JSON.stringify(r));
    r = await call('PUT', '/users/' + plat2, { name: 'platformtwo21', role: 'staff' });
    check('a platform admin can demote another platform admin, which ends the platform rights', r.status === 200 && (await dbFlag(plat2)).f === false, JSON.stringify({ r, f: await dbFlag(plat2) }));
    r = await call('PUT', '/users/' + plat2, { name: 'platformtwo21', role: 'org_admin' });
    check('promoting them back to administrator does not bring the platform rights back', r.status === 200 && (await dbFlag(plat2)).f === false, JSON.stringify({ r, f: await dbFlag(plat2) }));

    // ── overview ──
    r = await call('GET', '/backups/overview');
    const ov = r.body;
    check('overview answers with jobs, health, config and the database', r.status === 200 && Array.isArray(ov.jobs) && ov.jobs.length >= 5 && ov.health && Array.isArray(ov.health.problems) && ov.config && ov.config.retention_days && ov.database && ov.database.recovery_model, JSON.stringify(r).slice(0, 300));
    check('the five default jobs exist', ['full', 'log', 'drill', 'pitr', 'prune'].every(k => ov.jobs.some(j => j.kind === k)), ov.jobs.map(j => j.kind).join());
    check('an enabled job shows its next run when scheduling is on, none when off', ov.jobs.filter(j => j.enabled).every(j => (ov.enabled ? !!j.next_run : j.next_run === null)), JSON.stringify(ov.jobs[0]));
    original = { enabled: ov.enabled, backup_dir: ov.config.backup_dir.source === 'console' ? ov.config.backup_dir.value : '', offsite_dir: ov.config.offsite_dir.source === 'console' ? ov.config.offsite_dir.value : '', retention_days: ov.config.retention_days.value };

    // ── configuration ──
    for (const [label, body] of [
      ['a relative path', { backup_dir: 'backups' }], ['a path with ..', { backup_dir: 'D:\\Backups\\..\\Windows' }], ['a wildcard', { backup_dir: 'D:\\Back*ups' }],
      ['a quote (SQL injection attempt)', { offsite_dir: "\\\\srv\\share'; DROP DATABASE x;--" }], ['a pipe', { offsite_dir: '\\\\srv\\share|calc' }], ['a bare UNC server', { offsite_dir: '\\\\srv' }],
      ['a path that is far too long', { backup_dir: 'D:\\' + 'a'.repeat(500) }],
    ]) { r = await call('PUT', '/backups/config', body); check(`config refuses ${label}`, r.status === 400 && /INVALID_PATH|VALIDATION_FAILED/.test(r.body.code), JSON.stringify(r)); }
    r = await call('PUT', '/backups/config', { backup_dir: 'D:\\Same', offsite_dir: 'D:\\same' });
    check('the off-host folder must differ from the backup folder', bad(r, 'INVALID_PATH'), JSON.stringify(r));
    r = await call('PUT', '/backups/config', { retention_days: 0 }); check('retention below 1 day is refused', bad(r), JSON.stringify(r));
    r = await call('PUT', '/backups/config', { retention_days: 99999 }); check('retention above ten years is refused', bad(r), JSON.stringify(r));
    r = await call('PUT', '/backups/config', { retention_days: 'many' }); check('retention that is not a number is refused', bad(r), JSON.stringify(r));
    r = await call('PUT', '/backups/config', { retention_days: 21 });
    const after = (await call('GET', '/backups/overview')).body;
    check('retention is saved and shown as set in the console', r.status === 200 && after.config.retention_days.value === 21 && after.config.retention_days.source === 'console', JSON.stringify(after.config.retention_days));
    const audited = (await pool.request().input('o', sql.Int, org).query("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = @o AND entity = 'backup_config'")).recordset[0].n;
    check('the configuration change is audited', audited >= 1, audited);
    check('the path rules accept real drive and UNC paths', Cfg.checkPath('D:\\SQLBackups\\TuneGEN') === 'D:\\SQLBackups\\TuneGEN' && Cfg.checkPath('\\\\fileserver\\sqlbackups\\tunegen\\') === '\\\\fileserver\\sqlbackups\\tunegen' && Cfg.checkPath('  ') === null);

    // ── jobs: validation ──
    const job = { name: 'Smoke21 job', kind: 'log', cron_expr: '15 * * * *', enabled: false };
    for (const [label, body] of [
      ['an empty name', { ...job, name: '' }], ['an unknown kind', { ...job, kind: 'delete-everything' }], ['six fields', { ...job, cron_expr: '0 0 2 * * *' }],
      ['letters in the schedule', { ...job, cron_expr: '0 2 * * mon' }], ['an out-of-range minute', { ...job, cron_expr: '75 * * * *' }], ['a shell fragment', { ...job, cron_expr: '0 2 * * *; rm -rf /' }],
      ['a log job every 2 minutes', { ...job, cron_expr: '*/2 * * * *' }], ['a full job every minute', { ...job, kind: 'full', cron_expr: '* * * * *' }], ['a missing schedule', { name: 'x', kind: 'log' }],
    ]) { r = await call('POST', '/backups/jobs', body); check(`job refused: ${label}`, r.status === 400 && /VALIDATION_FAILED|INVALID_SCHEDULE/.test(r.body.code), JSON.stringify(r)); }

    // ── jobs: add, change, run, remove ──
    r = await call('POST', '/backups/jobs', job);
    const j1 = r.body; if (j1?.id) created.push(j1.id);
    check('a job can be added (disabled, so nothing runs by itself)', r.status === 201 && j1.name === 'Smoke21 job' && j1.enabled === false && j1.cron_expr === '15 * * * *', JSON.stringify(r));
    let list = (await call('GET', '/backups/overview')).body.jobs;
    check('the new job is listed and, being disabled, has no next run', list.some(j => j.id === j1.id && j.next_run === null));
    r = await call('PUT', `/backups/jobs/${j1.id}`, { ...job, name: 'Smoke21 renamed', cron_expr: '45 */2 * * *', enabled: true });
    check('a job can be edited and enabled', r.status === 200 && r.body.name === 'Smoke21 renamed' && r.body.cron_expr === '45 */2 * * *' && r.body.enabled === true, JSON.stringify(r));
    list = (await call('GET', '/backups/overview')).body;
    const shown = list.jobs.find(j => j.id === j1.id);
    check('an enabled job shows a next run in the future (when scheduling is on)', list.enabled ? !!shown.next_run && new Date(shown.next_run) > new Date() : shown.next_run === null, JSON.stringify(shown));
    r = await call('PUT', '/backups/jobs/999999999', job); check('editing a missing job is a 404', r.status === 404 && r.body.code === 'NOT_FOUND', JSON.stringify(r));
    r = await call('PUT', `/backups/jobs/${j1.id}`, { ...job, cron_expr: 'bad' }); check('an edit with a bad schedule is refused and changes nothing', r.status === 400 && (await call('GET', '/backups/overview')).body.jobs.find(j => j.id === j1.id).cron_expr === '45 */2 * * *');

    await call('PUT', `/backups/jobs/${j1.id}`, { ...job, enabled: false });    // keep it from firing on its own
    const both = await Promise.all([call('POST', `/backups/jobs/${j1.id}/run`), call('POST', `/backups/jobs/${j1.id}/run`)]);
    const codes = both.map(x => x.status).sort().join();
    check('run now starts in the background; a second start while it runs is refused as busy', codes === '202,409' && both.some(x => x.body && x.body.code === 'BUSY'), JSON.stringify(both.map(x => [x.status, x.body && x.body.code])));
    let run = null;
    for (let i = 0; i < 60 && !run; i++) {
      await new Promise(x => setTimeout(x, 1000));
      run = (await pool.request().input('j', sql.Int, j1.id).query('SELECT TOP 1 ok, source, kind, message FROM backup_runs WHERE job_id = @j ORDER BY id DESC')).recordset[0];
    }
    check('the run is recorded against the job as a manual run', !!run && run.source === 'manual' && run.kind === 'log', JSON.stringify(run));
    check('a log backup run succeeded (or the model has no log chain), never an unrecorded failure', !!run && (run.ok === true || /full backup|SIMPLE/.test(String(run.message))), JSON.stringify(run));
    r = await call('GET', '/backups/runs?kind=log&limit=5');
    check('run history is paged and filterable', r.status === 200 && Array.isArray(r.body.rows) && r.body.rows.length <= 5 && r.body.rows.every(x => x.kind === 'log') && r.body.total >= 1, JSON.stringify(r).slice(0, 200));
    r = await call('GET', '/backups/runs?limit=1000'); check('an oversized page is refused', bad(r), JSON.stringify(r));
    r = await call('GET', '/backups/runs?kind=hack'); check('an unknown kind filter is refused', bad(r), JSON.stringify(r));

    r = await call('DELETE', `/backups/jobs/${j1.id}`);
    check('a job can be removed', r.status === 200 && !(await call('GET', '/backups/overview')).body.jobs.some(j => j.id === j1.id), JSON.stringify(r));
    created.pop();
    r = await call('DELETE', `/backups/jobs/${j1.id}`); check('removing it again is a 404', r.status === 404, JSON.stringify(r));
    const jobAudits = (await pool.request().input('o', sql.Int, org).query("SELECT action FROM audit_logs WHERE organization_id = @o AND entity = 'backup_job' ORDER BY id")).recordset.map(x => x.action).join();
    check('create, update and delete of the job are audited', /CREATE/.test(jobAudits) && /UPDATE/.test(jobAudits) && /DELETE/.test(jobAudits), jobAudits);
    check('the default jobs were not touched by the suite', (await call('GET', '/backups/overview')).body.jobs.filter(j => ['full', 'log', 'drill', 'pitr', 'prune'].includes(j.kind)).length >= 5);
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    try { if (original) await Cfg.save({ enabled: original.enabled, backup_dir: original.backup_dir, offsite_dir: original.offsite_dir, retention_days: original.retention_days }, null); } catch (e) { console.log('config restore warn', e.message); }
    for (const id of created) await pool.request().input('i', sql.Int, id).query('DELETE FROM backup_jobs WHERE id = @i').catch(() => {});
    await pool.request().query("DELETE FROM backup_jobs WHERE name LIKE 'Smoke21%'").catch(() => {});
    await pool.request().query('DELETE FROM backup_runs WHERE job_id IS NOT NULL AND job_id NOT IN (SELECT id FROM backup_jobs)').catch(() => {});
    for (const q of ['DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o', 'DELETE FROM access_roles WHERE organization_id=@o', 'DELETE FROM users WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o']) {
      try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
