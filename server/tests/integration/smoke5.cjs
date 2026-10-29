process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + x}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG4', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Sup', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR))")).recordset[0].id;
  const admin = jwt.sign({ userId: 1001, orgId: org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const call = async (m, p, body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const stockOf = async id => (await call('GET', `/inventory/${id}`)).body.stock;
  try {
    // tracked item with an opening stock converts into LEGACY
    let r = await call('POST', '/inventory', { model: 'Milk', stock: 4, cost_price: 1, sale_price: 2, tracking: 'batch', track_expiry: true });
    check('create tracked item', r.status === 201 && r.body.tracking === 'batch' && r.body.track_expiry === true, JSON.stringify(r.body));
    const milk = r.body.id;
    r = await call('GET', `/inventory/batches?tire_id=${milk}`);
    check('opening stock sits in LEGACY batch', r.body.length === 1 && r.body[0].batch_no === 'LEGACY' && r.body[0].qty === 4, JSON.stringify(r.body));
    r = await call('PUT', `/inventory/${milk}`, { model: 'Milk', stock: 9, tracking: 'batch', track_expiry: true });
    check('stock cannot be edited on a tracked item', r.status === 400 && r.body.code === 'TRACKED_STOCK', JSON.stringify(r.body));

    // purchase received with batch + expiry
    const po = items => ({ supplier_id: sup, date: day(0), status: 'received', items });
    r = await call('POST', '/purchases', po([{ tire_id: milk, tire_name: 'Milk', qty: 10, unit_price: 1 }]));
    check('receipt without batch refused', r.status === 400 && r.body.code === 'BATCH_REQUIRED', JSON.stringify(r.body));
    check('refused receipt left stock alone', await stockOf(milk) === 4);
    r = await call('POST', '/purchases', po([{ tire_id: milk, tire_name: 'Milk', qty: 10, unit_price: 1, batch_no: 'M-SOON', expiry_date: day(5) }]));
    check('receipt with batch ok', r.status === 201, JSON.stringify(r.body));
    const poSoon = r.body.id;
    r = await call('POST', '/purchases', po([{ tire_id: milk, tire_name: 'Milk', qty: 10, unit_price: 1, batch_no: 'M-LATE', expiry_date: day(90) }]));
    check('second batch ok', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', '/purchases', po([{ tire_id: milk, tire_name: 'Milk', qty: 1, unit_price: 1, batch_no: 'M-OLD', expiry_date: day(-3) }]));
    check('receiving already-expired stock refused', r.status === 400 && r.body.code === 'EXPIRED_BATCH', JSON.stringify(r.body));

    // FEFO sale
    r = await call('POST', '/sales', { date: day(0), items: [{ tire_id: milk, qty: 12, unit_price: 2 }], tax_rate: 0 });
    check('sale 12 ok', r.status === 201, JSON.stringify(r.body));
    const sale = r.body.id;
    r = await call('GET', `/inventory/batches?tire_id=${milk}&in_stock=0`);
    const q = no => r.body.filter(b => b.batch_no === no).reduce((a, b) => a + b.qty, 0);
    check('FEFO: LEGACY (no expiry) last, soon-expiring first -> SOON 0, LATE 8, LEGACY 4', q('M-SOON') === 0 && q('M-LATE') === 8 && q('LEGACY') === 4 && r.body[0].batch_no.startsWith('M-'), JSON.stringify(r.body.map(b => [b.batch_no, b.qty])));
    check('item total 12', await stockOf(milk) === 12);

    // void restores same batches
    r = await call('POST', `/sales/${sale}/void`);
    check('void ok', r.status === 200, JSON.stringify(r.body));
    r = await call('GET', `/inventory/batches?tire_id=${milk}&in_stock=0`);
    check('void returns units to the batches they came from', r.body.filter(b => b.batch_no === 'M-SOON').reduce((a, b) => a + b.qty, 0) === 10 && r.body.filter(b => b.batch_no === 'M-LATE').reduce((a, b) => a + b.qty, 0) === 10, JSON.stringify(r.body.map(b => [b.batch_no, b.qty])));

    // expiry report + write-off of expired stock
    await pool.request().input('o', sql.Int, org).query(`UPDATE stock_batches SET expiry_date = '${day(-1)}' WHERE organization_id=@o AND batch_no='M-SOON'`);
    r = await call('GET', '/inventory/expiry?days=30');
    check('expiry report lists expired batch', r.status === 200 && r.body.expired.some(x => x.batch_no === 'M-SOON' && x.qty === 10) && r.body.expired_units === 10, JSON.stringify(r.body));
    r = await call('POST', '/sales', { date: day(0), items: [{ tire_id: milk, qty: 25, unit_price: 2 }], tax_rate: 0 });
    check('expired units are not sellable (14 sellable, 25 asked)', r.status === 409 && /expired/.test(r.body.error), JSON.stringify(r.body));
    r = await call('GET', `/inventory/batches?tire_id=${milk}`);
    const soon = r.body.find(b => b.batch_no === 'M-SOON');
    r = await call('POST', '/inventory/adjustments', { tire_id: milk, qty_change: -10, reason_code: 'expiry_writeoff', batch_id: soon.batch_id });
    check('write off expired batch', r.status === 201, JSON.stringify(r.body));
    check('stock now 14', await stockOf(milk) === 14);

    // adjust up needs a batch
    r = await call('POST', '/inventory/adjustments', { tire_id: milk, qty_change: 2, reason_code: 'found' });
    check('increase without batch refused', r.status === 400 && r.body.code === 'BATCH_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', '/inventory/adjustments', { tire_id: milk, qty_change: 2, reason_code: 'found', batch_no: 'M-LATE' });
    check('increase into existing batch ok', r.status === 201 && await stockOf(milk) === 16, JSON.stringify(r.body));

    // serial item
    r = await call('POST', '/inventory', { model: 'Phone', cost_price: 100, sale_price: 150, tracking: 'serial' });
    const phone = r.body.id;
    r = await call('POST', '/purchases', po([{ tire_id: phone, tire_name: 'Phone', qty: 3, unit_price: 100, serials: 'IMEI1, IMEI2\nIMEI3' }]));
    check('serial receipt ok', r.status === 201 && await stockOf(phone) === 3, JSON.stringify(r.body));
    r = await call('POST', '/purchases', po([{ tire_id: phone, tire_name: 'Phone', qty: 1, unit_price: 100, serials: 'IMEI2' }]));
    check('duplicate serial refused', r.status === 409 && r.body.code === 'DUPLICATE_SERIAL', JSON.stringify(r.body));
    r = await call('POST', '/purchases', po([{ tire_id: phone, tire_name: 'Phone', qty: 2, unit_price: 100, serials: 'IMEI9' }]));
    check('serial count must match qty', r.status === 400 && r.body.code === 'SERIAL_COUNT', JSON.stringify(r.body));
    r = await call('POST', '/sales', { date: day(0), items: [{ tire_id: phone, qty: 1, unit_price: 150, serials: ['IMEI2'] }], tax_rate: 0 });
    check('sell a specific serial', r.status === 201, JSON.stringify(r.body));
    r = await call('GET', `/inventory/batches?tire_id=${phone}`);
    check('sold serial gone, 2 remain', r.body.length === 2 && !r.body.some(b => b.batch_no === 'IMEI2'), JSON.stringify(r.body.map(b => b.batch_no)));
    r = await call('POST', '/sales', { date: day(0), items: [{ tire_id: phone, qty: 1, unit_price: 151, serials: ['IMEI2'] }], tax_rate: 0 });
    check('sold serial cannot be sold twice', r.status === 409 && r.body.code === 'SERIAL_NOT_FOUND', JSON.stringify(r.body));

    // receipt cancel reverses the right batches
    r = await call('PATCH', `/purchases/${poSoon}/status`, { status: 'cancelled' });
    check('cancel received PO whose batch was written off is refused', r.status === 409, JSON.stringify(r.body));

    // reconciliation
    r = await call('GET', '/inventory/reconciliation');
    check('reconciliation clean incl. batches', r.status === 200 && r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body));

    // switching off blocked while stock remains
    r = await call('PUT', `/inventory/${milk}`, { model: 'Milk', tracking: 'none' });
    check('cannot untrack an item with stock', r.status === 409 && r.body.code === 'TRACKING_IN_USE', JSON.stringify(r.body));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [
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
