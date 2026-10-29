process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + x}`); };
(async () => {
  const pool = await getPool();
  const mkOrg = async type => {
    const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    await pool.request().input('o', sql.Int, org).input('t', sql.NVarChar, type).query("INSERT INTO settings (organization_id, [key], value) VALUES (@o, 'business_type', @t)");
    const token = jwt.sign({ userId: 1001, orgId: org, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const call = async (m, p, body) => {
      const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
    };
    return { org, br, call };
  };
  const orgs = [];
  try {
    // ── pharmacy ──
    const ph = await mkOrg('pharmacy'); orgs.push(ph.org);
    let r = await ph.call('POST', '/inventory/categories', { name: 'Painkillers' });
    const cat = r.body.id;
    r = await ph.call('POST', '/inventory', { model: 'Panadol', size: '500mg', category_id: cat, stock: 50, cost_price: 2, sale_price: 3 });
    check('pharmacy: item with name only (no brand) saved, no tyre type', r.status === 201 && r.body.brand === '' && r.body.type === null && r.body.stock === 50, JSON.stringify(r.body));
    const sku = r.body.sku;
    r = await ph.call('POST', '/inventory', { brand: 'GSK', size: '10' });
    check('pharmacy: name is required', r.status === 400 && /name/i.test(r.body.error), JSON.stringify(r.body));
    r = await ph.call('POST', '/inventory/bulk', { rows: [{ name: 'x', model: 'Brufen', size: '400mg', stock: 10, cost_price: 1, sale_price: 2, sku: 'BRF-1', barcode: '999' }, { brand: 'only brand' }] });
    check('pharmacy: bulk import accepts name rows, rejects empty', r.status === 200 && r.body.inserted === 1 && r.body.errors.length === 1, JSON.stringify(r.body));
    r = await ph.call('GET', '/inventory/lookup?code=BRF-1');
    check('pharmacy: bulk import kept supplied SKU', r.status === 200 && r.body.model === 'Brufen' && r.body.sku === 'BRF-1', JSON.stringify(r.body));

    await ph.call('POST','/customers',{name:'Walk-in Patient'}); await ph.call('POST','/suppliers',{name:'Medico'});
    // sales bulk import resolves by name, by SKU and by barcode
    r = await ph.call('POST', '/sales/bulk', { invoices: [
      { invoice_ref: 'A1', customer_name: 'Walk-in Patient', date: '2026-10-28', items: [{ item_name: 'Panadol', qty: 2, unit_price: 3 }] },
      { invoice_ref: 'A2', customer_name: 'Walk-in Patient', date: '2026-10-28', items: [{ item_name: sku, qty: 3, unit_price: 3 }] },
      { invoice_ref: 'A3', customer_name: 'Walk-in Patient', date: '2026-10-28', items: [{ item_name: '999', qty: 4, unit_price: 2 }] },
    ] });
    check('sales import matches by name, SKU and barcode', r.status === 200 && r.body.inserted === 3 && !(r.body.errors || []).length, JSON.stringify(r.body));
    r = await ph.call('GET', '/inventory');
    const pan = r.body.find(i => i.model === 'Panadol'), bru = r.body.find(i => i.model === 'Brufen');
    check('stock deducted for each matched line (50-2-3=45, 10-4=6)', pan.stock === 45 && bru.stock === 6, JSON.stringify([pan.stock, bru.stock]));
    r = await ph.call('GET', '/sales/by-tire-type');
    check('dashboard breakdown groups by category for non-tyre', r.status === 200 && r.body.some(x => x.tire_type === 'Painkillers') && r.body.some(x => x.tire_type === 'Uncategorised'), JSON.stringify(r.body));
    r = await ph.call('POST', '/purchases/bulk', { pos: [{ po_ref: 'P1', supplier_name: 'Medico', date: '2026-10-28', status: 'received', items: [{ item_name: 'Panadol', qty: 5, unit_price: 2 }] }] });
    check('purchase import matches by name', r.status === 200 && r.body.inserted === 1, JSON.stringify(r.body));

    r = await ph.call('GET', '/lookups/tire-suggestions');
    check('pharmacy suggestions: only own brands, no tyre catalog', r.status === 200 && r.body.brands.length === 0 || (r.status === 200 && !r.body.brands.includes('Bridgestone') && !r.body.brands.includes('Michelin')), JSON.stringify(r.body.brands.slice(0,5)));
    check('pharmacy suggestions include own item names', r.body.models.some(m => m.model === 'Panadol'), JSON.stringify(r.body.models));
    // ── tyre shop ──
    const ty = await mkOrg('tyre_shop'); orgs.push(ty.org);
    r = await ty.call('POST', '/inventory', { model: 'Ecopia' });
    check('tyre shop: brand/model/size required', r.status === 400 && /size/.test(r.body.error), JSON.stringify(r.body));
    r = await ty.call('POST', '/inventory', { brand: 'Bridgestone', model: 'Ecopia', size: '195/65R15', stock: 8 });
    check('tyre shop: default type Passenger', r.status === 201 && r.body.type === 'Passenger', JSON.stringify(r.body));
    r = await ty.call('GET', '/lookups/tire-suggestions');
    check('tyre shop suggestions include catalog brands', r.status === 200 && r.body.brands.includes('Bridgestone') && r.body.brands.length > 10, String(r.body.brands.length));
    r = await ty.call('GET', '/sales/by-tire-type');
    check('tyre shop breakdown endpoint ok', r.status === 200, JSON.stringify(r.body));
    const cr = await ty.call('POST','/customers',{name:'Ahmed'}); console.log('cust:', cr.status, JSON.stringify(cr.body).slice(0,120));
    r = await ty.call('POST', '/sales/bulk', { invoices: [{ invoice_ref: 'T1', customer_name: 'Ahmed', date: '2026-10-28', items: [{ item_name: 'Bridgestone Ecopia 195/65R15', qty: 2, unit_price: 12000 }] }] });
    check('tyre shop: full-name import still matches', r.status === 200 && r.body.inserted === 1, JSON.stringify(r.body));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of orgs) for (const q of [
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchase_payments WHERE organization_id=@o',
      'DELETE FROM sales WHERE organization_id=@o', 'DELETE FROM purchases WHERE organization_id=@o', 'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o',
      'DELETE FROM tires WHERE organization_id=@o', 'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM customers WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o',
      'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, o).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 30), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
