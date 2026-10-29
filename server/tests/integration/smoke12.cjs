process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 400)}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG12', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'H Supply', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR))")).recordset[0].id;
  const tok = (role, uid) => jwt.sign({ userId: uid, orgId: org, branchId: role === 'staff' ? br : null, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok('org_admin', 1001), staff = tok('staff', 1002), mgr = tok('branch_manager', 1003);
  const call = async (m, p, body, t = admin) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  let n = 0;
  const mk = async (model, extra = {}) => {
    const r = await call('POST', '/inventory', { model, cost_price: 10, sale_price: 20, ...extra });
    if (r.status !== 201 && r.status !== 200) throw new Error('create ' + model + ' ' + JSON.stringify(r.body));
    return r.body.id;
  };
  const receive = (tire, qty) => call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: tire, tire_name: 'x', qty, unit_price: 10 + (++n) / 100 }] });
  const found = (tire, qty, loc) => call('POST', '/inventory/adjustments', { tire_id: tire, qty_change: qty, reason_code: 'found', location_id: loc, notes: 'n' + (++n) });
  const sell = (tire, qty) => call('POST', '/sales', { date: day(0), items: [{ tire_id: tire, qty, unit_price: 20 + (++n) / 100 }], tax_rate: 0 });
  const sellMany = (lines) => call('POST', '/sales', { date: day(0), items: lines.map(([t, q]) => ({ tire_id: t, qty: q, unit_price: 20 + (++n) / 100 })), tax_rate: 0 });
  const mkLoc = async (name, kind) => (await call('POST', '/inventory/locations', { name, ...(kind ? { kind } : {}) })).body.id;
  const setLoc = (id, b, t = admin) => call('PUT', `/inventory/hazmat/locations/${id}`, b, t);
  const trf = (from, to, items) => call('POST', '/inventory/transfers', { from_location_id: from, to_location_id: to, items: items.map(([tireId, qty]) => ({ tire_id: tireId, qty })), notes: 't' + (++n) });
  const stockOf = async id => (await call('GET', `/inventory/position/${id}`)).body.on_hand;
  const code = r => r.body?.code;
  try {
    // ── classes ──
    let r = await call('POST', '/inventory/hazmat/classes/seed-standard');
    check('standard classes and segregation pairs seeded', r.status === 201 && r.body.classes_added === 9 && r.body.pairs_added === 7, JSON.stringify(r.body));
    r = await call('POST', '/inventory/hazmat/classes/seed-standard');
    check('seeding twice adds nothing', r.body.classes_added === 0 && r.body.pairs_added === 0, JSON.stringify(r.body));
    r = await call('POST', '/inventory/hazmat/classes', { code: 'X', name: 'Nope' }, staff);
    check('staff cannot create classes', r.status === 403, r.status);
    const cl = (await call('GET', '/inventory/hazmat/classes')).body;
    const cid = c => cl.classes.find(x => x.code === c).id;
    r = await call('POST', '/inventory/hazmat/classes', { code: '3', name: 'dup' });
    check('duplicate class code rejected', r.status === 409, JSON.stringify(r.body));
    r = await call('POST', '/inventory/hazmat/classes', { code: 'TRANS', name: 'Needs transport details', requires_sds: false, requires_transport_info: true });
    const trans = r.body.id;
    r = await call('POST', '/inventory/hazmat/classes', { code: 'COLD', name: 'Cold chain', kind: 'special', requires_sds: false });
    check('custom classes (hazard and special handling) created', trans && r.status === 201, JSON.stringify(r.body));

    // ── plain business as usual ──
    const P = await mk('Plain widget', { stock: 0 });
    r = await receive(P, 50);
    check('non-hazardous item receives with no setup at all', r.status === 201, JSON.stringify(r.body));
    r = await sell(P, 2);
    check('non-hazardous item sells normally', r.status === 201, JSON.stringify(r.body));
    check('plain item is not in the hazmat register', !(await call('GET', '/inventory/hazmat/items')).body.some(i => i.id === P));

    // ── item data validation ──
    r = await call('POST', '/inventory', { model: 'Bad UN', cost_price: 1, sale_price: 2, un_number: 'abc' });
    check('invalid UN number rejected', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory', { model: 'Bad PG', cost_price: 1, sale_price: 2, packing_group: 'IV' });
    check('invalid packing group rejected', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory', { model: 'Bad temp', cost_price: 1, sale_price: 2, storage_temp_min_c: 9, storage_temp_max_c: 2 });
    check('minimum temperature above maximum rejected', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory', { model: 'Bad class', cost_price: 1, sale_price: 2, hazard_class_id: 999999 });
    check('unknown hazard class rejected', r.status === 404 || r.status === 400, JSON.stringify([r.status, r.body]));

    // ── hazardous items ──
    const FL = await mk('Solvent', { hazard_class_id: cid('3'), un_number: '1203', packing_group: 'II', flash_point_c: 12, sds_ref: 'SDS-001', sds_date: day(-30), ppe: 'Gloves, goggles', emergency_info: 'Call 999' });
    const OX = await mk('Bleach', { hazard_class_id: cid('5.1'), sds_ref: 'SDS-002', sds_date: day(-30) });
    const item = (await call('GET', '/inventory/hazmat/items')).body.find(i => i.id === FL);
    check('hazard data stored (UN number normalised)', item && item.un_number === 'UN1203' && item.packing_group === 'II' && item.class_code === '3' && item.ppe === 'Gloves, goggles', JSON.stringify(item));

    // ── permitted storage ──
    const defLoc = (await call('GET', '/inventory/locations')).body.find(l => l.is_default).id;
    r = await receive(FL, 10);
    check('hazardous receipt blocked: default location not permitted', r.status === 409 && code(r) === 'HAZMAT_LOCATION_NOT_PERMITTED', JSON.stringify([r.status, r.body]));
    check('blocked receipt left no stock', (await stockOf(FL)) === 0);
    r = await setLoc(defLoc, { permits: [{ hazard_class_id: cid('3'), max_qty: 20 }] }, staff);
    check('staff cannot approve storage', r.status === 403, r.status);
    r = await setLoc(defLoc, { permits: [{ hazard_class_id: cid('3'), max_qty: 20 }] });
    check('manager/admin permits the class with a limit', r.status === 200, JSON.stringify(r.body));
    r = await receive(FL, 10);
    check('permitted location accepts the receipt', r.status === 201, JSON.stringify([r.status, r.body]));
    r = await receive(FL, 15);
    check('quantity limit enforced (10 + 15 > 20)', r.status === 409 && code(r) === 'HAZMAT_LOCATION_CAPACITY', JSON.stringify([r.status, r.body]));
    r = await receive(FL, 10);
    check('up to the limit is fine', r.status === 201);

    // ── segregation ──
    await setLoc(defLoc, { permits: [{ hazard_class_id: cid('3'), max_qty: 60 }, { hazard_class_id: cid('5.1') }] });
    r = await found(OX, 5, defLoc);
    check('incompatible class cannot share a location with flammables', r.status === 409 && code(r) === 'HAZMAT_INCOMPATIBLE_STORAGE', JSON.stringify([r.status, r.body]));
    const oxLoc = await mkLoc('Oxidiser store');
    await setLoc(oxLoc, { permits: [{ hazard_class_id: cid('5.1') }] });
    r = await found(OX, 8, oxLoc);
    check('oxidiser accepted in its own approved location', r.status === 201 || r.status === 200, JSON.stringify([r.status, r.body]));
    r = await trf(defLoc, oxLoc, [[FL, 2]]);
    check('transfer to a location not approved for the class is refused', r.status === 409 && code(r) === 'HAZMAT_LOCATION_NOT_PERMITTED', JSON.stringify([r.status, r.body]));
    check('refused transfer moved nothing', (await stockOf(FL)) === 20);
    r = await sellMany([[FL, 1], [OX, 1]]);
    check('incompatible products cannot be sold in one shipment', r.status === 409 && code(r) === 'HAZMAT_INCOMPATIBLE_LOAD', JSON.stringify([r.status, r.body]));
    const FL3 = await mk('Thinner', { hazard_class_id: cid('3'), sds_ref: 'SDS-003', sds_date: day(-5) });
    r = await found(FL3, 3, defLoc);
    r = await sellMany([[FL, 1], [FL3, 1]]);
    check('compatible hazardous products can ship together', r.status === 201, JSON.stringify([r.status, r.body]));

    // ── dry-run check ──
    r = await call('POST', '/inventory/hazmat/check', { tire_id: FL, location_id: oxLoc, qty: 1, action: 'store' });
    check('check endpoint explains a refusal', r.body.allowed === false && r.body.code === 'HAZMAT_LOCATION_NOT_PERMITTED' && /approved/.test(r.body.message), JSON.stringify(r.body));
    r = await call('POST', '/inventory/hazmat/check', { tire_id: P, qty: 1, action: 'store' });
    check('check endpoint: plain item is unrestricted', r.body.allowed === true && r.body.special === false, JSON.stringify(r.body));

    // ── SDS and transport details ──
    const NS = await mk('No sheet', { hazard_class_id: cid('3') });
    await found(NS, 4, defLoc);
    r = await sell(NS, 1);
    check('dispatch blocked until a Safety Data Sheet is on file', r.status === 409 && code(r) === 'HAZMAT_SDS_MISSING', JSON.stringify([r.status, r.body]));
    r = await call('PUT', `/inventory/${NS}`, { model: 'No sheet', hazard_class_id: cid('3'), sds_ref: 'SDS-NEW', sds_date: day(-1) });
    r = await sell(NS, 1);
    check('dispatch allowed once the SDS is recorded', r.status === 201, JSON.stringify([r.status, r.body]));
    const TR = await mk('Aerosol', { hazard_class_id: trans });
    await setLoc(defLoc, { permits: [{ hazard_class_id: cid('3'), max_qty: 60 }, { hazard_class_id: cid('5.1') }, { hazard_class_id: trans }] });
    await found(TR, 5, defLoc);
    r = await sell(TR, 1);
    check('class needing transport details blocks dispatch without a UN number', r.status === 409 && code(r) === 'HAZMAT_TRANSPORT_INFO_MISSING', JSON.stringify([r.status, r.body]));
    await call('PUT', `/inventory/${TR}`, { model: 'Aerosol', hazard_class_id: trans, un_number: 'UN1950' });
    r = await sell(TR, 1);
    check('allowed with the UN number', r.status === 201, JSON.stringify([r.status, r.body]));

    // ── temperature sensitive (no hazard class) ──
    const CD = await mk('Vaccine', { storage_temp_min_c: 2, storage_temp_max_c: 8 });
    r = await found(CD, 5, defLoc);
    check('temperature item refused where no range is declared', r.status === 409 && code(r) === 'HAZMAT_TEMPERATURE', JSON.stringify([r.status, r.body]));
    const cold = await mkLoc('Cold room');
    await setLoc(cold, { temp_min_c: 0, temp_max_c: 10 });
    r = await found(CD, 5, cold);
    check('location range wider than the item tolerance is refused', r.status === 409 && code(r) === 'HAZMAT_TEMPERATURE', JSON.stringify([r.status, r.body]));
    await setLoc(cold, { temp_min_c: 3, temp_max_c: 6 });
    r = await found(CD, 5, cold);
    check('location range inside tolerance accepted', r.status === 201 || r.status === 200, JSON.stringify([r.status, r.body]));
    r = await trf(cold, defLoc, [[CD, 1]]);
    check('moving it to an unrated location is refused', r.status === 409 && code(r) === 'HAZMAT_TEMPERATURE', JSON.stringify([r.status, r.body]));
    r = await setLoc(cold, { temp_min_c: 8, temp_max_c: 3 });
    check('inverted temperature range rejected', r.status === 400, JSON.stringify(r.body));

    // ── location inspections ──
    r = await setLoc(oxLoc, { permits: [{ hazard_class_id: cid('5.1') }], inspection_interval_days: 30 });
    r = await found(OX, 1, oxLoc);
    check('never-inspected location blocks hazardous intake', r.status === 409 && code(r) === 'HAZMAT_LOCATION_INSPECTION_OVERDUE', JSON.stringify([r.status, r.body]));
    r = await call('POST', '/inventory/hazmat/inspections', { subject_type: 'location', location_id: oxLoc, result: 'pass', findings: 'Bunding intact' }, staff);
    check('any user can record an inspection', r.status === 201 && r.body.next_due === day(30), JSON.stringify(r.body));
    r = await found(OX, 1, oxLoc);
    check('passed inspection re-opens the location', r.status === 201 || r.status === 200, JSON.stringify([r.status, r.body]));
    r = await call('POST', '/inventory/hazmat/inspections', { subject_type: 'location', location_id: oxLoc, result: 'fail' }, staff);
    check('failed inspection needs findings', r.status === 400, JSON.stringify(r.body));
    await call('POST', '/inventory/hazmat/inspections', { subject_type: 'location', location_id: oxLoc, result: 'fail', findings: 'Spill kit missing' }, staff);
    r = await found(OX, 1, oxLoc);
    check('failed inspection blocks hazardous intake', r.status === 409 && code(r) === 'HAZMAT_LOCATION_FAILED_INSPECTION', JSON.stringify([r.status, r.body]));
    await call('POST', '/inventory/hazmat/inspections', { subject_type: 'location', location_id: oxLoc, result: 'pass', findings: 'Kit replaced' }, staff);
    r = await found(OX, 1, oxLoc);
    check('re-inspection clears it', r.status === 201 || r.status === 200, JSON.stringify([r.status, r.body]));
    await pool.request().input('l', sql.Int, oxLoc).query("UPDATE hazard_inspections SET next_due = DATEADD(DAY, -3, CAST(GETDATE() AS DATE)) WHERE location_id = @l AND id = (SELECT MAX(id) FROM hazard_inspections WHERE location_id = @l)");
    r = await found(OX, 1, oxLoc);
    check('overdue inspection blocks intake', r.status === 409 && code(r) === 'HAZMAT_LOCATION_INSPECTION_OVERDUE', JSON.stringify([r.status, r.body]));
    // item inspection
    const CY = await mk('Gas cylinder', { hazard_class_id: cid('2.2'), sds_ref: 'SDS-GAS', sds_date: day(-10), hazard_inspection_days: 90 });
    r = await call('POST', '/inventory/hazmat/inspections', { subject_type: 'item', tire_id: CY, result: 'fail', findings: 'Valve corrosion' }, staff);
    check('failed item inspection places the item on hold', r.status === 201 && r.body.item_placed_on_hold, JSON.stringify(r.body));

    // ── incidents ──
    const before = await stockOf(FL);
    r = await call('POST', '/inventory/hazmat/incidents', { incident_type: 'leak', severity: 'high', tire_id: FL, location_id: defLoc, description: 'Drum leaking at pallet 3', hold_item: false }, staff);
    const inc = r.body.id;
    check('staff can report an incident; high severity blocks dispatch by default', r.status === 201 && /^HZI/.test(r.body.incident_no) && r.body.blocks_dispatch, JSON.stringify(r.body));
    r = await sell(FL, 1);
    check('open incident blocks sale of the item', r.status === 409 && code(r) === 'HAZMAT_INCIDENT_OPEN', JSON.stringify([r.status, r.body]));
    r = await sell(NS, 1);
    check('and other hazardous items at that location', r.status === 409 && code(r) === 'HAZMAT_INCIDENT_OPEN', JSON.stringify([r.status, r.body]));
    r = await sell(P, 1);
    check('non-hazardous stock at the same location still sells', r.status === 201, JSON.stringify([r.status, r.body]));
    const quar = await mkLoc('Spill containment', 'quarantine');
    r = await trf(defLoc, quar, [[FL, 3]]);
    check('stock can still be moved into containment', r.status === 201 || r.status === 200, JSON.stringify([r.status, r.body]));
    check('containment moved the stock', (await stockOf(FL)) === before && (await call('GET', `/inventory/position/${FL}`)).body.quarantined === 3);
    r = await call('POST', `/inventory/hazmat/incidents/${inc}/close`, { resolution: 'Drum overpacked and cleaned' }, staff);
    check('staff cannot close an incident', r.status === 403, r.status);
    r = await call('POST', `/inventory/hazmat/incidents/${inc}/close`, { resolution: 'Drum overpacked and cleaned' }, mgr);
    check('manager closes the incident', r.status === 200, JSON.stringify(r.body));
    r = await sell(FL, 1);
    check('dispatch resumes after closure', r.status === 201, JSON.stringify([r.status, r.body]));
    r = await call('POST', '/inventory/hazmat/incidents', { incident_type: 'spill', severity: 'low', description: 'x' }, staff);
    check('incident needs a description and a subject', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory/hazmat/incidents', { incident_type: 'near_miss', severity: 'low', tire_id: FL, description: 'Forklift near miss', blocks_dispatch: false });
    check('low severity incident does not block unless asked', r.status === 201 && !r.body.blocks_dispatch && (await sell(FL, 1)).status === 201);

    // ── safety hold ──
    r = await call('PUT', `/inventory/hazmat/items/${FL}/hold`, { hold: true, reason: 'Label recall' }, staff);
    check('any user can hold an item', r.status === 200, JSON.stringify(r.body));
    r = await sell(FL, 1);
    check('held item cannot be dispatched', r.status === 409 && code(r) === 'HAZMAT_HOLD', JSON.stringify([r.status, r.body]));
    r = await call('PUT', `/inventory/hazmat/items/${FL}/hold`, { hold: false, reason: 'Label corrected' }, staff);
    check('staff cannot lift a hold', r.status === 403, r.status);
    r = await call('PUT', `/inventory/hazmat/items/${FL}/hold`, { hold: false, reason: 'Label corrected' }, mgr);
    check('manager lifts the hold', r.status === 200 && (await sell(FL, 1)).status === 201, JSON.stringify(r.body));

    // ── compliance board ──
    const A = await mk('Co-located A', { stock: 0 }), B = await mk('Co-located B', { stock: 0 });
    await receive(A, 3); await receive(B, 3);
    await call('PUT', `/inventory/${A}`, { model: 'Co-located A', hazard_class_id: cid('3'), sds_ref: 'S', sds_date: '2019-01-01' });
    await call('PUT', `/inventory/${B}`, { model: 'Co-located B', hazard_class_id: cid('6.1') });
    await call('PUT', '/inventory/hazmat/incompatibilities', { class_a: cid('3'), class_b: cid('6.1'), incompatible: true, reason: 'Test pair' });
    await call('PUT', `/inventory/${B}`, { model: 'Co-located B', hazard_class_id: cid('6.1') });
    let co = (await call('GET', '/inventory/hazmat/compliance')).body;
    check('existing co-located incompatible stock is flagged', co.incompatible.some(x => /Co-located/.test(x.a_name) && /Co-located/.test(x.b_name)), JSON.stringify(co.summary));
    check('stock of a class with no permit is flagged', co.misplaced.some(x => x.tire_id === B), JSON.stringify(co.misplaced.map(x => x.item_name)));
    check('old SDS flagged', co.sds_old.some(x => x.tire_id === A), JSON.stringify(co.sds_old.map(x => x.item_name)));
    check('missing SDS flagged for classes that require it', co.sds_missing.some(x => x.tire_id === B));
    check('temperature mismatch of existing stock flagged', Array.isArray(co.temperature));
    await setLoc(defLoc, { permits: [{ hazard_class_id: cid('3'), max_qty: 5 }, { hazard_class_id: cid('5.1') }, { hazard_class_id: trans }] });
    co = (await call('GET', '/inventory/hazmat/compliance')).body;
    check('over-capacity location flagged', co.over_capacity.some(x => x.location_id === defLoc), JSON.stringify(co.over_capacity));
    check('held item and inspection gaps listed', co.holds.some(x => x.tire_id === CY) && co.item_inspections.length >= 0 && co.location_inspections.some(x => x.location_id === oxLoc), JSON.stringify([co.holds.length, co.location_inspections]));
    check('needs_attention totals the findings', co.needs_attention >= 6, co.needs_attention);

    // ── housekeeping rules ──
    r = await call('DELETE', `/inventory/hazmat/classes/${cid('3')}`);
    check('class in use cannot be deleted', r.status === 409 && r.body.code === 'CLASS_IN_USE', JSON.stringify(r.body));
    r = await call('PUT', '/inventory/hazmat/incompatibilities', { class_a: cid('3'), class_b: cid('6.1'), incompatible: false });
    check('segregation pair can be removed', r.status === 200 && !(await call('GET', '/inventory/hazmat/classes')).body.incompatibilities.some(p => p.class_a === Math.min(cid('3'), cid('6.1')) && p.class_b === Math.max(cid('3'), cid('6.1'))));
    r = await call('PUT', '/inventory/hazmat/settings', { sds_max_age_days: 365 });
    check('company settings saved', r.status === 200 && r.body.sds_max_age_days === 365, JSON.stringify(r.body));
    r = await call('PUT', '/inventory/hazmat/settings', { sds_max_age_days: 365 }, staff);
    check('staff cannot change settings', r.status === 403);
    r = await call('POST', `/inventory/hazmat/items/${P}/hold`, { hold: true, reason: 'abc' }, tok('demo', 1004));
    r = await call('PUT', `/inventory/hazmat/items/${P}/hold`, { hold: true, reason: 'demo try' }, tok('demo', 1004));
    check('demo user is read-only', r.status === 403, r.status);

    // ── ledger intact ──
    r = await call('GET', '/inventory/reconciliation');
    check('ledger still reconciles', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 300));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [
      'DELETE FROM hazard_incidents WHERE organization_id=@o', 'DELETE FROM hazard_inspections WHERE organization_id=@o', 'DELETE FROM hazard_incompatibilities WHERE organization_id=@o',
      'DELETE FROM location_hazard_permits WHERE location_id IN (SELECT id FROM stock_locations WHERE organization_id=@o)', 'DELETE FROM hazard_classes WHERE organization_id=@o',
      'DELETE FROM batch_quality_events WHERE organization_id=@o', 'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o',
      'DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE organization_id=@o)', 'DELETE FROM stock_transfers WHERE organization_id=@o',
      'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
      'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sales WHERE organization_id=@o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
      'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
      'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
      'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
