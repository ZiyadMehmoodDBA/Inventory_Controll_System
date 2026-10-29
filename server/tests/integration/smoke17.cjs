// Architecture guarantees: versioned migrations, append-only history, database constraints, request validation, one error shape,
// concurrency control on stock, and "no token, no data" on every inventory-related API.
process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const migrations = require('../../migrations');
const { v, validate } = require('../../utils/validate');
const { describe } = require('../../utils/errors');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 500)}`); };
const day = n => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG17', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Sup', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR))")).recordset[0].id;
  const admin = (await pool.request().input('o', sql.Int, org).query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES ('s17', 's17' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR) + '@smoke17.test', 'x', 'org_admin', @o)")).recordset[0].id;
  const T = jwt.sign({ userId: admin, orgId: org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const call = async (m, p, body, t = T) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}), 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const purged = q => pool.request().query("EXEC sp_set_session_context N'allow_purge', 1; " + q);
  try {
    // ── versioned migrations ──
    const applied = (await pool.request().query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).recordset;
    const files = migrations.list();
    check('baseline and every migration file are recorded', applied[0].version === 0 && files.every(f => applied.some(a => a.version === f.version && a.checksum === f.checksum)), JSON.stringify(applied.map(a => a.version)));
    check('migration versions are unique and ordered', new Set(files.map(f => f.version)).size === files.length && files.every((f, i) => i === 0 || f.version > files[i - 1].version));
    await migrations.run(pool, () => {});
    check('running migrations again changes nothing', (await pool.request().query('SELECT COUNT(*) AS n FROM schema_migrations')).recordset[0].n === applied.length);
    await Promise.all([migrations.run(pool, () => {}), migrations.run(pool, () => {})]);
    check('two migrators at once are safe', (await pool.request().query('SELECT COUNT(*) AS n FROM schema_migrations')).recordset[0].n === applied.length);

    // ── data for the rest ──
    const I = (await call('POST', '/inventory', { model: 'Arch item', cost_price: 10, sale_price: 20, stock: 0 })).body.id;
    let r = await call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: I, tire_name: 'x', qty: 10, unit_price: 10 }] });
    check('seed stock received', r.status === 201, JSON.stringify(r.body));

    // ── append-only history ──
    const mv = (await pool.request().input('t', sql.Int, I).query('SELECT TOP 1 id, qty_change FROM stock_movements WHERE tire_id = @t ORDER BY id')).recordset[0];
    const refuses = async q => { try { await pool.request().query(q); return false; } catch (e) { return /append-only|CHECK constraint/.test(e.message); } };
    check('a movement cannot be deleted', await refuses(`DELETE FROM stock_movements WHERE id = ${mv.id}`));
    check('a movement quantity cannot be rewritten', await refuses(`UPDATE stock_movements SET qty_change = 99 WHERE id = ${mv.id}`));
    check('a movement reason cannot be rewritten', await refuses(`UPDATE stock_movements SET reason = 'x' WHERE id = ${mv.id}`));
    check('a movement date cannot be rewritten', await refuses(`UPDATE stock_movements SET created_at = '2000-01-01' WHERE id = ${mv.id}`));
    check('a movement cost may still be filled in by costing', !(await refuses(`UPDATE stock_movements SET unit_cost = 11 WHERE id = ${mv.id}`)));
    check('an update that matches nothing is harmless', !(await refuses('UPDATE stock_movements SET unit_cost = 1 WHERE id = -1')));
    check('the movement is unchanged', (await pool.request().query(`SELECT qty_change FROM stock_movements WHERE id = ${mv.id}`)).recordset[0].qty_change === mv.qty_change);
    await call('PUT', `/inventory/${I}`, { model: 'Arch item', cost_price: 10, sale_price: 21, stock: 10 });
    const aud = (await pool.request().input('o', sql.Int, org).query('SELECT TOP 1 id FROM audit_logs WHERE organization_id = @o ORDER BY id')).recordset[0];
    check('the audit log has entries for these actions', !!aud);
    check('an audit entry cannot be deleted', await refuses(`DELETE FROM audit_logs WHERE id = ${aud.id}`));
    check('an audit entry cannot be edited', await refuses(`UPDATE audit_logs SET action = 'X' WHERE id = ${aud.id}`));
    check('the app reports an append-only violation as IMMUTABLE', describe(Object.assign(new Error('x append-only y'), { number: 51000 })).body.code === 'IMMUTABLE');

    // ── database constraints ──
    const bad = async q => { try { await pool.request().query(q); return false; } catch (e) { return /CHECK constraint/i.test(e.message); } };
    check('a zero-quantity movement is refused', await bad(`INSERT INTO stock_movements (tire_id, organization_id, branch_id, qty_change, reason, item_name) VALUES (${I}, ${org}, ${br}, 0, 'x', 'x')`));
    check('a movement whose balance does not add up is refused', await bad(`INSERT INTO stock_movements (tire_id, organization_id, branch_id, qty_change, reason, qty_before, qty_after, item_name) VALUES (${I}, ${org}, ${br}, 5, 'x', 10, 99, 'x')`));
    check('an adjustment with an unknown status is refused', await bad(`INSERT INTO stock_adjustments (organization_id, branch_id, tire_id, qty_change, reason_code, status, requested_by) VALUES (${org}, ${br}, ${I}, 1, 'damage', 'maybe', ${admin})`));
    check('a negative approval limit is refused', await bad(`INSERT INTO access_roles (organization_id, name, base_role, permissions, approval_limit, is_builtin) VALUES (${org}, 'neg', 'staff', '[]', -1, 0)`));

    // ── validation and the common error shape ──
    r = await call('POST', '/users', { name: '', email: 'nope', password: 'short' });
    check('validation failure is 400 VALIDATION_FAILED with field details', r.status === 400 && r.body.code === 'VALIDATION_FAILED' && r.body.fields && Object.keys(r.body.fields).length >= 2 && typeof r.body.error === 'string', JSON.stringify(r.body));
    r = await call('POST', '/access/roles', { name: 'x'.repeat(200), base_role: 'staff', permissions: 'all' });
    check('wrong types and overlong text are refused', r.status === 400 && r.body.code === 'VALIDATION_FAILED' && r.body.fields.permissions && r.body.fields.name, JSON.stringify(r.body));
    r = await call('PUT', '/access/policy', { restricted_reasons: 'damage' });
    check('a list field must be a list', r.status === 400 && r.body.code === 'VALIDATION_FAILED');
    const raw = await fetch(BASE + '/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}` }, body: '{not json' });
    const rawBody = await raw.json();
    check('malformed JSON is 400 INVALID_JSON, not a stack trace', raw.status === 400 && rawBody.code === 'INVALID_JSON' && !/at /.test(JSON.stringify(rawBody)), JSON.stringify(rawBody));
    r = await call('GET', '/inventory/999999999');
    check('a missing record is a clean 404 with a code', r.status === 404 && r.body.error, JSON.stringify(r.body));
    r = await call('GET', '/inventory/insights/reports/nope');
    check('an unknown report is a 4xx with a code', r.status >= 400 && r.status < 500 && r.body.code, JSON.stringify(r.body));
    const v1 = (() => { try { validate({ n: '12abc' }, { n: v.number() }); return null; } catch (e) { return e; } })();
    check('"12abc" is not a number', v1 && v1.status === 400 && v1.fields?.n === undefined && v1.details.fields.n);
    check('unknown fields are dropped', Object.keys(validate({ a: 'x', b: 'y' }, { a: v.string() })).join() === 'a');
    check('numeric strings and trimming are applied', JSON.stringify(validate({ a: ' hi ', n: '5' }, { a: v.string(), n: v.int() })) === '{"a":"hi","n":5}');

    // ── concurrency: parallel stock-outs cannot oversell ──
    const C = (await call('POST', '/inventory', { model: 'Race item', cost_price: 5, sale_price: 9, stock: 0 })).body.id;
    await call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: C, tire_name: 'x', qty: 10, unit_price: 5 }] });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call('POST', '/inventory/adjustments', { tire_id: C, qty_change: -3, reason_code: 'damage', notes: `race ${i}` })));
    const ok = results.filter(x => x.status === 201).length;
    const stock = (await call('GET', `/inventory/${C}`)).body.stock;
    check('8 parallel write-offs of 3 against 10 units: at most 3 succeed', ok <= 3 && ok >= 1, JSON.stringify(results.map(x => x.status)));
    check('stock never goes negative and equals 10 minus what succeeded', stock >= 0 && stock === 10 - 3 * ok, `stock ${stock}, ok ${ok}`);
    const sales = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/sales', { date: day(0), items: [{ tire_id: C, qty: 1, unit_price: 9 }], tax_rate: 0 })));
    const stock2 = (await call('GET', `/inventory/${C}`)).body.stock;
    check('parallel sales never sell more than exists', stock2 >= 0 && stock2 === stock - sales.filter(x => x.status === 201).length, `stock ${stock2}`);
    r = await call('GET', '/inventory/reconciliation');
    check('ledger reconciles after the race', r.body.mismatches === 0 && r.body.location_mismatches === 0, JSON.stringify(r.body).slice(0, 200));
    const idem = { tire_id: C, qty_change: 1, reason_code: 'found', notes: 'idem' };
    const k = 'smoke17-' + Date.now();
    const post = () => fetch(BASE + '/inventory/adjustments', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T}`, 'X-Branch-ID': String(br), 'Idempotency-Key': k }, body: JSON.stringify(idem) }).then(x => x.status);
    const twice = await Promise.all([post(), post()]);
    const after = (await call('GET', `/inventory/${C}`)).body.stock;
    check('a repeated request with the same Idempotency-Key is applied once', after === stock2 + 1, JSON.stringify([twice, after, stock2]));

    // ── no token, no data ──
    const open = ['/inventory', '/inventory/locations', '/inventory/valuation', '/inventory/reconciliation', '/inventory/insights/dashboard', '/inventory/insights/reports', '/inventory/replenishment',
      '/inventory/losses/register', '/inventory/quality', '/inventory/hazmat/classes', '/inventory/counts', '/inventory/reservations', '/inventory/adjustments', '/inventory/transfers',
      '/purchases', '/suppliers', '/sales', '/users', '/audit', '/access/me', '/access/roles', '/access/policy', '/settings'];
    const leaks = [];
    for (const p of open) { const x = await call('GET', p, null, null); if (x.status !== 401) leaks.push(`${p}=${x.status}`); }
    check('every inventory, purchasing, user and audit API refuses an anonymous caller', leaks.length === 0, leaks.join(' '));
    const forged = jwt.sign({ userId: admin, orgId: org, branchId: null, role: 'org_admin' }, 'not-the-secret');
    check('a token signed with another secret is refused', (await call('GET', '/inventory', null, forged)).status === 401);
    const expired = jwt.sign({ userId: admin, orgId: org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: -10 });
    check('an expired token is refused', (await call('GET', '/inventory', null, expired)).status === 401);
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [`DELETE FROM stock_movements WHERE organization_id=${org}`, `DELETE FROM stock_adjustments WHERE organization_id=${org}`,
      `DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=${org})`, `DELETE FROM sales WHERE organization_id=${org}`,
      `DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=${org})`, `DELETE FROM purchases WHERE organization_id=${org}`,
      `DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=${org})`, `DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=${org})`,
      `DELETE FROM stock_batches WHERE organization_id=${org}`, `DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=${org})`,
      `DELETE FROM stock_locations WHERE organization_id=${org}`, `DELETE FROM warehouses WHERE organization_id=${org}`, `DELETE FROM product_history WHERE organization_id=${org}`,
      `DELETE FROM tires WHERE organization_id=${org}`, `DELETE FROM item_categories WHERE organization_id=${org}`, `DELETE FROM suppliers WHERE organization_id=${org}`,
      `DELETE FROM audit_logs WHERE organization_id=${org}`, `DELETE FROM idempotency_keys WHERE organization_id=${org}`, `DELETE FROM access_roles WHERE organization_id=${org}`,
      `DELETE FROM users WHERE organization_id=${org}`, `DELETE FROM branches WHERE organization_id=${org}`, `DELETE FROM settings WHERE organization_id=${org}`, `DELETE FROM organizations WHERE id=${org}`]) {
      try { await purged(q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
