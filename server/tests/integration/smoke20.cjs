// Validated contracts on the money routes: sales, purchases, payments (and their Excel imports). Bad input is refused with
// VALIDATION_FAILED naming the field; business rules (overpayment, voided/cancelled documents, ownership) answer with their own code;
// concurrent payments cannot both pass; a good document still goes through.
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
  const A = await mk('SMOKE ORG20'), B = await mk('SMOKE ORG20B');
  const uid = (await pool.request().input('o', sql.Int, A.org).input('e', sql.NVarChar(100), `a${Date.now()}@smoke20.test`).query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES ('admin20', @e, 'x', 'org_admin', @o)")).recordset[0].id;
  const suppB = (await pool.request().input('o', sql.Int, B.org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'B supplier', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 10000 AS NVARCHAR))")).recordset[0].id;
  const admin = jwt.sign({ userId: uid, orgId: A.org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const call = async (m, p, body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}`, 'X-Branch-ID': String(A.br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const today = new Date().toISOString().slice(0, 10);
  const bad = (r, field) => r.status === 400 && r.body.code === 'VALIDATION_FAILED' && (!field || (r.body.fields && field in r.body.fields));
  const stockOf = async id => Number((await pool.request().input('i', sql.Int, id).query('SELECT stock FROM tires WHERE id = @i')).recordset[0].stock);
  try {
    const supA = (await call('POST', '/suppliers', { name: 'Smoke20 Supplier' })).body.id;
    const custA = (await call('POST', '/customers', { name: 'Smoke20 Customer' })).body.id;
    const item = (await call('POST', '/inventory', { model: 'S20', cost_price: 5, sale_price: 10, stock: 20 })).body.id;
    const line = { tire_id: item, qty: 1, unit_price: 10 };

    // ── sales: bad bodies are refused before anything is written ──
    const before = Number((await pool.request().input('o', sql.Int, A.org).query('SELECT COUNT(*) AS n FROM sales WHERE organization_id = @o')).recordset[0].n);
    let r = await call('POST', '/sales', { date: today, items: [] });
    check('a sale with no lines is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [{ ...line, qty: -3 }] });
    check('a negative quantity is refused (it would add stock)', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [{ ...line, qty: 1.5 }] });
    check('a fractional quantity is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [{ ...line, unit_price: -10 }] });
    check('a negative price is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [{ ...line, unit_price: '12abc' }] });
    check('a price that is not a number is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [{ ...line, discount: 150 }] });
    check('a line discount above 100% is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [line], tax_rate: 400 });
    check('a tax rate above 100% is refused', bad(r, 'tax_rate'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [line], status: 'voided' });
    check('a sale cannot be created already voided', bad(r, 'status'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: 'yesterday', items: [line] });
    check('a malformed date is refused', bad(r, 'date'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [line], discount: -5 });
    check('a negative order discount is refused', bad(r, 'discount'), JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [line], discount: 500, tax_rate: 0 });
    check('a discount larger than the order is refused with its own code', r.status === 400 && r.body.code === 'DISCOUNT_TOO_LARGE', JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: [line], tax_rate: 0, payment_method: 'cash', amount_paid: 999 });
    check('paying more than the total at the till is refused', r.status === 400 && r.body.code === 'OVERPAYMENT', JSON.stringify(r));
    r = await call('POST', '/sales', { date: today, items: Array.from({ length: 501 }, () => line) });
    check('more than 500 lines is refused', bad(r, 'items'), JSON.stringify(r));
    const after = Number((await pool.request().input('o', sql.Int, A.org).query('SELECT COUNT(*) AS n FROM sales WHERE organization_id = @o')).recordset[0].n);
    check('none of the refused sales was written', after === before && (await stockOf(item)) === 20, `${before} -> ${after}, stock ${await stockOf(item)}`);

    // ── a good sale, then its status and payments ──
    r = await call('POST', '/sales', { customer_id: custA, date: today, items: [{ ...line, qty: 2 }], tax_rate: 0, status: 'pending', extra_field: 'ignored' });
    const sale = r.body;
    check('a valid sale is created (unknown fields are ignored)', r.status === 201 && Number(sale.total) === 20 && (await stockOf(item)) === 18, JSON.stringify(r));
    r = await call('PATCH', `/sales/${sale.id}/status`, { status: 'voided' });
    check('status cannot be set to voided through the status route', bad(r, 'status'), JSON.stringify(r));
    r = await call('PATCH', '/sales/999999999/status', { status: 'paid' });
    check('status change on a missing sale is a 404, not a silent success', r.status === 404 && r.body.code === 'NOT_FOUND', JSON.stringify(r));

    r = await call('POST', '/payments/sale', { sale_id: sale.id, amount: 'ten' });
    check('a payment amount that is not a number is refused', bad(r, 'amount'), JSON.stringify(r));
    r = await call('POST', '/payments/sale', { sale_id: sale.id, amount: 0 });
    check('a zero payment is refused', bad(r, 'amount'), JSON.stringify(r));
    r = await call('POST', '/payments/sale', { sale_id: sale.id, amount: -5 });
    check('a negative payment is refused', bad(r, 'amount'), JSON.stringify(r));
    r = await call('POST', '/payments/sale', { amount: 5 });
    check('a payment without a sale is refused', bad(r, 'sale_id'), JSON.stringify(r));
    r = await call('POST', '/payments/sale', { sale_id: sale.id, amount: 5, payment_date: '31/12/2026' });
    check('a malformed payment date is refused', bad(r, 'payment_date'), JSON.stringify(r));
    r = await call('POST', '/payments/sale', { sale_id: sale.id, amount: 25 });
    check('a payment above the balance is refused with the balance', r.status === 409 && r.body.code === 'OVERPAYMENT' && r.body.balance_due === 20, JSON.stringify(r));
    r = await call('POST', '/payments/sale', { sale_id: 999999999, amount: 5 });
    check('a payment on a missing sale is a 404', r.status === 404 && r.body.code === 'NOT_FOUND', JSON.stringify(r));

    // two payments of 15 on a balance of 20 at the same moment: exactly one may succeed
    const both = await Promise.all([call('POST', '/payments/sale', { sale_id: sale.id, amount: 15 }), call('POST', '/payments/sale', { sale_id: sale.id, amount: 15 })]);
    const ok = both.filter(x => x.status === 201).length, refused = both.filter(x => x.status === 409 && x.body.code === 'OVERPAYMENT').length;
    const paid = Number((await pool.request().input('i', sql.Int, sale.id).query('SELECT amount_paid FROM sales WHERE id = @i')).recordset[0].amount_paid);
    const sum = Number((await pool.request().input('i', sql.Int, sale.id).query('SELECT ISNULL(SUM(amount),0) AS s FROM sale_payments WHERE sale_id = @i')).recordset[0].s);
    check('two simultaneous payments cannot both pass (no lost update)', ok === 1 && refused === 1 && paid === 15 && sum === 15, JSON.stringify({ ok, refused, paid, sum, both: both.map(x => x.status) }));
    r = await call('POST', '/payments/sale', { sale_id: sale.id, amount: 5 });
    check('settling the exact balance marks the sale paid', r.status === 201 && r.body.new_status === 'paid' && r.body.balance_due === 0, JSON.stringify(r));

    // ── voided sale takes no payment ──
    const s2 = (await call('POST', '/sales', { customer_id: custA, date: today, items: [line], tax_rate: 0 })).body;
    await call('POST', `/sales/${s2.id}/void`, { reason: 'smoke20' });
    r = await call('POST', '/payments/sale', { sale_id: s2.id, amount: 5 });
    check('a voided sale takes no payment', r.status === 409 && r.body.code === 'SALE_VOIDED', JSON.stringify(r));
    r = await call('PATCH', `/sales/${s2.id}/status`, { status: 'paid' });
    check('a voided sale cannot change status', r.status === 409 && r.body.code === 'SALE_VOIDED', JSON.stringify(r));

    // ── purchases ──
    const pline = { tire_id: item, qty: 5, unit_price: 4 };
    r = await call('POST', '/purchases', { date: today, items: [pline] });
    check('a purchase without a supplier is refused', bad(r, 'supplier_id'), JSON.stringify(r));
    r = await call('POST', '/purchases', { supplier_id: supA, date: today, items: [] });
    check('a purchase with no lines is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/purchases', { supplier_id: supA, date: today, items: [{ ...pline, qty: -5 }] });
    check('a negative purchase quantity is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/purchases', { supplier_id: supA, date: today, items: [{ ...pline, unit_price: -1 }] });
    check('a negative purchase price is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/purchases', { supplier_id: supA, date: today, items: [{ ...pline, expiry_date: 'soon' }] });
    check('a malformed expiry date is refused', bad(r, 'items'), JSON.stringify(r));
    r = await call('POST', '/purchases', { supplier_id: supA, date: today, items: [pline], status: 'shipped' });
    check('an unknown purchase status is refused', bad(r, 'status'), JSON.stringify(r));
    r = await call('POST', '/purchases', { supplier_id: suppB, date: today, items: [pline] });
    check("a purchase cannot use another organisation's supplier", r.status === 400 && r.body.code === 'INVALID_SUPPLIER', JSON.stringify(r));
    check('refused purchases left stock alone', (await stockOf(item)) === 18);
    r = await call('POST', '/purchases', { supplier_id: supA, date: today, items: [pline], status: 'received', location_id: '' });
    const po = r.body;
    check('a valid received purchase books the stock (empty location = branch default)', r.status === 201 && (await stockOf(item)) === 23, JSON.stringify(r));
    r = await call('POST', '/purchases', { supplier_id: supA, date: today, items: [{ ...pline, batch_no: 'LOT1', expiry_date: '2030-01-31', serials: 'S1, S2' }] });
    check('batch, expiry and serials still pass validation', r.status === 201, JSON.stringify(r));
    r = await call('PATCH', `/purchases/${po.id}/status`, { status: 'archived' });
    check('an unknown purchase status change is refused', bad(r, 'status'), JSON.stringify(r));

    r = await call('POST', '/payments/purchase', { purchase_id: po.id, amount: 21 });
    check('a supplier payment above the balance is refused', r.status === 409 && r.body.code === 'OVERPAYMENT' && r.body.balance_due === 20, JSON.stringify(r));
    r = await call('POST', '/payments/purchase', { purchase_id: po.id, amount: -1 });
    check('a negative supplier payment is refused', bad(r, 'amount'), JSON.stringify(r));
    const both2 = await Promise.all([call('POST', '/payments/purchase', { purchase_id: po.id, amount: 15 }), call('POST', '/payments/purchase', { purchase_id: po.id, amount: 15 })]);
    const paidP = Number((await pool.request().input('i', sql.Int, po.id).query('SELECT amount_paid FROM purchases WHERE id = @i')).recordset[0].amount_paid);
    check('two simultaneous supplier payments cannot both pass', both2.filter(x => x.status === 201).length === 1 && paidP === 15, JSON.stringify({ paidP, both: both2.map(x => x.status) }));
    const po2 = (await call('POST', '/purchases', { supplier_id: supA, date: today, items: [pline] })).body;
    await call('PATCH', `/purchases/${po2.id}/status`, { status: 'cancelled' });
    r = await call('POST', '/payments/purchase', { purchase_id: po2.id, amount: 5 });
    check('a cancelled purchase takes no payment', r.status === 409 && r.body.code === 'PURCHASE_CANCELLED', JSON.stringify(r));

    // ── imports: per-row validation, the rest still go in ──
    r = await call('POST', '/sales/bulk', { invoices: 'nope' });
    check('a bulk sale import must be a list', bad(r, 'invoices'), JSON.stringify(r));
    r = await call('POST', '/sales/bulk', { invoices: [
      { invoice_ref: 'ok', customer_name: 'Smoke20 Customer', items: [{ item_name: 'S20', qty: 1, unit_price: 10 }] },
      { invoice_ref: 'badqty', customer_name: 'Smoke20 Customer', items: [{ item_name: 'S20', qty: -1, unit_price: 10 }] },
      { invoice_ref: 'badstatus', customer_name: 'Smoke20 Customer', status: 'voided', items: [{ item_name: 'S20', qty: 1, unit_price: 10 }] },
      { invoice_ref: 'nocust', items: [{ item_name: 'S20', qty: 1, unit_price: 10 }] },
    ] });
    const refs = (r.body.errors || []).map(e => e.ref).sort().join(',');
    check('a bulk sale import books the good row and reports each bad one', r.status === 200 && r.body.inserted === 1 && refs === 'badqty,badstatus,nocust', JSON.stringify(r));
    r = await call('POST', '/purchases/bulk', { pos: [
      { po_ref: 'ok', supplier_name: 'Smoke20 Supplier', items: [{ item_name: 'S20', qty: 2, unit_price: 3 }] },
      { po_ref: 'badprice', supplier_name: 'Smoke20 Supplier', items: [{ item_name: 'S20', qty: 2, unit_price: -3 }] },
      { po_ref: 'badstatus', supplier_name: 'Smoke20 Supplier', status: 'lost', items: [{ item_name: 'S20', qty: 2, unit_price: 3 }] },
    ] });
    const refs2 = (r.body.errors || []).map(e => e.ref).sort().join(',');
    check('a bulk purchase import books the good row and reports each bad one', r.status === 200 && r.body.inserted === 1 && refs2 === 'badprice,badstatus', JSON.stringify(r));
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
    const left = (await pool.request().query("SELECT COUNT(*) AS n FROM organizations WHERE name LIKE 'SMOKE ORG20%'")).recordset[0].n;
    if (left) console.log('WARN leftover orgs', left);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
