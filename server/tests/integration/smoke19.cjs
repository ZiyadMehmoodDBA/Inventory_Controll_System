// Security regressions: no password-reset token for anonymous callers, Google sign-in fails closed, money routes need authority,
// a sale cannot reference another organisation's customer.
process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 400)}`); };

(async () => {
  const pool = await getPool();
  const mk = async nm => {
    const org = (await pool.request().input('n', sql.NVarChar(100), nm).query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@n, 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    return { org, br };
  };
  const A = await mk('SMOKE ORG19'), B = await mk('SMOKE ORG19B');
  const email = `victim${Date.now()}@smoke19.test`;
  const uid = (await pool.request().input('o', sql.Int, A.org).input('e', sql.NVarChar(100), email).query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES ('victim', @e, 'x', 'org_admin', @o)")).recordset[0].id;
  const custB = (await pool.request().input('o', sql.Int, B.org).query("INSERT INTO customers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'B customer', 'C' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR))")).recordset[0].id;
  const tok = (o, role, id, br) => jwt.sign({ userId: id, orgId: o.org, branchId: role === 'org_admin' ? null : br, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok(A, 'org_admin', uid), staff = tok(A, 'staff', 424242, A.br);
  const call = async (m, p, body, t) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}), 'X-Branch-ID': String(A.br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  try {
    let r = await call('POST', '/auth/forgot-password', { email });
    check('forgot-password hands out no token', r.status === 200 && !('resetToken' in r.body) && !JSON.stringify(r.body).match(/eyJ/), JSON.stringify(r.body));
    const r2 = await call('POST', '/auth/forgot-password', { email: `nobody${Date.now()}@smoke19.test` });
    check('same answer for an unknown account (no enumeration)', r2.status === 200 && JSON.stringify(r2.body) === JSON.stringify(r.body), JSON.stringify(r2.body));
    const forged = jwt.sign({ userId: uid, type: 'password-reset' }, 'attacker-secret', { expiresIn: '1h' });
    r = await call('POST', '/auth/reset-password', { resetToken: forged, newPassword: 'hacked-password-1' });
    check('a forged reset token is refused', r.status >= 400 && r.status < 500, JSON.stringify(r));
    const row = (await pool.request().input('i', sql.Int, uid).query('SELECT password_hash FROM users WHERE id = @i')).recordset[0];
    check('the password was not changed', row.password_hash === 'x');
    r = await call('POST', '/auth/google', { credential: 'not-a-real-token' });
    check('Google sign-in without a configured client id fails closed (or rejects the token)', (r.status === 503 && /not configured/.test(r.body.error)) || r.status === 401, JSON.stringify(r));

    r = await call('DELETE', '/payments/sale/1', null, staff);
    check('staff cannot reverse a sale payment', r.status === 403, JSON.stringify(r));
    r = await call('DELETE', '/payments/purchase/1', null, staff);
    check('staff cannot reverse a purchase payment', r.status === 403 && r.body.code === 'FORBIDDEN', JSON.stringify(r));
    r = await call('POST', '/payments/purchase', { purchase_id: 1, amount: 10 }, staff);
    check('staff cannot record a purchase payment', r.status === 403 && r.body.code === 'FORBIDDEN', JSON.stringify(r));
    check('anonymous caller cannot reach payments', (await call('DELETE', '/payments/sale/1', null, null)).status === 401);
    r = await call('DELETE', '/payments/sale/999999999', null, admin);
    check('an administrator is allowed through (and gets a clean not-found)', r.status === 404 || r.status === 400, JSON.stringify(r));

    const item = (await call('POST', '/inventory', { model: 'S19', cost_price: 1, sale_price: 2, stock: 5 }, admin)).body.id;
    r = await call('POST', '/sales', { customer_id: custB, date: new Date().toISOString().slice(0, 10), items: [{ tire_id: item, qty: 1, unit_price: 2 }], tax_rate: 0 }, admin);
    check("a sale cannot use another organisation's customer", r.status === 400 && r.body.code === 'INVALID_CUSTOMER', JSON.stringify(r));
    r = await call('POST', '/sales', { date: new Date().toISOString().slice(0, 10), items: [{ tire_id: item, qty: 1, unit_price: 2 }], tax_rate: 0 }, admin);
    check('a walk-in sale still works', r.status === 201, JSON.stringify(r));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of [A.org, B.org]) {
      for (const q of ['DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sales WHERE organization_id=@o', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
        'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o', 'DELETE FROM warehouses WHERE organization_id=@o',
        'DELETE FROM product_history WHERE organization_id=@o', 'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
        'DELETE FROM customers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o', 'DELETE FROM access_roles WHERE organization_id=@o',
        'DELETE FROM users WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o']) {
        try { await pool.request().input('o', sql.Int, o).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); }
      }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
