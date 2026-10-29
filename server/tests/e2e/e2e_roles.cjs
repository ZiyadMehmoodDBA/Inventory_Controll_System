const path = require('path');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
// Roles & permissions: role editor, custom role, assignment on the Users tab, restricted reasons, and a warehouse-staff session that is stripped back.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: path.join(ctx.SHOTS, 'e2e-roles-fail.png') }); throw e; } };
const body = async ({ page, check, api, SHOTS, label }) => {
  const orgId = Number(await page.evaluate(() => localStorage.getItem('orgId')));
  const sup = (await api('POST', '/suppliers', { name: 'E2E Roles Supplier' })).body.id;
  await api('POST', '/inventory', { model: 'E2E Roles Item', cost_price: 7, sale_price: 15, supplier_id: sup, stock: 0 });

  await page.getByRole('button', { name: /^Settings/ }).first().click();
  await page.getByRole('button', { name: /Roles & permissions/ }).click();
  await page.locator('text=Warehouse staff').first().waitFor({ timeout: 10000 });
  let txt = await page.locator('main, body').first().innerText();
  check('built-in roles are listed', /Administrator/.test(txt) && /Manager/.test(txt) && /Warehouse staff/.test(txt) && /Purchasing \/ Finance/.test(txt), txt.slice(0, 300));
  await page.getByRole('button', { name: /^Administrator/ }).click();
  await page.locator('text=always has every permission').waitFor({ timeout: 5000 });
  check('administrator role is shown locked', (await page.getByLabel('See costs').first().isDisabled()) === true);

  // create a custom role
  await page.getByRole('button', { name: /New custom role/ }).click();
  await page.getByLabel('Role name').fill('E2E Floor Lead');
  await page.getByLabel('Base role').selectOption('staff');
  await page.getByLabel('See costs').check();
  await page.getByLabel('Request adjustments').check();
  await page.getByLabel('Approve adjustments').check();
  await page.getByLabel('Approval limit').fill('25');
  await page.getByRole('button', { name: 'Create role' }).click();
  await page.locator('text=Role created.').waitFor({ timeout: 8000 });
  const roles = (await api('GET', '/access/roles')).body;
  const lead = roles.find(r => r.name === 'E2E Floor Lead');
  check('custom role saved with permissions and limit', lead && !lead.is_builtin && lead.permissions.includes('inventory.view_cost') && lead.permissions.includes('stock.approve') && lead.approval_limit === 25, JSON.stringify(lead));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-roles-editor.png`) });

  // edit it, then the role list shows the change
  await page.getByLabel('Approve adjustments').uncheck();
  await page.getByRole('button', { name: 'Save role' }).click();
  await page.locator('text=applies to its users immediately').waitFor({ timeout: 8000 });
  const lead2 = (await api('GET', '/access/roles')).body.find(r => r.id === lead.id);
  check('permission removal saved', !lead2.permissions.includes('stock.approve') && lead2.permissions.includes('inventory.view_cost'));
  await page.getByRole('button', { name: /role comparison/ }).click();
  await page.locator('th:has-text("E2E Floor Lead")').waitFor({ timeout: 5000 });
  check('comparison matrix lists the new role', true);

  // restore a built-in role to defaults after changing it
  await page.getByRole('button', { name: /^Warehouse staff/ }).click();
  await page.getByLabel('Request adjustments').uncheck();
  await page.getByRole('button', { name: 'Save role' }).click();
  await page.locator('text=applies to its users immediately').waitFor({ timeout: 8000 });
  let st = (await api('GET', '/access/roles')).body.find(r => r.base_role === 'staff' && r.is_builtin);
  check('built-in role edited', !st.permissions.includes('stock.adjust_request'));
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Restore defaults' }).click();
  await page.locator('text=Restored to defaults.').waitFor({ timeout: 8000 });
  st = (await api('GET', '/access/roles')).body.find(r => r.base_role === 'staff' && r.is_builtin);
  check('restore defaults puts the permission back', st.permissions.includes('stock.adjust_request'));

  // restricted reasons
  await page.getByLabel('Restrict Damaged / broken goods').check();
  await page.getByRole('button', { name: 'Save restricted reasons' }).click();
  await page.locator('text=Restricted reasons saved.').waitFor({ timeout: 8000 });
  check('restricted reasons saved', (await api('GET', '/access/policy')).body.restricted_reasons.includes('damage'));
  await api('PUT', '/access/policy', { restricted_reasons: ['loss_theft', 'missing_stock', 'obsolete_writeoff'] });

  // assign on the Users tab
  await page.getByRole('button', { name: /^Users/ }).click();
  await page.getByRole('button', { name: /Add User/ }).click();
  await page.getByPlaceholder('Muhammad Ahmed').fill('E2E Lead User');
  await page.getByPlaceholder('ahmed@company.pk').fill(`lead${Date.now()}@e2e.test`);
  await page.getByPlaceholder('Min 8 characters').fill('password123');
  const sel = page.locator('label:has-text("Role") + select, label:has-text("Role") ~ select').first();
  check('role list offers custom roles', (await sel.locator('option').allInnerTexts()).some(t => /E2E Floor Lead \(custom\)/.test(t)));
  await sel.selectOption({ label: 'E2E Floor Lead (custom)' });
  await page.getByRole('button', { name: 'Create User' }).click();
  await page.locator('td:has-text("E2E Lead User")').waitFor({ timeout: 8000 });
  const users = (await api('GET', '/users')).body;
  check('user created with the custom role', users.find(u => u.name === 'E2E Lead User')?.access_role_id === lead.id, JSON.stringify(users.map(u => [u.name, u.access_role_id])));
  check('users table shows the role name', /E2E Floor Lead/.test(await page.locator('tr:has-text("E2E Lead User")').innerText()));

  // a warehouse-staff session: same page, stripped back
  const staffId = (await (await getPool()).request().input('o', sql.Int, orgId).query("INSERT INTO users (name, email, password_hash, role, organization_id, branch_id) OUTPUT INSERTED.id SELECT 'E2E Staff', 'e2estaff' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR) + '@e2e.test', 'x', 'staff', @o, MIN(id) FROM branches WHERE organization_id = @o")).recordset[0].id;
  const brId = (await (await getPool()).request().input('o', sql.Int, orgId).query('SELECT MIN(id) AS id FROM branches WHERE organization_id = @o')).recordset[0].id;
  const stoken = jwt.sign({ userId: staffId, orgId, branchId: brId, role: 'staff' }, process.env.JWT_SECRET, { expiresIn: '30m' });
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route(u => new URL(u).pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/refresh')) return route.fulfill({ json: { accessToken: stoken, user: { name: 'E2E Staff', email: 's@e2e.test', role: 'staff', organization_id: orgId, branch_id: brId,
      organization: { name: 'E2E ORG', code: 'E2E', currency: 'PKR' }, branches: [{ id: brId, name: 'Main', code: 'MAIN' }] } } });
    const headers = { ...route.request().headers(), authorization: `Bearer ${stoken}`, 'x-branch-id': String(brId), 'x-org-id': String(orgId) };
    delete headers.host;
    for (let i = 0; i < 4; i++) { try { return await route.fulfill({ response: await route.fetch({ url: 'http://localhost:3055' + url.pathname + url.search, headers }) }); } catch (e) { if (i === 3) return route.fulfill({ status: 502, json: { error: 'test proxy: ' + e.message } }).catch(() => {}); await new Promise(x => setTimeout(x, 250)); } }
  });
  await page.reload();
  await page.getByRole('button', { name: /^Inventory/ }).first().click({ timeout: 20000 });
  await page.waitForSelector('text=E2E Roles Item', { timeout: 15000 });
  await page.waitForTimeout(800);
  const body = await page.locator('body').innerText();
  check('staff session shows the item', /E2E Roles Item/.test(body));
  check('staff sees no cost or margin (server blanks it)', !/7\.00/.test(body) && (await page.locator('td:text-is("—")').count()) >= 2, body.slice(0, 200));
  check('staff has no Settings page', (await page.getByRole('button', { name: /^Settings/ }).count()) === 0);
  check('no replenishment button for staff', (await page.locator('button[title^="Replenishment"]').count()) === 0);
  check('no approvals button for staff', (await page.locator('button[title^="Stock adjustment approvals"]').count()) === 0);
  check('no add-item button for staff', (await page.locator('button[title^="Add new"]').count()) === 0);
  check('no valuation reports button for staff', (await page.locator('button[title^="Stock value"]').count()) === 0);
  check('no edit or delete on rows for staff', (await page.locator('button[title="Edit"]').count()) === 0 && (await page.locator('button[title="Delete"]').count()) === 0);
  check('staff keeps the adjust action and the dashboard', (await page.locator('button[title="Adjust stock"]').count()) > 0 && (await page.locator('button[title^="Exceptions that need a decision"]').count()) === 1);
  await page.locator('button[title^="Exceptions that need a decision"]').click();
  await page.locator('h3:text-is("Inventory Dashboard & Reports")').waitFor({ timeout: 10000 });
  await page.locator('text=Key figures').waitFor({ timeout: 10000 });
  check('dashboard values show as unavailable for staff', (await page.locator('p:text-is("Inventory value") + p').first().innerText()).trim() === '—');
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-roles-staff.png`) });
  await page.locator('div.fixed:has(h3:text-is("Inventory Dashboard & Reports")) button[aria-label="Close"]').click();
  await page.locator('button:has(p:text-is("Warehouse staff"))').first().click();
  await page.waitForTimeout(300);
  const hdr = await page.locator('body').innerText();
  check('header names the role', /Warehouse Staff|Warehouse staff/i.test(hdr));
};
