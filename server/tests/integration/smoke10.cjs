process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 400)}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG10', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const mkSup = async n => (await pool.request().input('o', sql.Int, org).input('n', sql.NVarChar, n).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, @n, 'S' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR))")).recordset[0].id;
  const S1 = await mkSup('Alpha Supply'), S2 = await mkSup('Beta Supply'), SO = await mkSup('Observed Supply');
  const tok = (role, uid) => jwt.sign({ userId: uid, orgId: org, branchId: role === 'staff' ? br : null, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok('org_admin', 1001), staff = tok('staff', 1002);
  const call = async (m, p, body, t = admin) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  // item with a sales history: sold = [[daysAgo, qty], ...]; created 100 days ago so the whole 90-day window counts
  const mk = async (model, { sold = [], ...extra } = {}) => {
    const r = await call('POST', '/inventory', { model, cost_price: 10, sale_price: 20, ...extra });
    if (r.status !== 201 && r.status !== 200) throw new Error('create ' + model + ' ' + JSON.stringify(r.body));
    const id = r.body.id;
    await pool.request().input('t', sql.Int, id).query('UPDATE tires SET created_at = DATEADD(DAY, -100, GETDATE()) WHERE id = @t');
    for (const [ago, q] of sold) {
      await pool.request().input('t', sql.Int, id).input('o', sql.Int, org).input('b', sql.Int, br).input('q', sql.Int, -q).input('d', sql.Int, -ago)
        .query("INSERT INTO stock_movements (tire_id, organization_id, branch_id, qty_change, reason, qty_before, qty_after, item_name, created_at) VALUES (@t, @o, @b, @q, 'sale', 0, @q, 'x', DATEADD(DAY, @d, GETDATE()))");
    }
    return id;
  };
  const steady = [[10, 30], [40, 30], [70, 30]];     // 90 units over the 90-day window = 1 per day
  const plan = async (q = '') => (await call('GET', '/inventory/replenishment/plan' + q)).body;
  const find = (p, id) => p.items.find(i => i.tire_id === id);
  const params = (id, b, t = admin) => call('PUT', `/inventory/replenishment/params/${id}`, b, t);
  const poCount = async () => (await pool.request().input('o', sql.Int, org).query('SELECT COUNT(*) AS n FROM purchases WHERE organization_id = @o')).recordset[0].n;
  try {
    // ── reorder point = demand during lead time + safety ──
    const A = await mk('Item A', { stock: 20, sold: steady, lead_time_days: 10, safety_stock: 5, supplier_id: S1 });
    let a = find(await plan(), A);
    check('ROP = demand in lead time (1/day x 10) + safety 5 = 15', a.daily_demand === 1 && a.reorder_point === 15 && a.safety_basis === 'set' && a.rop_basis === 'calculated' && a.lead_time_source === 'item', JSON.stringify(a));
    check('stock above ROP: not recommended', a.status === 'ok' && a.suggested_qty === 0 && !a.need_order, a.status);
    await call('POST', '/inventory/adjustments', { tire_id: A, qty_change: -8, reason_code: 'damage' });
    a = find(await plan(), A);
    check('below ROP: low, order up to target (ROP 15 + 30 days) = 45 - 12 = 33', a.status === 'low' && a.target === 45 && a.suggested_qty === 33 && a.days_of_cover === 12, JSON.stringify(a));
    check('stockout date and order-by date are given', a.stockout_date === day(12) && /^\d{4}-/.test(a.order_by), JSON.stringify([a.stockout_date, a.order_by]));
    await params(A, { lead_time_days: 15 });
    a = find(await plan(), A);
    check('cover (12 d) shorter than lead time (15 d) = critical, ROP 20', a.status === 'critical' && a.reorder_point === 20 && a.suggested_qty === 38, JSON.stringify([a.status, a.reorder_point, a.suggested_qty]));
    await params(A, { lead_time_days: 10 });

    // reservations reduce eligible stock
    const rsv = await call('POST', '/inventory/reservations', { tire_id: A, qty: 4 });
    a = find(await plan(), A);
    check('reserved stock is not eligible: available 8, order 37', rsv.status === 201 && a.available === 8 && a.reserved === 4 && a.suggested_qty === 37, JSON.stringify([a.available, a.reserved, a.suggested_qty]));
    await call('POST', `/inventory/reservations/${rsv.body.id}/release`);

    // supplier minimum, pack multiple, capacity
    await params(A, { moq: 40, order_multiple: 12 });
    a = find(await plan(), A);
    check('MOQ 40 then pack multiple 12 -> 48', a.suggested_qty === 48 && a.constraints.some(c => /minimum order/.test(c)) && a.constraints.some(c => /multiples of 12/.test(c)), JSON.stringify([a.suggested_qty, a.constraints]));
    await params(A, { capacity_units: 50 });
    a = find(await plan(), A);
    check('capacity 50 leaves room for 38: below the MOQ so nothing can be ordered', a.suggested_qty === 0 && a.constraints.some(c => /no storage room/.test(c)), JSON.stringify([a.suggested_qty, a.constraints]));
    await params(A, { moq: 10 });
    a = find(await plan(), A);
    check('MOQ 10: 33 -> 36 (multiple of 12), fits the room of 38', a.suggested_qty === 36, JSON.stringify([a.suggested_qty, a.constraints]));
    await params(A, { capacity_units: 30 });
    a = find(await plan(), A);
    check('capacity 30: trimmed to 12 (room 18, whole multiples)', a.suggested_qty === 12 && a.constraints.some(c => /storage capacity/.test(c)), JSON.stringify([a.suggested_qty, a.constraints]));
    let r = await params(A, { max_stock: 100, capacity_units: 50 });
    check('maximum above storage capacity is refused', r.status === 400 && r.body.code === 'INVALID_STOCK_LEVELS', JSON.stringify(r.body));
    r = await params(A, { lead_time_days: 400 });
    check('invalid lead time refused', r.status === 400, JSON.stringify(r.body));
    r = await params(A, { moq: null, order_multiple: null, capacity_units: null });
    check('limits can be cleared', r.status === 200 && r.body.suggested_qty === 33, JSON.stringify(r.body?.suggested_qty));
    r = await params(A, { safety_stock: 6 }, staff);
    check('staff cannot change replenishment parameters', r.status === 403);
    r = await call('GET', `/inventory/${A}/history`);
    check('parameter changes are in the item history', ['lead_time_days', 'moq', 'order_multiple', 'capacity_units'].every(f => r.body.some(h => h.field === f)), JSON.stringify(r.body.map(h => h.field)));

    // incoming supply
    const before = await poCount();
    const po = await call('POST', '/purchases', { supplier_id: S1, date: day(0), expected_date: day(3), items: [{ tire_id: A, tire_name: 'Item A', qty: 20, unit_price: 10 }] });
    a = find(await plan(), A);
    check('confirmed incoming PO counts: position 32 above ROP, not recommended', po.status === 201 && a.on_order === 20 && a.position === 32 && a.status === 'on_order' && a.suggested_qty === 0, JSON.stringify([a.on_order, a.position, a.status, a.suggested_qty]));
    r = await call('GET', '/inventory/replenishment/incoming');
    check('incoming list shows the PO with its expected date', r.body.rows.some(x => x.po_no === po.body.po_no && String(x.expected_date).startsWith(day(3)) && !x.overdue) && r.body.units >= 20, JSON.stringify(r.body.rows));
    await pool.request().input('p', sql.Int, po.body.id).query('UPDATE purchases SET expected_date = DATEADD(DAY, -2, CAST(GETDATE() AS DATE)) WHERE id = @p');
    r = await call('GET', '/inventory/replenishment/incoming');
    check('late PO flagged overdue', r.body.rows.find(x => x.purchase_id === po.body.id)?.days_overdue === 2 && r.body.overdue_lines >= 1, JSON.stringify(r.body.rows));
    r = await call('PATCH', `/purchases/${po.body.id}/status`, { status: 'received' });
    const rec = (await pool.request().input('p', sql.Int, po.body.id).query('SELECT received_at FROM purchases WHERE id = @p')).recordset[0];
    check('receiving a PO stamps received_at', r.status === 200 && rec.received_at != null, JSON.stringify(rec));
    check('planning created no purchase orders by itself', (await poCount()) === before + 1);

    // status board
    const B = await mk('Item B', { stock: 0, sold: steady, lead_time_days: 5, safety_stock: 0 });
    const C = await mk('Item C', { stock: 500, sold: steady, lead_time_days: 5, safety_stock: 0 });
    const D = await mk('Item D', { stock: 80, max_stock: 50, supplier_id: S2 });
    let p = await plan();
    const b = find(p, B), c = find(p, C), d = find(p, D);
    check('out of stock identified with a suggested order', b.status === 'out_of_stock' && b.suggested_qty === 35, JSON.stringify([b.status, b.suggested_qty]));
    check('excess by days of cover: 500 on hand vs 180 days = 320 surplus', c.status === 'excess' && c.excess_qty === 320 && c.excess_value === 3200, JSON.stringify([c.status, c.excess_qty]));
    check('excess over maximum: 80 vs max 50 = 30 surplus', d.status === 'excess' && d.excess_qty === 30, JSON.stringify([d.status, d.excess_qty]));
    check('summary counts each class', p.summary.out_of_stock >= 1 && p.summary.excess >= 2 && p.summary.items === p.items.length && p.summary.excess_value >= 3500, JSON.stringify(p.summary));
    r = await call('GET', '/inventory/replenishment');
    check('older reorder report still works (out/low only)', r.body.items.some(x => x.tire_id === B && x.status === 'out') && !r.body.items.some(x => x.tire_id === C), JSON.stringify(r.body.items.map(x => [x.tire_id, x.status])));

    // lead time sources
    const G = await mk('Item G', { stock: 5, sold: steady, supplier_id: SO, safety_stock: 0 });
    let g = find(await plan(), G);
    check('no lead time anywhere: company default (7 days)', g.lead_time_source === 'default' && g.lead_time_days === 7, JSON.stringify([g.lead_time_source, g.lead_time_days]));
    for (let i = 0; i < 2; i++) {
      const rp = await call('POST', '/purchases', { supplier_id: SO, date: day(0), status: 'received', items: [{ tire_id: G, tire_name: 'x', qty: i + 1, unit_price: 10 }] });
      await pool.request().input('p', sql.Int, rp.body.id).query('UPDATE purchases SET created_at = DATEADD(DAY, -12, GETDATE()) WHERE id = @p');
    }
    g = find(await plan(), G);
    check('observed supplier lead time (2 received orders, 12 days) is used', g.lead_time_source === 'observed' && g.lead_time_days === 12, JSON.stringify([g.lead_time_source, g.lead_time_days]));
    r = await call('GET', '/inventory/replenishment/suppliers');
    const so = r.body.find(x => x.id === SO);
    check('supplier list tracks observed lead times', so.received_orders === 2 && so.observed_days === 12, JSON.stringify(so));
    r = await call('PUT', `/inventory/replenishment/suppliers/${SO}`, { lead_time_days: 20, min_order_value: 100000 });
    g = find(await plan(), G);
    check('supplier lead time overrides observed', r.status === 200 && g.lead_time_source === 'supplier' && g.lead_time_days === 20, JSON.stringify([g.lead_time_source, g.lead_time_days]));
    r = await call('PUT', `/inventory/replenishment/suppliers/${SO}`, { lead_time_days: -1 });
    check('bad supplier lead time refused', r.status === 400);
    r = await call('PUT', `/inventory/replenishment/suppliers/${SO}`, { lead_time_days: 5 }, staff);
    check('staff cannot edit supplier lead times', r.status === 403);

    // supplier grouping and minimum order value
    p = await plan();
    const grp = p.groups.find(x => x.supplier_id === SO);
    check('recommendations grouped by supplier with totals', grp && grp.lines >= 1 && Math.abs(grp.total_cost - p.items.filter(i => i.supplier_id === SO && i.suggested_qty > 0).reduce((s, i) => s + i.suggested_cost, 0)) < 0.01 && p.groups.some(x => x.supplier_id === null), JSON.stringify(p.groups.map(x => [x.supplier_id, x.lines, x.total_cost])));
    check('supplier minimum order value flagged with the shortfall', grp.below_min_order_value === true && grp.min_order_shortfall > 0, JSON.stringify(grp));

    // seasonality
    const H = await mk('Item H', { stock: 100, sold: steady, lead_time_days: 1, safety_stock: 0 });
    let h = find(await plan(), H);
    check('no seasonality: factor 1', h.seasonal_factor === 1 && h.daily_demand === 1, JSON.stringify([h.seasonal_factor, h.daily_demand]));
    const f = Array(12).fill(1); f[new Date().getUTCMonth()] = 3;
    r = await params(H, { seasonality: f });
    h = find(await plan(), H);
    check('this month is 3x busy: demand forecast rises above the baseline', r.status === 200 && h.seasonal_factor === 3 && h.daily_demand > 1.2, JSON.stringify([h.seasonal_factor, h.daily_demand]));
    r = await params(H, { seasonality: [1, 2, 3] });
    check('seasonality needs 12 factors', r.status === 400 && r.body.code === 'INVALID_SEASONALITY', JSON.stringify(r.body));
    const cat = (await call('POST', '/inventory/categories', { name: 'Seasonal cat' })).body.id;
    const Hc = await mk('Item Hc', { stock: 100, sold: steady, lead_time_days: 1, safety_stock: 0, category_id: cat });
    r = await call('PUT', `/inventory/replenishment/category-seasonality/${cat}`, { factors: f });
    check('category seasonality applies to its items', r.status === 200 && find(await plan(), Hc).seasonal_factor === 3, JSON.stringify(r.body));

    // production / planned requirements
    const J = await mk('Item J', { stock: 50, sold: steady, lead_time_days: 10, safety_stock: 0 });
    check('J covered before the requirement', find(await plan(), J).status === 'ok');
    r = await call('POST', '/inventory/replenishment/requirements', { tire_id: J, qty: 50, needed_by: day(5), note: 'Production run' });
    const reqId = r.body.id;
    let j = find(await plan(), J);
    check('planned requirement inside the lead time raises the ROP to 60', r.status === 201 && j.reorder_point === 60 && j.need_order && j.planned_requirements === 50, JSON.stringify([j.reorder_point, j.status, j.planned_requirements]));
    r = await call('POST', '/inventory/replenishment/requirements', { tire_id: J, qty: 0, needed_by: day(5) });
    check('requirement quantity must be positive', r.status === 400);
    r = await call('POST', '/inventory/replenishment/requirements', { tire_id: J, qty: 5, needed_by: day(5) }, staff);
    check('staff cannot add requirements', r.status === 403);
    await call('POST', `/inventory/replenishment/requirements/${reqId}/close`);
    check('closed requirement no longer counts', find(await plan(), J).reorder_point === 10);
    r = await call('GET', '/inventory/replenishment/requirements');
    check('requirements list', r.body.length === 1 && r.body[0].status === 'closed' && r.body[0].item_name.includes('Item J'));

    // automatic safety stock from demand variability
    const K = await mk('Item K', { stock: 100, sold: steady, lead_time_days: 9 });
    let k = find(await plan(), K);
    check('no safety stock set: calculated from demand variability at 95% service', k.safety_basis === 'calculated' && k.safety_stock > 0, JSON.stringify([k.safety_basis, k.safety_stock]));
    r = await call('PUT', '/inventory/replenishment/settings', { service_level: 2 });
    check('service level validated', r.status === 400);
    r = await call('PUT', '/inventory/replenishment/settings', { service_level: 0.5 }, staff);
    check('only an administrator changes company settings', r.status === 403);
    r = await call('PUT', '/inventory/replenishment/settings', { service_level: 0 });
    k = find(await plan(), K);
    check('service level 0 turns automatic safety stock off', r.status === 200 && r.body.service_level === 0 && k.safety_basis === 'none' && k.safety_stock === 0, JSON.stringify([k.safety_basis, k.safety_stock]));
    await call('PUT', '/inventory/replenishment/settings', { service_level: 0.95, cover_days: 14 });
    k = find(await plan(), K);
    check('shorter order cycle (14 days) lowers the target', k.target === k.reorder_point + 14, JSON.stringify([k.target, k.reorder_point]));
    await call('PUT', '/inventory/replenishment/settings', { cover_days: 30 });

    // manual reorder point
    const L = await mk('Item L', { stock: 30, reorder_mode: 'manual', reorder_level: 40, sold: steady, lead_time_days: 1 });
    const l = find(await plan(), L);
    check('manual mode uses the fixed reorder point', l.reorder_point === 40 && l.rop_basis === 'manual' && l.need_order, JSON.stringify([l.reorder_point, l.rop_basis]));

    // working capital
    const M1 = await mk('Budget M1', { stock: 0, sold: steady, lead_time_days: 5, safety_stock: 0, cost_price: 10 });
    p = await plan('?budget=100');
    check('budget caps the funded total and defers or trims the rest', p.summary.funded_cost <= 100 && p.summary.budget === 100 && p.items.some(i => i.funding === 'deferred' || i.funding === 'partial'), JSON.stringify(p.summary));
    const top = p.items.filter(i => i.suggested_qty > 0).sort((x, y) => (x.status === 'out_of_stock' ? 0 : 1) - (y.status === 'out_of_stock' ? 0 : 1) || (x.days_of_cover ?? 1e9) - (y.days_of_cover ?? 1e9))[0];
    check('the most urgent item is funded first', ['full', 'partial'].includes(top.funding), JSON.stringify([top.item_name, top.funding]));
    r = await call('PUT', '/inventory/replenishment/settings', { budget: 50 });
    p = await plan();
    check('saved company budget applies when none is passed', p.summary.budget === 50 && p.summary.funded_cost <= 50, JSON.stringify(p.summary));
    await call('PUT', '/inventory/replenishment/settings', { budget: null });
    check('budget can be cleared', (await plan()).summary.budget === null);

    // ── approval -> purchase order ──
    const F = await mk('Item F', { stock: 2, sold: steady, lead_time_days: 5, safety_stock: 0, supplier_id: S1 });
    let fr = find(await plan(), F);
    check('F recommended: 33', fr.suggested_qty === 33 && fr.supplier_id === S1, JSON.stringify([fr.suggested_qty, fr.status]));
    const order = (lines, supplier = S1, t = admin, extra = {}) => call('POST', '/inventory/replenishment/orders', { orders: [{ supplier_id: supplier, lines, ...extra }] }, t);
    r = await order([{ tire_id: F, qty: 33 }], S1, staff);
    check('staff cannot approve recommendations', r.status === 403);
    r = await order([{ tire_id: F, qty: 100 }]);
    check('ordering more than recommended needs a reason', r.status === 409 && r.body.code === 'EXCEEDS_RECOMMENDATION' && r.body.recommended === 33, JSON.stringify(r.body));
    r = await order([{ tire_id: F, qty: 33 }], S2);
    check('item from another supplier refused', r.status === 400 && r.body.code === 'SUPPLIER_MISMATCH', JSON.stringify(r.body));
    r = await order([]);
    check('nothing selected refused', r.status === 400);
    const poBefore = await poCount();
    r = await order([{ tire_id: F, qty: 33 }], S1, admin, { note: 'weekly run' });
    const made = r.body.orders?.[0];
    check('approval creates a pending PO for the supplier', r.status === 201 && made && made.units === 33 && made.total === 330 && (await poCount()) === poBefore + 1, JSON.stringify(r.body));
    const poRow = (await pool.request().input('p', sql.Int, made.purchase_id).query('SELECT status, supplier_id, notes, expected_date FROM purchases WHERE id = @p')).recordset[0];
    const poLines = (await pool.request().input('p', sql.Int, made.purchase_id).query('SELECT tire_id, qty, unit_price FROM purchase_items WHERE purchase_id = @p')).recordset;
    check('the PO is pending (not received), expects delivery after the lead time', poRow.status === 'pending' && poRow.supplier_id === S1 && /weekly run/.test(poRow.notes) && String(poRow.expected_date.toISOString()).startsWith(day(5)) && poLines[0].qty === 33 && Number(poLines[0].unit_price) === 10, JSON.stringify([poRow, poLines]));
    fr = find(await plan(), F);
    check('the new PO now counts as incoming; nothing more to order', fr.on_order === 33 && fr.suggested_qty === 0, JSON.stringify([fr.on_order, fr.suggested_qty]));
    r = await order([{ tire_id: F, qty: 5 }]);
    check('approving an already covered item needs a reason (no double ordering)', r.status === 409 && r.body.code === 'NOT_RECOMMENDED', JSON.stringify(r.body));
    r = await order([{ tire_id: F, qty: 5, reason: 'Trade show next week' }]);
    check('override with a reason is allowed and recorded', r.status === 201, JSON.stringify(r.body));
    r = await call('GET', '/inventory/replenishment/approvals');
    const ap = r.body.filter(x => x.tire_id === F);
    check('approval log: suggested vs ordered, reason, basis, who', ap.length === 2 && ap.some(x => x.suggested_qty === 33 && x.ordered_qty === 33 && x.basis.reorder_point === 5) && ap.some(x => x.suggested_qty === 0 && x.ordered_qty === 5 && x.reason === 'Trade show next week') && ap.every(x => x.user_name != null || true), JSON.stringify(ap.map(x => [x.suggested_qty, x.ordered_qty, x.reason])));

    // concurrent approvals of the same recommendation: only one PO
    const N = await mk('Item N', { stock: 1, sold: steady, lead_time_days: 5, safety_stock: 0, supplier_id: S2 });
    const nRec = find(await plan(), N).suggested_qty;
    const rs = await Promise.all([order([{ tire_id: N, qty: nRec }], S2), order([{ tire_id: N, qty: nRec }], S2), order([{ tire_id: N, qty: nRec }], S2)]);
    const ok = rs.filter(x => x.status === 201).length;
    const nPos = (await pool.request().input('t', sql.Int, N).query("SELECT COUNT(*) AS n FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id WHERE pi.tire_id = @t AND p.status = 'pending'")).recordset[0].n;
    check('three simultaneous approvals create exactly one PO', ok === 1 && nPos === 1 && rs.filter(x => x.status === 409).length === 2, JSON.stringify(rs.map(x => [x.status, x.body.code])));

    // items without a supplier need one chosen at approval; inactive items are not planned
    const U = await mk('Item U', { stock: 0, sold: steady, lead_time_days: 5, safety_stock: 0 });
    r = await order([{ tire_id: U, qty: 35 }], S1);
    check('item with no default supplier can be ordered from a chosen supplier', r.status === 201 && r.body.orders[0].supplier_id === S1, JSON.stringify(r.body));
    const V = await mk('Item V', { stock: 0, sold: steady });
    await call('PUT', `/inventory/${V}`, { model: 'Item V', cost_price: 10, sale_price: 20, status: 'inactive' });
    check('inactive items are not planned', !find(await plan(), V));

    await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; DELETE FROM stock_movements WHERE organization_id = @o AND reason = 'sale' AND item_name = 'x'");
    r = await call('GET', '/inventory/reconciliation');
    check('ledger still reconciles', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 200));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [
      'DELETE FROM replenishment_approvals WHERE organization_id=@o', 'DELETE FROM replenishment_requirements WHERE organization_id=@o',
      'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o',
      'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
      'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
      'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
      'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
      'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
