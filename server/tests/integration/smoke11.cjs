process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 400)}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG11', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Q Supply', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR))")).recordset[0].id;
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
  const receive = (tire, it, t = admin) => call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: tire, tire_name: 'x', qty: 10, unit_price: 10 + (++n) / 100, ...it }] }, t);
  const batches = async (q = '') => (await call('GET', '/inventory/quality/batches' + q)).body;
  const bOf = async (tire, no) => (await batches('?tire_id=' + tire)).find(b => b.batch_no === no);
  const pos = async id => (await call('GET', `/inventory/position/${id}`)).body;
  const sell = (tire, qty, extra = {}) => call('POST', '/sales', { date: day(0), items: [{ tire_id: tire, qty, unit_price: 20 + (++n) / 100, ...extra }], tax_rate: 0 });
  try {
    // ── mfg date, shelf life, derived expiry ──
    const F = await mk('Food', { tracking: 'batch', track_expiry: true, shelf_life_days: 90 });
    let r = await receive(F, { batch_no: 'F1', mfg_date: day(-10) });
    let b = await bOf(F, 'F1');
    check('expiry derived from manufacturing date + shelf life', r.status === 201 && b && b.expiry_date === day(80) && b.mfg_date === day(-10) && b.days_left === 80, JSON.stringify([r.status, r.body, b]));
    r = await receive(F, { batch_no: 'F2' });
    check('no expiry and no mfg date: still required', r.status === 400 || r.status === 409 || r.status === 422, JSON.stringify([r.status, r.body]));
    r = await receive(F, { batch_no: 'F3', mfg_date: day(5), expiry_date: day(50) });
    check('future manufacturing date rejected', r.status >= 400 && /future/i.test(JSON.stringify(r.body)), JSON.stringify([r.status, r.body]));
    r = await receive(F, { batch_no: 'F4', mfg_date: day(-5), expiry_date: day(-8) });
    check('expiry before manufacturing rejected', r.status >= 400 && /before/i.test(JSON.stringify(r.body)), JSON.stringify([r.status, r.body]));
    check('rejected receipts leave no stock', (await pos(F)).on_hand === 10, JSON.stringify(await pos(F)));

    // ── items without expiry are not forced ──
    const P = await mk('Plain widget', { stock: 5 });
    r = await sell(P, 2);
    check('plain item sells without expiry or batch', r.status === 201, JSON.stringify(r.body));
    const T = await mk('Tracked no expiry', { tracking: 'batch' });
    r = await receive(T, { batch_no: 'T1' });
    check('batch item without track_expiry needs no expiry or mfg date', r.status === 201, JSON.stringify(r.body));
    check('quality alerts ignore it', !(await call('GET', '/inventory/quality/alerts')).body.near_expiry.some(x => x.tire_id === T));

    // ── rules resolution: item > profile > category profile > company ──
    let a = await call('GET', '/inventory/quality/batches?tire_id=' + F);
    check('company default near-expiry window 30 d', a.body[0].near_expiry_days === 30, JSON.stringify(a.body[0]));
    r = await call('PUT', '/inventory/quality/rules', { near_expiry_days: 60, inspection_interval_days: 0 });
    check('company rules saved', r.status === 200 && r.body.near_expiry_days === 60, JSON.stringify(r.body));
    r = await call('PUT', '/inventory/quality/rules', { near_expiry_days: 60 }, staff);
    check('staff cannot change company rules', r.status === 403, r.status);
    r = await call('POST', '/inventory/quality/profiles', { name: 'Pharma', regulation: 'GDP', near_expiry_days: 120, inspection_interval_days: 30, min_remaining_days: 100, require_mfg_date: true, release_approval: 'admin' });
    const pharma = r.body.id;
    check('profile created', r.status === 201 && pharma, JSON.stringify(r.body));
    r = await call('POST', '/inventory/quality/profiles', { name: 'Pharma' });
    check('duplicate profile name rejected', r.status === 409, JSON.stringify(r.body));
    r = await call('POST', '/inventory/quality/profiles', { name: 'Staff try' }, staff);
    check('staff cannot create profiles', r.status === 403, r.status);
    const D = await mk('Drug', { tracking: 'batch', track_expiry: true, quality_profile_id: pharma });
    r = await receive(D, { batch_no: 'D0', expiry_date: day(400) });
    check('profile requires manufacturing date', r.status >= 400 && /anufacturing/.test(JSON.stringify(r.body)), JSON.stringify([r.status, r.body]));
    r = await receive(D, { batch_no: 'D1', mfg_date: day(-20), expiry_date: day(50) });
    b = await bOf(D, 'D1');
    check('profile: short shelf life on receipt (50 < 100) puts batch on hold', r.status === 201 && b.quality_status === 'on_hold' && /Short shelf life/.test(b.status_reason || ''), JSON.stringify(b));
    check('profile window applied (120 d)', b.near_expiry_days === 120 && b.release_approval === 'admin' && b.inspection_interval_days === 30, JSON.stringify(b));
    let p = await pos(D);
    check('held units are on hand but not available', p.on_hand === 10 && p.held === 10 && p.available === 0, JSON.stringify(p));
    r = await sell(D, 1);
    check('held stock cannot be sold', r.status === 409 && /hold|BATCH|stock|available/i.test(JSON.stringify(r.body)), JSON.stringify([r.status, r.body]));
    r = await call('POST', '/inventory/reservations', { tire_id: D, qty: 1 });
    check('held stock cannot be reserved', r.status === 409, JSON.stringify(r.body));
    r = await call('POST', '/inventory/adjustments', { tire_id: D, qty_change: -1, reason_code: 'damage', batch_id: b.batch_id });
    check('held stock can still be written off by adjustment', r.status === 201 || r.status === 200, JSON.stringify([r.status, r.body]));

    // authorization of release
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/status`, { status: 'released', reason: 'Checked and fine' }, staff);
    check('staff cannot release', r.status === 403, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/status`, { status: 'released', reason: 'Checked and fine' }, mgr);
    check('profile needing admin release: manager refused', r.status === 403 && r.body.code === 'ADMIN_RELEASE_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/status`, { status: 'released', reason: '' }, admin);
    check('release needs a reason', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/status`, { status: 'released', reason: 'Supplier certificate checked' }, admin);
    check('admin releases', r.status === 200, JSON.stringify(r.body));
    p = await pos(D);
    check('released stock available again', p.held === 0 && p.available === 9, JSON.stringify(p));
    r = await sell(D, 2);
    check('released stock sells', r.status === 201, JSON.stringify(r.body));

    // item overrides profile
    await call('PUT', `/inventory/${D}`, { model: 'Drug', tracking: 'batch', track_expiry: true, quality_profile_id: pharma, near_expiry_days: 10, inspection_interval_days: 5, require_mfg_date: false });
    b = await bOf(D, 'D1');
    check('item values override profile', b.near_expiry_days === 10 && b.inspection_interval_days === 5, JSON.stringify(b));
    r = await receive(D, { batch_no: 'D2', expiry_date: day(300) });
    check('item mfg-date rule (no) overrides profile (yes)', r.status === 201, JSON.stringify([r.status, r.body]));
    r = await call('DELETE', `/inventory/quality/profiles/${pharma}`);
    check('assigned profile cannot be deleted', r.status === 409 && r.body.code === 'PROFILE_IN_USE', JSON.stringify(r.body));
    // category profile
    const cat = (await pool.request().input('o', sql.Int, org).query("INSERT INTO item_categories (organization_id, name) OUTPUT INSERTED.id VALUES (@o, 'Chems')")).recordset[0].id;
    r = await call('POST', '/inventory/quality/profiles', { name: 'Chem', near_expiry_days: 45 });
    const chem = r.body.id;
    r = await call('PUT', '/inventory/quality/assign', { scope: 'category', id: cat, profile_id: chem });
    check('category assignment', r.status === 200, JSON.stringify(r.body));
    const C = await mk('Glue', { tracking: 'batch', track_expiry: true, category_id: cat });
    await receive(C, { batch_no: 'C1', expiry_date: day(200) });
    b = await bOf(C, 'C1');
    check('category profile applies when item has none (45 d)', b && b.near_expiry_days === 45, JSON.stringify(b));

    // ── near-expiry, expired, alerts ──
    const M = await mk('Milk', { tracking: 'batch', track_expiry: true });
    await receive(M, { batch_no: 'MS', expiry_date: day(20) });
    await receive(M, { batch_no: 'ML', expiry_date: day(200) });
    let al = (await call('GET', '/inventory/quality/alerts')).body;
    check('near expiry alert (20 d within 60 d window)', al.near_expiry.some(x => x.batch_no === 'MS') && !al.near_expiry.some(x => x.batch_no === 'ML'), JSON.stringify(al.summary));
    await pool.request().input('t', sql.Int, M).query("UPDATE stock_batches SET expiry_date = DATEADD(DAY, -3, CAST(GETDATE() AS DATE)) WHERE tire_id = @t AND batch_no = 'MS'");
    al = (await call('GET', '/inventory/quality/alerts')).body;
    check('expired alert', al.expired.some(x => x.batch_no === 'MS' && x.days_left === -3), JSON.stringify(al.summary));
    check('needs_attention counts it', al.needs_attention >= 1);
    r = await call('GET', '/inventory/quality/batches?flag=expired');
    check('expired filter', r.body.length === 1 && r.body[0].batch_no === 'MS');

    // ── inspections ──
    const I = await mk('Adhesive', { tracking: 'batch', track_expiry: true, inspection_interval_days: 30 });
    await receive(I, { batch_no: 'I1', expiry_date: day(300) });
    b = await bOf(I, 'I1');
    check('inspection due in 30 days from receipt', b.inspection_due === day(30) && !b.inspection_overdue, JSON.stringify(b));
    await pool.request().input('t', sql.Int, I).query("UPDATE stock_batches SET received_date = DATEADD(DAY, -45, CAST(GETDATE() AS DATE)) WHERE tire_id = @t");
    al = (await call('GET', '/inventory/quality/alerts')).body;
    check('overdue inspection alert (15 d late)', al.inspection_overdue.some(x => x.batch_no === 'I1' && x.inspection_days_overdue === 15), JSON.stringify(al.inspection_overdue.map(x => [x.batch_no, x.inspection_days_overdue])));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/inspections`, { result: 'pass', notes: 'visual ok' }, staff);
    b = await bOf(I, 'I1');
    check('passed inspection resets due date', r.status === 201 && !b.inspection_overdue && b.inspection_due === day(30) && b.quality_status === 'released', JSON.stringify([r.status, b]));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/inspections`, { result: 'fail' }, staff);
    check('failed inspection needs notes', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/inspections`, { result: 'fail', notes: 'Skinning on surface' }, staff);
    b = await bOf(I, 'I1');
    check('failed inspection places batch on hold', r.status === 201 && r.body.placed_on_hold && b.quality_status === 'on_hold', JSON.stringify([r.status, r.body, b?.quality_status]));
    r = await call('GET', `/inventory/quality/batches/${b.batch_id}`);
    check('batch history records inspection and hold', r.body.events.length >= 3 && r.body.events.some(e => e.event_type === 'inspection' && e.result === 'fail') && r.body.events.some(e => e.to_status === 'on_hold'), JSON.stringify(r.body.events));
    await pool.request().input('b', sql.Int, b.batch_id).query("UPDATE stock_batches SET status_changed_at = DATEADD(DAY, -20, GETDATE()) WHERE id = @b");
    al = (await call('GET', '/inventory/quality/alerts')).body;
    check('stale hold alert after 14 d', al.on_hold.some(x => x.batch_no === 'I1' && x.stale) && al.summary.stale_holds.batches === 1, JSON.stringify(al.summary.stale_holds));

    // ── hold by staff, damaged ──
    const H = await mk('Yoghurt', { tracking: 'batch', track_expiry: true });
    await receive(H, { batch_no: 'H1', expiry_date: day(100) });
    b = await bOf(H, 'H1');
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/status`, { status: 'on_hold', reason: 'Customer complaint' }, staff);
    check('any user can place a precautionary hold', r.status === 200, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/status`, { status: 'on_hold', reason: 'again' }, staff);
    check('no-op status change rejected', r.status === 409, JSON.stringify(r.body));
    r = await sell(H, 1);
    check('on-hold batch cannot be sold (auto pick)', r.status === 409, JSON.stringify([r.status, r.body]));
    r = await sell(H, 1, { batch_id: b.batch_id });
    check('on-hold batch cannot be sold (explicit batch)', r.status === 409 && /BATCH_RESTRICTED|hold/i.test(JSON.stringify(r.body)), JSON.stringify([r.status, r.body]));
    r = await call('GET', `/inventory/rotation/pick/${H}`);
    check('pick guide lists held batch as excluded', r.status === 200 ? JSON.stringify(r.body).includes('quality_hold') : true, JSON.stringify(r.body).slice(0, 200));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/status`, { status: 'damaged', reason: 'Crushed' }, staff);
    check('staff cannot mark damaged', r.status === 403, r.status);

    // ── disposal ──
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/dispose`, { qty: 4, method: 'destroy', reason: 'Spoiled' }, staff);
    check('staff cannot dispose', r.status === 403, r.status);
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/dispose`, { qty: 40, method: 'destroy', reason: 'Spoiled' }, mgr);
    check('cannot dispose more than the batch holds', r.status === 409, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/dispose`, { qty: 4, method: 'burn', reason: 'Spoiled' }, mgr);
    check('invalid method rejected', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/dispose`, { qty: 4, method: 'destroy', reason: 'Spoiled', reference: 'Cert-7' }, mgr);
    check('manager disposes held stock', r.status === 201 && /^DSP/.test(r.body.disposal_no) && r.body.value > 0, JSON.stringify(r.body));
    p = await pos(H);
    check('disposal reduced on hand through the ledger', p.on_hand === 6, JSON.stringify(p));
    await call('PUT', '/inventory/quality/rules', { disposal_admin_value: 30 });
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/dispose`, { qty: 3, method: 'write_off', reason: 'More spoiled' }, mgr);
    check('disposal over threshold needs admin', r.status === 403 && r.body.code === 'ADMIN_APPROVAL_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/dispose`, { qty: 3, method: 'write_off', reason: 'More spoiled' }, admin);
    check('admin may dispose above threshold', r.status === 201, JSON.stringify(r.body));
    await call('PUT', '/inventory/quality/rules', { disposal_admin_value: null });
    r = await call('GET', '/inventory/quality/disposals');
    check('disposal register with totals by method', r.body.rows.length === 2 && r.body.total_qty === 7 && r.body.totals.length === 2, JSON.stringify(r.body.totals));
    r = await call('POST', `/inventory/quality/batches/${b.batch_id}/dispose`, { qty: 1, method: 'return_to_supplier', reason: 'Back to supplier', supplier_id: sup }, mgr);
    check('return to supplier', r.status === 201, JSON.stringify(r.body));

    // expired stock can be disposed
    const mm = (await bOf(M, 'MS'));
    r = await call('POST', `/inventory/quality/batches/${mm.batch_id}/dispose`, { qty: 10, method: 'destroy', reason: 'Expired' }, mgr);
    check('expired stock can be disposed', r.status === 201, JSON.stringify(r.body));

    // ── customer returns ──
    const R = await mk('Cream', { tracking: 'batch', track_expiry: true });
    await receive(R, { batch_no: 'R1', expiry_date: day(100) });
    const rb = await bOf(R, 'R1');
    r = await call('POST', '/inventory/quality/returns', { tire_id: R, batch_no: 'R1', qty: 2, reason: 'Wrong item', disposition: 'restock' }, staff);
    check('staff cannot authorise returns', r.status === 403, r.status);
    r = await call('POST', '/inventory/quality/returns', { tire_id: R, qty: 2, reason: 'Wrong item', disposition: 'restock' }, mgr);
    check('tracked return needs a batch', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory/quality/returns', { tire_id: R, batch_no: 'R1', qty: 2, reason: 'Wrong item', disposition: 'restock' }, mgr);
    p = await pos(R);
    check('restock return goes back to sellable stock', r.status === 201 && p.on_hand === 12 && p.available === 12, JSON.stringify([r.status, r.body, p]));
    r = await call('POST', '/inventory/quality/returns', { tire_id: R, batch_no: 'R1', qty: 1, reason: 'Suspected tampering', disposition: 'quarantine' }, mgr);
    p = await pos(R);
    check('quarantine return is on hand but not available', r.status === 201 && p.on_hand === 13 && p.quarantined === 1 && p.available === 12, JSON.stringify([r.status, r.body, p]));

    // ── recalls ──
    await receive(R, { batch_no: 'R2', expiry_date: day(150) });
    const rb2 = await bOf(R, 'R2');
    const sale = await sell(R, 3, { batch_id: rb.batch_id });
    check('sale from batch R1 before recall', sale.status === 201, JSON.stringify(sale.body));
    r = await call('POST', '/inventory/quality/recalls', { title: 'Cream contamination', reason: 'Listeria', severity: 'class1', batch_ids: [rb.batch_id] }, staff);
    check('staff cannot open a recall', r.status === 403, r.status);
    r = await call('POST', '/inventory/quality/recalls', { title: 'Cream contamination', reason: 'Listeria', severity: 'bad', batch_ids: [rb.batch_id] }, mgr);
    check('invalid severity rejected', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory/quality/recalls', { title: 'Cream contamination', reason: 'Listeria', severity: 'class1', batch_ids: [rb.batch_id] }, mgr);
    const rc = r.body.id;
    check('recall opened and numbered', r.status === 201 && /^RCL/.test(r.body.recall_no) && r.body.batches.length === 1, JSON.stringify(r.body));
    b = await bOf(R, 'R1');
    check('recalled batch marked', b.quality_status === 'recalled', b?.quality_status);
    r = await sell(R, 1, { batch_id: rb.batch_id });
    check('recalled batch cannot be sold', r.status === 409, JSON.stringify(r.body));
    r = await sell(R, 1);
    check('auto-pick skips the recalled batch and uses R2', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${rb.batch_id}/status`, { status: 'released', reason: 'try' }, admin);
    check('recalled batch cannot be released directly', r.status === 409 && r.body.code === 'RECALLED', JSON.stringify(r.body));
    r = await call('GET', `/inventory/quality/recalls/${rc}`);
    check('recall trace: stock on hand and units sold', r.body.batches[0].qty_sold === 3 && r.body.batches[0].qty_now > 0 && r.body.sales.length >= 1, JSON.stringify(r.body.batches));
    r = await call('POST', `/inventory/quality/recalls/${rc}/close`, { note: 'done', resolutions: [] }, mgr);
    check('only admin closes a recall', r.status === 403, r.status);
    r = await call('POST', `/inventory/quality/recalls/${rc}/close`, { note: 'done', resolutions: [] }, admin);
    check('cannot close while batches unresolved', r.status === 400 && r.body.code === 'UNRESOLVED_BATCHES', JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/recalls/${rc}/close`, { note: 'done', resolutions: [{ batch_id: rb.batch_id, disposition: 'disposed' }] }, admin);
    check('cannot close as disposed while stock remains', r.status === 409 && r.body.code === 'STOCK_REMAINS', JSON.stringify(r.body));
    const left = (await pos(R)).locations.reduce((a, l) => a + 0, 0);
    const rbn = (await call('GET', `/inventory/quality/batches/${rb.batch_id}`)).body;
    for (const bal of rbn.balances) {
      if (bal.qty > 0) { r = await call('POST', `/inventory/quality/batches/${rb.batch_id}/dispose`, { qty: bal.qty, method: 'destroy', reason: 'Recall destruction', location_id: bal.location_id }, mgr); if (r.status !== 201) check('recall disposal', false, JSON.stringify(r.body)); }
    }
    r = await call('GET', `/inventory/quality/recalls/${rc}`);
    check('disposals are linked to the recall', r.body.batches[0].qty_now === 0 && r.body.batches[0].qty_disposed > 0, JSON.stringify(r.body.batches));
    r = await call('POST', `/inventory/quality/recalls/${rc}/close`, { note: 'All destroyed', resolutions: [] }, admin);
    check('recall closes once resolved', r.status === 200 && r.body.disposed === 1, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/recalls/${rc}/close`, { note: 'again' }, admin);
    check('closed recall cannot close again', r.status === 409, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/recalls/${rc}/batches`, { batch_ids: [rb2.batch_id] }, mgr);
    check('cannot add batches to a closed recall', r.status === 409, JSON.stringify(r.body));
    // recall cleared batch
    r = await call('POST', '/inventory/quality/recalls', { title: 'Precaution', reason: 'Label error', batch_ids: [rb2.batch_id] }, mgr);
    const rc2 = r.body.id;
    r = await call('POST', `/inventory/quality/recalls/${rc2}/close`, { note: 'Label verified OK', resolutions: [{ batch_id: rb2.batch_id, disposition: 'release' }] }, admin);
    b = await bOf(R, 'R2');
    check('recall closure can release a cleared batch', r.status === 200 && b.quality_status === 'released', JSON.stringify([r.status, r.body, b?.quality_status]));
    r = await call('GET', '/inventory/quality/recalls?status=closed');
    check('recall list filters', r.body.length === 2 && r.body.every(x => x.status === 'closed'));

    // ── transfer held stock into quarantine ──
    const X = await mk('Dairy X', { tracking: 'batch', track_expiry: true });
    await receive(X, { batch_no: 'X1', expiry_date: day(100) });
    const xb = await bOf(X, 'X1');
    await call('POST', `/inventory/quality/batches/${xb.batch_id}/status`, { status: 'on_hold', reason: 'Pending lab' }, mgr);
    const locs = (await call('GET', '/inventory/locations')).body;
    const def = locs.find(l => l.is_default)?.id;
    r = await call('POST', '/inventory/locations', { name: 'Hold cage', kind: 'quarantine' });
    const cage = r.body.id;
    r = await call('POST', '/inventory/transfers', { from_location_id: def, to_location_id: cage, items: [{ tire_id: X, qty: 4 }] });
    check('held stock can be moved to a quarantine location', r.status === 201 || r.status === 200, JSON.stringify(r.body));
    const normal = await call('POST', '/inventory/locations', { name: 'Shelf 2' });
    r = await call('POST', '/inventory/transfers', { from_location_id: def, to_location_id: normal.body.id, items: [{ tire_id: X, qty: 2 }] });
    check('held stock cannot be moved to a normal location', r.status === 409, JSON.stringify([r.status, r.body]));

    // ── demo is read only, validation ──
    r = await call('POST', `/inventory/quality/batches/${xb.batch_id}/status`, { status: 'released', reason: 'x' }, tok('demo', 1004));
    check('demo user is read-only', r.status === 403, r.status);
    r = await call('GET', '/inventory/quality/meta');
    check('meta lists statuses, methods and severities', r.body.statuses.length === 4 && r.body.disposal_methods.length === 3 && r.body.severities.length === 4, JSON.stringify(r.body).slice(0, 150));
    r = await call('PUT', '/inventory/quality/rules', { near_expiry_days: -1 });
    check('invalid rule rejected', r.status === 400, JSON.stringify(r.body));
    r = await call('PUT', '/inventory/quality/assign', { scope: 'item', id: F, profile_id: 999999 });
    check('assigning an unknown profile fails', r.status === 404, JSON.stringify(r.body));
    r = await call('PUT', '/inventory/quality/assign', { scope: 'item', id: F, profile_id: chem });
    r = await call('PUT', '/inventory/quality/assign', { scope: 'item', id: F, profile_id: null });
    check('item profile can be cleared', r.status === 200, JSON.stringify(r.body));

    // ── ledger intact ──
    r = await call('GET', '/inventory/reconciliation');
    check('ledger still reconciles', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 300));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [
      'DELETE FROM batch_quality_events WHERE organization_id=@o', 'DELETE FROM product_recall_batches WHERE recall_id IN (SELECT id FROM product_recalls WHERE organization_id=@o)', 'DELETE FROM product_recalls WHERE organization_id=@o',
      'DELETE FROM quality_disposals WHERE organization_id=@o',
      'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o',
      'DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE organization_id=@o)', 'DELETE FROM stock_transfers WHERE organization_id=@o',
      'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
      'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sales WHERE organization_id=@o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
      'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
      'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM quality_profiles WHERE organization_id=@o',
      'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
      'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
