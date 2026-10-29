process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + x}`); };
(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const tok = (userId, role, b = null) => jwt.sign({ userId, orgId: org, branchId: b, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok(1001, 'org_admin'), staff = tok(1002, 'staff', br);
  const call = async (m, p, t, body, h = {}) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(br), ...h }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  try {
    let r = await call('GET', '/inventory/locations', admin);
    check('new branch gets a default location lazily', r.status === 200 && r.body.length === 1 && r.body[0].is_default && r.body[0].name === 'Main Store', JSON.stringify(r.body));
    const main = r.body[0].id;

    r = await call('POST', '/inventory/locations', admin, { name: 'Back Warehouse', code: 'wh-2' });
    check('create location (code normalised)', r.status === 201 && r.body.code === 'WH-2', JSON.stringify(r.body));
    const wh = r.body.id;
    r = await call('POST', '/inventory/locations', admin, { name: 'Dup', code: 'WH-2' });
    check('duplicate code 409', r.status === 409, JSON.stringify(r.body));
    r = await call('POST', '/inventory/locations', staff, { name: 'Nope' });
    check('staff cannot create locations', r.status === 403, JSON.stringify(r.body));

    r = await call('POST', '/inventory', admin, { model: 'Widget', stock: 10, cost_price: 5, sale_price: 9 });
    const id = r.body.id;
    r = await call('GET', `/inventory/stock-by-location?tire_id=${id}`, admin);
    check('opening stock sits in default location', r.status === 200 && r.body.length === 1 && r.body[0].location_id === main && r.body[0].qty === 10, JSON.stringify(r.body));

    // transfer
    r = await call('POST', '/inventory/transfers', staff, { from_location_id: main, to_location_id: wh, notes: 'restock', items: [{ tire_id: id, qty: 4 }] });
    check('transfer succeeds (staff allowed)', r.status === 201 && /^TRF-/.test(r.body.transferNo), JSON.stringify(r.body));
    r = await call('GET', `/inventory/stock-by-location?tire_id=${id}`, admin);
    check('balances split 6 / 4', r.body.find(x => x.location_id === main)?.qty === 6 && r.body.find(x => x.location_id === wh)?.qty === 4, JSON.stringify(r.body));
    r = await call('GET', `/inventory/${id}`, admin);
    check('item total unchanged (10)', r.body.stock === 10, JSON.stringify(r.body));
    r = await call('POST', '/inventory/transfers', admin, { from_location_id: main, to_location_id: wh, items: [{ tire_id: id, qty: 7 }] });
    check('transfer over source balance 409', r.status === 409 && r.body.code === 'INSUFFICIENT_STOCK' && /Main Store/.test(r.body.error), JSON.stringify(r.body));
    r = await call('POST', '/inventory/transfers', admin, { from_location_id: main, to_location_id: main, items: [{ tire_id: id, qty: 1 }] });
    check('same-location transfer 400', r.status === 400 && r.body.code === 'SAME_LOCATION', JSON.stringify(r.body));
    const body = { from_location_id: wh, to_location_id: main, items: [{ tire_id: id, qty: 1 }] };
    r = await call('POST', '/inventory/transfers', admin, body, { 'Idempotency-Key': 'trf-key-1' });
    const r2 = await call('POST', '/inventory/transfers', admin, body, { 'Idempotency-Key': 'trf-key-1' });
    check('idempotent transfer replay', r.status === 201 && r2.status === 201 && r.body.id === r2.body.id, JSON.stringify([r.body, r2.body]));
    r = await call('GET', `/inventory/stock-by-location?tire_id=${id}`, admin);
    check('replay moved only 1 unit (7 / 3)', r.body.find(x => x.location_id === main)?.qty === 7 && r.body.find(x => x.location_id === wh)?.qty === 3, JSON.stringify(r.body));
    r = await call('GET', '/inventory/transfers', admin);
    check('transfer history lists both', r.status === 200 && r.body.length === 2 && r.body[0].lines === 1, JSON.stringify(r.body));

    // sales draw from the default (selling) location
    const sale = qty => ({ date: '2026-10-28', items: [{ tire_id: id, qty, unit_price: 9 }], tax_rate: 0 });
    r = await call('POST', '/sales', admin, sale(8));
    check('sale beyond default-location stock is refused (7 there, 3 elsewhere)', r.status === 409 && /Main Store/.test(r.body.error), JSON.stringify(r.body));
    r = await call('POST', '/sales', admin, sale(2));
    check('sale within default location ok', r.status === 201, JSON.stringify(r.body));
    r = await call('GET', `/inventory/stock-by-location?location_id=${main}`, admin);
    check('stock-by-location for a location', r.status === 200 && r.body.find(x => x.tire_id === id)?.qty === 5, JSON.stringify(r.body));

    // adjustment at a specific location, and pending approval keeps the location
    r = await call('POST', '/inventory/adjustments', admin, { tire_id: id, qty_change: -1, reason_code: 'damage', location_id: wh });
    check('adjustment at warehouse', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', '/inventory/adjustments', staff, { tire_id: id, qty_change: -1, reason_code: 'damage', location_id: wh });
    check('staff adjustment pending', r.status === 202, JSON.stringify(r.body));
    const adjId = r.body.id;
    r = await call('POST', `/inventory/adjustments/${adjId}/approve`, admin, {});
    check('approval posts at the requested location', r.status === 200, JSON.stringify(r.body));
    r = await call('GET', `/inventory/stock-by-location?tire_id=${id}`, admin);
    check('warehouse now 1 (3-1-1)', r.body.find(x => x.location_id === wh)?.qty === 1, JSON.stringify(r.body));
    r = await call('GET', `/inventory/movements?tire_id=${id}&location_id=${wh}`, admin);
    check('movements filter by location with names', r.status === 200 && r.body.length >= 4 && r.body.every(m => m.location_name === 'Back Warehouse'), JSON.stringify(r.body.map(m => m.location_name)));

    // location management rules
    r = await call('PUT', `/inventory/locations/${wh}`, admin, { is_active: false });
    check('cannot deactivate a location holding stock', r.status === 409 && r.body.code === 'LOCATION_NOT_EMPTY', JSON.stringify(r.body));
    r = await call('PUT', `/inventory/locations/${main}`, admin, { is_active: false });
    check('cannot deactivate the default location', r.status === 409 && r.body.code === 'DEFAULT_LOCATION', JSON.stringify(r.body));
    r = await call('PUT', `/inventory/locations/${wh}`, admin, { is_default: true });
    check('switch default location', r.status === 200 && r.body.is_default === true, JSON.stringify(r.body));
    r = await call('GET', '/inventory/locations', admin);
    check('exactly one default, new default listed first', r.body.filter(l => l.is_default).length === 1 && r.body[0].id === wh && r.body[0].units === 1, JSON.stringify(r.body));
    r = await call('POST', '/inventory/transfers', admin, { from_location_id: main, to_location_id: wh, items: [{ tire_id: id, qty: 5 }] });
    check('empty the old location', r.status === 201, JSON.stringify(r.body));
    r = await call('PUT', `/inventory/locations/${main}`, admin, { is_active: false });
    check('now the empty old default can be deactivated', r.status === 200 && r.body.is_active === false, JSON.stringify(r.body));
    r = await call('POST', '/inventory/transfers', admin, { from_location_id: wh, to_location_id: main, items: [{ tire_id: id, qty: 1 }] });
    check('inactive location refused', r.status === 400, JSON.stringify(r.body));

    // reconciliation
    r = await call('GET', '/inventory/reconciliation', admin);
    check('reconciliation clean (ledger and locations)', r.status === 200 && r.body.mismatches === 0 && r.body.location_mismatches === 0, JSON.stringify(r.body));

    // cross-org
    const other = jwt.sign({ userId: 1, orgId: org + 100000, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    r = await call('POST', '/inventory/transfers', other, { from_location_id: wh, to_location_id: main, items: [{ tire_id: id, qty: 1 }] });
    check('other organisation cannot transfer', [400, 403, 404].includes(r.status), JSON.stringify(r.body));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [
      'DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE organization_id=@o)', 'DELETE FROM stock_transfers WHERE organization_id=@o',
      'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
      'DELETE FROM sales WHERE organization_id=@o', 'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 30), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
