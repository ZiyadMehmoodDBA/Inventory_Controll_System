const path = require('path');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
// Backup console (Settings > Backups): hidden from an organisation admin who is not a platform admin; for a platform admin it shows health and
// the job list, and lets them add, edit, validate, enable/disable, run now and delete a job and see the run history.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: path.join(ctx.SHOTS, 'e2e-backups-fail.png') }); throw e; } };

const body = async ({ page, check, api, SHOTS, label }) => {
  const orgId = Number(await page.evaluate(() => localStorage.getItem('orgId')));
  const pool = await getPool();
  const poll = async (fn, tries = 40) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await page.waitForTimeout(500); } return false; };
  const fetchApi = (p) => page.evaluate(async (u) => { const t = localStorage.getItem('tunegen_at'); const r = await fetch('/api' + u, { headers: { Authorization: 'Bearer ' + t, 'X-Org-ID': localStorage.getItem('orgId') || '1', 'X-Branch-ID': localStorage.getItem('branchId') || '1' } }); return { status: r.status, body: await r.json().catch(() => null) }; }, p);

  try {
    await page.setViewportSize({ width: 1440, height: 1000 });

    // ── an organisation admin who is not a platform admin ──
    await page.getByRole('button', { name: /^Settings/ }).first().click();
    await page.locator('h1:text-is("Settings")').waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    check('the Backups tab is not offered to an organisation admin', (await page.getByRole('button', { name: /^Backups/ }).count()) === 0);
    const direct = await fetchApi('/backups/overview');
    check('the backup API refuses that admin even when called directly', direct.status === 403 && direct.body && direct.body.code === 'PLATFORM_ONLY', JSON.stringify(direct));

    // ── a platform admin ──
    const brId = (await pool.request().input('o', sql.Int, orgId).query('SELECT MIN(id) AS id FROM branches WHERE organization_id = @o')).recordset[0].id;
    const pid = (await pool.request().input('o', sql.Int, orgId).query("INSERT INTO users (name, email, password_hash, role, organization_id, is_platform_admin) OUTPUT INSERTED.id VALUES ('E2E Platform', 'e2eplat' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR) + '@e2e.test', 'x', 'org_admin', @o, 1)")).recordset[0].id;
    const ptoken = jwt.sign({ userId: pid, orgId, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '30m' });
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.route(u => new URL(u).pathname.startsWith('/api/'), async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/auth/refresh')) return route.fulfill({ json: { accessToken: ptoken, user: { name: 'E2E Platform', email: 'p@e2e.test', role: 'org_admin', organization_id: orgId, branch_id: null,
        organization: { name: 'E2E ORG', code: 'E2E', currency: 'PKR' }, branches: [{ id: brId, name: 'Main', code: 'MAIN' }] } } });
      const headers = { ...route.request().headers(), authorization: `Bearer ${ptoken}`, 'x-branch-id': String(brId), 'x-org-id': String(orgId) };
      delete headers.host;
      for (let i = 0; i < 4; i++) { try { return await route.fulfill({ response: await route.fetch({ url: 'http://localhost:3055' + url.pathname + url.search, headers }) }); } catch (e) { if (i === 3) return route.fulfill({ status: 502, json: { error: 'test proxy: ' + e.message } }).catch(() => {}); await new Promise(x => setTimeout(x, 250)); } }
    });
    await page.reload();
    await page.getByRole('button', { name: /^Settings/ }).first().click({ timeout: 20000 });
    await page.getByRole('button', { name: /^Backups/ }).click({ timeout: 15000 });
    await page.locator('[data-testid="backups-console"]').waitFor({ timeout: 15000 });
    check('a platform admin sees the Backups tab', true);
    await page.locator('[data-testid="jobs-table"] tbody tr').first().waitFor({ timeout: 15000 });
    const names = await page.locator('[data-testid="jobs-table"] tbody tr td:first-child p:first-child').allTextContents();
    check('the default jobs are listed', ['Nightly full backup', 'Transaction log backup', 'Weekly restore drill', 'Weekly point-in-time drill', 'Prune old backup files'].every(n => names.includes(n)), names.join('|'));
    check('the health banner and the schedule descriptions render', (await page.locator('[data-testid="backup-health"]').innerText()).length > 10 && /Daily at 02:00/.test(await page.locator('[data-job="Nightly full backup"]').innerText()) && /Every 30 minutes/.test(await page.locator('[data-job="Transaction log backup"]').innerText()));
    await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-backups-console.png`), fullPage: true });

    // ── add a job ──
    await page.getByRole('button', { name: 'Add job' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add job' });
    await dlg.waitFor({ timeout: 5000 });
    await dlg.getByLabel('Job name').fill('E2E Job');
    await dlg.getByLabel('Job type').selectOption('log');
    await dlg.getByLabel('Schedule type').selectOption('weekly');
    await dlg.getByLabel('Day of week').selectOption('1');
    await dlg.getByLabel('Hour').fill('4');
    await dlg.getByLabel('Minute').fill('20');
    check('the schedule preview reads in plain words', /Mondays at 04:20/.test(await dlg.innerText()) && /20 4 \* \* 1/.test(await dlg.innerText()), (await dlg.innerText()).slice(0, 300));
    await dlg.getByRole('switch', { name: 'Job enabled' }).click();      // disabled: nothing may fire by itself
    await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-backups-addjob.png`) });
    await dlg.getByRole('button', { name: 'Add job' }).click();
    await page.locator('[data-job="E2E Job"]').waitFor({ timeout: 10000 });
    const row = page.locator('[data-job="E2E Job"]');
    check('the new job appears with its schedule, disabled', /Mondays at 04:20/.test(await row.innerText()) && /disabled/.test(await row.innerText()), await row.innerText());
    const dbJob = (await pool.request().query("SELECT id, kind, cron_expr, enabled FROM backup_jobs WHERE name = 'E2E Job'")).recordset[0];
    check('and is stored with the composed cron expression', dbJob && dbJob.kind === 'log' && dbJob.cron_expr === '20 4 * * 1' && dbJob.enabled === false, JSON.stringify(dbJob));

    // ── a bad schedule is refused in the dialog ──
    await row.getByRole('button', { name: 'Edit E2E Job' }).click();
    const ed = page.getByRole('dialog', { name: 'Edit job' });
    await ed.waitFor({ timeout: 5000 });
    check('editing opens with the saved values', (await ed.getByLabel('Job name').inputValue()) === 'E2E Job' && (await ed.getByLabel('Schedule type').inputValue()) === 'weekly' && (await ed.getByLabel('Hour').inputValue()) === '4');
    await ed.getByLabel('Schedule type').selectOption('custom');
    await ed.getByLabel('Cron expression').fill('* * * * *');
    await ed.getByRole('button', { name: 'Save job' }).click();
    await ed.locator('text=too frequent').waitFor({ timeout: 8000 });
    check('a schedule that is too frequent is refused with the reason, and the dialog stays open', await ed.isVisible());
    await ed.getByLabel('Cron expression').fill('0 2 * * mon');
    await ed.getByRole('button', { name: 'Save job' }).click();
    await ed.locator('text=Not a valid schedule').waitFor({ timeout: 8000 });
    check('a schedule with letters is refused', true);

    // ── edit it ──
    await ed.getByLabel('Job name').fill('E2E Job renamed');
    await ed.getByLabel('Cron expression').fill('5 */3 * * *');
    await ed.getByRole('button', { name: 'Save job' }).click();
    await page.locator('[data-job="E2E Job renamed"]').waitFor({ timeout: 10000 });
    check('the edited job shows its new name and custom schedule', /Custom \(5 \*\/3 \* \* \*\)/.test(await page.locator('[data-job="E2E Job renamed"]').innerText()));

    // ── enable it from the row ──
    await page.getByRole('switch', { name: 'Enable E2E Job renamed' }).click();
    check('the row switch enables the job', await poll(async () => (await pool.request().query("SELECT enabled FROM backup_jobs WHERE name = 'E2E Job renamed'")).recordset[0]?.enabled === true));
    await page.getByRole('switch', { name: 'Enable E2E Job renamed' }).click();
    check('and disables it again', await poll(async () => (await pool.request().query("SELECT enabled FROM backup_jobs WHERE name = 'E2E Job renamed'")).recordset[0]?.enabled === false));

    // ── configuration is validated ──
    await page.getByLabel('Backup folder').fill('backups');
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await page.locator('text=full path on the database server').first().waitFor({ timeout: 8000 });
    check('a relative backup folder is refused with an explanation', true);
    await page.getByLabel('Backup folder').fill('');
    await page.getByLabel('Off-host folder').fill("\\\\srv\\share'; DROP DATABASE x;--");
    await page.getByRole('button', { name: 'Save configuration' }).click();
    await page.locator('text=characters that are not allowed').first().waitFor({ timeout: 8000 });
    check('a path carrying SQL is refused', true);
    await page.getByLabel('Off-host folder').fill('');

    // ── run now, then see it in the history ──
    await page.getByRole('button', { name: 'Run E2E Job renamed now' }).click();
    await page.locator('text=E2E Job renamed started').waitFor({ timeout: 8000 });
    const ran = await poll(async () => (await pool.request().query("SELECT COUNT(*) AS n FROM backup_runs r JOIN backup_jobs j ON j.id = r.job_id WHERE j.name = 'E2E Job renamed' AND r.source = 'manual'")).recordset[0].n > 0, 90);
    check('run now records a manual run against the job', ran);
    await page.getByLabel('Filter by type').selectOption('log');
    check('the history can be filtered by type', await poll(async () => (await page.locator('[data-testid="runs-table"] tbody tr').count()) > 0 && !/Nightly full/.test(await page.locator('[data-testid="runs-table"]').innerText())));
    await page.getByLabel('Filter by type').selectOption('');

    // ── delete it ──
    await page.getByRole('button', { name: 'Delete E2E Job renamed' }).click();
    await page.locator('text=Its past runs stay in the history').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Delete job' }).last().click();
    await page.locator('[data-job="E2E Job renamed"]').waitFor({ state: 'detached', timeout: 10000 });
    check('a job can be deleted after confirming', (await pool.request().query("SELECT COUNT(*) AS n FROM backup_jobs WHERE name LIKE 'E2E Job%'")).recordset[0].n === 0);
    await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-backups-final.png`), fullPage: true });
  } finally {
    await pool.request().query("DELETE FROM backup_jobs WHERE name LIKE 'E2E Job%'").catch(() => {});
    await pool.request().query('DELETE FROM backup_runs WHERE job_id IS NOT NULL AND job_id NOT IN (SELECT id FROM backup_jobs)').catch(() => {});
  }
};
