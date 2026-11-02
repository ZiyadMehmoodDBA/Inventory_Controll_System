// Cross-tenant probe: tenant A holds valid credentials and tries every id-bearing route with tenant B's ids.
// Nothing may answer 2xx (no read leak, no write) or 5xx, and B's records must be exactly as they were afterwards.

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
  const A = await mk('SMOKE ORG24'), B = await mk('SMOKE ORG24B');
  const uid = (await pool.request().input('o', sql.Int, A.org).input('e', sql.NVarChar(100), `a${Date.now()}@smoke24.test`).query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES ('admin24', @e, 'x', 'org_admin', @o)")).recordset[0].id;
  const suppB = (await pool.request().input('o', sql.Int, B.org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'B supplier', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 10000 AS NVARCHAR))")).recordset[0].id;
  const admin = jwt.sign({ userId: uid, orgId: A.org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

  const bUid = (await pool.request().input('o', sql.Int, B.org).input('e', sql.NVarChar(100), `b${Date.now()}@smoke24.test`).query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES ('admin24b', @e, 'x', 'org_admin', @o)")).recordset[0].id;
  const adminB = jwt.sign({ userId: bUid, orgId: B.org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const call = async (tok, br, m, p, body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const cb = (m, p, b) => call(adminB, B.br, m, p, b);
  const ca = (m, p, b) => call(admin, A.br, m, p, b);
  const today = new Date().toISOString().slice(0, 10);
  const q1 = async (sqlText, id) => (await pool.request().input('i', sql.Int, id).query(sqlText)).recordset[0];
  try {
    // ── tenant B's records ──
    const bc = (await cb('POST', '/customers', { name: 'B Customer' })).body.id;
    const bs = (await cb('POST', '/suppliers', { name: 'B Supplier' })).body.id;
    const bi = (await cb('POST', '/inventory', { model: 'B24', cost_price: 5, sale_price: 10, stock: 20 })).body.id;
    const bsale = (await cb('POST', '/sales', { customer_id: bc, date: today, items: [{ tire_id: bi, qty: 1, unit_price: 10 }], tax_rate: 0, payment_method: 'cash', amount_paid: 4 })).body;
    const bpur = (await cb('POST', '/purchases', { supplier_id: bs, date: today, items: [{ tire_id: bi, qty: 2, unit_price: 4 }] })).body;
    const bpay = (await q1('SELECT TOP 1 id FROM sale_payments WHERE sale_id = @i', bsale.id)) || {};
    const bprod = (await cb('POST', '/products', { name: 'B Service', sale_price: 5 })).body.id;
    const btt = (await cb('POST', '/lookups/tire-types', { name: 'B Type' })).body?.id;
    const bcat = (await cb('POST', '/inventory/categories', { name: 'B Category' })).body?.id;
    const bwh = (await cb('POST', '/inventory/warehouses', { name: 'B Warehouse' })).body?.id;
    const bloc = (await cb('POST', '/inventory/locations', { name: 'B Shelf', code: 'BSH' })).body?.id;
    const brole = (await cb('POST', '/access/roles', { name: 'B Role', base_role: 'staff', permissions: ['inventory.view'] })).body?.id;
    check('tenant B fixtures exist', [bc, bs, bi, bsale?.id, bpur?.id, bpay.id, bprod, btt, bcat, bwh, bloc, brole].every(Boolean), JSON.stringify({ bc, bs, bi, bsale: bsale?.id, bpur: bpur?.id, bpay: bpay.id, bprod, btt, bcat, bwh, bloc, brole }));

    // ── tenant A attacks ──
    const probes = [
      ['GET', `/customers/${bc}`], ['PUT', `/customers/${bc}`, { name: 'HACK' }], ['DELETE', `/customers/${bc}`],
      ['GET', `/suppliers/${bs}`], ['PUT', `/suppliers/${bs}`, { name: 'HACK' }], ['DELETE', `/suppliers/${bs}`],
      ['GET', `/inventory/${bi}`], ['GET', `/inventory/${bi}/history`], ['PUT', `/inventory/${bi}`, { brand: 'H', model: 'HACK', size: '1', cost_price: 1, sale_price: 1 }], ['DELETE', `/inventory/${bi}`],
      ['GET', `/inventory/position/${bi}`],
      ['GET', `/sales/${bsale.id}`], ['POST', `/sales/${bsale.id}/void`, { reason: 'hack' }], ['PATCH', `/sales/${bsale.id}/status`, { status: 'paid' }],
      ['GET', `/purchases/${bpur.id}`], ['PATCH', `/purchases/${bpur.id}/status`, { status: 'received' }],
      ['POST', '/payments/sale', { sale_id: bsale.id, amount: 1 }], ['GET', `/payments/sale/${bsale.id}`], ['DELETE', `/payments/sale/${bpay.id}`],
      ['GET', `/ledger/customer/${bc}/statement`], ['GET', `/ledger/customer/${bc}/unpaid-invoices`], ['GET', `/ledger/supplier/${bs}/statement`], ['GET', `/ledger/supplier/${bs}/unpaid-pos`],
      ['PUT', `/products/${bprod}`, { name: 'HACK' }], ['DELETE', `/products/${bprod}`],
      ['PUT', `/lookups/tire-types/${btt}`, { name: 'HACK' }], ['DELETE', `/lookups/tire-types/${btt}`],
      ['PUT', `/inventory/categories/${bcat}`, { name: 'HACK' }], ['DELETE', `/inventory/categories/${bcat}`],
      ['PUT', `/inventory/warehouses/${bwh}`, { name: 'HACK' }],
      ['PUT', `/inventory/locations/${bloc}`, { name: 'HACK' }], ['GET', `/inventory/warehouse/locations/${bloc}/stock`],
      ['GET', `/inventory/locations/${bloc}/access`], ['PUT', `/inventory/locations/${bloc}/access`, { users: [] }], ['PUT', `/inventory/locations/${bloc}/warehouse`, { warehouse_id: bwh }],
      ['PUT', `/access/roles/${brole}`, { name: 'HACK', permissions: [] }], ['DELETE', `/access/roles/${brole}`], ['POST', `/access/roles/${brole}/reset`, {}],
      ['PUT', `/users/${bUid}`, { name: 'HACK', role: 'staff' }], ['PATCH', `/users/${bUid}/status`, { is_active: false }], ['PATCH', `/users/${bUid}/password`, { password: 'Hack12345!' }],
      ['PUT', `/branches/${B.br}`, { name: 'HACK' }], ['DELETE', `/branches/${B.br}`],
      ['POST', '/inventory/adjustments', { tire_id: bi, qty_change: 5, reason_code: 'count_correction' }],
      ['POST', '/inventory/reservations', { tire_id: bi, qty: 1 }],
      ['POST', '/inventory/transfers', { from_location_id: bloc, to_location_id: bloc + 1, items: [{ tire_id: bi, qty: 1 }] }],
      ['POST', '/sales', { date: today, items: [{ tire_id: bi, qty: 1, unit_price: 10 }] }],
      ['POST', '/sales', { customer_id: bc, date: today, items: [{ tire_id: bi, qty: 1, unit_price: 10 }] }],
      ['POST', '/purchases', { supplier_id: bs, date: today, items: [{ tire_id: bi, qty: 1, unit_price: 4 }] }],
    ];
    const leaks = [];
    for (const [m, p, b] of probes) {
      const r = await ca(m, p, b);
      const emptyList = m === 'GET' && Array.isArray(r.body) && !r.body.length;   // a list scoped to nothing is not a leak
      if ((r.status < 400 && !emptyList) || r.status >= 500) leaks.push(`${m} ${p} -> ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
    check(`${probes.length} cross-tenant requests all refused (4xx)`, !leaks.length, leaks.join(' | '));

    // reads must be real routes: tenant B itself can read what A was refused
    const reads = probes.filter(p => p[0] === 'GET' && !/\/(unpaid-|statement)/.test(p[1]));
    const dead = [];
    for (const [m, p] of reads) { const r = await cb(m, p); if (r.status >= 400) dead.push(`${p} -> ${r.status}`); }
    check('the same reads succeed for the owner (so the refusals above are not just missing routes)', !dead.length, dead.join(' | '));

    // ── B's records are untouched ──
    check('customer untouched', (await q1('SELECT name FROM customers WHERE id = @i', bc))?.name === 'B Customer');
    check('supplier untouched', (await q1('SELECT name FROM suppliers WHERE id = @i', bs))?.name === 'B Supplier');
    const it = await q1('SELECT model, stock FROM tires WHERE id = @i', bi);
    check('item untouched (name; stock moved only by its own sale)', it?.model === 'B24' && Number(it.stock) === 19, JSON.stringify(it));
    const sa = await q1('SELECT status, amount_paid FROM sales WHERE id = @i', bsale.id);
    check('sale untouched (not voided, payment kept)', sa && sa.status !== 'voided' && Number(sa.amount_paid) === 4 && !!(await q1('SELECT id FROM sale_payments WHERE id = @i', bpay.id)), JSON.stringify(sa));
    check('purchase untouched', (await q1('SELECT status FROM purchases WHERE id = @i', bpur.id))?.status === (bpur.status || 'pending'), JSON.stringify(await q1('SELECT status FROM purchases WHERE id = @i', bpur.id)));
    check('service untouched', (await q1('SELECT name FROM products WHERE id = @i', bprod))?.name === 'B Service');
    if (btt) check('tire type untouched', (await q1('SELECT name FROM tire_types WHERE id = @i', btt))?.name === 'B Type');
    if (bcat) check('category untouched', (await q1('SELECT name FROM item_categories WHERE id = @i', bcat))?.name === 'B Category');
    if (bwh) check('warehouse untouched', (await q1('SELECT name FROM warehouses WHERE id = @i', bwh))?.name === 'B Warehouse');
    if (bloc) check('location untouched', (await q1('SELECT name, warehouse_id FROM stock_locations WHERE id = @i', bloc))?.name === 'B Shelf');
    if (brole) check('role untouched', (await q1('SELECT name FROM access_roles WHERE id = @i', brole))?.name === 'B Role');
    const bu = await q1('SELECT name, is_active, role FROM users WHERE id = @i', bUid);
    check('user untouched', bu && bu.name === 'admin24b' && bu.is_active && bu.role === 'org_admin', JSON.stringify(bu));
    check('branch untouched', (await q1('SELECT name, is_active FROM branches WHERE id = @i', B.br))?.name === 'Main');
    const aud = Number((await pool.request().input('o', sql.Int, A.org).query("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = @o AND (before_json LIKE '%B Customer%' OR before_json LIKE '%B Service%' OR before_json LIKE '%B24%')")).recordset[0].n);
    check("tenant B's data never lands in tenant A's audit log", aud === 0, aud);
    } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of [A.org, B.org]) {
      for (const q of ['DELETE FROM location_access WHERE location_id IN (SELECT id FROM stock_locations WHERE organization_id=@o)', 'DELETE FROM products WHERE organization_id=@o', 'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM tire_types WHERE organization_id=@o', 'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM purchase_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
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
    const left = (await pool.request().query("SELECT COUNT(*) AS n FROM organizations WHERE name LIKE 'SMOKE ORG24%'")).recordset[0].n;
    if (left) console.log('WARN leftover orgs', left);
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
