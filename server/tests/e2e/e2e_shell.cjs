const path = require('path');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
// App shell: the header's "Go to" quick-jump (filter, keyboard, Escape), Escape closing the sales status menu, and the multi-branch switcher
// (every screen reloads for the chosen branch, and the API call carries that branch's id).
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: path.join(ctx.SHOTS, 'e2e-shell-fail.png') }); throw e; } };

const body = async ({ page, check, SHOTS, label }) => {
  const orgId = Number(await page.evaluate(() => localStorage.getItem('orgId')));
  const pool = await getPool();
  const br1 = (await pool.request().input('o', sql.Int, orgId).query('SELECT MIN(id) AS id FROM branches WHERE organization_id = @o')).recordset[0].id;
  const br2 = (await pool.request().input('o', sql.Int, orgId).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Second', 'SEC')")).recordset[0].id;
  const uid = (await pool.request().input('o', sql.Int, orgId).query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES ('E2E Shell', 'e2eshell' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR) + '@e2e.test', 'x', 'org_admin', @o)")).recordset[0].id;
  const token = jwt.sign({ userId: uid, orgId, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '30m' });
  const api = async (m, p, body, br = br1) => {
    const r = await fetch('http://localhost:3055/api' + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const item = (await api('POST', '/inventory', { model: 'Only Main Item', cost_price: 5, sale_price: 10, stock: 9 })).body.id;
  await api('POST', '/sales', { date: new Date().toISOString().slice(0, 10), items: [{ tire_id: item, qty: 1, unit_price: 10 }], status: 'pending' });

  const seenBranches = new Set();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(u => new URL(u).pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/refresh')) return route.fulfill({ json: { accessToken: token, user: { name: 'E2E Shell', email: 's@e2e.test', role: 'org_admin', organization_id: orgId, branch_id: null,
      organization: { name: 'E2E ORG', code: 'E2E', currency: 'PKR' }, branches: [{ id: br1, name: 'Main', code: 'MAIN' }, { id: br2, name: 'Second', code: 'SEC' }] } } });
    const sent = route.request().headers()['x-branch-id'];
    const own = [String(br1), String(br2)].includes(sent) ? sent : String(br1);   // the harness stores no branch until the switcher is used
    if (own && url.pathname.startsWith('/api/inventory')) seenBranches.add(own);
    const headers = { ...route.request().headers(), authorization: `Bearer ${token}`, 'x-branch-id': own || String(br1), 'x-org-id': String(orgId) };
    delete headers.host;
    for (let i = 0; i < 4; i++) { try { const resp = await route.fetch({ url: 'http://localhost:3055' + url.pathname + url.search, headers }); return await route.fulfill({ response: resp }); } catch (e) { if (i === 3) return route.fulfill({ status: 502, json: { error: 'test proxy' } }); } }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(id => localStorage.setItem('branchId', String(id)), br1);   // what a real sign-in stores
  await page.reload();
  const search = page.locator('input[aria-label="Go to screen"]');
  await search.waitFor({ timeout: 20000 });
  const heading = () => page.locator('header h2').first().innerText();

  // ── quick jump ──
  check('the header search is a working control, not a decoration (it has a listbox role)', (await search.getAttribute('role')) === 'combobox');
  await search.fill('cust');
  const opts = page.locator('#header-search-list [role="option"]');
  await opts.first().waitFor({ timeout: 5000 });
  check('typing filters the screens the user can open', (await opts.count()) === 1 && /Customers/.test(await opts.first().innerText()), await opts.allInnerTexts());
  await search.press('Enter');
  await page.waitForFunction(() => /Customers/i.test(document.querySelector('header h2')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('Enter opens the highlighted screen', /Customers/i.test(await heading()), await heading());
  check('the search box clears after jumping', (await search.inputValue()) === '');
  await search.fill('inv');
  await page.waitForTimeout(150);
  check('"inv" offers Inventory and Invoices', (await opts.allInnerTexts()).some(t => /Inventory/.test(t)) && (await opts.allInnerTexts()).some(t => /Invoices/.test(t)));
  await search.press('ArrowDown');
  await search.press('Enter');
  await page.waitForFunction(() => /Invoices/i.test(document.querySelector('header h2')?.textContent || ''), null, { timeout: 8000 }).catch(() => {});
  check('ArrowDown then Enter opens the second match (Inventory follows Invoices in the menu order)', /Inventory/i.test(await heading()), await heading());
  await search.fill('zzzz');
  check('no match says so', await page.getByText('No matching screen').isVisible());
  await search.press('Escape');
  check('Escape closes the list and clears the box', !(await page.getByText('No matching screen').isVisible().catch(() => false)) && (await search.inputValue()) === '');
  await search.fill('sales');
  await search.press('Enter');

  // ── Escape closes the sales status menu ──
  const trigger = page.locator('button[title="Click to change payment status"]').first();
  await trigger.waitFor({ timeout: 15000 });
  await trigger.click();
  const menu = page.getByText('Change Status', { exact: true });
  check('the sales status menu opens', await menu.isVisible());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Escape closes the sales status menu', !(await menu.isVisible().catch(() => false)));
  await trigger.click();
  await page.mouse.click(5, 400);
  await page.waitForTimeout(200);
  check('clicking elsewhere still closes it', !(await menu.isVisible().catch(() => false)));

  // ── branch switcher ──
  const sw = page.locator('select[aria-label="Branch"]');
  check('an administrator with two branches sees the branch switcher', await sw.isVisible());
  await search.fill('inventory');
  await search.press('Enter');
  await page.getByText('Only Main Item').first().waitFor({ timeout: 15000 });
  check('branch 1 shows its own item', true);
  seenBranches.clear();
  await sw.selectOption(String(br2));
  await page.waitForTimeout(1500);
  check('switching to the second branch hides the first branch\'s item', (await page.getByText('Only Main Item').count()) === 0);
  check('the inventory request carried the second branch id', seenBranches.has(String(br2)) && !seenBranches.has(String(br1)), [...seenBranches]);
  check('the choice is remembered', (await page.evaluate(() => localStorage.getItem('branchId'))) === String(br2));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-branch2.png`) });
  await sw.selectOption(String(br1));
  await page.getByText('Only Main Item').first().waitFor({ timeout: 15000 });
  check('switching back shows the item again', true);
};
