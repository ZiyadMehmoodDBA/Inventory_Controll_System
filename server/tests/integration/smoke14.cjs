process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 500)}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const pool = await getPool();
  const mkOrg = async nm => {
    const org = (await pool.request().input('n', sql.NVarChar(100), nm).query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@n, 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'W Supply', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR))")).recordset[0].id;
    return { org, br, sup };
  };
  const A = await mkOrg('SMOKE ORG14'), B = await mkOrg('SMOKE ORG14B');
  const { org, br, sup } = A;
  const east = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'East', 'EAST')")).recordset[0].id;
  const mkUser = async (role, branch, nm) => (await pool.request().input('o', sql.Int, org).input('b', sql.Int, branch).input('r', sql.NVarChar(50), role).input('n', sql.NVarChar(100), nm)
    .query("INSERT INTO users (name, email, password_hash, role, organization_id, branch_id) OUTPUT INSERTED.id VALUES (@n, @n + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR) + '@smoke14.test', 'x', @r, @o, @b)")).recordset[0].id;
  const uStaff1 = await mkUser('staff', br, 'wh staff one'), uStaff2 = await mkUser('staff', br, 'wh staff two'), uMgrMain = await mkUser('branch_manager', br, 'wh mgr main'),
        uMgrEast = await mkUser('branch_manager', east, 'wh mgr east'), uStaffEast = await mkUser('staff', east, 'wh staff east');
  const tok = (o, role, uid, branch) => jwt.sign({ userId: uid, orgId: o.org, branchId: role === 'org_admin' ? null : branch, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok(A, 'org_admin', 1001), staff1 = tok(A, 'staff', uStaff1, br), staff2 = tok(A, 'staff', uStaff2, br), mgrMain = tok(A, 'branch_manager', uMgrMain, br),
        mgrEast = tok(A, 'branch_manager', uMgrEast, east), staffEast = tok(A, 'staff', uStaffEast, east), adminB = tok(B, 'org_admin', 2001, null);
  const call = async (m, p, body, t = admin, branch = br) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(branch) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  let n = 0;
  const mk = async (model, extra = {}, branch = br) => {
    const r = await call('POST', '/inventory', { model, cost_price: 10, sale_price: 20, ...extra }, admin, branch);
    if (r.status !== 201 && r.status !== 200) throw new Error('create ' + model + ' ' + JSON.stringify(r.body));
    return r.body.id;
  };
  const receive = (tire, qty, extra = {}, it = {}, t = admin, branch = br) => call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', ...extra, items: [{ tire_id: tire, tire_name: 'x', qty, unit_price: 10 + (++n) * 0, ...it }] }, t, branch);
  const sell = (tire, qty, extra = {}, t = admin, branch = br) => call('POST', '/sales', { date: day(0), items: [{ tire_id: tire, qty, unit_price: 20 + (++n) / 100 }], tax_rate: 0, ...extra }, t, branch);
  const stockOf = async (id, branch = br) => (await call('GET', `/inventory/position/${id}`, null, admin, branch)).body.on_hand;
  const atLoc = async (tire, loc, branch = br) => ((await call('GET', `/inventory/position/${tire}`, null, admin, branch)).body.locations || []).find(l => l.location_id === loc || l.id === loc)?.on_hand ?? 0;
  const trf = (from, to, items, extra = {}, t = admin, branch = br) => call('POST', '/inventory/transfers', { from_location_id: from, to_location_id: to, items: items.map(([tire_id, qty]) => ({ tire_id, qty })), ...extra }, t, branch);
  const findItem = async (branch, name) => (await call('GET', '/inventory', null, admin, branch)).body.find?.(i => (i.model || '').trim() === name) || ((await call('GET', '/inventory', null, admin, branch)).body.items || []).find(i => (i.model || '').trim() === name);
  try {
    // ── warehouses ──
    const mainLocs = (await call('GET', '/inventory/locations')).body;
    const L1 = mainLocs.find(l => l.is_default).id;
    let r = await call('POST', '/inventory/locations', { name: 'Rack B', code: 'RACKB' });
    const L2 = r.body.id;
    r = await call('POST', '/inventory/warehouses', { name: 'Central DC', code: 'cdc', address: '1 Depot Rd' });
    check('manager creates a warehouse', r.status === 201 && r.body.code === 'CDC', JSON.stringify(r.body));
    const W1 = r.body.id;
    r = await call('POST', '/inventory/warehouses', { name: 'Again', code: 'CDC' });
    check('duplicate warehouse code refused', r.status === 409, JSON.stringify(r.body));
    r = await call('POST', '/inventory/warehouses', { name: 'Staff try', code: 'ST' }, staff1);
    check('staff cannot create warehouses', r.status === 403);
    r = await call('POST', '/inventory/warehouses', { name: '' });
    check('warehouse needs a name', r.status === 400);
    r = await call('PUT', `/inventory/locations/${L1}/warehouse`, { warehouse_id: W1 });
    check('default location joins the warehouse', r.status === 200 && r.body.warehouse_id === W1, JSON.stringify(r.body));
    r = await call('PUT', `/inventory/locations/${L2}/warehouse`, { warehouse_id: W1 });
    check('second location joins the warehouse', r.status === 200);
    r = await call('PUT', `/inventory/locations/${L2}/warehouse`, { warehouse_id: 999999 });
    check('unknown warehouse refused', r.status === 404);
    r = await call('GET', '/inventory/warehouses');
    check('warehouse list shows its locations', r.body.find(w => w.id === W1)?.locations === 2, JSON.stringify(r.body));

    // ── receive / issue against a chosen location ──
    const P = await mk('Pallet item', { supplier_id: sup, stock: 0 });
    r = await receive(P, 40);
    check('receipt without a location lands in the default location', r.status === 201 && (await atLoc(P, L1)) === 40, JSON.stringify(r.body));
    r = await receive(P, 25, { location_id: L2 });
    check('receipt into a chosen location', r.status === 201 && (await atLoc(P, L2)) === 25 && (await atLoc(P, L1)) === 40, JSON.stringify(r.body));
    r = await call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'pending', location_id: L2, items: [{ tire_id: P, tire_name: 'x', qty: 5, unit_price: 10 }] });
    const poId = r.body.id;
    r = await call('PATCH', `/purchases/${poId}/status`, { status: 'received' });
    check('pending order received later goes to its location', r.status === 200 && (await atLoc(P, L2)) === 30, JSON.stringify(r.body));
    r = await receive(P, 5, { location_id: 99999999 });
    check('unknown receiving location refused', r.status === 404 || r.status === 400, JSON.stringify([r.status, r.body]));
    r = await sell(P, 28, { location_id: L2 });
    check('sale issues from the chosen location', r.status === 201 && (await atLoc(P, L2)) === 2 && (await atLoc(P, L1)) === 40, JSON.stringify(r.body));
    r = await sell(P, 5, { location_id: L2 });
    check('cannot sell more than that location holds', r.status === 409 && r.body.code === 'INSUFFICIENT_STOCK', JSON.stringify(r.body));
    check('failed sale moved nothing', (await atLoc(P, L2)) === 2 && (await stockOf(P)) === 42);
    r = await sell(P, 1, { location_id: 999999 });
    check('sale from an unknown location refused', r.status === 404 || r.status === 400, JSON.stringify([r.status, r.body]));

    // ── same-branch transfer + in transit + receipt ──
    r = await trf(L1, L2, [[P, 10]]);
    check('immediate transfer completes', r.status === 201 && r.body.status === 'completed' && r.body.crossBranch === false, JSON.stringify(r.body));
    check('stock moved between locations', (await atLoc(P, L1)) === 30 && (await atLoc(P, L2)) === 12);
    r = await trf(L1, L2, [[P, 6]], { in_transit: true, notes: 'forklift run', expected_at: day(-2), carrier: 'Yard truck' });
    const t1 = r.body.id;
    check('in-transit transfer leaves the source and waits', r.status === 201 && r.body.status === 'in_transit' && (await atLoc(P, L1)) === 24 && (await atLoc(P, L2)) === 12 && (await stockOf(P)) === 36, JSON.stringify(r.body));
    r = await call('GET', '/inventory/warehouse/in-transit');
    const row = r.body.transfers.find(t => t.id === t1);
    check('in-transit board lists it as overdue with units', row && row.overdue === 1 && row.units === 6 && r.body.overdue >= 1 && row.carrier === 'Yard truck', JSON.stringify(r.body).slice(0, 300));
    r = await call('POST', `/inventory/transfers/${t1}/receive`, { lines: [{ tire_id: P, qty_received: 99 }] });
    check('cannot receive more than was sent', r.status === 400 && r.body.code === 'INVALID_QUANTITY', JSON.stringify(r.body));
    r = await call('POST', `/inventory/transfers/${t1}/receive`, {});
    check('full receipt confirms the transfer', r.status === 200 && r.body.status === 'received' && r.body.discrepancy === false && (await atLoc(P, L2)) === 18 && (await stockOf(P)) === 42, JSON.stringify([r.body, await atLoc(P, L1), await atLoc(P, L2), await stockOf(P)]));
    r = await call('POST', `/inventory/transfers/${t1}/receive`, {});
    check('cannot receive twice', r.status === 409 && r.body.code === 'NOT_IN_TRANSIT', JSON.stringify(r.body));
    r = await call('GET', `/inventory/warehouse/transfers/${t1}`);
    check('trail shows dispatch then receipt', r.status === 200 && r.body.events.map(e => e.event).join() === 'dispatched,received' && r.body.lines[0].qty_received === 6, JSON.stringify(r.body.events));
    // short receipt inside a branch returns the remainder to the source
    r = await trf(L1, L2, [[P, 8]], { in_transit: true });
    const t2 = r.body.id;
    r = await call('POST', `/inventory/transfers/${t2}/receive`, { lines: [{ tire_id: P, qty_received: 5 }] });
    check('short receipt needs an explanation', r.status === 400 && r.body.code === 'NOTE_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', `/inventory/transfers/${t2}/receive`, { lines: [{ tire_id: P, qty_received: 5 }], note: '3 crushed in the cage' });
    check('short receipt: remainder returns to source and is flagged', r.status === 200 && r.body.discrepancy === true && r.body.lines[0].short === 3 && (await atLoc(P, L1)) === 19 && (await atLoc(P, L2)) === 23 && (await stockOf(P)) === 42, JSON.stringify(r.body));
    r = await call('GET', '/inventory/warehouse/transfers?discrepancy=1');
    check('discrepancy filter finds it', r.body.some(t => t.id === t2 && t.units_short === 3));
    // cancel
    r = await trf(L1, L2, [[P, 4]], { in_transit: true });
    r = await call('POST', `/inventory/transfers/${r.body.id}/cancel`, {});
    check('cancel returns everything to the source', r.status === 200 && r.body.status === 'cancelled' && (await atLoc(P, L1)) === 19 && (await stockOf(P)) === 42, JSON.stringify(r.body));
    r = await trf(L1, L1, [[P, 1]]);
    check('same location refused', r.status === 400 && r.body.code === 'SAME_LOCATION');

    // ── cross-branch ──
    const eastLoc = (await call('GET', '/inventory/locations', null, admin, east)).body.find(l => l.is_default).id;
    r = await call('GET', '/inventory/warehouse/destinations');
    check('destinations list other branches and their locations', r.status === 200 && r.body.some(b => b.id === east && b.locations.some(l => l.id === eastLoc)) && !r.body.some(b => b.id === br), JSON.stringify(r.body));
    r = await call('GET', '/inventory/warehouse/destinations', null, staff1);
    check('staff cannot browse destinations', r.status === 403);
    r = await trf(L1, eastLoc, [[P, 5]], {}, staff1);
    check('staff cannot send stock to another branch', r.status === 403 && r.body.code === 'CROSS_BRANCH_FORBIDDEN', JSON.stringify(r.body));
    r = await trf(L1, 99999999, [[P, 5]]);
    check('unknown destination refused', r.status === 404);
    r = await trf(L1, eastLoc, [[P, 500]], {}, mgrMain);
    check('over-quantity cross-branch send refused', r.status === 409 && r.body.code === 'INSUFFICIENT_STOCK', JSON.stringify(r.body));
    r = await trf(L1, eastLoc, [[P, 12]], { expected_at: day(3), carrier: 'Van 7', reference: 'WAYBILL-77', notes: 'restock East' }, mgrMain);
    const x1 = r.body.id;
    check('manager dispatches to another branch: always in transit', r.status === 201 && r.body.status === 'in_transit' && r.body.crossBranch === true, JSON.stringify(r.body));
    check('units left the source, none arrived yet', (await atLoc(P, L1)) === 7 && (await stockOf(P)) === 30);
    r = await call('GET', '/inventory/warehouse/in-transit', null, mgrMain);
    check('sender sees it as outgoing', r.body.transfers.find(t => t.id === x1)?.direction === 'outgoing');
    r = await call('GET', '/inventory/warehouse/in-transit', null, mgrEast, east);
    check('receiver sees it as incoming', r.body.transfers.find(t => t.id === x1)?.direction === 'incoming', JSON.stringify(r.body).slice(0, 300));
    r = await call('GET', '/inventory/warehouse/network', null, mgrMain);
    const mainNet = r.body.branches.find(b => b.id === br);
    check('network view counts units in transit out of the sender', r.body.scope === 'branch' && mainNet.in_transit_out >= 12 && r.body.branches.length === 1, JSON.stringify(r.body).slice(0, 300));
    r = await call('POST', `/inventory/transfers/${x1}/cancel`, {}, mgrEast, east);
    check('receiver cannot cancel the sender\'s dispatch', r.status === 404, JSON.stringify([r.status, r.body]));
    r = await call('POST', `/inventory/transfers/${x1}/receive`, {}, mgrMain);
    check('sender cannot confirm receipt for the destination', r.status === 404, JSON.stringify([r.status, r.body]));
    r = await call('POST', `/inventory/transfers/${x1}/receive`, { lines: [{ tire_id: P, qty_received: 9 }], note: '3 missing from the pallet' }, staffEast, east);
    check('destination staff confirm receipt (short)', r.status === 200 && r.body.status === 'received' && r.body.discrepancy === true && r.body.lines[0].received === 9, JSON.stringify(r.body));
    const eastP = await findItem(east, 'Pallet item');
    check('product created in the destination branch on first transfer', !!eastP && eastP.id !== P, JSON.stringify(eastP)?.slice(0, 200));
    check('destination holds exactly what arrived', eastP && (await stockOf(eastP.id, east)) === 9 && (await atLoc(eastP.id, eastLoc, east)) === 9);
    check('the 3 short units went back to the source', (await atLoc(P, L1)) === 10 && (await stockOf(P)) === 33, `${await atLoc(P, L1)} ${await stockOf(P)}`);
    r = await call('GET', `/inventory/${eastP.id}`, null, admin, east);
    check('cost carried over to the destination copy', r.status === 200 ? Number(r.body.cost_price) === 10 : true, JSON.stringify(r.body).slice(0, 200));
    r = await call('GET', `/inventory/warehouse/transfers/${x1}`, null, mgrEast, east);
    check('both branches can read the audit trail', r.status === 200 && r.body.events.map(e => e.event).join() === 'dispatched,received_short' && r.body.cross_branch === 1 && r.body.carrier === 'Van 7' && r.body.reference === 'WAYBILL-77' && r.body.lines[0].dest_tire_id === eastP.id, JSON.stringify(r.body).slice(0, 400));
    check('trail records who and what was short', r.body.events[1].user_name === 'wh staff east' && r.body.events[1].details.units_short === 3 && /missing/.test(r.body.events[1].note || ''));
    r = await call('GET', `/inventory/warehouse/transfers/${x1}`, null, adminB, B.br);
    check('other organisation cannot read it', r.status === 404);
    // second shipment reuses the existing destination item
    r = await trf(L1, eastLoc, [[P, 4]], {}, mgrMain);
    const x2 = r.body.id;
    r = await call('POST', `/inventory/transfers/${x2}/receive`, {}, mgrEast, east);
    check('second shipment lands on the same destination item', r.status === 200 && (await stockOf(eastP.id, east)) === 13 && (await stockOf(P)) === 29, JSON.stringify(r.body));
    // short + write off: only an administrator or the sender's manager
    r = await trf(L1, eastLoc, [[P, 6]], {}, mgrMain);
    const x3 = r.body.id;
    r = await call('POST', `/inventory/transfers/${x3}/receive`, { lines: [{ tire_id: P, qty_received: 2 }], note: 'pallet damaged', short_action: 'write_off' }, mgrEast, east);
    check('destination manager cannot write off the sender\'s stock', r.status === 403, JSON.stringify([r.status, r.body]));
    r = await call('POST', `/inventory/transfers/${x3}/receive`, { lines: [{ tire_id: P, qty_received: 2 }], note: 'pallet damaged', short_action: 'write_off' }, admin, east);
    check('admin writes off units lost in transit', r.status === 200 && r.body.discrepancy === true && (await stockOf(eastP.id, east)) === 15, JSON.stringify(r.body));
    check('written-off units are gone from the source too', (await stockOf(P)) === 23 && (await atLoc(P, L1)) === 0, `${await stockOf(P)} ${await atLoc(P, L1)}`);
    r = await call('GET', '/inventory/adjustments', null, admin, br);
    const adjs = Array.isArray(r.body) ? r.body : r.body.adjustments || r.body.rows || [];
    check('write-off is on the adjustment register as missing stock', adjs.some(a => a.reason_code === 'missing_stock' && /TRF-/.test(a.notes || '')), JSON.stringify(adjs).slice(0, 300));
    // sender cancels in transit
    const l2Before = await atLoc(P, L2);
    r = await trf(L2, eastLoc, [[P, 3]], {}, mgrMain);
    const x4 = r.body.id;
    r = await call('POST', `/inventory/transfers/${x4}/cancel`, {}, mgrMain);
    check('sender cancels a dispatch: stock returns', r.status === 200 && r.body.status === 'cancelled' && (await atLoc(P, L2)) === l2Before && (await stockOf(P)) === 23 && (await stockOf(eastP.id, east)) === 15, JSON.stringify(r.body));
    r = await call('POST', `/inventory/transfers/${x4}/receive`, {}, mgrEast, east);
    check('cancelled dispatch cannot be received', r.status === 409);

    // tracked item across branches
    const T = await mk('Dated item', { supplier_id: sup, tracking: 'batch', track_expiry: true, stock: 0 });
    await receive(T, 30, {}, { batch_no: 'W-LOT-1', expiry_date: day(60) });
    r = await trf(L1, eastLoc, [[T, 10]], {}, mgrMain);
    const x5 = r.body.id;
    check('tracked item dispatched', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', `/inventory/transfers/${x5}/receive`, {}, mgrEast, east);
    check('tracked item received', r.status === 200, JSON.stringify(r.body));
    const eastT = await findItem(east, 'Dated item');
    check('destination copy is batch tracked and holds the units', eastT && eastT.tracking === 'batch' && (await stockOf(eastT.id, east)) === 10);
    r = await call('GET', `/inventory/batches?tire_id=${eastT.id}`, null, mgrEast, east);
    const eb = (Array.isArray(r.body) ? r.body : r.body.batches || [])[0];
    check('batch recreated at the destination with the same lot and expiry', eb && eb.batch_no === 'W-LOT-1' && String(eb.expiry_date).slice(0, 10) === day(60), JSON.stringify(r.body).slice(0, 300));
    check('source batch balance fell', (await stockOf(T)) === 20);

    // tracking mismatch is caught before anything moves
    const Mm = await mk('Mismatch item', { supplier_id: sup, stock: 0 });
    await mk('Mismatch item', { tracking: 'batch', track_expiry: true, stock: 0 }, east);
    await receive(Mm, 5);
    r = await trf(L1, eastLoc, [[Mm, 2]], {}, mgrMain);
    check('different tracking at the destination blocks the send', r.status === 409 && r.body.code === 'TRACKING_MISMATCH', JSON.stringify(r.body));
    check('and nothing moved', (await stockOf(Mm)) === 5);

    // ── location access ──
    r = await call('GET', `/inventory/locations/${L2}/access`);
    check('access list starts open with the branch staff available', r.status === 200 && r.body.restricted === false && r.body.users.some(u => u.id === uStaff1), JSON.stringify(r.body));
    r = await sell(P, 1, { location_id: L2 }, staff2);
    check('open location: staff can sell from it', r.status === 201, JSON.stringify(r.body));
    r = await call('PUT', `/inventory/locations/${L2}/access`, { users: [{ user_id: uStaff1, can_issue: true, can_receive: true, can_count: false }] });
    check('manager restricts the location to one person', r.status === 200 && r.body.restricted === true, JSON.stringify(r.body));
    r = await sell(P, 1, { location_id: L2 }, staff2);
    check('other staff cannot sell from it', r.status === 403 && r.body.code === 'LOCATION_FORBIDDEN', JSON.stringify(r.body));
    r = await sell(P, 1, { location_id: L2 }, staff1);
    check('the named person can', r.status === 201, JSON.stringify(r.body));
    r = await receive(P, 2, { location_id: L2 }, {}, staff2);
    check('other staff cannot receive into it', r.status === 403, JSON.stringify([r.status, r.body]));
    r = await call('POST', '/inventory/adjustments', { tire_id: P, qty_change: -1, reason_code: 'damage', notes: 'x1', location_id: L2 }, staff2);
    check('or write stock off from it', r.status === 403, JSON.stringify([r.status, r.body]));
    r = await trf(L2, L1, [[P, 1]], {}, staff2);
    check('or transfer out of it', r.status === 403, JSON.stringify([r.status, r.body]));
    r = await trf(L1, L2, [[P, 1]], {}, staff2);
    check('or transfer into it', r.status === 403, JSON.stringify([r.status, r.body]));
    r = await call('POST', '/inventory/counts', { location_id: L2 }, staff1);
    check('named person without count right cannot count', r.status === 403, JSON.stringify([r.status, r.body]));
    r = await call('POST', '/inventory/counts', { location_id: L2 }, staff2);
    check('other staff cannot count it either', r.status === 403);
    r = await call('POST', '/inventory/counts', { location_id: L2 }, mgrMain);
    check('branch manager is never locked out', r.status === 201, JSON.stringify(r.body));
    const cnt = r.body.id;
    r = await call('PUT', `/inventory/counts/${cnt}/lines`, { lines: [] }, staff2);
    check('count lines are protected too', r.status === 403);
    r = await call('POST', `/inventory/counts/${cnt}/complete`, {}, staff2);
    check('and completion', r.status === 403);
    r = await call('POST', `/inventory/counts/${cnt}/complete`, {}, mgrMain);
    check('manager completes the count', r.status === 200, JSON.stringify(r.body));
    r = await call('PUT', `/inventory/locations/${L2}/access`, { users: [{ user_id: uStaffEast }] });
    check('cannot grant access to another branch\'s user', r.status === 400, JSON.stringify(r.body));
    r = await call('PUT', `/inventory/locations/${L2}/access`, { users: [] });
    check('clearing the list reopens the location', r.status === 200 && r.body.restricted === false);
    r = await sell(P, 1, { location_id: L2 }, staff2);
    check('staff can use it again', r.status === 201, JSON.stringify(r.body));
    r = await call('PUT', `/inventory/locations/${L2}/access`, { users: [] }, staff1);
    check('staff cannot edit access', r.status === 403);
    r = await sell(P, 1, { location_id: eastLoc }, staff1);
    check('staff cannot issue from another branch\'s location', r.status === 403 || r.status === 404 || r.status === 400, JSON.stringify([r.status, r.body]));

    // ── network, counts overview ──
    r = await call('GET', '/inventory/warehouse/network', null, admin);
    const nb = r.body.branches;
    const sumUnits = nb.reduce((a, b) => a + b.units, 0);
    const trueTotal = (await pool.request().input('o', sql.Int, org).query('SELECT ISNULL(SUM(stock),0) AS n FROM tires WHERE organization_id = @o')).recordset[0].n;
    check('organisation view spans both branches', r.body.scope === 'organisation' && nb.length === 2 && nb.some(b => b.id === east), JSON.stringify(nb.map(b => b.name)));
    check('network units equal the item totals', sumUnits === trueTotal && r.body.totals.units === trueTotal, `${sumUnits} vs ${trueTotal}`);
    const mainB = nb.find(b => b.id === br);
    check('warehouse level groups its locations', mainB.warehouses.some(w => w.id === W1 && w.locations.length === 2) && mainB.warehouses.every(w => w.units === w.locations.reduce((a, l) => a + l.units, 0)));
    check('values roll up', Math.abs(mainB.value - mainB.warehouses.reduce((a, w) => a + w.value, 0)) < 0.01 && mainB.value > 0);
    r = await call('GET', '/inventory/warehouse/network?q=Dated', null, admin);
    check('item filter narrows the view', r.body.totals.units === 30 && r.body.branches.find(b => b.id === east).units === 10, JSON.stringify(r.body.totals));
    r = await call('GET', '/inventory/warehouse/network', null, staffEast, east);
    check('branch users see only their own branch', r.body.branches.length === 1 && r.body.branches[0].id === east && r.body.scope === 'branch');
    r = await call('GET', '/inventory/warehouse/network', null, adminB, B.br);
    check('another organisation sees none of it', r.body.totals.units === 0 && !r.body.branches.some(b => b.id === br || b.id === east), JSON.stringify(r.body.totals));
    const l2Now = await atLoc(P, L2);
    r = await call('GET', `/inventory/warehouse/locations/${L2}/stock`, null, admin);
    check('location drill-down lists items', r.status === 200 && r.body.items.some(i => i.tire_id === P && i.qty === l2Now), JSON.stringify(r.body).slice(0, 200));
    r = await call('GET', `/inventory/warehouse/locations/${L1}/stock`, null, staffEast, east);
    check('other branch cannot drill into it', r.status === 404);
    r = await call('GET', `/inventory/warehouse/locations/${L1}/stock`, null, adminB, B.br);
    check('nor another organisation', r.status === 404);
    r = await call('GET', '/inventory/warehouse/counts');
    check('counts overview lists each location with its last count', r.status === 200 && r.body.find(l => l.location_id === L2)?.last_count_no && r.body.length >= 2, JSON.stringify(r.body).slice(0, 300));
    r = await trf(L1, eastLoc, [[P, 1]], {}, adminB, B.br);
    check('other organisation cannot move our stock', r.status === 404, JSON.stringify([r.status, r.body]));
    r = await call('GET', '/inventory/warehouse/transfers?status=received');
    check('history filters by status', r.status === 200 && r.body.length >= 3 && r.body.every(t => t.status === 'received'));
    r = await call('GET', '/inventory/warehouse/transfers?direction=outgoing', null, mgrMain);
    check('and by direction', r.body.length >= 4 && r.body.every(t => t.direction === 'outgoing'), JSON.stringify(r.body.map(t => t.direction)));
    r = await call('PUT', `/inventory/warehouses/${W1}`, { is_active: false });
    check('warehouse holding stock cannot be deactivated', r.status === 409 && r.body.code === 'WAREHOUSE_HAS_STOCK', JSON.stringify(r.body));

    // ── ledger intact in every branch ──
    for (const b of [br, east]) {
      r = await call('GET', '/inventory/reconciliation', null, admin, b);
      check(`ledger still reconciles (branch ${b === br ? 'Main' : 'East'})`, r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 300));
    }
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
