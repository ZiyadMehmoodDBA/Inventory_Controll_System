const path = require('path');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
// Navigation sync: the desktop sidebar, the phone bottom bar (tabs + "More") and the screen router all come from one list (src/lib/navigation.ts).
// Checks that every menu entry opens the screen it names, that the phone menu offers exactly what the sidebar does, that a restricted role loses the
// same entries in both, and that signing out leaves nothing of the session behind.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: path.join(ctx.SHOTS, 'e2e-navsync-fail.png') }); throw e; } };

const TITLE = {   // sidebar label -> screen heading
  Dashboard: /^Welcome back/, Reports: /^Reports & Analytics$/, 'AI Reports': /^AI Reports$/, Sales: /^Sales$/, Purchases: /^Purchases$/, Invoices: /^Invoices$/,
  Inventory: /^Inventory$/, Services: /^Services$/, Ledger: /^Financial Ledger$/, Customers: /^Customers$/, Suppliers: /^Suppliers$/,
  Organization: /^Organizations$/, 'Audit Log': /^Audit Log$/, Settings: /^Settings$/,
};
const MOBILE_TAB = { Home: 'Dashboard', Stock: 'Inventory' };   // bottom-bar short labels

const body = async ({ page, check, SHOTS, label }) => {
  const clean = t => t.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  const sidebarLabels = async () => (await page.locator('aside nav button, aside button:has-text("Settings")').allTextContents()).map(clean).filter(t => t && t !== 'Sign out' && t !== 'Sign Out');
  const mobileLabels = async () => {
    const tabs = (await page.locator('nav.fixed.bottom-0 button').allTextContents()).map(clean).filter(t => t && t !== 'More').map(t => MOBILE_TAB[t] || t);
    await page.locator('nav.fixed.bottom-0 button:has-text("More")').click();
    await page.waitForTimeout(400);
    const more = (await page.locator('div.rounded-t-2xl button').allTextContents()).map(clean).filter(t => t && t !== 'More' && t !== 'Sign Out' && t !== 'Sign out');
    await page.locator('div.rounded-t-2xl button:has(svg.lucide-x)').first().click().catch(() => {});
    return [...tabs, ...more];
  };
  const sameSet = (a, b) => [...new Set(a)].sort().join('|') === [...new Set(b)].sort().join('|');

  // ── admin, desktop ──
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator('aside nav button').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const adminSide = await sidebarLabels();
  const expectedAdmin = ['Dashboard', 'Reports', 'AI Reports', 'Sales', 'Purchases', 'Invoices', 'Inventory', 'Services', 'Ledger', 'Customers', 'Suppliers', 'Organization', 'Audit Log', 'Settings'];
  check('admin sidebar lists every screen (no tyre module for this business type)', sameSet(adminSide, expectedAdmin), adminSide.join(','));

  let wrong = [];
  for (const l of expectedAdmin) {
    await page.locator(`aside button:has-text("${l}")`).first().click();
    await page.waitForTimeout(350);
    const h = (await page.locator('header h2').first().innerText()).trim();
    const active = await page.locator(`aside button:has-text("${l}")`).first().evaluate(b => /bg-teal-500/.test(b.className));
    if (!TITLE[l].test(h) || !active) wrong.push(`${l} -> "${h}" active=${active}`);
  }
  check('every sidebar entry opens its own screen and is highlighted', wrong.length === 0, wrong.join('; '));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-nav-desktop.png`) });

  // ── admin, phone ──
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(500);
  const adminMobile = await mobileLabels();
  check('phone menu offers exactly what the sidebar offers (admin)', sameSet(adminMobile, adminSide), `side=${adminSide.join(',')} phone=${adminMobile.join(',')}`);
  await page.locator('nav.fixed.bottom-0 button:has-text("More")').click();
  await page.waitForTimeout(300);
  await page.locator('div.rounded-t-2xl button:has-text("Audit Log")').first().click();
  await page.waitForTimeout(400);
  check('an admin-only screen opens from the phone menu', /^Audit Log$/.test((await page.locator('header h2').first().innerText()).trim()));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-nav-phone.png`) });

  // ── warehouse staff: same restriction in both menus ──
  const orgId = Number(await page.evaluate(() => localStorage.getItem('orgId')));
  const pool = await getPool();
  const brId = (await pool.request().input('o', sql.Int, orgId).query('SELECT MIN(id) AS id FROM branches WHERE organization_id = @o')).recordset[0].id;
  const staffId = (await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, brId).query("INSERT INTO users (name, email, password_hash, role, organization_id, branch_id) OUTPUT INSERTED.id VALUES ('E2E Nav Staff', 'e2enav' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR) + '@e2e.test', 'x', 'staff', @o, @b)")).recordset[0].id;
  const stoken = jwt.sign({ userId: staffId, orgId, branchId: brId, role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '30m' });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(u => new URL(u).pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/refresh')) return route.fulfill({ json: { accessToken: stoken, user: { name: 'E2E Nav Staff', email: 's@e2e.test', role: 'staff', organization_id: orgId, branch_id: brId,
      organization: { name: 'E2E ORG', code: 'E2E', currency: 'PKR' }, branches: [{ id: brId, name: 'Main', code: 'MAIN' }] } } });
    const headers = { ...route.request().headers(), authorization: `Bearer ${stoken}`, 'x-branch-id': String(brId), 'x-org-id': String(orgId) };
    delete headers.host;
    for (let i = 0; i < 4; i++) { try { return await route.fulfill({ response: await route.fetch({ url: 'http://localhost:3055' + url.pathname + url.search, headers }) }); } catch (e) { if (i === 3) return route.fulfill({ status: 502, json: { error: 'test proxy: ' + e.message } }).catch(() => {}); await new Promise(x => setTimeout(x, 250)); } }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.locator('aside nav button').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  const staffSide = await sidebarLabels();
  check('staff sidebar has no admin screens', !staffSide.some(l => ['Settings', 'Organization', 'Audit Log'].includes(l)), staffSide.join(','));
  check('staff sidebar keeps operational screens', ['Dashboard', 'Sales', 'Inventory', 'Customers'].every(l => staffSide.includes(l)), staffSide.join(','));
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(500);
  const staffMobile = await mobileLabels();
  check('phone menu offers exactly what the sidebar offers (staff)', sameSet(staffMobile, staffSide), `side=${staffSide.join(',')} phone=${staffMobile.join(',')}`);

  // ── sign out leaves nothing behind ──
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(400);
  await page.locator('aside button:has-text("Sign out"), aside button:has-text("Sign Out"), aside button:has-text("Logout")').first().click();
  await page.locator('input[type="password"]').first().waitFor({ timeout: 10000 });
  const left = await page.evaluate(() => ({ s: localStorage.getItem('tunegen_settings_v1'), o: localStorage.getItem('orgId'), b: localStorage.getItem('branchId'), t: localStorage.getItem('tunegen_at') }));
  check('sign-out clears cached settings, organisation, branch and token', !left.s && !left.o && !left.b && !left.t, JSON.stringify(left));
};
