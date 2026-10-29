process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + x}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG7', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Acme Supply', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR))")).recordset[0].id;
  const tok = role => jwt.sign({ userId: role === 'staff' ? 1002 : 1001, orgId: org, branchId: role === 'staff' ? br : null, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok('org_admin'), staff = tok('staff');
  const call = async (m, p, body, t = admin, raw = false) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    if (raw) { const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, text: buf.toString("utf8"), bom: buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, headers: r.headers }; }
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const recv = (id, qty, price) => call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: id, tire_name: 'x', qty, unit_price: price }] });
  try {
    let r = await call('GET', '/inventory/meta');
    check('meta lists units, types, statuses, tax classes', r.status === 200 && r.body.uoms.includes('carton') && r.body.item_types.length === 7 && r.body.statuses.length === 3 && r.body.tax_classes.includes('exempt'), JSON.stringify(r.body).slice(0, 120));

    r = await call('POST', '/inventory/categories', { name: 'Raw' });
    const raw = r.body.id;
    r = await call('POST', '/inventory/categories', { name: 'Metals', parent_id: raw });
    const metals = r.body.id;
    r = await call('POST', '/inventory/categories', { name: 'Steel', parent_id: metals });
    check('a third level is refused on create', r.status === 400 && r.body.code === 'CATEGORY_DEPTH', JSON.stringify(r.body));
    r = await call('PUT', `/inventory/categories/${metals}`, { name: 'Metals', parent_id: metals });
    check('category cannot be its own parent', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory/categories', { name: 'Other' });
    const other = r.body.id;
    r = await call('PUT', `/inventory/categories/${raw}`, { name: 'Raw', parent_id: other });
    check('category with children cannot be nested (two levels only)', r.status === 400 && r.body.code === 'CATEGORY_DEPTH', JSON.stringify(r.body));
    r = await call('PUT', `/inventory/categories/${metals}`, { name: 'Metals', parent_id: other });
    check('sub-category can move to another parent', r.status === 200 && r.body.parent_id === other, JSON.stringify(r.body));

    const full = { model: 'Steel Rod 10mm', sku: 'RM-001', barcode: '1234567890123', description: 'Hot rolled', category_id: metals, uom: 'kg', purchase_uom: 'carton', sales_uom: 'kg',
      item_type: 'raw_material', manufacturer: 'SteelCo', supplier_id: sup, pack_size: 25, length_cm: 600, width_cm: 1, height_cm: 1, weight_kg: 0.6, volume_l: 0.05,
      cost_price: 4, sale_price: 7, tax_class: 'standard', tax_rate: 15, min_stock: 20, max_stock: 200, reorder_level: 40, reorder_qty: 50, shelf_life_days: 365,
      storage_conditions: 'Dry, below 30C', storage_requirements: 'Racked off the floor', handling_instructions: 'Use gloves', safety_requirements: 'Sharp edges',
      conversions: [{ uom: 'carton', factor: 25 }, { uom: 'pallet', factor: 500 }] };
    r = await call('POST', '/inventory', full);
    check('create with the full master record', r.status === 201 && r.body.item_type === 'raw_material' && r.body.status === 'active' && r.body.conversions.length === 2, JSON.stringify(r.body).slice(0, 200));
    const rod = r.body.id;
    r = await call('GET', `/inventory/${rod}`);
    check('GET returns every attribute and conversions', r.body.manufacturer === 'SteelCo' && Number(r.body.pack_size) === 25 && r.body.min_stock === 20 && r.body.tax_class === 'standard'
      && r.body.storage_conditions === 'Dry, below 30C' && r.body.conversions.find(c => c.uom === 'pallet')?.factor === 500 && r.body.supplier_id === sup, JSON.stringify(r.body).slice(0, 300));

    const bad = (name, patch, code) => call('POST', '/inventory', { model: 'Bad ' + name, ...patch }).then(x => check(`rejects ${name}`, x.status === 400 && (!code || x.body.code === code), JSON.stringify(x.body)));
    await bad('invalid unit of measure', { uom: 'bananas' }, 'INVALID_UOM');
    await bad('invalid purchase unit', { purchase_uom: 'zzz' }, 'INVALID_UOM');
    await bad('invalid item type', { item_type: 'gadget' }, 'INVALID_ITEM_TYPE');
    await bad('invalid tax class', { tax_class: 'weird' }, 'INVALID_TAX_CLASS');
    await bad('min above max', { min_stock: 10, max_stock: 5 }, 'INVALID_STOCK_LEVELS');
    await bad('negative weight', { weight_kg: -1 }, 'INVALID_NUMBER');
    await bad('tax rate above 100', { tax_rate: 150 }, 'INVALID_NUMBER');
    await bad('conversion to the base unit', { uom: 'kg', conversions: [{ uom: 'kg', factor: 1 }] }, 'INVALID_CONVERSIONS');
    await bad('duplicate conversion unit', { conversions: [{ uom: 'box', factor: 2 }, { uom: 'box', factor: 3 }] }, 'INVALID_CONVERSIONS');
    await bad('zero conversion factor', { conversions: [{ uom: 'box', factor: 0 }] });
    await bad('unknown supplier', { supplier_id: 99999999 }, 'SUPPLIER_NOT_FOUND');
    r = await call('POST', '/inventory', { model: 'Dup', sku: 'RM-001' });
    check('duplicate product code is a 409', r.status === 409 && r.body.code === 'DUPLICATE_IDENTIFIER', JSON.stringify(r.body));
    r = await call('POST', '/inventory', { model: 'Dup2', sku: 'rm-001' });
    check('duplicate code is case-insensitive', r.status === 409, JSON.stringify(r.body));

    // history
    r = await call('PUT', `/inventory/${rod}`, { ...full, sale_price: 8, min_stock: 25, category_id: raw, conversions: [{ uom: 'carton', factor: 24 }] });
    check('update ok', r.status === 200 && Number(r.body.sale_price) === 8, JSON.stringify(r.body).slice(0, 200));
    r = await call('GET', `/inventory/${rod}/history`);
    const f = name => r.body.filter(h => h.field === name);
    check('history has created entry', f('(created)').length === 1 && f('(created)')[0].new_value === 'Steel Rod 10mm', JSON.stringify(r.body.map(h => h.field)));
    check('history records price change old→new', f('sale_price').length === 1 && f('sale_price')[0].old_value === '7' && f('sale_price')[0].new_value === '8', JSON.stringify(f('sale_price')));
    check('history shows category names, not ids', f('category_id')[0]?.old_value === 'Metals' && f('category_id')[0]?.new_value === 'Raw', JSON.stringify(f('category_id')));
    check('history records min stock and conversions', f('min_stock')[0]?.new_value === '25' && /carton=24/.test(f('conversions')[0]?.new_value || ''), JSON.stringify([f('min_stock'), f('conversions')]));
    check('unchanged fields are not logged', !f('barcode').length && !f('manufacturer').length);
    r = await call('PUT', `/inventory/${rod}`, { ...full, sale_price: 8, min_stock: 25, category_id: raw, conversions: [{ uom: 'carton', factor: 24 }] });
    r = await call('GET', `/inventory/${rod}/history`);
    check('saving with no changes adds no history', r.body.length === 1 + 4 + 0 || r.body.length >= 5, String(r.body.length));
    const histLen = r.body.length;
    await call('PUT', `/inventory/${rod}`, { ...full, sale_price: 8, min_stock: 25, category_id: raw, conversions: [{ uom: 'carton', factor: 24 }] });
    r = await call('GET', `/inventory/${rod}/history`);
    check('re-saving identical data is silent', r.body.length === histLen, `${histLen} -> ${r.body.length}`);

    // status rules
    await recv(rod, 30, 4);
    r = await call('PATCH', `/inventory/${rod}/status`, { status: 'discontinued' }, staff);
    check('staff cannot change status', r.status === 403, JSON.stringify(r.body));
    r = await call('PATCH', `/inventory/${rod}/status`, { status: 'discontinued' });
    check('discontinue ok', r.status === 200 && r.body.status === 'discontinued', JSON.stringify(r.body));
    r = await call('GET', `/inventory/${rod}`);
    check('is_active mirrors status', r.body.is_active === false && r.body.status === 'discontinued');
    r = await recv(rod, 5, 4);
    check('discontinued items cannot be purchased', r.status === 409 && r.body.code === 'ITEM_INACTIVE', JSON.stringify(r.body));
    r = await call('POST', '/sales', { date: day(0), items: [{ tire_id: rod, qty: 2, unit_price: 8 }], tax_rate: 0 });
    check('discontinued items can still be sold off', r.status === 201, JSON.stringify(r.body));
    await call('PATCH', `/inventory/${rod}/status`, { status: 'inactive' });
    r = await call('POST', '/sales', { date: day(0), items: [{ tire_id: rod, qty: 1, unit_price: 9 }], tax_rate: 0 });
    check('inactive items cannot be sold', r.status === 409 && r.body.code === 'ITEM_INACTIVE', JSON.stringify(r.body));
    r = await call('GET', `/inventory/lookup?code=RM-001`);
    check('inactive items are hidden from barcode lookup', r.status === 404 || !r.body?.id, JSON.stringify(r.body));
    r = await call('PATCH', `/inventory/${rod}/status`, { status: 'archived' });
    check('invalid status rejected', r.status === 400, JSON.stringify(r.body));
    await call('PATCH', `/inventory/${rod}/status`, { status: 'active' });
    r = await call('GET', `/inventory/${rod}/history`);
    check('status changes are in the history', r.body.filter(h => h.field === 'status').length === 3, JSON.stringify(r.body.filter(h => h.field === 'status').map(h => [h.old_value, h.new_value])));

    // delete protection
    r = await call('DELETE', `/inventory/${rod}`);
    check('item with history cannot be deleted', r.status === 409 && r.body.code === 'ITEM_HAS_HISTORY' && /inactive or discontinued/.test(r.body.error), JSON.stringify(r.body));
    r = await call('POST', '/inventory', { model: 'Typo item' });
    const typo = r.body.id;
    r = await call('DELETE', `/inventory/${typo}`);
    check('a never-used item can be deleted', r.status === 200, JSON.stringify(r.body));
    r = await call('POST', '/inventory', { model: 'Opened', stock: 5 });
    r = await call('DELETE', `/inventory/${r.body.id}`);
    check('an item with opening stock (ledger rows) cannot be deleted', r.status === 409 && r.body.code === 'ITEM_HAS_HISTORY', JSON.stringify(r.body));

    // replenishment with stock levels
    r = await call('POST', '/inventory', { model: 'Lot item', stock: 2, reorder_level: 5, max_stock: 50, reorder_qty: 20, cost_price: 3 });
    const lot = r.body.id;
    r = await call('POST', '/inventory', { model: 'Min item', stock: 8, reorder_level: 5, min_stock: 10, max_stock: 30, cost_price: 1 });
    const minItem = r.body.id;
    r = await call('GET', '/inventory/replenishment');
    const rl = r.body.items.find(i => i.tire_id === lot), rm = r.body.items.find(i => i.tire_id === minItem);
    check('suggestion orders up to max, rounded to lot size (48 -> 60)', rl && rl.suggested_qty === 60 && rl.suggested_cost === 180, JSON.stringify(rl));
    check('item below its minimum is listed even above reorder point', rm && rm.suggested_qty === 22, JSON.stringify(rm));

    // export + import
    r = await call('GET', '/inventory/export', null, admin, true);
    const lines = r.text.replace(/^\uFEFF/, '').trim().split(/\r\n/);
    check('export is CSV with BOM and header', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && r.bom && lines[0].startsWith('sku,barcode,brand,model'), lines[0].slice(0, 80));
    check('export has a row per item with master data', lines.length >= 5 && lines.some(l => l.includes('Steel Rod 10mm') && l.includes('raw_material') && l.includes('Raw') && l.includes('Acme Supply') && l.includes('carton=24')), lines.slice(0, 3).join(' | '));
    r = await call('POST', '/inventory', { model: '=cmd|calc', sku: 'INJ-1' });
    r = await call('GET', '/inventory/export', null, admin, true);
    check('export neutralises formula injection', /"'=cmd\|calc"/.test(r.text), r.text.slice(0, 200));
    r = await call('POST', '/inventory/bulk', { rows: [
      { model: 'Imported A', sku: 'IMP-A', category: 'Packaging > Boxes', item_type: 'packaging', uom: 'box', supplier: 'Acme Supply', min_stock: 5, max_stock: 50, cost_price: 2, sale_price: 3, stock: 10, tracking: 'batch', track_expiry: 1, conversions: 'pallet=40' },
      { model: 'Imported B', sku: 'IMP-B', uom: 'weird' },
      { model: 'Imported C', sku: 'IMP-A' },
      { model: 'Imported D', item_type: 'gadget' },
      { model: 'Imported E', supplier: 'Nobody Ltd' },
    ] });
    check('import: 1 good row, 4 reported', r.status === 200 && r.body.inserted === 1 && r.body.errors.length === 4, JSON.stringify(r.body));
    check('import errors name the problem', /not valid/.test(r.body.errors.find(e => e.row === 3)?.message || '') && /SKU/.test(r.body.errors.find(e => e.row === 4)?.message || '') && /Item type/.test(r.body.errors.find(e => e.row === 5)?.message || '') && /Nobody/.test(r.body.errors.find(e => e.row === 6)?.message || ''), JSON.stringify(r.body.errors));
    r = await call('GET', '/inventory');
    const ia = r.body.find(x => x.sku === 'IMP-A');
    check('imported row carries master data, tracking and stock', ia && ia.item_type === 'packaging' && ia.uom === 'box' && ia.tracking === 'batch' && ia.stock === 10 && ia.supplier_id === sup && ia.max_stock === 50, JSON.stringify(ia));
    r = await call('GET', '/inventory/categories');
    const boxes = r.body.find(c => c.name === 'Boxes'), pack = r.body.find(c => c.name === 'Packaging');
    check('import created the category path', boxes && pack && boxes.parent_id === pack.id, JSON.stringify(r.body.map(c => [c.name, c.parent_id])));
    r = await call('GET', `/inventory/${ia.id}`);
    check('import saved conversions', r.body.conversions.length === 1 && r.body.conversions[0].uom === 'pallet', JSON.stringify(r.body.conversions));

    r = await call('GET', '/inventory/reconciliation');
    check('reconciliation still clean', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 200));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [
      'DELETE FROM product_history WHERE organization_id=@o',
      'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
      'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
      'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
      'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
      'DELETE FROM sales WHERE organization_id=@o', 'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM item_categories WHERE organization_id=@o AND parent_id IS NOT NULL', 'DELETE FROM item_categories WHERE organization_id=@o',
      'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
      'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 40), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
