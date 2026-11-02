// Master-data contracts (customers, suppliers, services, item master), settings hardening, and tenant-scoped system info.
// Bad bodies answer VALIDATION_FAILED naming the field; settings cannot write policy keys; sessions never list another tenant.

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
  const A = await mk('SMOKE ORG25'), B = await mk('SMOKE ORG25B');
  const uid = (await pool.request().input('o', sql.Int, A.org).input('e', sql.NVarChar(100), `a${Date.now()}@smoke25.test`).query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES ('admin25', @e, 'x', 'org_admin', @o)")).recordset[0].id;
  const suppB = (await pool.request().input('o', sql.Int, B.org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'B supplier', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 10000 AS NVARCHAR))")).recordset[0].id;
  const admin = jwt.sign({ userId: uid, orgId: A.org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const mkUser = async (org, role, tag) => (await pool.request().input('o', sql.Int, org).input('e', sql.NVarChar(100), `${tag}${Date.now()}@smoke25.test`).input('r', sql.NVarChar(30), role)
    .query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id, INSERTED.email VALUES ('u25', @e, 'x', @r, @o)")).recordset[0];
  const staff = await mkUser(A.org, 'staff', 's');
  const ub = await mkUser(B.org, 'org_admin', 'b');
  const tok = (u, o, r) => jwt.sign({ userId: u, orgId: o, branchId: null, role: r }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const staffTok = tok(staff.id, A.org, 'staff');
  const call = async (m, p, body, t = admin) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(A.br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const bad = (r, field) => r.status === 400 && r.body.code === 'VALIDATION_FAILED' && (!field || (r.body.fields && field in r.body.fields));
  const long = n => 'x'.repeat(n);
  try {
    // ── customers ──
    let r = await call('POST', '/customers', {});
    check('a customer needs a name', bad(r, 'name'), JSON.stringify(r));
    r = await call('POST', '/customers', { name: long(101) });
    check('an over-long customer name is refused', bad(r, 'name'), JSON.stringify(r));
    r = await call('POST', '/customers', { name: 'C25', email: 12345 });
    check('a non-text email is refused', bad(r, 'email'), JSON.stringify(r));
    r = await call('POST', '/customers', { name: 'C25', vehicle_year: 'abc' });
    check('a non-numeric vehicle year is refused', bad(r, 'vehicle_year'), JSON.stringify(r));
    r = await call('POST', '/customers', { name: 'C25 Good', phone: '0300-25', vehicle_year: '', vehicle_plate: 'abc 123' });
    const cid = r.body?.id;
    check('a good customer is created (blank year allowed, plate upper-cased)', r.status === 201 && r.body.vehicle_plate === 'ABC 123' && r.body.vehicle_year === null, JSON.stringify(r).slice(0, 250));
    r = await call('PUT', `/customers/${cid}`, { phone: '1' });
    check('updating a customer without a name is refused', bad(r, 'name'), JSON.stringify(r));
    r = await call('PUT', `/customers/${cid}`, { name: 'C25 Renamed', balance: 'lots' });
    check('a non-numeric balance is refused', bad(r, 'balance'), JSON.stringify(r));
    r = await call('PUT', `/customers/${cid}`, { name: 'C25 Renamed' });
    check('a customer can be renamed', r.status === 200 && r.body.name === 'C25 Renamed', JSON.stringify(r).slice(0, 200));
    r = await call('GET', '/customers/abc');
    check('a malformed customer id is simply not found', r.status === 404, JSON.stringify(r));
    r = await call('DELETE', '/customers/99999999');
    check('deleting a customer that does not exist answers 404', r.status === 404, JSON.stringify(r));
    r = await call('GET', '/ledger/customer/abc/statement');
    check('a malformed ledger id is simply not found', r.status === 404, JSON.stringify(r));

    // ── suppliers ──
    r = await call('POST', '/suppliers', {});
    check('a supplier needs a name', bad(r, 'name'), JSON.stringify(r));
    r = await call('POST', '/suppliers', { name: 'S25', phone: long(51) });
    check('an over-long supplier phone is refused', bad(r, 'phone'), JSON.stringify(r));
    r = await call('POST', '/suppliers', { name: 'S25 Good' });
    const sid = r.body?.id;
    check('a good supplier is created', r.status === 201, JSON.stringify(r).slice(0, 200));
    r = await call('PUT', `/suppliers/${sid}`, { phone: '1' });
    check('updating a supplier without a name is refused', bad(r, 'name'), JSON.stringify(r));
    r = await call('PUT', '/suppliers/99999999', { name: 'Nobody' });
    check('updating a supplier that does not exist answers 404', r.status === 404, JSON.stringify(r));

    // ── services ──
    r = await call('POST', '/products', { name: 'Svc', sale_price: -5 });
    check('a negative service price is refused', bad(r, 'sale_price'), JSON.stringify(r));
    r = await call('POST', '/products', { name: 'Svc', cost_price: 'abc' });
    check('a non-numeric service cost is refused', bad(r, 'cost_price'), JSON.stringify(r));
    r = await call('POST', '/products', { name: 'Svc 25', sale_price: '12.5', is_active: true });
    check('a good service is created (numeric strings accepted)', r.status === 201 && Number(r.body.sale_price) === 12.5, JSON.stringify(r).slice(0, 200));

    // ── item master ──
    r = await call('POST', '/inventory', { model: 'I25', cost_price: 'abc' });
    check('a non-numeric item cost is refused', bad(r, 'cost_price'), JSON.stringify(r));
    r = await call('POST', '/inventory', { model: 'I25', sale_price: -1 });
    check('a negative item price is refused', bad(r, 'sale_price'), JSON.stringify(r));
    r = await call('POST', '/inventory', { model: 'I25', reorder_level: 1.5 });
    check('a fractional reorder level is refused', bad(r, 'reorder_level'), JSON.stringify(r));
    r = await call('POST', '/inventory', { model: long(101) });
    check('an over-long item name is refused', bad(r, 'model'), JSON.stringify(r));
    r = await call('POST', '/inventory', { model: 'I25', stock: -3 });
    check('negative opening stock is refused', r.status === 400, JSON.stringify(r));
    r = await call('POST', '/inventory', { model: 'I25 Good', cost_price: '5', sale_price: 10, stock: '4', reorder_level: '' });
    const iid = r.body?.id;
    check('a good item is created from form strings', r.status === 201 && Number(r.body.stock) === 4, JSON.stringify(r).slice(0, 250));
    r = await call('PUT', `/inventory/${iid}`, { model: 'I25 Good', cost_price: 'abc' });
    check('a bad item update is refused', bad(r, 'cost_price'), JSON.stringify(r));
    r = await call('PUT', '/inventory/99999999', { model: 'Nobody' });
    check('updating an item that does not exist answers 404', r.status === 404, JSON.stringify(r));

    // ── settings ──
    r = await call('POST', '/settings', { company_name: 'Nope' }, staffTok);
    check('staff cannot change company settings', r.status === 403, JSON.stringify(r));
    r = await call('POST', '/settings', { default_tax_rate: 'abc' });
    check('a bad tax rate is refused', bad(r, 'default_tax_rate'), JSON.stringify(r));
    r = await call('POST', '/settings', { currency: 'PKRR' });
    check('a bad currency is refused', bad(r, 'currency'), JSON.stringify(r));
    r = await call('POST', '/settings', { allow_negative_stock: 'true', valuation_method: 'lifo' });
    check('policy keys alone are not settable here (nothing to save)', r.status === 400 && r.body.code === 'NO_SETTINGS', JSON.stringify(r));
    r = await call('POST', '/settings', { company_name: 'SMOKE ORG25 Ltd', default_tax_rate: 17, valuation_method: 'lifo', allow_negative_stock: 'true' });
    const pol = (await pool.request().input('o', sql.Int, A.org).query("SELECT COUNT(*) AS n FROM settings WHERE organization_id = @o AND [key] IN ('valuation_method', 'allow_negative_stock') AND value IN ('lifo', 'true')")).recordset[0].n;
    check('profile keys are saved and policy keys in the same body are ignored', r.status === 200 && r.body.company_name === 'SMOKE ORG25 Ltd' && r.body.default_tax_rate === '17' && pol === 0, JSON.stringify(r).slice(0, 200) + ' pol=' + pol);
    r = await call('POST', '/settings', { business_type: 'nonsense' });
    check('an unknown business type is refused', r.status === 400, JSON.stringify(r));

    // ── system info lists only this tenant's sessions ──
    for (const u of [staff, ub]) await pool.request().input('u', sql.Int, u.id).input('h', sql.NVarChar(255), `h25-${u.id}-${Date.now()}`).query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (@u, @h, DATEADD(DAY, 1, GETDATE()))');
    r = await call('GET', '/settings/system-info');
    const emails = (r.body?.sessions?.users || []).map(x => x.email);
    check('system info lists this tenant\'s sessions', r.status === 200 && emails.includes(staff.email), JSON.stringify(emails));
    check('system info never lists another tenant\'s users', !emails.includes(ub.email), JSON.stringify(emails));

    // ── the shared tyre reference database belongs to the platform ──
    for (const [m, p] of [['POST', '/catalog/scraper/run'], ['DELETE', '/catalog/entries/1'], ['GET', '/catalog/stats'], ['GET', '/catalog/scraper/config']]) {
      r = await call(m, p, m === 'POST' ? {} : undefined);
      check(`a tenant administrator cannot ${m} ${p}`, r.status === 403, JSON.stringify(r));
    }
    } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of [A.org, B.org]) {
      for (const q of ['DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE organization_id=@o)', 'DELETE FROM products WHERE organization_id=@o', 'DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM purchase_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
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
    const left = (await pool.request().query("SELECT COUNT(*) AS n FROM organizations WHERE name LIKE 'SMOKE ORG25%'")).recordset[0].n;
    if (left) console.log('WARN leftover orgs', left);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
