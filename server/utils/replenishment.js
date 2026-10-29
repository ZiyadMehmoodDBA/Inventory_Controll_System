// Replenishment planning: when to reorder, how much, and from whom. Pure planning: nothing here creates a purchase commitment.
//   reorder point  = expected demand during lead time + safety stock            (never below the item's minimum stock)
//   inventory pos. = eligible available (on hand - quarantined - expired - reserved) + confirmed incoming (pending POs + in-transit transfers)
//   order trigger  = inventory position <= reorder point
//   order quantity = target stock - inventory position, then raised to the supplier minimum, rounded up to the pack multiple, capped by storage capacity
//   target stock   = the item's maximum, else reorder point + demand over the order cycle
const { getPool, sql } = require('../db');
const { POSITION_APPLY, POSITION_COLUMNS } = require('./stockPosition');

const round2 = n => Math.round(n * 100) / 100;
const DEFAULTS = { service_level: 0.95, lookback_days: 90, cover_days: 30, default_lead_days: 7, excess_days: 180, mode: 'auto' };
const KEYS = { service_level: 'rep_service_level', lookback_days: 'rep_lookback_days', cover_days: 'rep_cover_days', default_lead_days: 'rep_default_lead_days',
               excess_days: 'rep_excess_days', mode: 'rep_mode', budget: 'rep_budget' };

// z-scores for the service levels people actually use; linear in between.
const Z_TABLE = [[0.5, 0], [0.8, 0.84], [0.85, 1.04], [0.9, 1.28], [0.95, 1.65], [0.975, 1.96], [0.99, 2.33], [0.999, 3.09]];
function zOf(p) {
  if (!(p > 0.5)) return 0;
  if (p >= Z_TABLE[Z_TABLE.length - 1][0]) return Z_TABLE[Z_TABLE.length - 1][1];
  for (let i = 1; i < Z_TABLE.length; i++) {
    const [p1, z1] = Z_TABLE[i];
    if (p <= p1) { const [p0, z0] = Z_TABLE[i - 1]; return z0 + ((p - p0) / (p1 - p0)) * (z1 - z0); }
  }
  return 0;
}

/** Seasonality: 12 monthly demand factors (Jan..Dec), 1 = normal. Accepts an array or JSON text; null/empty clears. */
function parseSeasonality(v) {
  if (v === undefined || v === null || v === '') return null;
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { throw Object.assign(new Error('Seasonality must be 12 numbers'), { code: 'INVALID_SEASONALITY', status: 400 }); } }
  if (!Array.isArray(a) || a.length !== 12 || a.some(x => !Number.isFinite(Number(x)) || Number(x) < 0 || Number(x) > 10)) {
    throw Object.assign(new Error('Seasonality needs 12 monthly factors between 0 and 10 (1 = normal demand)'), { code: 'INVALID_SEASONALITY', status: 400 });
  }
  const nums = a.map(Number);
  return nums.every(x => x === 1) ? null : JSON.stringify(nums);
}
const readSeasonality = t => { try { const a = t ? JSON.parse(t) : null; return Array.isArray(a) && a.length === 12 ? a.map(Number) : null; } catch { return null; } };
/** Average factor over `days` days starting `offset` days from today (negative offset = the past). */
function factorAvg(f, offset, days) {
  if (!f || days <= 0) return 1;
  let sum = 0;
  for (let i = 0; i < days; i++) sum += f[new Date(Date.now() + (offset + i) * 86400000).getUTCMonth()];
  return sum / days;
}

async function loadSettings(orgId, conn) {
  const r = await (conn || (await getPool())).request().input('o', sql.Int, orgId)
    .query(`SELECT [key], value FROM settings WHERE organization_id = @o AND [key] LIKE 'rep[_]%'`);
  const raw = Object.fromEntries(r.recordset.map(x => [x.key, x.value]));
  const num = (k, d, lo, hi) => { const n = Number(raw[KEYS[k]]); return Number.isFinite(n) && raw[KEYS[k]] !== undefined && raw[KEYS[k]] !== '' ? Math.min(Math.max(n, lo), hi) : d; };
  const budget = Number(raw[KEYS.budget]);
  return {
    service_level: num('service_level', DEFAULTS.service_level, 0, 0.999),
    lookback_days: Math.round(num('lookback_days', DEFAULTS.lookback_days, 14, 365)),
    cover_days: Math.round(num('cover_days', DEFAULTS.cover_days, 1, 365)),
    default_lead_days: Math.round(num('default_lead_days', DEFAULTS.default_lead_days, 0, 365)),
    excess_days: Math.round(num('excess_days', DEFAULTS.excess_days, 30, 1000)),
    mode: raw[KEYS.mode] === 'manual' ? 'manual' : 'auto',
    budget: raw[KEYS.budget] && Number.isFinite(budget) && budget > 0 ? budget : null,
  };
}

const PRIORITY = { out_of_stock: 0, critical: 1, low: 2 };

/**
 * Classify every active item of the branch and size the orders. `budget` (working capital) overrides the saved company budget;
 * funding goes to the most urgent items first. Returns every item, supplier groups of what needs ordering, and a summary.
 */
async function computePlan(orgId, branchId, opts = {}) {
  const pool = await getPool();
  const cfg = await loadSettings(orgId, pool);
  const budget = opts.budget !== undefined && opts.budget !== null && opts.budget !== '' ? (Number(opts.budget) > 0 ? Number(opts.budget) : null) : cfg.budget;
  const L = cfg.lookback_days;

  const items = (await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
    .query(`SELECT t.id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, t.sku, t.uom, t.stock, t.cost_price, t.reorder_level, t.min_stock, t.max_stock, t.reorder_qty,
                   t.reorder_mode, t.safety_stock, t.lead_time_days, t.moq, t.order_multiple, t.capacity_units, t.seasonality, t.supplier_id, t.pack_size,
                   DATEDIFF(DAY, t.created_at, GETDATE()) AS age_days, ISNULL(c.name, 'Uncategorised') AS category, c.seasonality AS cat_seasonality,
                   s.name AS supplier_name, s.lead_time_days AS sup_lead, s.min_order_value, ${POSITION_COLUMNS}
            FROM tires t ${POSITION_APPLY}
            LEFT JOIN item_categories c ON c.id = t.category_id LEFT JOIN suppliers s ON s.id = t.supplier_id
            WHERE t.organization_id = @o AND t.branch_id = @b AND t.status = 'active' AND ISNULL(t.lifecycle_status, '') NOT IN ('discontinued', 'obsolete') ORDER BY t.model`)).recordset;

  const daily = {}, used = {}, reqs = {}, observed = {};
  const dq = pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('n', sql.Int, L);
  for (const m of (await dq.query(`SELECT m.tire_id, CAST(m.created_at AS DATE) AS d, SUM(-m.qty_change) AS q FROM stock_movements m JOIN tires t ON t.id = m.tire_id
      WHERE t.organization_id = @o AND t.branch_id = @b AND m.reason IN ('sale', 'sale_voided', 'sale_deleted') AND m.created_at >= DATEADD(DAY, -@n, CAST(GETDATE() AS DATE))
      GROUP BY m.tire_id, CAST(m.created_at AS DATE)`)).recordset) (daily[m.tire_id] ??= []).push(Number(m.q));
  for (const u of (await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('n', sql.Int, L)
    .query(`SELECT tire_id, SUM(-qty_change) AS q FROM stock_adjustments WHERE organization_id = @o AND branch_id = @b AND reason_code = 'internal_use' AND status = 'approved'
            AND decided_at >= DATEADD(DAY, -@n, CAST(GETDATE() AS DATE)) GROUP BY tire_id`)).recordset) used[u.tire_id] = Math.max(0, Number(u.q));
  for (const q of (await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
    .query(`SELECT tire_id, qty, DATEDIFF(DAY, CAST(GETDATE() AS DATE), needed_by) AS in_days FROM replenishment_requirements WHERE organization_id = @o AND branch_id = @b AND status = 'open'`)).recordset) (reqs[q.tire_id] ??= []).push(q);
  for (const o of (await pool.request().input('o', sql.Int, orgId)
    .query(`SELECT supplier_id, COUNT(*) AS n, AVG(CAST(DATEDIFF(DAY, created_at, received_at) AS FLOAT)) AS avg_days FROM purchases
            WHERE organization_id = @o AND status = 'received' AND received_at IS NOT NULL AND supplier_id IS NOT NULL AND received_at >= DATEADD(DAY, -365, GETDATE()) GROUP BY supplier_id`)).recordset) observed[o.supplier_id] = o;

  const z = zOf(cfg.service_level);
  const out = items.map(x => {
    const f = readSeasonality(x.seasonality) || readSeasonality(x.cat_seasonality);
    const observedDays = Math.min(L, Math.max(7, x.age_days ?? L));
    const series = daily[x.id] || [];
    const sold = Math.max(0, series.reduce((a, v) => a + v, 0)), usage = used[x.id] || 0;
    const baseDaily = (sold + usage) / observedDays / (factorAvg(f, -observedDays, observedDays) || 1);
    // standard deviation of daily sales over the observed window (zero days included)
    const mean = sold / observedDays;
    const variance = observedDays > 1 ? (series.reduce((a, v) => a + (v - mean) ** 2, 0) + (observedDays - series.length) * mean ** 2) / (observedDays - 1) : 0;
    const sigma = Math.sqrt(Math.max(0, variance));

    let lt, ltSource;
    if (x.lead_time_days != null) { lt = x.lead_time_days; ltSource = 'item'; }
    else if (x.sup_lead != null) { lt = x.sup_lead; ltSource = 'supplier'; }
    else if (x.supplier_id && observed[x.supplier_id]?.n >= 2) { lt = Math.max(1, Math.round(observed[x.supplier_id].avg_days)); ltSource = 'observed'; }
    else { lt = cfg.default_lead_days; ltSource = 'default'; }

    const fLT = factorAvg(f, 0, lt || 1), dailyLT = baseDaily * fLT;
    const rq = reqs[x.id] || [];
    const reqLT = rq.filter(r => r.in_days <= lt).reduce((a, r) => a + r.qty, 0);
    const reqCycle = rq.filter(r => r.in_days > lt && r.in_days <= lt + cfg.cover_days).reduce((a, r) => a + r.qty, 0);
    const demandLT = dailyLT * lt + reqLT;

    let safety = 0, safetyBasis = 'none';
    if (x.safety_stock != null) { safety = x.safety_stock; safetyBasis = 'set'; }
    else if (z > 0 && sigma > 0) { safety = Math.ceil(z * sigma * fLT * Math.sqrt(Math.max(lt, 1))); safetyBasis = 'calculated'; }

    const mode = x.reorder_mode || cfg.mode;
    let rop, ropBasis;
    if (mode === 'manual') { rop = x.reorder_level ?? 0; ropBasis = 'manual'; }
    else if (baseDaily === 0 && reqLT === 0 && safety === 0) { rop = x.reorder_level ?? 0; ropBasis = 'level'; }   // no demand data: fall back to the item's fixed reorder point
    else { rop = Math.ceil(demandLT + safety - 1e-9); ropBasis = 'calculated'; }
    if (x.min_stock != null && rop < x.min_stock) { rop = x.min_stock; ropBasis = ropBasis === 'calculated' ? 'minimum' : ropBasis; }

    const incoming = x.on_order + x.in_transit;
    const position = x.available + incoming;
    const dailyCycle = baseDaily * factorAvg(f, lt, cfg.cover_days);
    let target = x.max_stock != null ? x.max_stock : Math.ceil(rop + dailyCycle * cfg.cover_days + reqCycle - 1e-9);
    if (x.max_stock == null && target <= rop) target = Math.max(rop * 2, rop + 1);
    if (target < rop) target = rop;

    const needOrder = position <= rop && !(rop === 0 && baseDaily === 0 && reqLT === 0 && x.available > 0);
    const daysCover = dailyLT > 0 ? Math.floor(x.available / dailyLT) : null;
    const stockoutDate = daysCover != null ? new Date(Date.now() + daysCover * 86400000).toISOString().slice(0, 10) : null;
    const orderBy = daysCover != null ? new Date(Date.now() + Math.max(0, daysCover - lt) * 86400000).toISOString().slice(0, 10) : null;

    let status;
    if (x.available <= 0) status = 'out_of_stock';
    else if (needOrder && ((daysCover != null && daysCover < lt) || (safety > 0 && x.available < safety))) status = 'critical';
    else if (needOrder) status = 'low';
    else if (x.available <= rop) status = 'on_order';
    else if ((x.max_stock != null && x.available + incoming > x.max_stock) || (dailyLT > 0 && daysCover > cfg.excess_days)) status = 'excess';
    else status = 'ok';

    // order quantity: top up to target, then respect supplier / pack / storage rules
    let qty = 0, raw = 0; const constraints = [];
    if (needOrder) {
      raw = Math.max(0, target - position);
      qty = raw;
      if (qty > 0 && x.moq && qty < x.moq) { qty = x.moq; constraints.push('minimum order qty'); }
      const mult = x.order_multiple || x.reorder_qty || (x.pack_size && Number.isInteger(Number(x.pack_size)) && Number(x.pack_size) > 1 ? Number(x.pack_size) : 1);
      if (qty > 0 && mult > 1 && qty % mult) { qty = Math.ceil(qty / mult) * mult; constraints.push(`rounded up to multiples of ${mult}`); }
      if (qty > 0 && x.capacity_units != null) {
        const room = Math.max(0, x.capacity_units - x.stock - incoming);
        if (qty > room) {
          const fit = mult > 1 ? Math.floor(room / mult) * mult : room;
          if (fit < (x.moq || 1)) { constraints.push(`no storage room (capacity ${x.capacity_units})`); qty = 0; }
          else { qty = fit; constraints.push(`limited by storage capacity ${x.capacity_units}`); }
        }
      }
    }
    let excessQty = 0;
    if (status === 'excess') excessQty = x.max_stock != null && x.available + incoming > x.max_stock ? x.available + incoming - x.max_stock : Math.max(0, x.available - Math.ceil(dailyLT * cfg.excess_days));

    const cost = Number(x.cost_price);
    return {
      tire_id: x.id, item_name: x.item_name, sku: x.sku, uom: x.uom, category: x.category, supplier_id: x.supplier_id, supplier_name: x.supplier_name,
      stock: x.stock, available: x.available, reserved: x.reserved, quarantined: x.quarantined, expired: x.expired, on_order: x.on_order, in_transit: x.in_transit, incoming, position,
      sold, used: usage, daily_demand: round2(dailyLT), seasonal_factor: round2(fLT), planned_requirements: reqLT + reqCycle, demand_observed_days: observedDays,
      lead_time_days: lt, lead_time_source: ltSource, safety_stock: safety, safety_basis: safetyBasis,
      reorder_point: rop, rop_basis: ropBasis, reorder_mode: mode, min_stock: x.min_stock, max_stock: x.max_stock, target,
      days_of_cover: daysCover, stockout_date: stockoutDate, order_by: orderBy, status, need_order: needOrder,
      raw_qty: raw, suggested_qty: qty, constraints, cost_price: cost, suggested_cost: round2(qty * cost), excess_qty: excessQty, excess_value: round2(excessQty * cost),
      capacity_units: x.capacity_units, moq: x.moq, order_multiple: x.order_multiple || x.reorder_qty || null,
      min_order_value: x.min_order_value != null ? Number(x.min_order_value) : null,
      funded_qty: qty, funded_cost: round2(qty * cost), funding: qty > 0 ? 'full' : 'none',
    };
  });

  // working capital: fund the most urgent first; shrink to whole order multiples, or defer
  if (budget != null) {
    let left = budget;
    const ranked = out.filter(i => i.suggested_qty > 0).sort((a, b) => (PRIORITY[a.status] ?? 3) - (PRIORITY[b.status] ?? 3) || (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9));
    for (const i of ranked) {
      if (i.cost_price <= 0 || i.suggested_cost <= left) { left -= i.suggested_cost; continue; }
      const mult = i.order_multiple || 1;
      const units = Math.floor(left / i.cost_price);
      const fit = mult > 1 ? Math.floor(units / mult) * mult : units;
      if (fit > 0 && fit >= (i.moq || 1)) { i.funded_qty = fit; i.funded_cost = round2(fit * i.cost_price); i.funding = 'partial'; left -= i.funded_cost; }
      else { i.funded_qty = 0; i.funded_cost = 0; i.funding = 'deferred'; }
    }
  }

  const groups = {};
  for (const i of out.filter(i => i.suggested_qty > 0)) {
    const g = groups[i.supplier_id ?? 'none'] ??= { supplier_id: i.supplier_id, supplier_name: i.supplier_name || 'No supplier assigned', min_order_value: i.min_order_value, lead_time_days: 0, lines: 0, total_qty: 0, total_cost: 0, funded_cost: 0 };
    g.lines++; g.total_qty += i.suggested_qty; g.total_cost += i.suggested_cost; g.funded_cost += i.funded_cost; g.lead_time_days = Math.max(g.lead_time_days, i.lead_time_days);
  }
  const groupList = Object.values(groups).map(g => ({ ...g, total_cost: round2(g.total_cost), funded_cost: round2(g.funded_cost),
    below_min_order_value: g.min_order_value != null && g.funded_cost > 0 && g.funded_cost < g.min_order_value, min_order_shortfall: g.min_order_value != null ? round2(Math.max(0, g.min_order_value - g.funded_cost)) : 0 }))
    .sort((a, b) => b.total_cost - a.total_cost);
  const count = s => out.filter(i => i.status === s).length;
  const summary = {
    out_of_stock: count('out_of_stock'), critical: count('critical'), low: count('low'), on_order: count('on_order'), ok: count('ok'), excess: count('excess'), items: out.length,
    to_order: out.filter(i => i.suggested_qty > 0).length, suggested_cost: round2(out.reduce((a, i) => a + i.suggested_cost, 0)), funded_cost: round2(out.reduce((a, i) => a + i.funded_cost, 0)),
    deferred: out.filter(i => i.funding === 'deferred').length, excess_value: round2(out.reduce((a, i) => a + i.excess_value, 0)), budget,
  };
  return { settings: { ...cfg, budget }, summary, groups: groupList, items: out };
}

module.exports = { computePlan, loadSettings, parseSeasonality, readSeasonality, factorAvg, zOf, KEYS, DEFAULTS, round2 };
