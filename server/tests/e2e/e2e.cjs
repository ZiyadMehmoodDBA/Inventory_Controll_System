// Real-browser check of the Inventory page against a throwaway org. Usage: node e2e.cjs <label>
process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const { chromium } = require('playwright');
const path = require('path');
const SHOTS = path.join(__dirname, 'screenshots');
require('fs').mkdirSync(SHOTS, { recursive: true });
const label = process.argv[2] || 'run';
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + x}`); };

(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('E2E ORG', 'E2E' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Sup', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR))")).recordset[0].id;
  const token = jwt.sign({ userId: 1001, orgId: org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '30m' });
  const api = async (m, p, body) => {
    const r = await fetch('http://localhost:3055/api' + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let browser;
  try {
    // data: plain item, tracked batch item with expiry, serial item
    const plain = (await api('POST', '/inventory', { model: 'Widget', cost_price: 5, sale_price: 12, reorder_level: 10, stock: 3 })).body.id;
    const milk = (await api('POST', '/inventory', { model: 'Milk', cost_price: 1, sale_price: 2, tracking: 'batch', track_expiry: true })).body.id;
    const phone = (await api('POST', '/inventory', { model: 'Phone', cost_price: 100, sale_price: 150, tracking: 'serial' })).body.id;
    const po = items => api('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items });
    await po([{ tire_id: milk, tire_name: 'Milk', qty: 10, unit_price: 1, batch_no: 'M-SOON', expiry_date: day(5) }]);
    await po([{ tire_id: milk, tire_name: 'Milk', qty: 10, unit_price: 1, batch_no: 'M-LATE', expiry_date: day(90) }]);
    await po([{ tire_id: phone, tire_name: 'Phone', qty: 3, unit_price: 100, serials: 'IMEI1,IMEI2,IMEI3' }]);
    await api('POST', '/sales', { date: day(0), items: [{ tire_id: plain, qty: 1, unit_price: 12 }], tax_rate: 0 });

    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    // stub auth + forward every API call to the spare server
    await page.route(u => new URL(u).pathname.startsWith('/api/'), async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/auth/refresh')) {
        return route.fulfill({ json: { accessToken: token, user: { name: 'E2E Admin', email: 'e2e@example.test', role: 'org_admin', organization_id: org, branch_id: null,
          organization: { name: 'E2E ORG', code: 'E2E', currency: 'PKR' }, branches: [{ id: br, name: 'Main', code: 'MAIN' }] } } });
      }
      const headers = { ...route.request().headers(), authorization: `Bearer ${token}`, 'x-branch-id': String(br), 'x-org-id': String(org) };
      delete headers.host;
      const r = await route.fetch({ url: 'http://localhost:3055' + url.pathname + url.search, headers });
      return route.fulfill({ response: r });
    });
    await page.addInitScript(() => { try { sessionStorage.setItem('tunegen_rt', 'stub'); localStorage.setItem('branchId', '1'); } catch { /* */ } });
    await page.goto('http://localhost:5199/tunegen/');
    await page.getByRole('button', { name: /^Inventory/ }).first().click({ timeout: 20000 });
    await page.waitForSelector('text=Widget', { timeout: 15000 });
    check('inventory page loads with items', true);
    check('tracked items show a tracking badge', (await page.locator('text=/batch · expiry/').count()) > 0 && (await page.locator('text=serial').count()) > 0);

    await page.locator('button[title="Stock value, reorder suggestions and margin"]').click();
    for (const [tabName, marker] of [['Stock value', 'Stock value (cost)'], ['Reorder', 'Suggested order cost'], ['Margin', 'Cost of goods'], ['Stock value', 'Retail value'], ['Margin', 'Revenue'], ['Reorder', 'Need attention']]) {
      await page.getByRole('button', { name: new RegExp('^' + tabName) }).click();
      let ok = true;
      try { await page.waitForSelector(`text=${marker}`, { timeout: 8000 }); } catch { ok = false; }
      const blank = (await page.locator('body').innerText()).trim().length < 20;
      check(`Reports tab "${tabName}" renders (${marker})`, ok && !blank);
      await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-${tabName.replace(' ', '')}.png`) });
    }
    check('no uncaught page errors', errors.filter(e => e.startsWith('pageerror')).length === 0, errors.slice(0, 3).join(' | '));
    await page.locator('div.fixed button:has(svg.lucide-x)').first().click();
    if (process.argv[3] === 'extra') await require(process.argv[4])({ page, check, api, ids: { plain, milk, phone }, errors, SHOTS, label, day });
  } catch (e) { fail++; console.log('EXC', e.message.split('\n')[0]); }
  finally {
    try { await browser?.close(); } catch { /* */ }
    for (const q of [
      'DELETE FROM access_roles WHERE organization_id=@o', 'DELETE FROM transfer_events WHERE organization_id=@o', 'DELETE FROM location_access WHERE location_id IN (SELECT id FROM stock_locations WHERE organization_id=@o)', 'DELETE FROM warehouses WHERE organization_id=@o', 'DELETE FROM loss_actions WHERE organization_id=@o', 'DELETE FROM supplier_returns WHERE organization_id=@o', 'DELETE FROM quality_disposals WHERE organization_id=@o', 'DELETE FROM valuation_adjustment_layers WHERE adjustment_id IN (SELECT id FROM valuation_adjustments WHERE organization_id=@o)', 'DELETE FROM valuation_adjustments WHERE organization_id=@o', 'DELETE FROM hazard_incidents WHERE organization_id=@o', 'DELETE FROM hazard_inspections WHERE organization_id=@o', 'DELETE FROM hazard_incompatibilities WHERE organization_id=@o', 'DELETE FROM location_hazard_permits WHERE location_id IN (SELECT id FROM stock_locations WHERE organization_id=@o)', 'DELETE FROM hazard_classes WHERE organization_id=@o', 'DELETE FROM batch_quality_events WHERE organization_id=@o', 'DELETE FROM product_recall_batches WHERE recall_id IN (SELECT id FROM product_recalls WHERE organization_id=@o)', 'DELETE FROM product_recalls WHERE organization_id=@o', 'DELETE FROM quality_disposals WHERE organization_id=@o', 'DELETE FROM quality_profiles WHERE organization_id=@o', 'DELETE FROM replenishment_approvals WHERE organization_id=@o', 'DELETE FROM replenishment_requirements WHERE organization_id=@o', 'DELETE FROM valuation_adjustment_layers WHERE adjustment_id IN (SELECT id FROM valuation_adjustments WHERE organization_id=@o)', 'DELETE FROM valuation_adjustments WHERE organization_id=@o', 'DELETE FROM valuation_snapshot_items WHERE snapshot_id IN (SELECT id FROM valuation_snapshots WHERE organization_id=@o)', 'DELETE FROM valuation_snapshots WHERE organization_id=@o', 'DELETE FROM valuation_policy_history WHERE organization_id=@o', 'DELETE FROM stock_count_items WHERE count_id IN (SELECT id FROM stock_counts WHERE organization_id=@o)', 'DELETE FROM stock_counts WHERE organization_id=@o', 'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE organization_id=@o)', 'DELETE FROM stock_transfers WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o', 'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
      'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
      'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
      'DELETE FROM sales WHERE organization_id=@o', 'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
      'DELETE FROM users WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 40), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
