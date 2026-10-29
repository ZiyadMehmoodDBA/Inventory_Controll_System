process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 600)}`); };
const day = n => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
(async () => {
  const pool = await getPool();
  const mkOrg = async nm => {
    const org = (await pool.request().input('n', sql.NVarChar(100), nm).query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@n, 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'D Supply', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR))")).recordset[0].id;
    return { org, br, sup };
  };
  const A = await mkOrg('SMOKE ORG15'), B = await mkOrg('SMOKE ORG15B');
  const { org, br, sup } = A;
  const east = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'East', 'EAST')")).recordset[0].id;
  const mkUser = async (role, branch, nm) => (await pool.request().input('o', sql.Int, org).input('b', sql.Int, branch).input('r', sql.NVarChar(50), role).input('n', sql.NVarChar(100), nm)
    .query("INSERT INTO users (name, email, password_hash, role, organization_id, branch_id) OUTPUT INSERTED.id VALUES (@n, @n + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR) + '@smoke15.test', 'x', @r, @o, @b)")).recordset[0].id;
  const uStaff = await mkUser('staff', br, 'dash staff'), uMgr = await mkUser('branch_manager', br, 'dash mgr');
  const tok = (o, role, uid, branch) => jwt.sign({ userId: uid, orgId: o.org, branchId: role === 'org_admin' ? null : branch, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok(A, 'org_admin', 1001), staff = tok(A, 'staff', uStaff, br), mgr = tok(A, 'branch_manager', uMgr, br), adminB = tok(B, 'org_admin', 2001, null);
  const call = async (m, p, body, t = admin, branch = br) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(branch) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const raw = async (p, t = admin, branch = br) => { const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${t}`, 'X-Branch-ID': String(branch) } }); const buf = Buffer.from(await r.arrayBuffer()); return { status: r.status, type: r.headers.get('content-type'), bom: buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, text: buf.toString('utf8').replace(/^﻿/, '') }; };
  let n = 0;
  const mk = async (model, extra = {}, branch = br) => {
    const r = await call('POST', '/inventory', { model, cost_price: 10, sale_price: 20, ...extra }, admin, branch);
    if (r.status !== 201 && r.status !== 200) throw new Error('create ' + model + ' ' + JSON.stringify(r.body));
    return r.body.id;
  };
  const receive = (tire, qty, extra = {}, it = {}, branch = br) => call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', ...extra, items: [{ tire_id: tire, tire_name: 'x', qty, unit_price: 10, ...it }] }, admin, branch);
  const sell = (tire, qty) => call('POST', '/sales', { date: day(0), items: [{ tire_id: tire, qty, unit_price: 20 + (++n) / 100 }], tax_rate: 0 });
  const adj = (tire, qty, code, t = admin, extra = {}) => call('POST', '/inventory/adjustments', { tire_id: tire, qty_change: qty, reason_code: code, notes: `n${++n}`, ...extra }, t);
  const rep = (id, qs = '', t = admin, branch = br) => call('GET', `/inventory/insights/reports/${id}${qs ? '?' + qs : ''}`, null, t, branch);
  const sqlOne = async (q, ...p) => { const rq = pool.request().input('o', sql.Int, org).input('b', sql.Int, br); return (await rq.query(q)).recordset[0]; };
  const names = rows => rows.map(r => String(r.item_name ?? r.name).trim());
  try {
    // ── data ──
    const A1 = await mk('Dash plain', { supplier_id: sup, stock: 0, reorder_level: 20 });
    const A2 = await mk('Dash low', { supplier_id: sup, stock: 0, reorder_level: 10 });
    const A3 = await mk('Dash out', { supplier_id: sup, stock: 0, reorder_level: 5 });
    const A4 = await mk('Dash dated', { supplier_id: sup, stock: 0, tracking: 'batch', track_expiry: true });
    const A5 = await mk('Dash slow', { supplier_id: sup, stock: 0 });
    const A6 = await mk('Dash excess', { supplier_id: sup, stock: 0, max_stock: 50 });
    await receive(A1, 100); await receive(A2, 5); await receive(A3, 5); await receive(A5, 40); await receive(A6, 500);
    await receive(A4, 6, {}, { batch_no: 'D1', expiry_date: day(10) });
    await receive(A4, 8, {}, { batch_no: 'D2', expiry_date: day(90) });
    await receive(A4, 4, {}, { batch_no: 'D3', expiry_date: day(5) });
    await pool.request().input('t', sql.Int, A4).query("UPDATE stock_batches SET expiry_date = DATEADD(DAY, -3, CAST(GETDATE() AS DATE)) WHERE tire_id = @t AND batch_no = 'D3'");
    await sell(A2, 2); await sell(A3, 5);
    await pool.request().input('t', sql.Int, A5).query('UPDATE tires SET created_at = DATEADD(DAY, -200, GETDATE()) WHERE id = @t');
    await pool.request().input('t', sql.Int, A5).query("EXEC sp_set_session_context N'allow_purge', 1; UPDATE stock_movements SET created_at = DATEADD(DAY, -200, GETDATE()) WHERE tire_id = @t");
    const locs = (await call('GET', '/inventory/locations')).body;
    const L1 = locs.find(l => l.is_default).id;
    const Q = (await call('POST', '/inventory/locations', { name: 'Dash cage', kind: 'quarantine' })).body.id;
    let r = await call('POST', '/inventory/transfers', { from_location_id: L1, to_location_id: Q, items: [{ tire_id: A1, qty: 7 }], notes: 'to cage' });
    check('seed: quarantine transfer', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', '/purchases', { supplier_id: sup, date: day(-5), status: 'pending', expected_date: day(-2), items: [{ tire_id: A1, tire_name: 'x', qty: 12, unit_price: 10 }] });
    check('seed: overdue purchase order', r.status === 201, JSON.stringify(r.body));
    const eastLoc = (await call('GET', '/inventory/locations', null, admin, east)).body.find(l => l.is_default).id;
    r = await call('POST', '/inventory/transfers', { from_location_id: L1, to_location_id: eastLoc, items: [{ tire_id: A1, qty: 5 }], expected_at: day(-1) }, mgr);
    check('seed: overdue cross-branch transfer', r.status === 201 && r.body.status === 'in_transit', JSON.stringify(r.body));
    r = await adj(A1, -8, 'damage', staff);
    check('seed: staff write-off waits for approval', r.body.status === 'pending', JSON.stringify(r.body));
    r = await adj(A1, -3, 'damage');
    check('seed: admin write-off posts', r.status === 201 && r.body.status === 'approved', JSON.stringify(r.body));
    // count with a variance at the default location
    r = await call('POST', '/inventory/counts', { location_id: L1 });
    const cnt = r.body.id;
    const cd = (await call('GET', `/inventory/counts/${cnt}`)).body;
    const lines = (cd.items || cd.lines || []).map(l => ({ id: l.id, counted_qty: l.tire_id === A1 ? l.system_qty - 1 : l.system_qty }));
    await call('PUT', `/inventory/counts/${cnt}/lines`, { lines });
    r = await call('POST', `/inventory/counts/${cnt}/complete`, {});
    check('seed: count completed with a variance', r.status === 200, JSON.stringify(r.body));

    // ── dashboard ──
    r = await call('GET', '/inventory/insights/dashboard');
    check('dashboard loads', r.status === 200 && r.body.kpis, JSON.stringify(r.body).slice(0, 200));
    const D = r.body, K = D.kpis;
    const truth = await sqlOne('SELECT SUM(stock) AS units, COUNT(CASE WHEN status = \'active\' THEN 1 END) AS active, COUNT(*) AS products FROM tires WHERE organization_id = @o AND branch_id = @b');
    check('total units match the item records', K.units === Number(truth.units), `${K.units} vs ${truth.units}`);
    check('product counts match', K.active_products === truth.active && K.products === truth.products);
    const val = (await call('GET', '/inventory/valuation')).body;
    check('inventory value equals the valuation report', Math.abs(K.inventory_value - val.totals.value) < 0.01 && K.inventory_value > 0, `${K.inventory_value} vs ${val.totals?.value}`);
    check('out of stock with demand counted', K.out_of_stock >= 1 && K.out_of_stock_with_demand >= 1, JSON.stringify([K.out_of_stock, K.out_of_stock_with_demand]));
    check('low stock counted', K.low_stock >= 1);
    check('replenishment recommendation counted with cost', K.reorder.items >= 2 && K.reorder.cost > 0, JSON.stringify(K.reorder));
    check('excess stock found', K.excess.items >= 1 && K.excess.units > 0, JSON.stringify(K.excess));
    check('slow moving found', K.slow_moving.items >= 1 && K.slow_moving.value > 0, JSON.stringify(K.slow_moving));
    check('expired stock counted', K.expiry.expired_units === 4 && K.expiry.expired_batches === 1 && K.expiry.expired_value === 40, JSON.stringify(K.expiry));
    check('near-expiry stock counted (30 days)', K.expiry.near_units === 6 && K.expiry.near_days === 30, JSON.stringify(K.expiry));
    check('quarantined units counted', K.quarantine.units === 7 && K.quarantine.value === 70, JSON.stringify(K.quarantine));
    check('pending receipts counted and overdue flagged', K.pending_receipts.orders === 1 && K.pending_receipts.units === 12 && K.pending_receipts.overdue === 1, JSON.stringify(K.pending_receipts));
    check('pending transfers counted and overdue flagged', K.pending_transfers.transfers === 1 && K.pending_transfers.units === 5 && K.pending_transfers.overdue === 1, JSON.stringify(K.pending_transfers));
    check('adjustments awaiting approval counted', K.pending_approvals >= 1);
    check('count variances counted', K.discrepancies.count_variance_lines >= 1 && K.discrepancies.count_lines >= 1, JSON.stringify(K.discrepancies));
    check('clean ledger shows no integrity mismatches', K.discrepancies.ledger_mismatches === 0 && K.discrepancies.location_mismatches === 0, JSON.stringify(K.discrepancies));
    const sev = D.exceptions.map(e => e.severity);
    const rank = { critical: 0, warning: 1, info: 2 };
    check('exceptions are ordered critical, warning, info', sev.every((s, i) => i === 0 || rank[sev[i - 1]] <= rank[s]) && D.exceptions.length >= 6, sev.join());
    const ids = D.exceptions.map(e => e.id);
    check('expired stock is a critical exception with its value', D.exceptions.find(e => e.id === 'expired')?.severity === 'critical' && D.exceptions.find(e => e.id === 'expired').value === 40);
    check('overdue transfer is critical', D.exceptions.find(e => e.id === 'transfers_overdue')?.severity === 'critical');
    check('excess and slow are information only', D.exceptions.find(e => e.id === 'excess')?.severity === 'info' && D.exceptions.find(e => e.id === 'slow')?.severity === 'info', ids.join());
    check('every exception names where to act', D.exceptions.every(e => e.target && e.title && e.detail && e.count > 0));
    check('exception counts add up', D.exception_counts.critical + D.exception_counts.warning + D.exception_counts.info === D.exceptions.length);
    check('recent movements newest first, at most 12', D.recent_movements.length === 12 && D.recent_movements.every((m, i, a) => i === 0 || m.id < a[i - 1].id));
    check('14-day trend is continuous', D.trend.length === 14 && D.trend[13].day === day(0) && D.trend[13].units_in > 0, JSON.stringify(D.trend.slice(-2)));
    check('low stock and expiring lists give names', D.low_stock_list.some(x => /Dash out/.test(x.item_name)) && D.expiring_list.some(x => x.batch_no === 'D3' && x.days_left < 0), JSON.stringify([D.low_stock_list.length, D.expiring_list.length]));
    // a corrupted record is the first thing the dashboard must shout about
    await pool.request().input('t', sql.Int, A6).query('UPDATE tires SET stock = stock + 1 WHERE id = @t');
    r = await call('GET', '/inventory/insights/dashboard');
    const integ = r.body.exceptions.find(e => e.id === 'integrity');
    check('record mismatch becomes the top critical exception', integ && integ.severity === 'critical' && r.body.exceptions[0].severity === 'critical' && r.body.kpis.discrepancies.ledger_mismatches === 1, JSON.stringify(r.body.exceptions[0]));
    await pool.request().input('t', sql.Int, A6).query('UPDATE tires SET stock = stock - 1 WHERE id = @t');
    r = await call('GET', '/inventory/insights/dashboard?scope=org');
    check('organisation scope spans branches', r.body.scope === 'organisation' && r.body.kpis.units >= K.units);
    r = await call('GET', '/inventory/insights/dashboard?scope=org', null, staff);
    check('staff cannot widen scope', r.body.scope === 'branch' && r.body.kpis.units === K.units, r.body.scope);
    r = await call('GET', '/inventory/insights/dashboard', null, adminB, B.br);
    check('another organisation sees none of it', r.body.kpis.units === 0 && r.body.kpis.products === 0 && r.body.recent_movements.length === 0 && r.body.exceptions.length === 0, JSON.stringify(r.body.kpis).slice(0, 200));

    // ── report catalogue ──
    r = await call('GET', '/inventory/insights/reports');
    check('admin sees the 12 standard reports', r.body.length === 12 && ['current_stock', 'movement_ledger', 'valuation', 'low_stock', 'aging', 'slow_moving', 'batch_expiry', 'damage_writeoff', 'count_variance', 'branch_comparison', 'demand_replenishment', 'audit'].every(i => r.body.some(x => x.id === i)));
    check('each report describes its filters', r.body.every(x => x.title && x.description && Array.isArray(x.filters)));
    r = await call('GET', '/inventory/insights/reports', null, staff);
    check('staff do not see valuation or audit', r.body.length === 10 && !r.body.some(x => x.id === 'valuation' || x.id === 'audit'));
    check('staff are refused valuation', (await rep('valuation', '', staff)).status === 403);
    check('staff are refused audit', (await rep('audit', '', staff)).status === 403);
    check('unknown report is 404', (await rep('nope')).status === 404);

    // ── current stock ──
    r = await rep('current_stock');
    let row = r.body.rows.find(x => x.item_name === 'Dash plain');
    const pos = (await call('GET', `/inventory/position/${A1}`)).body;
    check('current stock row agrees with the position screen', r.status === 200 && row && row.on_hand === pos.on_hand && row.available === pos.available && row.quarantined === 7, JSON.stringify([row, pos.on_hand, pos.available]));
    check('totals row sums quantities and value', r.body.totals.on_hand === r.body.rows.reduce((a, x) => a + x.on_hand, 0) && Math.abs(r.body.totals.value - r.body.rows.reduce((a, x) => a + x.value, 0)) < 0.01);
    r = await rep('current_stock', 'q=Dash%20low');
    check('search narrows the report', r.body.rows.length === 1 && r.body.rows[0].item_name === 'Dash low', JSON.stringify(r.body.rows.map(x => x.item_name)));
    r = await rep('current_stock', `location=${Q}`);
    check('location filter shows only that location', r.body.rows.length === 1 && r.body.rows[0].qty === 7 && r.body.rows[0].location === 'Dash cage', JSON.stringify(r.body.rows));
    r = await rep('current_stock', 'by=location');
    check('by-location view lists each location balance', r.body.rows.some(x => x.location === 'Dash cage') && r.body.rows.some(x => x.item_name === 'Dash plain' && x.location !== 'Dash cage'));
    r = await rep('current_stock', 'q=Dash&include_zero=1');
    check('zero-stock items appear on request', r.body.rows.some(x => x.item_name === 'Dash out' && x.on_hand === 0));
    r = await rep('current_stock', 'limit=2');
    check('row limit truncates and says so', r.body.rows.length === 2 && r.body.truncated === true && r.body.row_count === 2);
    r = await rep('current_stock', 'category=abc');
    check('bad filter value is rejected', r.status === 400);

    // ── ledger ──
    r = await rep('movement_ledger', `from=${day(-1)}&to=${day(0)}`);
    const nMov = (await sqlOne('SELECT COUNT(*) AS n FROM stock_movements WHERE organization_id = @o AND branch_id = @b AND created_at >= CAST(@d AS DATE)'.replace('@d', `'${day(-1)}'`))).n;
    check('ledger lists movements of the period', r.status === 200 && r.body.rows.length > 0 && r.body.rows.length <= nMov, `${r.body.rows.length} vs ${nMov}`);
    check('ledger summary balances in and out', r.body.summary[2].value === r.body.summary[0].value - r.body.summary[1].value && r.body.totals.qty_change === r.body.summary[2].value);
    check('ledger rows carry before / after', r.body.rows.every(x => x.qty_before != null && x.qty_after != null && x.qty_after - x.qty_before === x.qty_change) );
    r = await rep('movement_ledger', 'reason=sale&q=Dash');
    check('ledger filters by reason and item', r.body.rows.length === 2 && r.body.rows.every(x => x.reason === 'Sale'), JSON.stringify(r.body.rows.map(x => x.reason)));
    r = await rep('movement_ledger', `location=${Q}`);
    check('ledger filters by location', r.body.rows.length >= 1 && r.body.rows.every(x => x.location === 'Dash cage'));
    check('reversed date range is rejected', (await rep('movement_ledger', `from=${day(0)}&to=${day(-5)}`)).status === 400);
    check('invalid date is rejected', (await rep('movement_ledger', 'from=yesterday')).status === 400);
    r = await rep('movement_ledger', `from=${day(-40)}&to=${day(-35)}`);
    check('empty period returns an empty report, not an error', r.status === 200 && r.body.rows.length === 0);

    // ── valuation ──
    r = await rep('valuation');
    check('valuation total equals the valuation screen', Math.abs(r.body.totals.value - val.totals.value) < 0.01 && Math.abs(r.body.totals.stock - val.totals.units) < 1, JSON.stringify([r.body.totals, val.totals]));
    check('valuation has category breakdown and method', r.body.breakdown.length >= 1 && r.body.summary[0].label === 'Method');
    r = await rep('valuation', 'q=excess');
    check('valuation filters by item', r.body.rows.length === 1 && r.body.rows[0].stock === 500);

    // ── low stock ──
    r = await rep('low_stock');
    const lowRows = r.body.rows;
    check('low stock report lists low and out-of-stock items', lowRows.some(x => x.item_name === 'Dash out' && x.status === 'Out of stock') && lowRows.some(x => x.item_name === 'Dash low'), JSON.stringify(lowRows.map(x => [x.item_name, x.status])));
    check('most urgent first', lowRows[0].status === 'Out of stock');
    check('suggested order has quantity and cost', lowRows.filter(x => x.suggested_qty > 0).every(x => x.suggested_cost > 0));
    r = await rep('low_stock', 'status=excess');
    check('excess view lists overstocked items', r.body.rows.length >= 1 && r.body.rows.every(x => x.excess_qty > 0) && r.body.rows.some(x => x.item_name === 'Dash excess'));

    // ── aging / slow ──
    r = await rep('aging', 'q=Dash%20slow');
    check('aging puts old stock in the old bucket', r.body.rows.length === 1 && r.body.rows[0].units === 40 && r.body.rows[0]['u_181-365'] === 40 && r.body.rows[0].oldest_days >= 199, JSON.stringify(r.body.rows[0]));
    r = await rep('aging');
    check('aging breakdown totals match the rows', r.body.breakdown.reduce((a, b) => a + b.units, 0) === r.body.totals.units, JSON.stringify(r.body.totals));
    r = await rep('slow_moving');
    row = r.body.rows.find(x => x.name === 'Dash slow');
    check('slow-moving report classifies the idle item', row && ['non_moving', 'Non-moving', 'Obsolete', 'Slow'].some(c => String(row.class_label).includes(c.replace('_', '-'))) && row.idle_days >= 199 && row.provision_value > 0, JSON.stringify(row));
    check('active items are left out by default', !r.body.rows.some(x => x.name === 'Dash plain'));
    r = await rep('slow_moving', 'class=all&q=Dash%20plain');
    check('class=all includes active items', r.body.rows.length === 1 && /Active/i.test(r.body.rows[0].class_label));

    // ── batch / expiry ──
    r = await rep('batch_expiry', 'days=30');
    const b = Object.fromEntries(r.body.rows.map(x => [x.batch_no, x]));
    check('expiry report lists expired and soon-to-expire batches', b.D3?.expiry_status === 'Expired' && b.D1?.expiry_status === 'Expiring' && !b.D2, JSON.stringify(r.body.rows.map(x => [x.batch_no, x.expiry_status])));
    check('expiry values and days left', b.D3.qty === 4 && b.D3.value === 40 && b.D3.days_left === -3 && b.D1.days_left === 10, JSON.stringify([b.D3, b.D1]));
    check('expiry summary separates expired from expiring', r.body.summary[0].value === 40 && r.body.summary[1].value === 60);
    r = await rep('batch_expiry', 'days=120&status=expired');
    check('expired-only filter', r.body.rows.length === 1 && r.body.rows[0].batch_no === 'D3');
    r = await rep('batch_expiry', 'status=all&q=Dash%20dated');
    check('status=all lists every batch with stock', r.body.rows.length === 3);

    // ── damage / write-off ──
    r = await rep('damage_writeoff');
    const wo = r.body.rows.filter(x => x.item_name === 'Dash plain' && x.qty === 3);
    check('write-off report lists the approved loss with its people', wo.length === 1 && wo[0].qty === 3 && wo[0].value === 30 && wo[0].cause_label && wo[0].approved_by !== undefined && wo[0].reason_label, JSON.stringify(wo));
    check('pending write-off is not a loss yet', !r.body.rows.some(x => x.qty === 8));
    check('count shortage appears as a physical loss too', r.body.rows.some(x => x.reason_label === 'Stock count shortage' && x.qty === 1));
    check('physical loss is separate from valuation write-downs', r.body.summary[0].label === 'Physical loss' && r.body.summary[1].label.includes('Valuation') && r.body.breakdown.length >= 1);
    r = await rep('damage_writeoff', 'cause=theft');
    check('cause filter works', r.body.rows.length === 0);

    // ── count variance ──
    r = await rep('count_variance');
    row = r.body.rows.find(x => x.item_name === 'Dash plain');
    check('count variance report shows system vs counted', row && row.variance === -1 && row.counted_qty === row.system_qty - 1 && row.variance_value === -10 && row.count_no, JSON.stringify(row));
    check('count summary has accuracy and shortage value', r.body.summary.some(s => s.label === 'Counting accuracy') && r.body.summary.find(s => s.label === 'Shortage value').value === 10, JSON.stringify(r.body.summary));
    r = await rep('count_variance', 'variances_only=0');
    check('variances_only=0 includes matching lines', r.body.rows.length > 1);
    r = await rep('count_variance', `location=${Q}`);
    check('count report filters by location', r.body.rows.length === 0);

    // ── branch comparison ──
    r = await rep('branch_comparison', 'by=branch', admin);
    check('staff-scope comparison has own branch only', r.body.rows.every(x => x.branch === 'Main'));
    r = await call('GET', '/inventory/insights/reports/branch_comparison?by=branch&scope=org');
    check('org comparison lists both branches with value shares', r.body.rows.length === 2 && Math.abs(r.body.rows.reduce((a, x) => a + x.share, 0) - 100) < 0.2, JSON.stringify(r.body.rows));
    row = r.body.rows.find(x => x.branch === 'Main');
    check('comparison shows units sent in transit', row.in_transit_out === 5 && r.body.rows.find(x => x.branch === 'East').in_transit_in === 5, JSON.stringify(r.body.rows));
    r = await call('GET', '/inventory/insights/reports/branch_comparison?by=item&scope=org');
    check('item comparison has a column per branch', r.body.columns.filter(c => c.key.startsWith('br_')).length === 1 && r.body.rows.some(x => x.item_name === 'Dash plain'), JSON.stringify(r.body.columns.map(c => c.key)));
    r = await call('GET', '/inventory/insights/reports/branch_comparison?by=location&scope=org');
    check('location comparison lists warehouses and locations', r.body.rows.some(x => x.location === 'Dash cage') && r.body.columns.some(c => c.key === 'location'));
    r = await call('GET', '/inventory/insights/reports/branch_comparison?by=warehouse');
    check('warehouse comparison groups unassigned locations', r.body.rows.every(x => x.warehouse));

    // ── demand & replenishment ──
    r = await rep('demand_replenishment');
    row = r.body.rows.find(x => x.item_name === 'Dash out');
    check('demand report shows sales, cover and suggested order', row && row.sold === 5 && row.status === 'Out of stock' && row.suggested_qty >= 0 && row.lead_time_days != null, JSON.stringify(row));
    check('items without demand or need are left out', !r.body.rows.some(x => x.item_name === 'Dash plain' && x.status === 'Ok' && x.sold === 0));
    r = await rep('demand_replenishment', 'status=all&q=Dash%20plain');
    check('status=all includes quiet items', r.body.rows.length === 1);

    // ── audit ──
    r = await rep('audit');
    check('audit report lists inventory changes with user and entity', r.status === 200 && r.body.rows.length > 0 && r.body.rows.every(x => x.entity && x.action), JSON.stringify(r.body.rows.slice(0, 2)));
    check('audit summary reports movements without user / reference', r.body.summary.length === 3);
    r = await rep('audit', 'entity=stock_transfer');
    check('audit filters by record type', r.body.rows.length >= 2 && r.body.rows.every(x => x.entity === 'Stock transfer'), JSON.stringify(r.body.rows.map(x => x.entity)));
    r = await rep('audit', 'entity=stock_adjustment&action=CREATE');
    check('audit filters by action', r.body.rows.length >= 1 && r.body.rows.every(x => x.action === 'CREATE'));

    // ── export ──
    const xl = await call('POST', '/inventory', { model: '=HYPERLINK("http://x")', cost_price: 1, sale_price: 2, stock: 0 });
    await call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: xl.body.id, tire_name: 'x', qty: 3, unit_price: 1 }] });
    let ex = await raw('/inventory/insights/reports/current_stock/export?q=HYPERLINK');
    check('CSV export has the right type and a BOM', ex.status === 200 && /text\/csv/.test(ex.type) && ex.bom, ex.type);
    const csv = ex.text.trim().split(/\r\n/);
    check('CSV has header, data and a total row', csv.length === 3 && /^Branch,SKU,Item/.test(csv[0]) && /^Total,/.test(csv[2]), csv.join(' | ').slice(0, 300));
    check('CSV neutralises spreadsheet formulas', csv[1].includes("'=HYPERLINK"), csv[1]);
    ex = await raw('/inventory/insights/reports/movement_ledger/export');
    check('ledger exports with readable dates', ex.status === 200 && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ex.text));
    ex = await raw('/inventory/insights/reports/valuation/export', staff);
    check('export respects report access', ex.status === 403);
    await new Promise(r => setTimeout(r, 800));
    const aud = await pool.request().input('o', sql.Int, org).query("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = @o AND entity = 'inventory_report' AND action = 'EXPORT'");
    check('exports are written to the audit log', aud.recordset[0].n >= 2, aud.recordset[0].n);

    // ── isolation ──
    for (const id of ['current_stock', 'movement_ledger', 'valuation', 'low_stock', 'aging', 'slow_moving', 'batch_expiry', 'damage_writeoff', 'count_variance', 'branch_comparison', 'demand_replenishment', 'audit']) {
      r = await rep(id, '', adminB, B.br);
      check(`other organisation gets nothing from ${id}`, r.status === 200 && r.body.rows.every(x => !(x.units || x.on_hand || x.qty || x.value)) && (id === 'branch_comparison' || r.body.rows.length === 0), JSON.stringify([r.status, r.body.rows?.length]));
    }
    r = await rep('current_stock', `tire=${A1}`, adminB, B.br);
    check('cannot reach our item by id', r.body.rows.length === 0);

    // ── ledger intact (reports are read-only) ──
    r = await call('GET', '/inventory/reconciliation');
    check('ledger still reconciles', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 200));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of [org, B.org]) {
      for (const q of [
        'DELETE FROM transfer_events WHERE organization_id=@o', 'DELETE FROM location_access WHERE location_id IN (SELECT id FROM stock_locations WHERE organization_id=@o)',
        'DELETE FROM stock_count_items WHERE count_id IN (SELECT id FROM stock_counts WHERE organization_id=@o)', 'DELETE FROM stock_counts WHERE organization_id=@o',
        'DELETE FROM loss_actions WHERE organization_id=@o', 'DELETE FROM supplier_returns WHERE organization_id=@o', 'DELETE FROM quality_disposals WHERE organization_id=@o',
        'DELETE FROM valuation_adjustment_layers WHERE adjustment_id IN (SELECT id FROM valuation_adjustments WHERE organization_id=@o)', 'DELETE FROM valuation_adjustments WHERE organization_id=@o',
        'DELETE FROM batch_quality_events WHERE organization_id=@o', 'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o',
        'DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE organization_id=@o)', 'DELETE FROM stock_transfers WHERE organization_id=@o',
        'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
        'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
        'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sales WHERE organization_id=@o',
        'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
        'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o', 'DELETE FROM warehouses WHERE organization_id=@o',
        'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
        'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
        'DELETE FROM users WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
        { try { await pool.request().input('o', sql.Int, o).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); } }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
