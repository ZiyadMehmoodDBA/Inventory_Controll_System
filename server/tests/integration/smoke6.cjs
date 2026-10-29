process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + x}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG5', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Sup', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR))")).recordset[0].id;
  const tok = role => jwt.sign({ userId: role === 'staff' ? 1002 : 1001, orgId: org, branchId: role === 'staff' ? br : null, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok('org_admin'), staff = tok('staff');
  const call = async (m, p, body, t = admin) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const recv = (id, qty, price) => call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: id, tire_name: 'x', qty, unit_price: price }] });
  try {
    let r = await call('GET', '/inventory/valuation-method');
    check('default method is standard', r.status === 200 && r.body.method === 'standard', JSON.stringify(r.body));
    r = await call('PUT', '/inventory/valuation-method', { method: 'lifo' });
    check('invalid method refused', r.status === 400, JSON.stringify(r.body));
    r = await call('PUT', '/inventory/valuation-method', { method: 'fifo' }, staff);
    check('staff cannot change method', r.status === 403, JSON.stringify(r.body));
    r = await call('PUT', '/inventory/valuation-method', { method: 'fifo' });
    check('admin sets FIFO', r.status === 200 && r.body.method === 'fifo', JSON.stringify(r.body));

    r = await call('POST', '/inventory', { model: 'Widget', cost_price: 5, sale_price: 12, reorder_level: 10 });
    const w = r.body.id;
    await recv(w, 10, 5); await recv(w, 10, 7);
    r = await call('GET', '/inventory/valuation');
    check('FIFO valuation = 10*5 + 10*7 = 120', r.status === 200 && r.body.totals.value === 120 && r.body.totals.units === 20 && r.body.totals.retail_value === 240, JSON.stringify(r.body.totals));
    r = await call('POST', '/sales', { date: day(0), items: [{ tire_id: w, qty: 15, unit_price: 12 }], tax_rate: 0 });
    check('sale of 15 ok', r.status === 201, JSON.stringify(r.body));
    const sale = r.body.id;
    r = await call('GET', '/inventory/valuation');
    check('FIFO value after sale = 5 left @7 = 35', r.body.totals.value === 35 && r.body.items[0].unit_cost === 7, JSON.stringify(r.body.totals));
    r = await call('GET', `/inventory/margin?from=${day(-1)}&to=${day(1)}`);
    check('margin: revenue 180, cogs 85 (50+35), margin 95', r.status === 200 && r.body.totals.revenue === 180 && r.body.totals.cogs === 85 && r.body.totals.margin === 95, JSON.stringify(r.body.totals));
    r = await call('GET', '/inventory/margin?from=bad&to=worse');
    check('bad dates fall back to default window', r.status === 200, JSON.stringify(r.body));
    r = await call('POST', `/sales/${sale}/void`);
    r = await call('GET', '/inventory/valuation');
    check('void restores value at original cost = 120', r.body.totals.value === 120 && r.body.totals.units === 20, JSON.stringify(r.body.totals));

    // average method re-averages on receipt
    await call('PUT', '/inventory/valuation-method', { method: 'average' });
    r = await call('POST', '/inventory', { model: 'Gadget', cost_price: 100, sale_price: 150 });
    const g = r.body.id;
    await recv(g, 10, 100); await recv(g, 10, 200);
    r = await call('GET', `/inventory/${g}`);
    check('average cost price = 150', Number(r.body.cost_price) === 150, JSON.stringify(r.body.cost_price));
    r = await call('GET', '/inventory/valuation');
    const gi = r.body.items.find(i => i.tire_id === g);
    check('average valuation 20 * 150 = 3000', gi && gi.value === 3000 && r.body.method === 'average', JSON.stringify(gi));
    check('category totals present', Array.isArray(r.body.categories) && r.body.categories[0].category === 'Uncategorised', JSON.stringify(r.body.categories));

    // replenishment
    r = await call('POST', '/inventory', { model: 'Scarce', cost_price: 10, sale_price: 20, reorder_level: 10, stock: 3 });
    const sc = r.body.id;
    r = await call('GET', '/inventory/replenishment');
    let row = r.body.items.find(i => i.tire_id === sc);
    check('low item listed with suggestion 20-3=17', r.status === 200 && row && row.status === 'low' && row.suggested_qty === 17 && row.suggested_cost === 170, JSON.stringify(row));
    check('healthy items not listed', !r.body.items.some(i => i.tire_id === w || i.tire_id === g), JSON.stringify(r.body.items.map(i => i.item_name)));
    r = await call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'pending', items: [{ tire_id: sc, tire_name: 'Scarce', qty: 20, unit_price: 10 }] });
    r = await call('GET', '/inventory/replenishment');
    check('pending PO covers it (on order 20, not listed)', !r.body.items.some(i => i.tire_id === sc), JSON.stringify(r.body.items.map(i => i.item_name)));

    r = await call('GET', '/inventory/reconciliation');
    check('reconciliation still clean', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [
      'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
      'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
      'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
      'DELETE FROM sales WHERE organization_id=@o', 'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
      'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 40), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
