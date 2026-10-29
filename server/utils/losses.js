// Waste, damage & obsolete inventory.
//
// Two different things are kept apart on purpose:
//   PHYSICAL loss  - units that left stock without a sale: write-offs (stock adjustments with a loss reason), batch disposals and count
//                    shortages. Valued at the cost the ledger actually consumed (stock_movements.unit_cost).
//   VALUATION      - a change in what the stock on hand is worth (valuation_adjustments / provisions). No unit moves.
// Supplier returns are a third bucket: stock leaves, but a credit note may come back, so only an unrecovered shortfall is a loss.
// Nothing here posts stock; it reads the ledger and the document tables.
const { sql } = require('../db');
const { ADJUSTMENT_REASONS } = require('./stock');

const CAUSES = {
  expiry:        'Expired',
  deterioration: 'Deterioration / spoilage',
  breakage:      'Breakage / damage',
  contamination: 'Contamination',
  theft:         'Theft',
  missing:       'Missing / unexplained shortage',
  handling:      'Incorrect handling',
  obsolete:      'Obsolete / changing demand',
  recall:        'Product recall',
  other:         'Other',
};
const REASON_CAUSE = Object.fromEntries(Object.entries(ADJUSTMENT_REASONS).filter(([, r]) => r.loss).map(([k, r]) => [k, r.loss]));
const LOSS_REASONS = Object.keys(REASON_CAUSE);
const CLASSES = { active: 'Active', slow: 'Slow moving', non_moving: 'Non-moving', obsolete: 'Obsolete' };

const RECOMMENDATIONS = {
  expiry:        'Order smaller quantities more often, enforce first-expired-first-out picking, mark down near-expiry stock early, and agree a supplier take-back for short-dated lots.',
  deterioration: 'Check storage conditions (temperature, humidity, stacking), shorten stock cover for this item, and rotate older stock forward.',
  breakage:      'Review packing, racking and handling at the point of loss; claim transit damage from the supplier or carrier; consider changing pack size or packaging.',
  contamination: 'Isolate the affected area, review cleaning and pest control, and inspect inbound goods from the supplier involved.',
  theft:         'Restrict access to the location, count the high-risk items more often, and review key control and who can record write-offs.',
  missing:       'Count the item more often, check receiving and dispatch accuracy, and reconcile picks against sales until the gap closes.',
  handling:      'Retrain the staff involved, add a check at receiving or picking, and label locations and units clearly.',
  obsolete:      'Stop reordering, liquidate remaining stock (mark down, bundle or return to supplier), and revisit forecasts and minimum stock levels.',
  recall:        'Review supplier qualification and strengthen inbound inspection for this product.',
  other:         'Review the individual records and agree a more specific cause for next time.',
};

const DEFAULTS = {
  loss_writeoff_approval_value: null,
  obs_slow_days: 90, obs_nonmoving_days: 180, obs_obsolete_days: 365, obs_grace_days: 30, obs_slow_cover_days: 365,
  obs_provision_slow: 10, obs_provision_nonmoving: 25, obs_provision_obsolete: 50,
  loss_pattern_days: 180, loss_pattern_min_events: 3,
};
const SETTING_KEYS = Object.keys(DEFAULTS);

const rq = conn => (conn.request ? conn.request() : new sql.Request(conn));
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dayOf = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function loadSettings(conn, orgId) {
  const r = await rq(conn).input('o', sql.Int, orgId).query('SELECT [key], value FROM settings WHERE organization_id = @o AND ([key] LIKE \'obs[_]%\' OR [key] LIKE \'loss[_]%\')');
  const out = { ...DEFAULTS };
  for (const { key, value } of r.recordset) {
    if (!(key in DEFAULTS)) continue;
    const n = Number(value);
    if (value !== null && value !== '' && Number.isFinite(n)) out[key] = n;
  }
  return out;
}

// Periods are inclusive calendar dates ('YYYY-MM-DD'). SQL turns them into datetime bounds, so the database clock decides what "today" is:
// passing JS Dates would shift them by the timezone difference between this server and the database.
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftDay = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const periodOf = (from, to, defaultDays = 90) => {
  const end = to || ymd(new Date());
  return { start: from || shiftDay(end, -(defaultDays - 1)), end };
};
const BOUNDS = (col, from = '@from', to = '@to') => `${col} >= CAST(${from} AS DATE) AND ${col} < DATEADD(DAY, 1, CAST(${to} AS DATE))`;

/** Approved physical losses, gains (found / count surpluses) and untracked supplier returns for a period. */
async function lossEvents(conn, { orgId, branchId, start, end }) {
  const base = r => r.input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null).input('from', sql.VarChar(10), start).input('to', sql.VarChar(10), end);
  const reasons = [...LOSS_REASONS, 'count_correction', 'found', 'return_to_supplier'].map(x => `'${x}'`).join(', ');
  const adj = (await base(rq(conn)).query(`
    SELECT a.id, a.tire_id, a.item_name, a.reason_code, a.qty_change, a.location_id, sl.name AS location_name, a.batch_id, b.batch_no,
           a.requested_by, ru.name AS recorded_by, du.name AS approved_by, a.decided_by, a.decided_at, a.notes, t.supplier_id,
           ISNULL(m.unit_cost, t.cost_price) AS unit_cost
    FROM stock_adjustments a
    JOIN tires t ON t.id = a.tire_id
    LEFT JOIN stock_movements m ON m.id = a.movement_id
    LEFT JOIN stock_locations sl ON sl.id = a.location_id
    LEFT JOIN stock_batches b ON b.id = a.batch_id
    LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
    WHERE a.organization_id = @o AND (@b IS NULL OR a.branch_id = @b) AND a.status = 'approved'
      AND ${BOUNDS('a.decided_at')} AND a.reason_code IN (${reasons})
      AND NOT EXISTS (SELECT 1 FROM supplier_returns sr WHERE sr.adjustment_id = a.id)`)).recordset;
  const dsp = (await base(rq(conn)).query(`
    SELECT d.id, d.disposal_no, d.created_at, d.tire_id, d.item_name, d.batch_id, d.batch_no, d.qty, d.unit_cost, d.value, d.method, d.reason, d.loss_cause, d.recall_id,
           d.supplier_id, d.user_id, u.name AS recorded_by, b.expiry_date, b.quality_status
    FROM quality_disposals d LEFT JOIN users u ON u.id = d.user_id LEFT JOIN stock_batches b ON b.id = d.batch_id
    WHERE d.organization_id = @o AND (@b IS NULL OR d.branch_id = @b) AND ${BOUNDS('d.created_at')}`)).recordset;

  const losses = [], gains = [], unlinkedReturns = [];
  for (const a of adj) {
    const qty = Math.abs(a.qty_change), unit = Number(a.unit_cost || 0), value = round2(qty * unit);
    const label = ADJUSTMENT_REASONS[a.reason_code]?.label ?? a.reason_code;
    const ev = {
      source: 'adjustment', id: a.id, ref: `ADJ-${a.id}`, at: a.decided_at, tire_id: a.tire_id, item_name: String(a.item_name ?? '').replace(/\s+/g, ' ').trim(), qty, unit_cost: unit, value,
      reason_code: a.reason_code, reason_label: label, location_id: a.location_id, location_name: a.location_name, batch_id: a.batch_id, batch_no: a.batch_no,
      supplier_id: a.supplier_id, recorded_by_id: a.requested_by, recorded_by: a.recorded_by, approved_by_id: a.decided_by, approved_by: a.approved_by, notes: a.notes,
    };
    if (a.reason_code === 'return_to_supplier') { if (a.qty_change < 0) unlinkedReturns.push(ev); continue; }
    if (a.qty_change > 0) { if (a.reason_code === 'found' || a.reason_code === 'count_correction') gains.push(ev); continue; }
    const cause = REASON_CAUSE[a.reason_code] ?? (a.reason_code === 'count_correction' ? 'missing' : 'other');
    if (a.reason_code === 'count_correction') ev.reason_label = 'Stock count shortage';
    losses.push({ ...ev, cause, cause_label: CAUSES[cause] });
  }
  for (const d of dsp) {
    const ev = {
      source: 'disposal', id: d.id, ref: d.disposal_no, at: d.created_at, tire_id: d.tire_id, item_name: d.item_name, qty: d.qty, unit_cost: Number(d.unit_cost), value: Number(d.value),
      reason_code: d.method, reason_label: d.method === 'destroy' ? 'Destroyed / disposed' : d.method === 'write_off' ? 'Written off' : 'Returned to supplier', location_id: null, location_name: null,
      batch_id: d.batch_id, batch_no: d.batch_no, supplier_id: d.supplier_id, recorded_by_id: d.user_id, recorded_by: d.recorded_by, approved_by: null, notes: d.reason,
    };
    if (d.method === 'return_to_supplier') { unlinkedReturns.push(ev); continue; }
    const expired = d.expiry_date && new Date(d.expiry_date) < new Date(d.created_at);
    let cause = d.loss_cause && CAUSES[d.loss_cause] ? d.loss_cause : expired ? 'expiry' : d.recall_id ? 'recall' : d.quality_status === 'damaged' ? 'breakage' : 'other';
    losses.push({ ...ev, cause, cause_label: CAUSES[cause] });
  }
  const byDate = (a, b) => new Date(b.at) - new Date(a.at);
  losses.sort(byDate); gains.sort(byDate);
  return { losses, gains, unlinkedReturns };
}

const total = rows => ({ events: rows.length, units: rows.reduce((a, x) => a + x.qty, 0), value: round2(rows.reduce((a, x) => a + x.value, 0)) });
function groupBy(rows, keyFn, labelFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r); if (k == null) continue;
    const g = m.get(k) ?? { key: k, label: labelFn ? labelFn(r) : String(k), events: 0, units: 0, value: 0 };
    g.events++; g.units += r.qty; g.value += r.value; m.set(k, g);
  }
  const all = [...m.values()].map(g => ({ ...g, value: round2(g.value) })).sort((a, b) => b.value - a.value);
  const sum = all.reduce((a, g) => a + g.value, 0);
  return all.map(g => ({ ...g, share: sum ? Math.round((g.value / sum) * 1000) / 10 : 0 }));
}

/** Supplier return documents with their derived status. Value is what the ledger took out of stock (or the current cost while awaiting approval). */
async function supplierReturns(conn, { orgId, branchId, start = null, end = null, supplierId = null }) {
  const r = await rq(conn).input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null).input('from', sql.VarChar(10), start).input('to', sql.VarChar(10), end).input('s', sql.Int, supplierId)
    .query(`SELECT r.id, r.return_no, r.supplier_id, s.name AS supplier_name, r.tire_id, r.item_name, r.batch_id, bt.batch_no, r.qty, r.reason, r.reference, r.adjustment_id,
                   a.status AS adj_status, ISNULL(m.unit_cost, t.cost_price) AS unit_cost, r.credit_amount, r.credit_ref, r.credit_at, r.closed_at, r.created_at,
                   cu.name AS created_by_name, au.name AS approved_by_name
            FROM supplier_returns r
            JOIN stock_adjustments a ON a.id = r.adjustment_id JOIN tires t ON t.id = r.tire_id JOIN suppliers s ON s.id = r.supplier_id
            LEFT JOIN stock_movements m ON m.id = a.movement_id LEFT JOIN stock_batches bt ON bt.id = r.batch_id
            LEFT JOIN users cu ON cu.id = r.created_by LEFT JOIN users au ON au.id = a.decided_by
            WHERE r.organization_id = @o AND (@b IS NULL OR r.branch_id = @b) AND (@from IS NULL OR r.created_at >= CAST(@from AS DATE)) AND (@to IS NULL OR r.created_at < DATEADD(DAY, 1, CAST(@to AS DATE)))
              AND (@s IS NULL OR r.supplier_id = @s) ORDER BY r.id DESC`);
  return r.recordset.map(x => {
    const value = round2(x.qty * Number(x.unit_cost || 0)), credit = Number(x.credit_amount);
    let status = 'shipped';
    if (x.adj_status === 'pending') status = 'awaiting_approval';
    else if (x.adj_status === 'rejected') status = 'rejected';
    else if (x.closed_at) status = credit >= value - 0.005 ? 'credited' : 'short_credited';
    const shortfall = x.closed_at && x.adj_status === 'approved' ? Math.max(0, round2(value - credit)) : 0;
    const outstanding = x.adj_status === 'approved' && !x.closed_at ? Math.max(0, round2(value - credit)) : 0;
    return { ...x, value, credit_amount: credit, status, shortfall, outstanding, unit_cost: Number(x.unit_cost || 0) };
  });
}
const returnTotals = rows => {
  const live = rows.filter(r => r.status !== 'awaiting_approval' && r.status !== 'rejected');
  return { documents: live.length, shipped_value: round2(live.reduce((a, r) => a + r.value, 0)), credit_received: round2(live.reduce((a, r) => a + r.credit_amount, 0)),
           credit_outstanding: round2(live.reduce((a, r) => a + r.outstanding, 0)), unrecovered_loss: round2(live.reduce((a, r) => a + r.shortfall, 0)),
           awaiting_approval: rows.filter(r => r.status === 'awaiting_approval').length };
};

async function valuationChanges(conn, { orgId, branchId, start, end }) {
  const r = await rq(conn).input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null).input('from', sql.VarChar(10), start).input('to', sql.VarChar(10), end)
    .query(`SELECT a.id, a.tire_id, a.item_name, a.qty, a.old_unit_cost, a.new_unit_cost, a.old_value, a.new_value, a.new_value - a.old_value AS delta, a.reason, a.method, a.created_at, u.name AS user_name
            FROM valuation_adjustments a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.organization_id = @o AND (@b IS NULL OR a.branch_id = @b) AND ${BOUNDS('a.created_at')} ORDER BY a.id DESC`);
  const rows = r.recordset.map(x => ({ ...x, delta: round2(x.delta) }));
  const down = rows.filter(x => x.delta < 0), up = rows.filter(x => x.delta > 0);
  return { rows, write_down: round2(-down.reduce((a, x) => a + x.delta, 0)), write_up: round2(up.reduce((a, x) => a + x.delta, 0)),
           net: round2(rows.reduce((a, x) => a + x.delta, 0)) };
}

/** Stock that is already a loss waiting to be recorded: expired, held/damaged batches, and units sitting in damaged / quarantine locations. */
async function exposure(conn, { orgId, branchId }) {
  const q = sqlText => rq(conn).input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null).query(sqlText).then(r => r.recordset[0]);
  const [expired, held, locs] = await Promise.all([
    q(`SELECT COUNT(DISTINCT b.id) AS batches, ISNULL(SUM(x.qty), 0) AS units, ISNULL(SUM(x.qty * ISNULL(b.unit_cost, t.cost_price)), 0) AS value
       FROM stock_batches b JOIN tires t ON t.id = b.tire_id JOIN batch_location_stock x ON x.batch_id = b.id
       WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND b.expiry_date IS NOT NULL AND b.expiry_date < CAST(GETDATE() AS DATE) AND x.qty > 0`),
    q(`SELECT COUNT(DISTINCT b.id) AS batches, ISNULL(SUM(x.qty), 0) AS units, ISNULL(SUM(x.qty * ISNULL(b.unit_cost, t.cost_price)), 0) AS value
       FROM stock_batches b JOIN tires t ON t.id = b.tire_id JOIN batch_location_stock x ON x.batch_id = b.id
       WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND b.quality_status IN ('on_hold', 'damaged', 'recalled') AND x.qty > 0
         AND NOT (b.expiry_date IS NOT NULL AND b.expiry_date < CAST(GETDATE() AS DATE))`),
    q(`SELECT ISNULL(SUM(CASE WHEN l.kind = 'damaged' THEN x.qty END), 0) AS damaged_units, ISNULL(SUM(CASE WHEN l.kind = 'damaged' THEN x.qty * t.cost_price END), 0) AS damaged_value,
              ISNULL(SUM(CASE WHEN l.kind = 'quarantine' THEN x.qty END), 0) AS quarantine_units, ISNULL(SUM(CASE WHEN l.kind = 'quarantine' THEN x.qty * t.cost_price END), 0) AS quarantine_value
       FROM item_location_stock x JOIN stock_locations l ON l.id = x.location_id JOIN tires t ON t.id = x.tire_id
       WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND l.kind IN ('damaged', 'quarantine') AND x.qty > 0`),
  ]);
  return {
    expired: { batches: expired.batches, units: expired.units, value: round2(expired.value) },
    held_batches: { batches: held.batches, units: held.units, value: round2(held.value) },
    damaged_location: { units: locs.damaged_units, value: round2(locs.damaged_value) },
    quarantine_location: { units: locs.quarantine_units, value: round2(locs.quarantine_value) },
    note: 'Awaiting a write-off, disposal or release decision. Locations and batches can overlap, so these are not added together.',
  };
}

async function costOfSales(conn, { orgId, branchId, start, end }) {
  const r = await rq(conn).input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null).input('from', sql.VarChar(10), start).input('to', sql.VarChar(10), end)
    .query(`SELECT ISNULL(SUM(-m.qty_change * ISNULL(m.unit_cost, 0)), 0) AS v FROM stock_movements m JOIN tires t ON t.id = m.tire_id
            WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND m.reason IN ('sale', 'sale_voided', 'sale_deleted') AND ${BOUNDS('m.created_at')}`);
  return round2(r.recordset[0].v);
}

async function summary(conn, ctx, range) {
  const p = { orgId: ctx.orgId, branchId: ctx.branchId, ...range };
  const [ev, rets, val, exp, cogs] = await Promise.all([lossEvents(conn, p), supplierReturns(conn, { ...p }), valuationChanges(conn, p), exposure(conn, p), costOfSales(conn, p)]);
  const physical = total(ev.losses), gains = total(ev.gains), rt = returnTotals(rets);
  const months = [];
  const [sy, sm] = range.start.split('-').map(Number), [ey, em] = range.end.split('-').map(Number);
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  const monthKey = x => new Date(x.at).toISOString().slice(0, 7);
  const byMonth = months.map(m => { const rows = ev.losses.filter(x => monthKey(x) === m); return { month: m, ...total(rows) }; });
  const netPhysical = round2(physical.value + rt.unrecovered_loss);
  return {
    period: { from: range.start, to: range.end },
    physical: { ...physical, by_cause: groupBy(ev.losses, x => x.cause, x => x.cause_label), by_reason: groupBy(ev.losses, x => x.reason_label), by_month: byMonth,
                by_source: { adjustments: total(ev.losses.filter(x => x.source === 'adjustment')), disposals: total(ev.losses.filter(x => x.source === 'disposal')) } },
    gains: { ...gains, note: 'Stock found and count surpluses. Netted against shortages to give net shrinkage.' },
    net_shrinkage: round2(physical.value - gains.value),
    supplier_returns: { ...rt, unlinked: total(ev.unlinkedReturns), unlinked_note: 'Returns recorded as a plain adjustment or disposal without a supplier return document, so no credit is tracked.' },
    net_physical_loss: netPhysical,
    valuation: { write_down: val.write_down, write_up: val.write_up, net_change: val.net, adjustments: val.rows.slice(0, 50),
                 note: 'Changes in what stock on hand is worth. No units left stock. Reported separately from physical loss and never added to it.' },
    cost_of_sales: cogs, loss_rate_pct: cogs > 0 ? Math.round((physical.value / cogs) * 1000) / 10 : null,
    exposure: exp,
  };
}

// ── Slow-moving and obsolete classification ────────────────────────────────
async function classifyStock(conn, { orgId, branchId }, st) {
  const items = (await rq(conn).input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null).query(`
    SELECT t.id AS tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS name, t.sku, ISNULL(c.name, 'Uncategorised') AS category, t.stock, t.cost_price, t.created_at,
           t.lifecycle_status, t.lifecycle_note, t.track_expiry,
           s.last_sale, r.last_receipt, ISNULL(s.sold_90, 0) AS sold_90, ISNULL(s.sold_365, 0) AS sold_365,
           DATEDIFF(DAY, ISNULL(s.last_sale, t.created_at), GETDATE()) AS idle_days, DATEDIFF(DAY, r.last_receipt, GETDATE()) AS receipt_days
    FROM tires t
    LEFT JOIN item_categories c ON c.id = t.category_id
    LEFT JOIN (SELECT m.tire_id,
                      MAX(CASE WHEN m.reason = 'sale' THEN m.created_at END) AS last_sale,
                      SUM(CASE WHEN m.created_at >= DATEADD(DAY, -90, GETDATE()) THEN -m.qty_change ELSE 0 END) AS sold_90,
                      SUM(CASE WHEN m.created_at >= DATEADD(DAY, -365, GETDATE()) THEN -m.qty_change ELSE 0 END) AS sold_365
               FROM stock_movements m WHERE m.organization_id = @o AND m.reason IN ('sale', 'sale_voided', 'sale_deleted') GROUP BY m.tire_id) s ON s.tire_id = t.id
    LEFT JOIN (SELECT m.tire_id, MAX(m.created_at) AS last_receipt FROM stock_movements m
               WHERE m.organization_id = @o AND m.qty_change > 0 AND m.reason IN ('grn_received', 'opening_stock', 'opening_balance') GROUP BY m.tire_id) r ON r.tire_id = t.id
    WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND t.status = 'active' AND t.stock > 0`)).recordset;
  const prov = { slow: st.obs_provision_slow, non_moving: st.obs_provision_nonmoving, obsolete: st.obs_provision_obsolete };
  const rows = items.map(x => {
    const cost = Number(x.cost_price || 0), value = round2(x.stock * cost);
    const idle = Math.max(0, x.idle_days);
    const sinceReceipt = x.last_receipt ? Math.max(0, x.receipt_days) : null;
    const newStock = sinceReceipt != null && sinceReceipt < st.obs_grace_days && idle >= st.obs_slow_days;
    const daily = x.sold_90 > 0 ? x.sold_90 / 90 : 0;
    const cover = daily > 0 ? Math.round(x.stock / daily) : null;
    const flagged = x.lifecycle_status === 'obsolete' || x.lifecycle_status === 'discontinued';
    let cls = 'active', why = null;
    if (flagged) { cls = 'obsolete'; why = x.lifecycle_status === 'obsolete' ? 'Marked obsolete' : 'Marked discontinued'; }
    else if (!newStock) {
      if (idle >= st.obs_obsolete_days) { cls = 'obsolete'; why = `No sale for ${idle} days`; }
      else if (idle >= st.obs_nonmoving_days) { cls = 'non_moving'; why = `No sale for ${idle} days`; }
      else if (idle >= st.obs_slow_days) { cls = 'slow'; why = `No sale for ${idle} days`; }
      else if (cover != null && cover >= st.obs_slow_cover_days) { cls = 'slow'; why = `${cover} days of cover at the current sales rate`; }
    } else why = `Received ${sinceReceipt} day(s) ago, not yet judged`;
    const pct = prov[cls] ?? 0;
    const action = { slow: 'Promote or bundle, cut the reorder quantity, stop automatic replenishment.', non_moving: 'Mark down or bundle, ask the supplier to take it back, review the write-down.',
                     obsolete: 'Liquidate, return to supplier, write down to net realisable value, or write off and dispose.', active: '' }[cls];
    return { tire_id: x.tire_id, name: x.name, sku: x.sku, category: x.category, stock: x.stock, unit_cost: cost, value, class: cls, class_label: CLASSES[cls], reason: why,
             idle_days: idle, last_sale: dayOf(x.last_sale), last_receipt: dayOf(x.last_receipt), sold_90: x.sold_90, sold_365: x.sold_365, cover_days: cover,
             lifecycle_status: x.lifecycle_status, lifecycle_note: x.lifecycle_note, new_stock: newStock,
             provision_pct: pct, provision_value: round2(value * pct / 100), suggested_unit_cost: round2(cost * (1 - pct / 100)), action };
  });
  const summary = Object.fromEntries(Object.keys(CLASSES).map(k => [k, { items: 0, units: 0, value: 0, provision: 0 }]));
  for (const r of rows) { const g = summary[r.class]; g.items++; g.units += r.stock; g.value += r.value; g.provision += r.provision_value; }
  for (const g of Object.values(summary)) { g.value = round2(g.value); g.provision = round2(g.provision); }
  const bounds = [['0-30', 30], ['31-90', 90], ['91-180', 180], ['181-365', 365], ['365+', Infinity]];
  const idleBuckets = bounds.map(([label, max], i) => {
    const lo = i === 0 ? -1 : bounds[i - 1][1];
    const inB = rows.filter(r => r.idle_days > lo && r.idle_days <= max);
    return { label, items: inB.length, units: inB.reduce((a, r) => a + r.stock, 0), value: round2(inB.reduce((a, r) => a + r.value, 0)) };
  });
  rows.sort((a, b) => ({ obsolete: 3, non_moving: 2, slow: 1, active: 0 }[b.class] - { obsolete: 3, non_moving: 2, slow: 1, active: 0 }[a.class]) || b.value - a.value);
  const atRisk = rows.filter(r => r.class !== 'active');
  return { summary, idle_buckets: idleBuckets, rows, at_risk_value: round2(atRisk.reduce((a, r) => a + r.value, 0)), suggested_provision: round2(atRisk.reduce((a, r) => a + r.provision_value, 0)),
           thresholds: { slow_days: st.obs_slow_days, non_moving_days: st.obs_nonmoving_days, obsolete_days: st.obs_obsolete_days, grace_days: st.obs_grace_days, slow_cover_days: st.obs_slow_cover_days,
                         provision: prov },
           note: 'Valued at current item cost. A provision is a valuation write-down (no units leave stock); writing the stock off or disposing of it is a physical loss. They are separate entries.' };
}

// ── Repeated loss patterns ─────────────────────────────────────────────────
async function detectPatterns(conn, ctx, st, days = null) {
  const span = Math.min(Math.max(days || st.loss_pattern_days, 30), 730);
  const minEv = Math.max(2, st.loss_pattern_min_events);
  const end = ymd(new Date()), start = shiftDay(end, -(span - 1)), prevEnd = shiftDay(start, -1), prevStart = shiftDay(start, -span);
  const p = { orgId: ctx.orgId, branchId: ctx.branchId };
  const [cur, prev, rets] = await Promise.all([lossEvents(conn, { ...p, start, end }), lossEvents(conn, { ...p, start: prevStart, end: prevEnd }), supplierReturns(conn, { ...p, start, end })]);
  const L = cur.losses, totalValue = L.reduce((a, x) => a + x.value, 0);
  const sevOf = v => (totalValue > 0 && v / totalValue >= 0.25 ? 'high' : totalValue > 0 && v / totalValue >= 0.1 ? 'medium' : 'low');
  const out = [];
  const supplierNames = Object.fromEntries((await rq(conn).input('o', sql.Int, ctx.orgId).query('SELECT id, name FROM suppliers WHERE organization_id = @o')).recordset.map(s => [s.id, s.name]));
  const push = pt => out.push({ evidence_period_days: span, ...pt, recommendation: pt.recommendation ?? RECOMMENDATIONS[pt.cause] ?? RECOMMENDATIONS.other });
  const top = rows => { const g = groupBy(rows, x => x.cause, x => x.cause_label); return g[0]; };

  // Same item losing stock again and again.
  const byItem = new Map(); for (const x of L) (byItem.get(x.tire_id) ?? byItem.set(x.tire_id, []).get(x.tire_id)).push(x);
  for (const [tireId, rows] of byItem) {
    if (rows.length < minEv) continue;
    const t = top(rows), value = round2(rows.reduce((a, x) => a + x.value, 0));
    push({ key: `item:${tireId}`, type: 'repeat_item', severity: sevOf(value), cause: t.key, subject: rows[0].item_name, subject_id: tireId,
           title: `${rows[0].item_name}: ${rows.length} losses in ${span} days`, detail: `Mostly ${t.label.toLowerCase()} (${t.events} of ${rows.length} events).`,
           evidence: { events: rows.length, units: rows.reduce((a, x) => a + x.qty, 0), value } });
  }
  // One supplier's goods repeatedly damaged / contaminated / expiring / deteriorating.
  const supplierCauses = new Set(['breakage', 'contamination', 'deterioration', 'expiry', 'recall']);
  const bySup = new Map(); for (const x of L) if (x.supplier_id && supplierCauses.has(x.cause)) (bySup.get(x.supplier_id) ?? bySup.set(x.supplier_id, []).get(x.supplier_id)).push(x);
  for (const [sid, rows] of bySup) {
    const value = round2(rows.reduce((a, x) => a + x.value, 0));
    if (rows.length < minEv && !(rows.length >= 2 && totalValue > 0 && value / totalValue >= 0.3)) continue;
    const t = top(rows);
    push({ key: `supplier:${sid}`, type: 'supplier_quality', severity: sevOf(value), cause: t.key, subject: supplierNames[sid] ?? `Supplier ${sid}`, subject_id: sid,
           title: `${supplierNames[sid] ?? 'Supplier'}: ${rows.length} quality-related losses`, detail: `Mostly ${t.label.toLowerCase()}. Consider claims or returns, and an inbound inspection or a supplier review.`,
           evidence: { events: rows.length, units: rows.reduce((a, x) => a + x.qty, 0), value },
           recommendation: 'Raise the pattern with the supplier, claim or return affected lots through a supplier return document, inspect their next deliveries, and weigh alternative suppliers.' });
  }
  // A location where losses concentrate.
  const byLoc = groupBy(L.filter(x => x.location_id), x => x.location_id, x => x.location_name);
  if (byLoc.length > 1) {
    for (const g of byLoc) {
      if (g.events < minEv || g.share < 40) continue;
      const rows = L.filter(x => x.location_id === g.key), t = top(rows);
      push({ key: `location:${g.key}`, type: 'location_hotspot', severity: sevOf(g.value), cause: t.key, subject: g.label, subject_id: g.key,
             title: `${g.label}: ${g.share}% of write-off value`, detail: `${g.events} events, mostly ${t.label.toLowerCase()}.`, evidence: { events: g.events, units: g.units, value: g.value } });
    }
  }
  // One person recording or approving most of the write-offs.
  const recorders = groupBy(L.filter(x => x.recorded_by_id), x => x.recorded_by_id, x => x.recorded_by ?? `User ${x.recorded_by_id}`);
  if (recorders.length >= 2) {
    for (const g of recorders) {
      if (g.events < Math.max(minEv, 5) || g.share < 60) continue;
      push({ key: `user:${g.key}`, type: 'recorder_concentration', severity: 'medium', cause: top(L.filter(x => x.recorded_by_id === g.key)).key, subject: g.label, subject_id: g.key,
             title: `${g.label} recorded ${g.share}% of write-off value`, detail: `${g.events} events. A concentration is not proof of a problem (it may be their area), but it merits a review.`,
             evidence: { events: g.events, units: g.units, value: g.value },
             recommendation: 'Review a sample of their write-offs against physical stock, rotate who records them, and require a second approver above a value limit.' });
    }
  }
  // Rising causes compared with the previous equal period.
  const nowByCause = groupBy(L, x => x.cause, x => x.cause_label), prevByCause = Object.fromEntries(groupBy(prev.losses, x => x.cause).map(g => [g.key, g.value]));
  for (const g of nowByCause) {
    const before = prevByCause[g.key] ?? 0;
    if (g.events < minEv || g.value <= 0) continue;
    if (before === 0 ? false : g.value >= before * 1.5) {
      push({ key: `trend:${g.key}`, type: 'rising_cause', severity: sevOf(g.value), cause: g.key, subject: g.label,
             title: `${g.label} losses up ${Math.round((g.value / before - 1) * 100)}%`, detail: `${g.value} this period against ${before} in the previous ${span} days.`, evidence: { events: g.events, units: g.units, value: g.value, previous_value: before } });
    }
  }
  // Items repeatedly written off as expired: the reorder policy is probably too generous.
  const expiryRows = L.filter(x => x.cause === 'expiry');
  if (expiryRows.length >= minEv) {
    const value = round2(expiryRows.reduce((a, x) => a + x.value, 0));
    push({ key: 'cause:expiry', type: 'recurring_expiry', severity: sevOf(value), cause: 'expiry', subject: 'Expired stock',
           title: `${expiryRows.length} expiry write-offs worth ${value}`, detail: `${new Set(expiryRows.map(x => x.tire_id)).size} item(s) affected.`, evidence: { events: expiryRows.length, units: expiryRows.reduce((a, x) => a + x.qty, 0), value } });
  }
  // Suppliers that do not credit returns in full.
  const short = new Map(); for (const r of rets) if (r.shortfall > 0) (short.get(r.supplier_id) ?? short.set(r.supplier_id, { name: r.supplier_name, n: 0, v: 0 }).get(r.supplier_id), short.get(r.supplier_id).n++, short.get(r.supplier_id).v += r.shortfall);
  for (const [sid, s] of short) {
    push({ key: `returns:${sid}`, type: 'unrecovered_returns', severity: 'medium', cause: 'other', subject: s.name, subject_id: sid, title: `${s.name} credited ${s.n} return(s) short`, detail: `${round2(s.v)} not recovered.`,
           evidence: { events: s.n, units: 0, value: round2(s.v) }, recommendation: 'Chase the outstanding credit notes, agree return terms before shipping, and keep proof of condition and dispatch.' });
  }
  const actions = (await rq(conn).input('o', sql.Int, ctx.orgId).query("SELECT id, pattern_key, status FROM loss_actions WHERE organization_id = @o AND pattern_key IS NOT NULL")).recordset;
  const rank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.evidence.value - a.evidence.value);
  for (const pt of out) { const a = actions.filter(x => x.pattern_key === pt.key).sort((x, y) => y.id - x.id)[0]; pt.action = a ? { id: a.id, status: a.status } : null; }
  return { days: span, min_events: minEv, total_loss_value: round2(totalValue), patterns: out };
}

module.exports = { CAUSES, CLASSES, REASON_CAUSE, LOSS_REASONS, RECOMMENDATIONS, DEFAULTS, SETTING_KEYS, loadSettings, periodOf, lossEvents, groupBy, total, supplierReturns, returnTotals,
                   valuationChanges, exposure, costOfSales, summary, classifyStock, detectPatterns, round2, dayOf };
