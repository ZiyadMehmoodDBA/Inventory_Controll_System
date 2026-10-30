// Organisation isolation, stock-movement validation, and walk-in payment records.
// Tenants only ever see/edit their own organisation; adjustments and transfers refuse bad bodies with VALIDATION_FAILED;
// walk-in sales keep sale_payments rows (no customer, no ledger entry) and can take later payments.
process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 400)}`); };

(async () => {
  const pool = await getPool();
  const mk = async nm => {
    const org = (await pool.request().input('n', sql.NVarChar(100), nm).query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@n, 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'general_store')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    return { org, br };
  };
  const A = await mk('SMOKE ORG23'), B = await mk('SMOKE ORG23B');
  const uid = (await pool.request().input('o', sql.Int, A.org).input('e', sql.NVarChar(100), `a${Date.now()}@smoke23.test`).query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES ('admin23', @e, 'x', 'org_admin', @o)")).recordset[0].id;
  const suppB = (await pool.request().input('o', sql.Int, B.org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'B supplier', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 10000 AS NVARCHAR))")).recordset[0].id;
  const admin = jwt.sign({ userId: uid, orgId: A.org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const call = async (m, p, body, tok = admin) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, 'X-Branch-ID': String(A.br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const today = new Date().toISOString().slice(0, 10);
  const bad = (r, field) => r.status === 400 && r.body.code === 'VALIDATION_FAILED' && (!field || (r.body.fields && field in r.body.fields));
  const stockOf = async id => Number((await pool.request().input('i', sql.Int, id).query('SELECT stock FROM tires WHERE id = @i')).recordset[0].stock);
  try {
    // ── item 4: organisation isolation ──
    let r = await call('GET', '/organizations');
    check('an administrator lists only their own organisation', r.status === 200 && r.body.length === 1 && r.body[0].id === A.org, JSON.stringify(r).slice(0, 300));
    r = await call('GET', '/organizations/' + B.org);
    check("another tenant's organisation answers 404", r.status === 404, JSON.stringify(r));
    r = await call('GET', '/organizations/' + A.org);
    check('own organisation is readable with its branches', r.status === 200 && r.body.id === A.org && Array.isArray(r.body.branches), JSON.stringify(r).slice(0, 200));
    r = await call('PUT', '/organizations/' + B.org, { name: 'HIJACKED' });
    const nameB = (await pool.request().input('o', sql.Int, B.org).query('SELECT name FROM organizations WHERE id = @o')).recordset[0].name;
    check("editing another tenant's organisation is refused and changes nothing", r.status === 404 && nameB === 'SMOKE ORG23B', JSON.stringify(r) + nameB);
    r = await call('PUT', '/organizations/' + A.org, { name: 'SMOKE ORG23', currency: 'PK' });
    check('an invalid currency is refused', bad(r, 'currency'), JSON.stringify(r));
    r = await call('PUT', '/organizations/' + A.org, { phone: '0300-1' });
    check('own organisation can be edited', r.status === 200 && r.body.phone === '0300-1', JSON.stringify(r).slice(0, 200));
    r = await call('POST', '/organizations', { name: 'SMOKE ORG23 ROGUE' });
    check('a tenant cannot create organisations', r.status === 403 && r.body.code === 'PLATFORM_ONLY', JSON.stringify(r));
    r = await call('GET', '/organizations/abc');
    check('a malformed id answers 404', r.status === 404, JSON.stringify(r));

    // ── item 6: adjustments ──
    const item = (await call('POST', '/inventory', { model: 'S23', cost_price: 5, sale_price: 10, stock: 20 })).body.id;
    r = await call('POST', '/inventory/adjustments', { qty_change: 2, reason_code: 'count_correction' });
    check('an adjustment without an item is refused', bad(r, 'tire_id'), JSON.stringify(r));
    r = await call('POST', '/inventory/adjustments', { tire_id: item, qty_change: 1.5, reason_code: 'count_correction' });
    check('a fractional adjustment is refused', bad(r, 'qty_change'), JSON.stringify(r));
    r = await call('POST', '/inventory/adjustments', { tire_id: item, qty_change: 'abc', reason_code: 'count_correction' });
    check('a non-numeric adjustment is refused', bad(r, 'qty_change'), JSON.stringify(r));
    r = await call('POST', '/inventory/adjustments', { tire_id: item, qty_change: 1, reason_code: 'count_correction', expiry_date: '31/12/2030' });
    check('a malformed expiry date is refused', bad(r, 'expiry_date'), JSON.stringify(r));
    r = await call('POST', '/inventory/adjustments', { tire_id: item, qty_change: 1, reason_code: 'nonsense' });
    check('an unknown reason keeps its business code', r.status === 400 && r.body.code === 'INVALID_REASON', JSON.stringify(r));
    r = await call('POST', '/inventory/adjustments', { tire_id: item, qty_change: 0, reason_code: 'count_correction' });
    check('a zero adjustment keeps its business code', r.status === 400 && r.body.code === 'INVALID_QUANTITY', JSON.stringify(r));
    check('refused adjustments changed no stock', (await stockOf(item)) === 20);
    r = await call('POST', '/inventory/adjustments', { tire_id: String(item), qty_change: '-3', reason_code: 'count_correction', location_id: '' });
    check('numeric strings from a form still work', r.status === 201 && (await stockOf(item)) === 17, JSON.stringify(r));
    r = await call('POST', '/inventory/adjustments/abc/approve', {});
    check('approving a malformed id answers 404', r.status === 404, JSON.stringify(r));

    // ── item 6: transfers ──
    const locs = (await call('GET', '/inventory/locations')).body;
    const from = locs[0].id;
    const to = (await call('POST', '/inventory/locations', { name: 'Shelf B', code: 'SHB' })).body.id;
    const tbody = (o = {}) => ({ from_location_id: from, to_location_id: to, items: [{ tire_id: item, qty: 2 }], ...o });
    r = await call('POST', '/inventory/transfers', tbody({ items: [] }));
    check('a transfer with no lines is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/inventory/transfers', tbody({ items: [{ tire_id: item, qty: -2 }] }));
    check('a negative transfer quantity is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/inventory/transfers', tbody({ items: [{ tire_id: item, qty: 1.5 }] }));
    check('a fractional transfer quantity is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/inventory/transfers', tbody({ from_location_id: 'x' }));
    check('a non-numeric location is refused', bad(r, 'from_location_id'), JSON.stringify(r));
    r = await call('POST', '/inventory/transfers', tbody({ expected_at: 'tomorrow' }));
    check('a malformed expected date is refused', bad(r, 'expected_at'), JSON.stringify(r));
    r = await call('POST', '/inventory/transfers', tbody({ to_location_id: from }));
    check('same-location keeps its business code', r.status === 400 && r.body.code === 'SAME_LOCATION', JSON.stringify(r));
    r = await call('POST', '/inventory/transfers', tbody({ in_transit: true }));
    check('a valid in-transit transfer is created', r.status === 201 && r.body.status === 'in_transit', JSON.stringify(r).slice(0, 200));
    const tid = r.body.id;
    r = await call('POST', `/inventory/transfers/${tid}/receive`, { lines: [{ tire_id: item, qty_received: 'many' }] });
    check('a non-numeric received quantity is refused', bad(r), JSON.stringify(r));
    r = await call('POST', `/inventory/transfers/${tid}/receive`, { short_action: 'burn' });
    check('an unknown short action is refused', bad(r, 'short_action'), JSON.stringify(r));
    r = await call('POST', `/inventory/transfers/${tid}/receive`, {});
    check('a plain receive still completes', r.status === 200 && r.body.status === 'received', JSON.stringify(r).slice(0, 200));

    // ── item 7: walk-in payments ──
    const sale = { date: today, items: [{ tire_id: item, qty: 2, unit_price: 10 }], payment_method: 'cash', amount_paid: 23 };
    r = await call('POST', '/sales', sale);
    check('a walk-in cash sale is created paid', r.status === 201 && r.body.status === 'paid', JSON.stringify(r).slice(0, 200));
    const sid = r.body.id;
    const pays = async id => (await pool.request().input('s', sql.Int, id).query('SELECT amount, payment_method, customer_id FROM sale_payments WHERE sale_id = @s ORDER BY id')).recordset;
    let p = await pays(sid);
    check('the walk-in sale has one payment row, no customer', p.length === 1 && Number(p[0].amount) === 23 && p[0].payment_method === 'cash' && p[0].customer_id === null, JSON.stringify(p));
    r = await call('POST', '/sales', { ...sale, items: [{ tire_id: item, qty: 3, unit_price: 10 }], payment_method: 'mixed', cash_amount: 10, card_amount: 24.5, amount_paid: 34.5 });
    p = await pays(r.body.id);
    check('a mixed-tender walk-in sale records cash and card separately', r.status === 201 && p.length === 2 && p.map(x => x.payment_method).join() === 'cash,card', JSON.stringify(p));
    r = await call('POST', '/sales', { ...sale, amount_paid: 5 });
    const part = r.body.id;
    check('a part-paid walk-in sale is partial', r.status === 201 && r.body.status === 'partial', JSON.stringify(r).slice(0, 200));
    r = await call('POST', '/payments/sale', { sale_id: part, amount: 18, payment_method: 'cash' });
    check('a walk-in sale can take a later payment', r.status === 201 && r.body.new_status === 'paid', JSON.stringify(r).slice(0, 250));
    const led = Number((await pool.request().input('o', sql.Int, A.org).query('SELECT COUNT(*) AS n FROM ledger_entries WHERE organization_id = @o AND sale_id IS NOT NULL')).recordset[0].n);
    check('walk-in sales create no customer ledger entries', led === 0, led);
    p = await pays(part);
    check('the part-paid sale now lists both payments', p.length === 2 && p.reduce((a, x) => a + Number(x.amount), 0) === 23, JSON.stringify(p));
    const cust = (await call('POST', '/customers', { name: 'S23 Customer' })).body.id;
    r = await call('POST', '/sales', { ...sale, customer_id: cust });
    p = await pays(r.body.id);
    check('a customer sale still records its payment against the customer', r.status === 201 && p.length === 1 && p[0].customer_id === cust, JSON.stringify(p));
    
    } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of [A.org, B.org]) {
      for (const q of ['DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM purchase_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
        'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
        'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sales WHERE organization_id=@o',
        'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
        'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o', 'DELETE FROM warehouses WHERE organization_id=@o',
        'DELETE FROM product_history WHERE organization_id=@o', 'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
        'DELETE FROM customers WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
        'DELETE FROM access_roles WHERE organization_id=@o', 'DELETE FROM users WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o']) {
        try { await pool.request().input('o', sql.Int, o).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); }
      }
    }
    const left = (await pool.request().query("SELECT COUNT(*) AS n FROM organizations WHERE name LIKE 'SMOKE ORG23%'")).recordset[0].n;
    if (left) console.log('WARN leftover orgs', left);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
