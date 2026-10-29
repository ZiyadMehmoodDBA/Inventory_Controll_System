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
  const tok = (role, b = null) => jwt.sign({ userId: 1001, orgId: org, branchId: b, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok('org_admin'), staff = tok('staff', br);
  const call = async (m, p, t, body) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  try {
    let r = await call('POST', '/inventory/categories', admin, { name: 'Perfume' });
    check('create category', r.status === 201 && r.body.name === 'Perfume', JSON.stringify(r.body));
    const cat = r.body.id;
    r = await call('POST', '/inventory/categories', admin, { name: 'Perfume' });
    check('duplicate category 409', r.status === 409, JSON.stringify(r.body));
    r = await call('POST', '/inventory/categories', staff, { name: 'X' });
    check('staff cannot create category', r.status === 403, JSON.stringify(r.body));

    const base = { brand: 'Dior', model: 'Sauvage', size: '100ml', stock: 4, cost_price: 50, sale_price: 90 };
    r = await call('POST', '/inventory', admin, { ...base, barcode: '123456', category_id: cat, uom: 'pcs', description: 'EDT' });
    check('item created with category/barcode, auto SKU', r.status === 201 && /^SKU-\d{6}$/.test(r.body.sku) && r.body.barcode === '123456' && r.body.category_id === cat, JSON.stringify(r.body));
    const id = r.body.id, sku = r.body.sku;
    r = await call('POST', '/inventory', admin, { ...base, model: 'Other', barcode: '123456' });
    check('duplicate barcode 409', r.status === 409 && r.body.code === 'DUPLICATE_IDENTIFIER' && /barcode/.test(r.body.error), JSON.stringify(r.body));
    r = await call('POST', '/inventory', admin, { ...base, model: 'Third', sku });
    check('duplicate SKU 409', r.status === 409 && /SKU/.test(r.body.error), JSON.stringify(r.body));
    r = await call('POST', '/inventory', admin, { ...base, model: 'Bad', category_id: 999999 });
    check('unknown category 400', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory', admin, { ...base, model: 'Odd', uom: 'bogus' });
    check('unknown uom is rejected', r.status === 400 && r.body.code === 'INVALID_UOM', JSON.stringify(r.body));

    r = await call('GET', '/inventory/lookup?code=123456', admin);
    check('lookup by barcode', r.status === 200 && r.body.id === id, JSON.stringify(r.body));
    r = await call('GET', `/inventory/lookup?code=${sku}`, admin);
    check('lookup by SKU', r.status === 200 && r.body.id === id, JSON.stringify(r.body));
    r = await call('GET', '/inventory/lookup?code=nope', admin);
    check('lookup miss 404', r.status === 404);

    r = await call('PUT', `/inventory/${id}`, admin, { ...base, barcode: '123456', category_id: cat, uom: 'set', is_active: false, reorder_level: 5 });
    check('update keeps SKU, changes uom, deactivates', r.status === 200 && r.body.sku === sku && r.body.uom === 'set' && r.body.is_active === false, JSON.stringify(r.body));
    r = await call('GET', '/inventory/lookup?code=123456', admin);
    check('inactive item not returned by lookup', r.status === 404, JSON.stringify(r.body));

    r = await call('GET', '/inventory/categories', admin);
    check('category item_count', r.status === 200 && r.body.find(c => c.id === cat)?.item_count === 1, JSON.stringify(r.body));
    r = await call('DELETE', `/inventory/categories/${cat}`, admin);
    check('delete in-use category 409', r.status === 409 && r.body.code === 'CATEGORY_IN_USE', JSON.stringify(r.body));
    r = await call('PUT', `/inventory/${id}`, admin, { ...base, category_id: null, reorder_level: 5 });
    r = await call('DELETE', `/inventory/categories/${cat}`, admin);
    check('delete unused category', r.status === 200, JSON.stringify(r.body));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of ['DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
      'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 30), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
