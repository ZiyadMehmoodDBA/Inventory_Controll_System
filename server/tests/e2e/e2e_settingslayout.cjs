const path = require('path');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
// Settings page layout: the tab row never scrolls sideways, the page does not either, the heading sits close to the tabs, and the tabs fit on one
// line on a desktop and wrap (not scroll) on a phone. Uses a platform administrator so the longest set of tabs is shown.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: path.join(ctx.SHOTS, 'e2e-settingslayout-fail.png') }); throw e; } };

const body = async ({ page, check, SHOTS, label }) => {
  const orgId = Number(await page.evaluate(() => localStorage.getItem('orgId')));
  const pool = await getPool();
  const brId = (await pool.request().input('o', sql.Int, orgId).query('SELECT MIN(id) AS id FROM branches WHERE organization_id = @o')).recordset[0].id;
  const pid = (await pool.request().input('o', sql.Int, orgId).query("INSERT INTO users (name, email, password_hash, role, organization_id, is_platform_admin) OUTPUT INSERTED.id VALUES ('E2E Layout', 'e2elay' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR) + '@e2e.test', 'x', 'org_admin', @o, 1)")).recordset[0].id;
  const token = jwt.sign({ userId: pid, orgId, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '30m' });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(u => new URL(u).pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/refresh')) return route.fulfill({ json: { accessToken: token, user: { name: 'E2E Layout', email: 'l@e2e.test', role: 'org_admin', organization_id: orgId, branch_id: null,
      organization: { name: 'E2E ORG', code: 'E2E', currency: 'PKR' }, branches: [{ id: brId, name: 'Main', code: 'MAIN' }] } } });
    const headers = { ...route.request().headers(), authorization: `Bearer ${token}`, 'x-branch-id': String(brId), 'x-org-id': String(orgId) };
    delete headers.host;
    for (let i = 0; i < 4; i++) { try { return await route.fulfill({ response: await route.fetch({ url: 'http://localhost:3055' + url.pathname + url.search, headers }) }); } catch (e) { if (i === 3) return route.fulfill({ status: 502, json: { error: 'test proxy: ' + e.message } }).catch(() => {}); await new Promise(x => setTimeout(x, 250)); } }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: /^Settings/ }).first().click({ timeout: 20000 });
  await page.locator('[data-testid="settings-tabs"]').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);

  const measure = () => page.evaluate(() => {
    const bar = document.querySelector('[data-testid="settings-tabs"]');
    const tabs = [...bar.querySelectorAll('button')];
    const tops = new Set(tabs.map(b => Math.round(b.getBoundingClientRect().top)));
    const cs = getComputedStyle(bar);
    const sub = [...document.querySelectorAll('h1')].find(h => h.textContent === 'Settings').parentElement.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const main = document.querySelector('main');
    return {
      count: tabs.length, rows: tops.size, barOverflow: bar.scrollWidth - bar.clientWidth, overflowX: cs.overflowX,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth, mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
      gap: Math.round(r.top - sub.bottom), headTop: Math.round(sub.top - (main ? main.getBoundingClientRect().top : 0)),
      cut: tabs.filter(b => b.scrollWidth > b.clientWidth + 1).length, barWidth: Math.round(r.width),
    };
  });

  const out = {};
  for (const w of [1920, 1440, 1280, 1024, 768, 400]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(350);
    out[w] = await measure();
    if (w === 1440 || w === 400) await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-settings-${w}.png`) });
  }
  const j = w => JSON.stringify(out[w]);
  check('the platform admin of a general store sees nine tabs (Lookup Tables is tyre-only)', out[1440].count === 9, j(1440));
  for (const w of Object.keys(out)) {
    check(`${w}px: the tab row has no horizontal scroll`, out[w].barOverflow <= 0 && !/auto|scroll/.test(out[w].overflowX), j(w));
    check(`${w}px: the page has no horizontal scroll`, out[w].pageOverflow <= 0 && out[w].mainOverflow <= 0, j(w));
    check(`${w}px: no tab label is cut off`, out[w].cut === 0, j(w));
  }
  check('desktop (1440px): all tabs in a single row', out[1440].rows === 1, j(1440));
  check('wide desktop (1920px): all tabs in a single row', out[1920].rows === 1, j(1920));
  check('phone (400px): the tabs wrap onto several rows instead of scrolling', out[400].rows >= 2, j(400));
  check('the tabs sit close under the heading (gap of 16px or less)', Object.values(out).every(m => m.gap >= 0 && m.gap <= 16), JSON.stringify(Object.values(out).map(m => m.gap)));
  check('the heading starts close to the top of the page', Object.values(out).every(m => m.headTop <= 16), JSON.stringify(Object.values(out).map(m => m.headTop)));

  // the longest case: a tyre shop adds Lookup Tables (ten tabs)
  await pool.request().input('o', sql.Int, orgId).query("MERGE settings AS t USING (SELECT @o AS organization_id, 'business_type' AS [key]) AS s ON t.organization_id = s.organization_id AND t.[key] = s.[key] WHEN MATCHED THEN UPDATE SET value = 'tyre_shop' WHEN NOT MATCHED THEN INSERT (organization_id, [key], value) VALUES (@o, 'business_type', 'tyre_shop');");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.getByRole('button', { name: /^Settings/ }).first().click({ timeout: 20000 });
  await page.locator('[data-testid="settings-tabs"]').waitFor({ timeout: 15000 });
  await page.waitForTimeout(600);
  const tyre = {};
  for (const w of [1920, 1440, 1280, 1024]) { await page.setViewportSize({ width: w, height: 900 }); await page.waitForTimeout(350); tyre[w] = await measure(); }
  await page.screenshot({ path: path.join(SHOTS, 'e2e-' + label + '-settings-tyre.png') });
  check('a tyre shop shows ten tabs', tyre[1920].count === 10, JSON.stringify(tyre[1920]));
  check('ten tabs: no horizontal scroll at any width, none cut off', Object.values(tyre).every(m => m.barOverflow <= 0 && m.pageOverflow <= 0 && m.cut === 0), JSON.stringify(tyre));
  check('ten tabs fit on one row at 1440px and wider', tyre[1920].rows === 1 && tyre[1440].rows === 1, JSON.stringify([tyre[1920].rows, tyre[1440].rows]));
  check('ten tabs wrap to at most two rows even at 1024px', tyre[1024].rows <= 2, JSON.stringify(tyre[1024]));

  // every tab still opens its panel
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  for (const name of ['Invoice & PO Defaults', 'Users', 'Roles & permissions', 'System', 'Backups', 'Company Profile']) {
    await page.locator('[data-testid="settings-tabs"]').getByRole('button', { name: new RegExp('^' + name.replace(/[&]/g, '\\&')) }).click();
    await page.waitForTimeout(250);
    const active = await page.locator('[data-testid="settings-tabs"] button.bg-white').innerText();
    if (!active.includes(name.split(' ')[0])) check(`tab "${name}" opens`, false, active);
  }
  check('all the tabs still open and show as active', true);
  await pool.request().input('i', sql.Int, pid).query('DELETE FROM users WHERE id = @i').catch(() => {});
};
