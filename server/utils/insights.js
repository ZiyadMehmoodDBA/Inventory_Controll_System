// Inventory dashboard and standard reports. Read-only: everything is derived from the stock ledger, batches, documents and the existing
// replenishment / classification engines, so a figure here always agrees with the screen it came from.
// branchId null = every branch of the organisation (organisation administrators only; the route decides).
// Dates are inclusive 'YYYY-MM-DD' strings cast in SQL (see utils/losses.js: JS Dates would shift by the database timezone).
const { getPool, sql } = require('../db');
const R = require('./replenishment');
const Ls = require('./losses');
const { POSITION_APPLY, POSITION_COLUMNS } = require('./stockPosition');
const { computeValuation, METHOD_INFO } = require('./valuation');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const dayOf = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
const human = s => String(s ?? '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const SEV = { critical: 0, warning: 1, info: 2 };

const itemName = 'LTRIM(RTRIM(t.brand + \' \' + t.model + \' \' + t.size))';

class InsightError extends Error { constructor(message, status = 400, code = 'INVALID_REQUEST') { super(message); this.status = status; this.code = code; } }

async function branchIds(pool, scope) {
  if (scope.branchId != null) return [scope.branchId];
  return (await pool.request().input('o', sql.Int, scope.orgId).query('SELECT id FROM branches WHERE organization_id = @o AND is_active = 1 ORDER BY id')).recordset.map(r => r.id);
}

async function planFor(scope, pool) {
  const ids = await branchIds(pool, scope);
  const plans = await Promise.all(ids.map(b => R.computePlan(scope.orgId, b)));
  const items = plans.flatMap((p, i) => p.items.map(x => ({ ...x, branch_id: ids[i] })));
  return { items, plans, ids };
}

const bind = (rq, scope) => rq.input('o', sql.Int, scope.orgId).input('b', sql.Int, scope.branchId ?? null);

// ── Dashboard ────────────────────────────────────────────────────────────────
async function dashboard(scope) {
  const pool = await getPool();
  const st = await Ls.loadSettings(pool, scope.orgId);
  const nearDays = Number((await pool.request().input('o', sql.Int, scope.orgId).query("SELECT value FROM settings WHERE organization_id = @o AND [key] = 'near_expiry_days'")).recordset[0]?.value) || 30;
  const methodRow = (await pool.request().input('o', sql.Int, scope.orgId).query("SELECT value FROM settings WHERE organization_id = @o AND [key] = 'valuation_method'")).recordset[0]?.value;
  const method = METHOD_INFO[methodRow] ? methodRow : 'standard';

  const [valuation, plan, classes, pos, tot, exp, pend, trf, adj, mism, counts, recent, trend, nearList, branchRows] = await Promise.all([
    computeValuation(scope.orgId, scope.branchId ?? null, method, pool),
    planFor(scope, pool),
    Ls.classifyStock(pool, { orgId: scope.orgId, branchId: scope.branchId ?? null }, st),
    bind(pool.request(), scope).query(`
      SELECT ISNULL(SUM(qr.qty), 0) AS quarantined, ISNULL(SUM(qr.qty * t.cost_price), 0) AS quarantined_value,
             ISNULL(SUM(hd.qty), 0) AS held, ISNULL(SUM(hd.qty * t.cost_price), 0) AS held_value,
             ISNULL(SUM(rsv.qty), 0) AS reserved, ISNULL(SUM(tt.qty), 0) AS in_transit, ISNULL(SUM(oo.qty), 0) AS on_order,
             ISNULL(SUM(CASE WHEN t.stock - qr.qty - ex.qty - hd.qty - rsv.qty < 0 THEN 0 ELSE t.stock - qr.qty - ex.qty - hd.qty - rsv.qty END), 0) AS available
      FROM tires t ${POSITION_APPLY} WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b)`),
    bind(pool.request(), scope).query(`
      SELECT COUNT(*) AS products, COUNT(CASE WHEN status = 'active' THEN 1 END) AS active_products, ISNULL(SUM(stock), 0) AS units,
             COUNT(CASE WHEN stock < 0 THEN 1 END) AS negative
      FROM tires t WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b)`),
    bind(pool.request(), scope).input('n', sql.Int, nearDays).query(`
      SELECT ISNULL(SUM(CASE WHEN b.expiry_date < CAST(GETDATE() AS DATE) THEN x.qty END), 0) AS expired_units,
             ISNULL(SUM(CASE WHEN b.expiry_date < CAST(GETDATE() AS DATE) THEN x.qty * ISNULL(b.unit_cost, t.cost_price) END), 0) AS expired_value,
             COUNT(DISTINCT CASE WHEN b.expiry_date < CAST(GETDATE() AS DATE) THEN b.id END) AS expired_batches,
             ISNULL(SUM(CASE WHEN b.expiry_date >= CAST(GETDATE() AS DATE) AND b.expiry_date <= DATEADD(DAY, @n, CAST(GETDATE() AS DATE)) THEN x.qty END), 0) AS near_units,
             ISNULL(SUM(CASE WHEN b.expiry_date >= CAST(GETDATE() AS DATE) AND b.expiry_date <= DATEADD(DAY, @n, CAST(GETDATE() AS DATE)) THEN x.qty * ISNULL(b.unit_cost, t.cost_price) END), 0) AS near_value,
             COUNT(DISTINCT CASE WHEN b.expiry_date >= CAST(GETDATE() AS DATE) AND b.expiry_date <= DATEADD(DAY, @n, CAST(GETDATE() AS DATE)) THEN b.id END) AS near_batches
      FROM batch_location_stock x JOIN stock_batches b ON b.id = x.batch_id JOIN tires t ON t.id = b.tire_id
      WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND x.qty > 0 AND b.expiry_date IS NOT NULL`),
    bind(pool.request(), scope).query(`
      SELECT COUNT(*) AS orders, ISNULL(SUM(u.units), 0) AS units, ISNULL(SUM(p.total), 0) AS value,
             COUNT(CASE WHEN p.expected_date < CAST(GETDATE() AS DATE) THEN 1 END) AS overdue
      FROM purchases p OUTER APPLY (SELECT SUM(pi.qty) AS units FROM purchase_items pi WHERE pi.purchase_id = p.id) u
      WHERE p.organization_id = @o AND (@b IS NULL OR p.branch_id = @b) AND p.status = 'pending'`),
    bind(pool.request(), scope).query(`
      SELECT COUNT(*) AS transfers, ISNULL(SUM(u.units), 0) AS units,
             COUNT(CASE WHEN tr.expected_at < CAST(GETDATE() AS DATE) THEN 1 END) AS overdue,
             COUNT(CASE WHEN tr.created_at < DATEADD(DAY, -7, GETDATE()) AND tr.expected_at IS NULL THEN 1 END) AS stale
      FROM stock_transfers tr OUTER APPLY (SELECT SUM(i.qty) AS units FROM stock_transfer_items i WHERE i.transfer_id = tr.id) u
      WHERE tr.organization_id = @o AND tr.status = 'in_transit' AND (@b IS NULL OR tr.branch_id = @b OR tr.to_branch_id = @b)`),
    bind(pool.request(), scope).query("SELECT COUNT(*) AS pending FROM stock_adjustments WHERE organization_id = @o AND (@b IS NULL OR branch_id = @b) AND status = 'pending'"),
    bind(pool.request(), scope).query(`
      SELECT COUNT(CASE WHEN t.stock <> ISNULL(x.total, 0) THEN 1 END) AS location_mismatch,
             COUNT(CASE WHEN t.stock <> ISNULL(m.total, 0) THEN 1 END) AS ledger_mismatch
      FROM tires t OUTER APPLY (SELECT SUM(qty) AS total FROM item_location_stock WHERE tire_id = t.id) x
                   OUTER APPLY (SELECT SUM(qty_change) AS total FROM stock_movements WHERE tire_id = t.id) m
      WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b)`),
    bind(pool.request(), scope).query(`
      SELECT COUNT(DISTINCT c.id) AS counts, COUNT(CASE WHEN i.counted_qty IS NOT NULL THEN 1 END) AS lines,
             COUNT(CASE WHEN i.variance IS NOT NULL AND i.variance <> 0 THEN 1 END) AS variance_lines,
             ISNULL(SUM(CASE WHEN i.variance IS NOT NULL THEN ABS(i.variance) * t.cost_price END), 0) AS variance_value,
             (SELECT COUNT(*) FROM stock_transfers x WHERE x.organization_id = @o AND x.has_discrepancy = 1 AND x.received_at >= DATEADD(DAY, -30, GETDATE())
                AND (@b IS NULL OR x.branch_id = @b OR x.to_branch_id = @b)) AS transfer_shortages
      FROM stock_counts c JOIN stock_count_items i ON i.count_id = c.id JOIN tires t ON t.id = i.tire_id
      WHERE c.organization_id = @o AND (@b IS NULL OR c.branch_id = @b) AND c.status = 'completed' AND c.completed_at >= DATEADD(DAY, -30, GETDATE())`),
    bind(pool.request(), scope).query(`
      SELECT TOP 12 m.id, m.created_at, m.reason, m.qty_change, m.qty_after, m.reference, ISNULL(m.item_name, ${itemName}) AS item_name, sl.name AS location_name, u.name AS user_name
      FROM stock_movements m JOIN tires t ON t.id = m.tire_id LEFT JOIN stock_locations sl ON sl.id = m.location_id LEFT JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = @o AND (@b IS NULL OR m.branch_id = @b) ORDER BY m.id DESC`),
    bind(pool.request(), scope).query(`
      SELECT CONVERT(VARCHAR(10), CAST(m.created_at AS DATE), 23) AS day,
             ISNULL(SUM(CASE WHEN m.qty_change > 0 THEN m.qty_change END), 0) AS units_in, ISNULL(SUM(CASE WHEN m.qty_change < 0 THEN -m.qty_change END), 0) AS units_out
      FROM stock_movements m
      WHERE m.organization_id = @o AND (@b IS NULL OR m.branch_id = @b) AND m.reason NOT IN ('transfer_in', 'transfer_out') AND m.created_at >= DATEADD(DAY, -13, CAST(GETDATE() AS DATE))
      GROUP BY CAST(m.created_at AS DATE) ORDER BY day`),
    bind(pool.request(), scope).input('n', sql.Int, nearDays).query(`
      SELECT TOP 8 b.id AS batch_id, ${itemName} AS item_name, b.batch_no, b.expiry_date, DATEDIFF(DAY, CAST(GETDATE() AS DATE), b.expiry_date) AS days_left,
             SUM(x.qty) AS qty, SUM(x.qty * ISNULL(b.unit_cost, t.cost_price)) AS value
      FROM batch_location_stock x JOIN stock_batches b ON b.id = x.batch_id JOIN tires t ON t.id = b.tire_id
      WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND x.qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= DATEADD(DAY, @n, CAST(GETDATE() AS DATE))
      GROUP BY b.id, t.brand, t.model, t.size, b.batch_no, b.expiry_date ORDER BY b.expiry_date, value DESC`),
    pool.request().input('o', sql.Int, scope.orgId).query('SELECT id, name FROM branches WHERE organization_id = @o AND is_active = 1 ORDER BY id'),
  ]);

  const P = pos.recordset[0], T = tot.recordset[0], E = exp.recordset[0], PO = pend.recordset[0], TR = trf.recordset[0], A = adj.recordset[0], M = mism.recordset[0], C = counts.recordset[0];
  const items = plan.items;
  const withDemand = x => (x.daily_demand || 0) > 0 || (x.sold || 0) > 0;
  const out = items.filter(x => x.status === 'out_of_stock');
  const crit = items.filter(x => x.status === 'critical');
  const low = items.filter(x => x.status === 'low');
  const excess = items.filter(x => x.status === 'excess');
  const toOrder = items.filter(x => x.suggested_qty > 0);
  const slow = classes.summary.slow, nonMoving = classes.summary.non_moving, obsolete = classes.summary.obsolete;
  const slowValue = round2(slow.value + nonMoving.value + obsolete.value);
  const slowItems = slow.items + nonMoving.items + obsolete.items;

  const kpis = {
    units: Number(T.units), inventory_value: valuation.totals.value, retail_value: valuation.totals.retail_value, valuation_method: method,
    products: T.products, active_products: T.active_products, available_units: P.available, reserved_units: P.reserved,
    out_of_stock: out.length, out_of_stock_with_demand: out.filter(withDemand).length, critical: crit.length, low_stock: low.length + crit.length,
    reorder: { items: toOrder.length, cost: round2(toOrder.reduce((a, i) => a + i.suggested_cost, 0)) },
    excess: { items: excess.length, units: excess.reduce((a, i) => a + i.excess_qty, 0), value: round2(excess.reduce((a, i) => a + i.excess_value, 0)) },
    slow_moving: { items: slowItems, value: slowValue, obsolete_items: obsolete.items, non_moving_items: nonMoving.items, slow_items: slow.items, provision: classes.suggested_provision },
    expiry: { expired_units: Number(E.expired_units), expired_value: round2(E.expired_value), expired_batches: E.expired_batches,
              near_units: Number(E.near_units), near_value: round2(E.near_value), near_batches: E.near_batches, near_days: nearDays },
    quarantine: { units: Number(P.quarantined), value: round2(P.quarantined_value), held_units: Number(P.held), held_value: round2(P.held_value) },
    pending_receipts: { orders: PO.orders, units: Number(PO.units), value: round2(PO.value), overdue: PO.overdue },
    pending_transfers: { transfers: TR.transfers, units: Number(TR.units), overdue: TR.overdue, stale: TR.stale },
    pending_approvals: A.pending,
    discrepancies: { ledger_mismatches: M.ledger_mismatch, location_mismatches: M.location_mismatch, negative_stock: T.negative,
                     count_variance_lines: C.variance_lines, count_variance_value: round2(C.variance_value), count_lines: C.lines, transfer_shortages: C.transfer_shortages },
  };
  const d = kpis.discrepancies;
  d.total = d.ledger_mismatches + d.location_mismatches + d.negative_stock + d.count_variance_lines + d.transfer_shortages;

  // Exceptions: what needs a decision, most urgent first.
  const ex = [];
  const add = (id, severity, title, detail, count, value, target) => { if (count > 0) ex.push({ id, severity, title, detail, count, value: round2(value || 0), target }); };
  add('integrity', 'critical', 'Stock records do not agree', `${M.ledger_mismatch} item(s) differ from the movement ledger, ${M.location_mismatch} from the location balances. Investigate before trusting these figures.`, M.ledger_mismatch + M.location_mismatch, 0, 'reports:audit');
  add('negative', 'critical', 'Negative stock', `${T.negative} item(s) show less than zero on hand: something was issued that was never received.`, T.negative, 0, 'reports:current_stock');
  add('expired', 'critical', 'Expired stock on hand', `${kpis.expiry.expired_units} unit(s) in ${E.expired_batches} batch(es) are past expiry and must not be sold.`, E.expired_batches, E.expired_value, 'quality');
  add('out_of_stock_demand', 'critical', 'Out of stock with demand', `${kpis.out_of_stock_with_demand} item(s) with recent sales have nothing available.`, kpis.out_of_stock_with_demand, 0, 'replenishment');
  add('transfers_overdue', 'critical', 'Overdue transfers', `${TR.overdue} transfer(s) are past their expected arrival and still in transit.`, TR.overdue, 0, 'warehouse');
  add('critical_stock', 'warning', 'Will run out before resupply', `${crit.length} item(s) will stock out before a new order could arrive.`, crit.length, 0, 'replenishment');
  add('low_stock', 'warning', 'Low stock', `${low.length} item(s) are at or below their reorder point.`, low.length, 0, 'replenishment');
  add('reorder', 'warning', 'Replenishment recommended', `${toOrder.length} item(s) should be ordered now (about ${round2(toOrder.reduce((a, i) => a + i.suggested_cost, 0)).toLocaleString()} at cost).`, toOrder.length, toOrder.reduce((a, i) => a + i.suggested_cost, 0), 'replenishment');
  add('near_expiry', 'warning', 'Near expiry', `${kpis.expiry.near_units} unit(s) in ${E.near_batches} batch(es) expire within ${nearDays} days.`, E.near_batches, E.near_value, 'reports:batch_expiry');
  add('quarantine', 'warning', 'Damaged, quarantined or held stock', `${kpis.quarantine.units} unit(s) in quarantine / damaged locations and ${kpis.quarantine.held_units} on quality hold.`, kpis.quarantine.units + kpis.quarantine.held_units, kpis.quarantine.value + kpis.quarantine.held_value, 'quality');
  add('approvals', 'warning', 'Adjustments awaiting approval', `${A.pending} stock adjustment(s) are waiting for a decision.`, A.pending, 0, 'approvals');
  add('count_variances', 'warning', 'Count variances (last 30 days)', `${C.variance_lines} counted line(s) differed from the records, worth about ${round2(C.variance_value).toLocaleString()}.`, C.variance_lines, C.variance_value, 'reports:count_variance');
  add('transfer_shortages', 'warning', 'Transfer shortages (last 30 days)', `${C.transfer_shortages} transfer(s) arrived short.`, C.transfer_shortages, 0, 'warehouse');
  add('receipts_overdue', 'warning', 'Overdue purchase orders', `${PO.overdue} pending order(s) are past their expected date.`, PO.overdue, 0, 'reports:demand_replenishment');
  add('excess', 'info', 'Excess stock', `${excess.length} item(s) hold more than needed (${kpis.excess.units} unit(s) over).`, excess.length, kpis.excess.value, 'reports:low_stock');
  add('slow', 'info', 'Slow, non-moving and obsolete stock', `${slowItems} item(s) tie up capital (${obsolete.items} obsolete, ${nonMoving.items} non-moving, ${slow.items} slow).`, slowItems, slowValue, 'losses');
  ex.sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.value - a.value);

  const lowList = [...out, ...crit, ...low].sort((a, b) => ({ out_of_stock: 0, critical: 1, low: 2 }[a.status] - { out_of_stock: 0, critical: 1, low: 2 }[b.status]) || (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9)).slice(0, 8)
    .map(x => ({ tire_id: x.tire_id, item_name: x.item_name, sku: x.sku, available: x.available, reorder_point: x.reorder_point, days_of_cover: x.days_of_cover, status: x.status, suggested_qty: x.suggested_qty, supplier_name: x.supplier_name }));

  // fill missing trend days with zero so the chart has a continuous axis
  const byDay = Object.fromEntries(trend.recordset.map(r => [r.day, r]));
  const days = [];
  for (let i = 13; i >= 0; i--) { const dt = new Date(); dt.setDate(dt.getDate() - i); const k = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; days.push({ day: k, units_in: Number(byDay[k]?.units_in || 0), units_out: Number(byDay[k]?.units_out || 0) }); }

  return redactDashboard(scope, {
    generated_at: new Date().toISOString(), scope: scope.branchId == null ? 'organisation' : 'branch', branches: branchRows.recordset,
    kpis, exceptions: ex, exception_counts: { critical: ex.filter(e => e.severity === 'critical').length, warning: ex.filter(e => e.severity === 'warning').length, info: ex.filter(e => e.severity === 'info').length },
    recent_movements: recent.recordset.map(r => ({ ...r, reason_label: human(r.reason) })), trend: days,
    low_stock_list: lowList, expiring_list: nearList.recordset.map(r => ({ ...r, expiry_date: dayOf(r.expiry_date), value: round2(r.value) })),
    note: 'Inventory value is at the organisation valuation method; excess, slow and reorder figures come from the replenishment and classification engines.',
  });
}

// ── Reports ──────────────────────────────────────────────────────────────────
// Column types: text, int, money, date, datetime, pct. `sum: true` adds the column to the totals row.
const col = (key, label, type = 'text', sum = false) => ({ key, label, type, ...(sum ? { sum: true } : {}) });

const REPORTS = [
  { id: 'current_stock', title: 'Current Stock Report', description: 'What is on hand now: available, reserved, quarantined, expired, held, on order and in transit, valued at item cost.', filters: ['q', 'category', 'supplier', 'location', 'by', 'include_zero'] },
  { id: 'movement_ledger', title: 'Inventory Movement Ledger', description: 'Every stock movement in the period with before and after balances, location, batch, reference and user.', filters: ['period', 'q', 'category', 'supplier', 'location', 'reason'] },
  { id: 'valuation', title: 'Inventory Valuation Report', description: 'Stock value under the organisation valuation method, with retail value and category totals.', filters: ['q', 'category'], perm: 'reports.valuation' },
  { id: 'low_stock', title: 'Low Stock and Reorder Report', description: 'Items out of stock, below their reorder point or on order, with suggested order quantities and cost.', filters: ['q', 'category', 'supplier', 'status'] },
  { id: 'aging', title: 'Inventory Aging Report', description: 'Units and value by age since receipt (0-30 up to over 365 days).', filters: ['q', 'category'] },
  { id: 'slow_moving', title: 'Slow Moving and Non-Moving Stock Report', description: 'Items by days since last sale and cover, classified slow, non-moving or obsolete with a suggested provision.', filters: ['q', 'category', 'class'] },
  { id: 'batch_expiry', title: 'Batch and Expiry Report', description: 'Batches and serials by expiry date, quality status and value at risk.', filters: ['q', 'category', 'supplier', 'location', 'days', 'status'] },
  { id: 'damage_writeoff', title: 'Damage and Write Off Report', description: 'Approved physical losses and disposals with cause, responsible user and approver; valuation write-downs are shown apart.', filters: ['period', 'q', 'location', 'cause'] },
  { id: 'count_variance', title: 'Physical Stock Count and Variance Report', description: 'Completed counts: system versus counted quantity, variance and its value, and the adjustment raised.', filters: ['period', 'q', 'category', 'location', 'variances_only'] },
  { id: 'branch_comparison', title: 'Warehouse and Branch Stock Comparison', description: 'Stock by branch, warehouse, location or side by side per item across branches.', filters: ['q', 'category', 'supplier', 'by'] },
  { id: 'demand_replenishment', title: 'Inventory Demand and Replenishment Report', description: 'Sales in the period against forecast demand, lead time, reorder point, days of cover and the suggested order.', filters: ['period', 'q', 'category', 'supplier', 'status'] },
  { id: 'audit', title: 'Inventory Transaction Audit Report', description: 'Who changed what: audit log of item, adjustment, transfer, count, location and valuation changes with before and after.', filters: ['period', 'q', 'entity', 'action'], perm: 'reports.audit' },
];
const REPORT_IDS = new Set(REPORTS.map(r => r.id));

// Without "see costs" every cost and value figure is removed from what leaves the server (columns, cells, totals, summaries, breakdowns).
const COSTLY = /cost|value|margin|retail|provision|price/i;
function redact(scope, rep) {
  if (scope.can('inventory.view_cost')) return rep;
  const drop = new Set(rep.columns.filter(c => c.type === 'money' || COSTLY.test(c.key)).map(c => c.key));
  return { ...rep,
    columns: rep.columns.filter(c => !drop.has(c.key)),
    rows: rep.rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.has(k)))),
    totals: Object.fromEntries(Object.entries(rep.totals).filter(([k]) => !drop.has(k))),
    summary: rep.summary.filter(s => !s.money && !COSTLY.test(s.label)),
    breakdown: rep.breakdown.map(({ value, ...b }) => b), notes: [...rep.notes, 'Cost and value figures are hidden for your role.'] };
}
function redactDashboard(scope, d) {
  if (scope.can('inventory.view_cost')) return d;
  const walk = o => (Array.isArray(o) ? o.map(walk) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, COSTLY.test(k) && typeof v === 'number' ? null : walk(v)])) : o);
  return walk(d);
}

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T00:00:00`).getTime());
const intOrNull = v => { if (v === undefined || v === null || v === '') return null; const n = Number(v); if (!Number.isInteger(n)) throw new InsightError('Invalid filter value'); return n; };
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);

function parseFilters(q = {}) {
  const end = q.to !== undefined && q.to !== '' ? q.to : ymd(new Date());
  if (q.to && !isDay(q.to)) throw new InsightError('"to" must be a date (YYYY-MM-DD)');
  if (q.from && !isDay(q.from)) throw new InsightError('"from" must be a date (YYYY-MM-DD)');
  const d = new Date(`${end}T12:00:00`); d.setDate(d.getDate() - 29);
  const start = q.from ? q.from : ymd(d);
  if (start > end) throw new InsightError('"from" must not be after "to"');
  const text = String(q.q ?? '').trim().slice(0, 60);
  return {
    from: start, to: end, q: text ? `%${text.replace(/[%_[]/g, m => '[' + m + ']')}%` : null, qText: text,
    category: intOrNull(q.category), supplier: intOrNull(q.supplier), location: intOrNull(q.location), tire: intOrNull(q.tire),
    reason: q.reason ? String(q.reason).slice(0, 50) : null, cause: q.cause ? String(q.cause).slice(0, 30) : null,
    status: q.status ? String(q.status).slice(0, 20) : null, class: q.class ? String(q.class).slice(0, 20) : null,
    by: q.by ? String(q.by).slice(0, 20) : null, days: Math.min(Math.max(intOrNull(q.days) ?? 90, 1), 3650),
    include_zero: q.include_zero === '1' || q.include_zero === 'true' || q.include_zero === true,
    variances_only: !(q.variances_only === '0' || q.variances_only === 'false' || q.variances_only === false),
    entity: q.entity ? String(q.entity).slice(0, 50) : null, action: q.action ? String(q.action).slice(0, 20) : null,
    limit: Math.min(Math.max(intOrNull(q.limit) ?? 1000, 1), 50000),
  };
}

const bindF = (rq, scope, f) => rq.input('o', sql.Int, scope.orgId).input('b', sql.Int, scope.branchId ?? null)
  .input('q', sql.NVarChar(70), f.q).input('cat', sql.Int, f.category).input('sup', sql.Int, f.supplier).input('loc', sql.Int, f.location)
  .input('tire', sql.Int, f.tire).input('from', sql.VarChar(10), f.from).input('to', sql.VarChar(10), f.to);
const ITEM_FILTER = `(@b IS NULL OR t.branch_id = @b) AND (@q IS NULL OR t.brand + ' ' + t.model + ' ' + t.size LIKE @q OR t.sku LIKE @q OR t.barcode LIKE @q)
  AND (@cat IS NULL OR t.category_id = @cat OR c.parent_id = @cat) AND (@sup IS NULL OR t.supplier_id = @sup) AND (@tire IS NULL OR t.id = @tire)`;
const BOUNDS = (c) => `${c} >= CAST(@from AS DATE) AND ${c} < DATEADD(DAY, 1, CAST(@to AS DATE))`;

/** Item filters applied to rows that were produced by a shared engine (valuation, plan, aging, classification). */
async function itemMatcher(pool, scope, f) {
  if (f.q == null && f.category == null && f.supplier == null && f.tire == null) return null;
  const ids = (await bindF(pool.request(), scope, f).query(`SELECT t.id FROM tires t LEFT JOIN item_categories c ON c.id = t.category_id WHERE t.organization_id = @o AND ${ITEM_FILTER}`)).recordset;
  const set = new Set(ids.map(r => r.id));
  return id => set.has(id);
}

const branchNameCol = 'br.name';

const IMPL = {
  async current_stock(pool, scope, f) {
    const byLocation = f.by === 'location' || f.location != null;
    if (byLocation) {
      const r = await bindF(pool.request(), scope, f).input('n', sql.Int, f.limit + 1).query(`
        SELECT TOP (@n) ${branchNameCol} AS branch, ISNULL(w.name, '') AS warehouse, l.name AS location, l.kind, ${itemName} AS item_name, t.sku, ISNULL(c.name, 'Uncategorised') AS category, t.uom,
               x.qty, t.cost_price AS unit_cost, x.qty * t.cost_price AS value
        FROM item_location_stock x JOIN stock_locations l ON l.id = x.location_id JOIN tires t ON t.id = x.tire_id JOIN branches br ON br.id = t.branch_id
        LEFT JOIN warehouses w ON w.id = l.warehouse_id LEFT JOIN item_categories c ON c.id = t.category_id
        WHERE t.organization_id = @o AND ${ITEM_FILTER} AND (@loc IS NULL OR l.id = @loc) AND (x.qty <> 0 ${f.include_zero ? 'OR 1 = 1' : ''})
        ORDER BY br.name, w.name, l.name, t.brand, t.model`);
      return { columns: [col('branch', 'Branch'), col('warehouse', 'Warehouse'), col('location', 'Location'), col('sku', 'SKU'), col('item_name', 'Item'), col('category', 'Category'), col('uom', 'UoM'),
                         col('qty', 'Qty', 'int', true), col('unit_cost', 'Unit cost', 'money'), col('value', 'Value', 'money', true)],
               rows: r.recordset.map(x => ({ ...x, value: round2(x.value) })), notes: ['Quantities per location. Stock in transit is not in any location.'] };
    }
    const r = await bindF(pool.request(), scope, f).input('n', sql.Int, f.limit + 1).query(`
      SELECT TOP (@n) ${branchNameCol} AS branch, t.sku, ${itemName} AS item_name, ISNULL(c.name, 'Uncategorised') AS category, t.uom, t.status, t.stock AS on_hand, ${POSITION_COLUMNS},
             t.cost_price AS unit_cost, t.stock * t.cost_price AS value
      FROM tires t ${POSITION_APPLY} JOIN branches br ON br.id = t.branch_id LEFT JOIN item_categories c ON c.id = t.category_id
      WHERE t.organization_id = @o AND ${ITEM_FILTER} AND (${f.include_zero ? '1 = 1' : 't.stock <> 0 OR rsv.qty > 0 OR tt.qty > 0 OR oo.qty > 0'})
      ORDER BY br.name, t.brand, t.model, t.size`);
    return { columns: [col('branch', 'Branch'), col('sku', 'SKU'), col('item_name', 'Item'), col('category', 'Category'), col('uom', 'UoM'), col('status', 'Status'),
                       col('on_hand', 'On hand', 'int', true), col('reserved', 'Reserved', 'int', true), col('quarantined', 'Quarantined', 'int', true), col('expired', 'Expired', 'int', true), col('held', 'On hold', 'int', true),
                       col('available', 'Available', 'int', true), col('in_transit', 'In transit', 'int', true), col('on_order', 'On order', 'int', true), col('unit_cost', 'Unit cost', 'money'), col('value', 'Value', 'money', true)],
             rows: r.recordset.map(x => ({ ...x, value: round2(x.value) })),
             notes: ['Available = on hand less quarantined, expired, held and reserved. In transit and on order are not part of on hand.'] };
  },

  async movement_ledger(pool, scope, f) {
    const r = await bindF(pool.request(), scope, f).input('n', sql.Int, f.limit + 1).input('reason', sql.NVarChar(50), f.reason).query(`
      SELECT TOP (@n) m.id, m.created_at, ${branchNameCol} AS branch, ISNULL(m.item_name, ${itemName}) AS item_name, t.sku, sl.name AS location, sb.batch_no, m.reason,
             m.qty_change, m.qty_before, m.qty_after, m.unit_cost, m.qty_change * ISNULL(m.unit_cost, 0) AS value, m.reference, u.name AS user_name, m.notes
      FROM stock_movements m JOIN tires t ON t.id = m.tire_id JOIN branches br ON br.id = m.branch_id LEFT JOIN item_categories c ON c.id = t.category_id
      LEFT JOIN stock_locations sl ON sl.id = m.location_id LEFT JOIN stock_batches sb ON sb.id = m.batch_id LEFT JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = @o AND (@b IS NULL OR m.branch_id = @b) AND ${BOUNDS('m.created_at')} AND ${ITEM_FILTER}
        AND (@loc IS NULL OR m.location_id = @loc) AND (@reason IS NULL OR m.reason = @reason)
      ORDER BY m.id DESC`);
    const rows = r.recordset.map(x => ({ ...x, reason: human(x.reason), value: round2(x.value) }));
    const inn = rows.filter(x => x.qty_change > 0).reduce((a, x) => a + x.qty_change, 0), outn = rows.filter(x => x.qty_change < 0).reduce((a, x) => a - x.qty_change, 0);
    return { columns: [col('created_at', 'Date / time', 'datetime'), col('branch', 'Branch'), col('sku', 'SKU'), col('item_name', 'Item'), col('location', 'Location'), col('batch_no', 'Batch'), col('reason', 'Reason'),
                       col('qty_change', 'Qty change', 'int', true), col('qty_before', 'Before', 'int'), col('qty_after', 'After', 'int'), col('unit_cost', 'Unit cost', 'money'), col('value', 'Value', 'money', true),
                       col('reference', 'Reference'), col('user_name', 'User'), col('notes', 'Notes')],
             rows, summary: [{ label: 'Units in', value: inn }, { label: 'Units out', value: outn }, { label: 'Net', value: inn - outn }],
             notes: ['Newest first. A movement is never edited: corrections appear as further movements.'] };
  },

  async valuation(pool, scope, f) {
    const mRow = (await pool.request().input('o', sql.Int, scope.orgId).query("SELECT value FROM settings WHERE organization_id = @o AND [key] = 'valuation_method'")).recordset[0]?.value;
    const method = METHOD_INFO[mRow] ? mRow : 'standard';
    const v = await computeValuation(scope.orgId, scope.branchId ?? null, method, pool);
    const match = await itemMatcher(pool, scope, f);
    const items = match ? v.items.filter(i => match(i.tire_id)) : v.items;
    const rows = items.map(i => ({ ...i, margin_pct: i.retail_value ? round2(((i.retail_value - i.value) / i.retail_value) * 100) : null }));
    const byCat = {};
    for (const i of items) { const c = byCat[i.category] ??= { label: i.category, units: 0, value: 0 }; c.units += i.stock; c.value += i.value; }
    const total = round2(items.reduce((a, i) => a + i.value, 0));
    return { columns: [col('sku', 'SKU'), col('item_name', 'Item'), col('category', 'Category'), col('uom', 'UoM'), col('stock', 'Units', 'int', true), col('unit_cost', 'Unit cost', 'money'),
                       col('value', 'Value', 'money', true), col('retail_value', 'Retail value', 'money', true), col('margin_pct', 'Margin %', 'pct')],
             rows, breakdown: Object.values(byCat).map(c => ({ ...c, value: round2(c.value), share: total ? Math.round((c.value / total) * 1000) / 10 : 0 })).sort((a, b) => b.value - a.value),
             summary: [{ label: 'Method', value: METHOD_INFO[method]?.label ?? method }, { label: 'Value', value: total, money: true }],
             notes: ['Items with stock on hand only. Valued at the organisation valuation method; retail value uses the current sale price.'] };
  },

  async low_stock(pool, scope, f) {
    const { items } = await planFor(scope, pool);
    const match = await itemMatcher(pool, scope, f);
    const set = f.status === 'all' ? null : new Set(f.status === 'excess' ? ['excess'] : f.status === 'out_of_stock' ? ['out_of_stock'] : ['out_of_stock', 'critical', 'low', 'on_order']);
    const rows = items.filter(x => (!match || match(x.tire_id)) && (!set || set.has(x.status))).map(x => ({
      sku: x.sku, item_name: x.item_name, category: x.category, supplier: x.supplier_name, status: human(x.status), stock: x.stock, available: x.available, incoming: x.incoming, reorder_point: x.reorder_point,
      days_of_cover: x.days_of_cover, stockout_date: x.stockout_date, suggested_qty: x.suggested_qty, cost_price: x.cost_price, suggested_cost: x.suggested_cost, order_by: x.order_by, excess_qty: x.excess_qty,
      _rank: { out_of_stock: 0, critical: 1, low: 2, on_order: 3, excess: 4, ok: 5 }[x.status] ?? 6,
    })).sort((a, b) => a._rank - b._rank || (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9)).map(({ _rank, ...x }) => x);
    return { columns: [col('sku', 'SKU'), col('item_name', 'Item'), col('category', 'Category'), col('supplier', 'Supplier'), col('status', 'Status'), col('available', 'Available', 'int', true), col('incoming', 'On order / in transit', 'int', true),
                       col('reorder_point', 'Reorder point', 'int'), col('days_of_cover', 'Days of cover', 'int'), col('stockout_date', 'Stock-out date', 'date'), col('order_by', 'Order by', 'date'),
                       col('suggested_qty', 'Suggested qty', 'int', true), col('suggested_cost', 'Suggested cost', 'money', true), col('excess_qty', 'Excess units', 'int', true)],
             rows, notes: ['Reorder point, lead time and demand come from the replenishment engine (Replenishment screen). Status "excess" lists overstocked items.'] };
  },

  async aging(pool, scope, f) {
    const age = await require('../routes/rotation').computeStockAge(scope.orgId, scope.branchId ?? null);
    const match = await itemMatcher(pool, scope, f);
    const rows = age.items.filter(i => !match || match(i.tire_id)).map(i => ({ sku: i.sku, item_name: i.name, category: i.category, units: i.units, value: i.value, ...Object.fromEntries(age.buckets.map(k => [`u_${k}`, i.buckets[k].units])),
      oldest_days: i.oldest_days, average_days: i.average_days }));
    return { columns: [col('sku', 'SKU'), col('item_name', 'Item'), col('category', 'Category'), col('units', 'Units', 'int', true), col('value', 'Value', 'money', true),
                       ...age.buckets.map(k => col(`u_${k}`, `${k} days`, 'int', true)), col('oldest_days', 'Oldest (days)', 'int'), col('average_days', 'Average (days)', 'int')],
             rows, breakdown: age.buckets.map(k => ({ label: `${k} days`, units: age.totals[k].units, value: age.totals[k].value })),
             summary: [{ label: 'Over 180 days', value: age.slow_units }, { label: 'Value over 180 days', value: age.slow_value, money: true }], notes: [age.basis, 'Up to 500 items with the oldest stock first.'] };
  },

  async slow_moving(pool, scope, f) {
    const st = await Ls.loadSettings(pool, scope.orgId);
    const c = await Ls.classifyStock(pool, { orgId: scope.orgId, branchId: scope.branchId ?? null }, st);
    const match = await itemMatcher(pool, scope, f);
    const want = ['slow', 'non_moving', 'obsolete'].includes(f.class) ? [f.class] : f.class === 'all' ? ['active', 'slow', 'non_moving', 'obsolete'] : ['slow', 'non_moving', 'obsolete'];
    const rows = c.rows.filter(r => want.includes(r.class) && (!match || match(r.tire_id)));
    return { columns: [col('sku', 'SKU'), col('name', 'Item'), col('category', 'Category'), col('class_label', 'Class'), col('stock', 'Units', 'int', true), col('unit_cost', 'Unit cost', 'money'), col('value', 'Value', 'money', true),
                       col('idle_days', 'Days since sale', 'int'), col('last_sale', 'Last sale', 'date'), col('last_receipt', 'Last receipt', 'date'), col('sold_90', 'Sold (90d)', 'int'), col('cover_days', 'Days of cover', 'int'),
                       col('provision_value', 'Suggested provision', 'money', true), col('reason', 'Why'), col('action', 'Suggested action')],
             rows, breakdown: Object.entries(c.summary).map(([k, g]) => ({ label: Ls.CLASSES[k], units: g.units, value: g.value })),
             summary: [{ label: 'At-risk value', value: c.at_risk_value, money: true }, { label: 'Suggested provision', value: c.suggested_provision, money: true }], notes: [c.note] };
  },

  async batch_expiry(pool, scope, f) {
    const r = await bindF(pool.request(), scope, f).input('n', sql.Int, f.limit + 1).input('days', sql.Int, f.days).query(`
      SELECT TOP (@n) ${branchNameCol} AS branch, t.sku, ${itemName} AS item_name, b.batch_no, b.expiry_date, b.mfg_date, b.received_date, b.quality_status,
             DATEDIFF(DAY, CAST(GETDATE() AS DATE), b.expiry_date) AS days_left, SUM(x.qty) AS qty, ISNULL(b.unit_cost, t.cost_price) AS unit_cost, SUM(x.qty) * ISNULL(b.unit_cost, t.cost_price) AS value
      FROM batch_location_stock x JOIN stock_batches b ON b.id = x.batch_id JOIN tires t ON t.id = b.tire_id JOIN branches br ON br.id = t.branch_id LEFT JOIN item_categories c ON c.id = t.category_id
      WHERE t.organization_id = @o AND ${ITEM_FILTER} AND x.qty > 0 AND (@loc IS NULL OR x.location_id = @loc)
        AND (${f.status === 'all' ? '1 = 1' : 'b.expiry_date IS NOT NULL AND b.expiry_date <= DATEADD(DAY, @days, CAST(GETDATE() AS DATE))'})
      GROUP BY br.name, t.sku, t.brand, t.model, t.size, b.batch_no, b.expiry_date, b.mfg_date, b.received_date, b.quality_status, b.unit_cost, t.cost_price
      ORDER BY CASE WHEN b.expiry_date IS NULL THEN 1 ELSE 0 END, b.expiry_date, value DESC`);
    let rows = r.recordset.map(x => ({ ...x, expiry_date: dayOf(x.expiry_date), mfg_date: dayOf(x.mfg_date), received_date: dayOf(x.received_date), value: round2(x.value),
      expiry_status: x.expiry_date == null ? 'No expiry' : x.days_left < 0 ? 'Expired' : x.days_left <= f.days ? 'Expiring' : 'Fresh', quality_status: human(x.quality_status) }));
    if (f.status === 'expired') rows = rows.filter(x => x.expiry_status === 'Expired');
    else if (f.status === 'near') rows = rows.filter(x => x.expiry_status === 'Expiring');
    const sum = k => rows.filter(x => x.expiry_status === k).reduce((a, x) => a + x.value, 0);
    return { columns: [col('branch', 'Branch'), col('sku', 'SKU'), col('item_name', 'Item'), col('batch_no', 'Batch / serial'), col('expiry_date', 'Expiry', 'date'), col('days_left', 'Days left', 'int'), col('expiry_status', 'Expiry status'),
                       col('quality_status', 'Quality'), col('qty', 'Qty', 'int', true), col('unit_cost', 'Unit cost', 'money'), col('value', 'Value', 'money', true), col('received_date', 'Received', 'date')],
             rows, summary: [{ label: 'Expired value', value: round2(sum('Expired')), money: true }, { label: `Expiring within ${f.days} days`, value: round2(sum('Expiring')), money: true }],
             notes: ['Batches with stock only. Expired stock cannot be sold or issued; use Quality & inspection to dispose or return it.'] };
  },

  async damage_writeoff(pool, scope, f) {
    const ev = await Ls.lossEvents(pool, { orgId: scope.orgId, branchId: scope.branchId ?? null, start: f.from, end: f.to });
    const tireIds = [...new Set(ev.losses.map(x => x.tire_id).filter(Boolean))];
    const nameLike = f.qText.toLowerCase();
    let rows = ev.losses.filter(x => (!nameLike || String(x.item_name).toLowerCase().includes(nameLike)) && (!f.cause || x.cause === f.cause) && (f.location == null || x.location_id === f.location));
    const val = await Ls.valuationChanges(pool, { orgId: scope.orgId, branchId: scope.branchId ?? null, start: f.from, end: f.to });
    const total = round2(rows.reduce((a, x) => a + x.value, 0));
    const by = {};
    for (const x of rows) { const g = by[x.cause_label] ??= { label: x.cause_label, units: 0, value: 0 }; g.units += x.qty; g.value += x.value; }
    void tireIds;
    return { columns: [col('at', 'Date', 'datetime'), col('ref', 'Reference'), col('item_name', 'Item'), col('qty', 'Qty', 'int', true), col('unit_cost', 'Unit cost', 'money'), col('value', 'Value', 'money', true),
                       col('cause_label', 'Cause'), col('reason_label', 'Reason'), col('location_name', 'Location'), col('batch_no', 'Batch'), col('recorded_by', 'Recorded by'), col('approved_by', 'Approved by'), col('notes', 'Notes')],
             rows: rows.map(x => ({ ...x, value: round2(x.value) })),
             breakdown: Object.values(by).map(g => ({ ...g, value: round2(g.value) })).sort((a, b) => b.value - a.value),
             summary: [{ label: 'Physical loss', value: total, money: true }, { label: 'Valuation write-downs (no units moved)', value: round2(val.write_down), money: true }],
             notes: ['Physical losses remove units from stock. Valuation write-downs only change what remaining units are worth and are not included in the loss total.'] };
  },

  async count_variance(pool, scope, f) {
    const r = await bindF(pool.request(), scope, f).input('n', sql.Int, f.limit + 1).query(`
      SELECT TOP (@n) c.count_no, c.completed_at, ${branchNameCol} AS branch, l.name AS location, t.sku, i.item_name, i.batch_no, i.system_qty, i.counted_qty, i.variance,
             i.variance * t.cost_price AS variance_value, a.status AS adjustment_status, cu.name AS counted_by
      FROM stock_count_items i JOIN stock_counts c ON c.id = i.count_id JOIN stock_locations l ON l.id = c.location_id JOIN tires t ON t.id = i.tire_id JOIN branches br ON br.id = c.branch_id
      LEFT JOIN item_categories ic ON ic.id = t.category_id LEFT JOIN stock_adjustments a ON a.id = i.adjustment_id LEFT JOIN users cu ON cu.id = c.completed_by
      WHERE c.organization_id = @o AND (@b IS NULL OR c.branch_id = @b) AND c.status = 'completed' AND ${BOUNDS('c.completed_at')} AND i.counted_qty IS NOT NULL
        AND (@loc IS NULL OR c.location_id = @loc) AND (@q IS NULL OR i.item_name LIKE @q OR t.sku LIKE @q) AND (@cat IS NULL OR t.category_id = @cat OR ic.parent_id = @cat)
        ${f.variances_only ? 'AND i.variance <> 0' : ''}
      ORDER BY c.completed_at DESC, c.id DESC, i.id`);
    const rows = r.recordset.map(x => ({ ...x, item_name: String(x.item_name ?? '').trim(), variance_value: round2(x.variance_value), adjustment_status: x.adjustment_status ? human(x.adjustment_status) : '' }));
    const all = (await bindF(pool.request(), scope, f).query(`
      SELECT COUNT(DISTINCT c.id) AS counts, COUNT(*) AS lines, COUNT(CASE WHEN i.variance <> 0 THEN 1 END) AS variance_lines
      FROM stock_count_items i JOIN stock_counts c ON c.id = i.count_id JOIN tires t ON t.id = i.tire_id LEFT JOIN item_categories ic ON ic.id = t.category_id
      WHERE c.organization_id = @o AND (@b IS NULL OR c.branch_id = @b) AND c.status = 'completed' AND ${BOUNDS('c.completed_at')} AND i.counted_qty IS NOT NULL
        AND (@loc IS NULL OR c.location_id = @loc) AND (@q IS NULL OR i.item_name LIKE @q OR t.sku LIKE @q) AND (@cat IS NULL OR t.category_id = @cat OR ic.parent_id = @cat)`)).recordset[0];
    const short = rows.filter(x => x.variance < 0).reduce((a, x) => a - x.variance_value, 0), over = rows.filter(x => x.variance > 0).reduce((a, x) => a + x.variance_value, 0);
    return { columns: [col('count_no', 'Count'), col('completed_at', 'Completed', 'datetime'), col('branch', 'Branch'), col('location', 'Location'), col('sku', 'SKU'), col('item_name', 'Item'), col('batch_no', 'Batch'),
                       col('system_qty', 'System', 'int'), col('counted_qty', 'Counted', 'int'), col('variance', 'Variance', 'int', true), col('variance_value', 'Variance value', 'money', true), col('adjustment_status', 'Adjustment'), col('counted_by', 'Completed by')],
             rows, summary: [{ label: 'Counts', value: all.counts }, { label: 'Lines counted', value: all.lines }, { label: 'Counting accuracy', value: all.lines ? `${Math.round(((all.lines - all.variance_lines) / all.lines) * 1000) / 10}%` : '—' },
                             { label: 'Shortage value', value: round2(short), money: true }, { label: 'Surplus value', value: round2(over), money: true }],
             notes: ['Variance = counted less system quantity at count time. Differences become stock adjustments that follow the approval rules.'] };
  },

  async branch_comparison(pool, scope, f) {
    const by = oneOf(f.by, ['branch', 'warehouse', 'location', 'item'], 'branch');
    if (by === 'item') {
      const r = await bindF(pool.request(), scope, f).input('n', sql.Int, f.limit + 1).query(`
        SELECT TOP (@n) t.branch_id, br.name AS branch, COALESCE(NULLIF(t.sku, ''), ${itemName}) AS k, t.sku, ${itemName} AS item_name, ISNULL(c.name, 'Uncategorised') AS category, t.stock, t.cost_price
        FROM tires t JOIN branches br ON br.id = t.branch_id LEFT JOIN item_categories c ON c.id = t.category_id
        WHERE t.organization_id = @o AND ${ITEM_FILTER} AND t.status = 'active' AND br.is_active = 1 ORDER BY item_name`);
      const brs = [...new Map(r.recordset.map(x => [x.branch_id, x.branch])).entries()].sort((a, b) => a[0] - b[0]);
      const map = new Map();
      for (const x of r.recordset) {
        const row = map.get(x.k) ?? { sku: x.sku, item_name: x.item_name, category: x.category, total: 0, value: 0 };
        row[`br_${x.branch_id}`] = (row[`br_${x.branch_id}`] ?? 0) + x.stock; row.total += x.stock; row.value += x.stock * Number(x.cost_price); map.set(x.k, row);
      }
      const rows = [...map.values()].map(x => ({ ...x, value: round2(x.value) }));
      return { columns: [col('sku', 'SKU'), col('item_name', 'Item'), col('category', 'Category'), ...brs.map(([id, name]) => col(`br_${id}`, name, 'int', true)), col('total', 'Total', 'int', true), col('value', 'Value', 'money', true)],
               rows, notes: ['Items are matched across branches by SKU (or by name when there is none).', 'Stock in transit is not counted for either branch.'] };
    }
    const grp = { branch: 'br.id, br.name, CAST(NULL AS NVARCHAR(100)), CAST(NULL AS NVARCHAR(100))', warehouse: 'br.id, br.name, ISNULL(w.name, \'(no warehouse)\'), CAST(NULL AS NVARCHAR(100))', location: 'br.id, br.name, ISNULL(w.name, \'(no warehouse)\'), l.name' }[by];
    const r = await bindF(pool.request(), scope, f).query(`
      SELECT br.name AS branch, ${by === 'branch' ? "''" : "ISNULL(w.name, '(no warehouse)')"} AS warehouse, ${by === 'location' ? 'l.name' : "''"} AS location,
             COUNT(DISTINCT CASE WHEN x.qty <> 0 THEN x.tire_id END) AS items, ISNULL(SUM(x.qty), 0) AS units, ISNULL(SUM(x.qty * t.cost_price), 0) AS value
      FROM item_location_stock x JOIN stock_locations l ON l.id = x.location_id JOIN tires t ON t.id = x.tire_id JOIN branches br ON br.id = t.branch_id
      LEFT JOIN warehouses w ON w.id = l.warehouse_id LEFT JOIN item_categories c ON c.id = t.category_id
      WHERE t.organization_id = @o AND ${ITEM_FILTER} AND (@loc IS NULL OR l.id = @loc)
      GROUP BY br.id, br.name${by === 'branch' ? '' : ', w.name'}${by === 'location' ? ', l.name' : ''} ORDER BY br.name${by === 'branch' ? '' : ', w.name'}${by === 'location' ? ', l.name' : ''}`);
    void grp;
    const total = r.recordset.reduce((a, x) => a + Number(x.value), 0);
    let rows = r.recordset.map(x => ({ ...x, value: round2(x.value), share: total ? Math.round((Number(x.value) / total) * 1000) / 10 : 0 }));
    if (by === 'branch') {
      const all = (await pool.request().input('o', sql.Int, scope.orgId).input('b', sql.Int, scope.branchId ?? null).query('SELECT name FROM branches WHERE organization_id = @o AND is_active = 1 AND (@b IS NULL OR id = @b) ORDER BY name')).recordset;
      for (const b of all) if (!rows.some(x => x.branch === b.name)) rows.push({ branch: b.name, warehouse: '', location: '', items: 0, units: 0, value: 0, share: 0 });
      rows.sort((x, y) => x.branch.localeCompare(y.branch));
      const tr = (await bindF(pool.request(), scope, f).query(`
        SELECT tr.branch_id AS from_branch, ISNULL(tr.to_branch_id, tr.branch_id) AS to_branch, SUM(i.qty) AS units
        FROM stock_transfers tr JOIN stock_transfer_items i ON i.transfer_id = tr.id WHERE tr.organization_id = @o AND tr.status = 'in_transit' GROUP BY tr.branch_id, ISNULL(tr.to_branch_id, tr.branch_id)`)).recordset;
      const names = (await pool.request().input('o', sql.Int, scope.orgId).query('SELECT id, name FROM branches WHERE organization_id = @o')).recordset;
      const idOf = n => names.find(b => b.name === n)?.id;
      rows = rows.map(x => { const id = idOf(x.branch); return { ...x, in_transit_out: tr.filter(t => t.from_branch === id).reduce((a, t) => a + t.units, 0), in_transit_in: tr.filter(t => t.to_branch === id).reduce((a, t) => a + t.units, 0) }; });
    }
    const columns = [col('branch', 'Branch'), ...(by !== 'branch' ? [col('warehouse', 'Warehouse')] : []), ...(by === 'location' ? [col('location', 'Location')] : []),
                     col('items', 'Items', 'int'), col('units', 'Units', 'int', true), col('value', 'Value', 'money', true), col('share', 'Share of value %', 'pct'),
                     ...(by === 'branch' ? [col('in_transit_out', 'Sent, in transit', 'int'), col('in_transit_in', 'Arriving', 'int')] : [])];
    return { columns, rows, notes: ['Valued at item cost. Stock in transit is shown separately and is not in any branch total.'] };
  },

  async demand_replenishment(pool, scope, f) {
    const { items } = await planFor(scope, pool);
    const match = await itemMatcher(pool, scope, f);
    const sold = (await bindF(pool.request(), scope, f).query(`
      SELECT m.tire_id, SUM(-m.qty_change) AS qty FROM stock_movements m JOIN tires t ON t.id = m.tire_id LEFT JOIN item_categories c ON c.id = t.category_id
      WHERE m.organization_id = @o AND (@b IS NULL OR m.branch_id = @b) AND m.reason IN ('sale', 'sale_voided', 'sale_deleted') AND ${BOUNDS('m.created_at')} GROUP BY m.tire_id`)).recordset;
    const soldBy = Object.fromEntries(sold.map(s => [s.tire_id, Math.max(0, Number(s.qty))]));
    const span = Math.max(1, Math.round((new Date(`${f.to}T12:00:00`) - new Date(`${f.from}T12:00:00`)) / 86400000) + 1);
    const want = f.status === 'all' ? null : f.status ? new Set([f.status]) : null;
    const rows = items.filter(x => (!match || match(x.tire_id)) && (want ? want.has(x.status) : f.status === 'all' || (soldBy[x.tire_id] || 0) > 0 || x.status !== 'ok'))
      .map(x => ({ sku: x.sku, item_name: x.item_name, category: x.category, supplier: x.supplier_name, sold: soldBy[x.tire_id] || 0, avg_daily: round2((soldBy[x.tire_id] || 0) / span), forecast_daily: x.daily_demand,
                   lead_time_days: x.lead_time_days, safety_stock: x.safety_stock, reorder_point: x.reorder_point, available: x.available, incoming: x.incoming, days_of_cover: x.days_of_cover, status: human(x.status),
                   suggested_qty: x.suggested_qty, suggested_cost: x.suggested_cost, stockout_date: x.stockout_date }))
      .sort((a, b) => b.sold - a.sold);
    return { columns: [col('sku', 'SKU'), col('item_name', 'Item'), col('category', 'Category'), col('supplier', 'Supplier'), col('sold', 'Sold in period', 'int', true), col('avg_daily', 'Avg / day', 'pct'), col('forecast_daily', 'Forecast / day', 'pct'),
                       col('lead_time_days', 'Lead time (days)', 'int'), col('safety_stock', 'Safety stock', 'int'), col('reorder_point', 'Reorder point', 'int'), col('available', 'Available', 'int', true), col('incoming', 'Incoming', 'int', true),
                       col('days_of_cover', 'Days of cover', 'int'), col('status', 'Status'), col('suggested_qty', 'Suggested qty', 'int', true), col('suggested_cost', 'Suggested cost', 'money', true), col('stockout_date', 'Stock-out date', 'date')],
             rows, summary: [{ label: 'Period', value: `${span} day(s)` }], notes: ['Sold = net sales (voids and deletions reverse them) in the chosen period. Forecast, lead time and reorder point come from the replenishment engine.'] };
  },

  async audit(pool, scope, f) {
    const ents = ['inventory', 'stock_adjustment', 'stock_transfer', 'stock_count', 'stock_reservation', 'stock_location', 'warehouse', 'location_access', 'item_category', 'products', 'valuation_adjustment', 'valuation_snapshot', 'rotation_policy'];
    const r = await bindF(pool.request(), scope, f).input('n', sql.Int, f.limit + 1).input('ent', sql.NVarChar(50), f.entity).input('act', sql.NVarChar(20), f.action).query(`
      SELECT TOP (@n) a.id, a.created_at, a.user_name, a.action, a.entity, a.entity_id, a.branch_id, LEFT(a.before_json, 400) AS before_json, LEFT(a.after_json, 400) AS after_json
      FROM audit_logs a WHERE a.organization_id = @o AND (@b IS NULL OR a.branch_id = @b) AND ${BOUNDS('a.created_at')} AND a.entity IN (${ents.map(e => `'${e}'`).join(', ')})
        AND (@ent IS NULL OR a.entity = @ent) AND (@act IS NULL OR a.action = @act)
        AND (@q IS NULL OR a.user_name LIKE @q OR a.entity LIKE @q OR a.after_json LIKE @q OR a.before_json LIKE @q)
      ORDER BY a.id DESC`);
    const rows = r.recordset.map(x => ({ ...x, entity: human(x.entity) }));
    const mv = (await bindF(pool.request(), scope, f).query(`
      SELECT COUNT(*) AS movements, COUNT(CASE WHEN m.user_id IS NULL THEN 1 END) AS no_user, COUNT(CASE WHEN m.reference IS NULL AND m.reason NOT IN ('opening_stock', 'opening_balance') THEN 1 END) AS no_reference
      FROM stock_movements m WHERE m.organization_id = @o AND (@b IS NULL OR m.branch_id = @b) AND ${BOUNDS('m.created_at')}`)).recordset[0];
    return { columns: [col('created_at', 'Date / time', 'datetime'), col('user_name', 'User'), col('action', 'Action'), col('entity', 'Record'), col('entity_id', 'Id', 'int'), col('before_json', 'Before'), col('after_json', 'After')],
             rows, summary: [{ label: 'Movements in period', value: mv.movements }, { label: 'Without a user', value: mv.no_user }, { label: 'Without a reference', value: mv.no_reference }],
             notes: ['Change log of inventory records. Stock movement history is in the Inventory Movement Ledger.', 'Before / after are cut at 400 characters.'] };
  },
};

function finalize(def, out, f, scope, limit) {
  const truncated = out.rows.length > limit;
  const rows = truncated ? out.rows.slice(0, limit) : out.rows;
  const totals = {};
  for (const c of out.columns) if (c.sum) totals[c.key] = c.type === 'money' ? round2(rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0)) : rows.reduce((a, r) => a + (Number(r[c.key]) || 0), 0);
  return {
    id: def.id, title: def.title, description: def.description, generated_at: new Date().toISOString(), scope: scope.branchId == null ? 'organisation' : 'branch',
    filters: { from: f.from, to: f.to, q: f.qText || null, category: f.category, supplier: f.supplier, location: f.location, reason: f.reason, cause: f.cause, status: f.status, class: f.class, by: f.by, days: f.days },
    columns: out.columns, rows, row_count: rows.length, truncated, totals, summary: out.summary ?? [], breakdown: out.breakdown ?? [], notes: out.notes ?? [],
  };
}

async function runReport(id, scope, query = {}) {
  const def = REPORTS.find(r => r.id === id);
  if (!def) throw new InsightError('Unknown report', 404, 'NOT_FOUND');
  if (!scope.can('reports.inventory') || (def.perm && !scope.can(def.perm))) throw new InsightError('You do not have access to this report', 403, 'FORBIDDEN');
  const f = parseFilters(query);
  const pool = await getPool();
  const out = await IMPL[id](pool, scope, f);
  return redact(scope, finalize(def, out, f, scope, f.limit));
}

module.exports = { REPORTS, REPORT_IDS, dashboard, runReport, parseFilters, InsightError };
