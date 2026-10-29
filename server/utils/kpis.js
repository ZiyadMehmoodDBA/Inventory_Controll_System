// Business performance scorecard: the eleven operating measures of the inventory function, each computed from the ledger and documents
// (never typed in), compared with a target the organisation configures. Read-only except for the targets and the carrying-cost rate.
//
// Every measure states its basis, so a number can be defended: what was counted, over which period, and what is NOT measured.
// Targets are never invented: a measure has no target until one is set (the screen offers a suggestion derived from the organisation's own
// actual figure). Money measures are flagged so the route can withhold them from users without the cost permission.
const { getPool, sql } = require('../db');
const Ls = require('./losses');
const { computeValuation, METHOD_INFO } = require('./valuation');

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const round1 = n => Math.round((Number(n) || 0) * 10) / 10;
const pct = (num, den) => (den > 0 ? round1((num / den) * 100) : null);
const BOUNDS = (col, from = '@from', to = '@to') => `${col} >= CAST(${from} AS DATE) AND ${col} < DATEADD(DAY, 1, CAST(${to} AS DATE))`;
const TARGETS_KEY = 'kpi_targets';
const CARRYING_KEY = 'kpi_carrying_cost_rate';
const TOLERANCE = 0.10;                       // within 10 % of target on the wrong side = "watch"

// id, group, label, unit, which direction is better
const MEASURES = [
  { id: 'inventory_accuracy',     group: 'Control',     label: 'Inventory accuracy',             unit: 'pct',   better: 'higher' },
  { id: 'stockout_rate',          group: 'Service',     label: 'Stockout rate',                  unit: 'pct',   better: 'lower' },
  { id: 'inventory_turnover',     group: 'Efficiency',  label: 'Inventory turnover (per year)',  unit: 'ratio', better: 'higher' },
  { id: 'days_on_hand',           group: 'Efficiency',  label: 'Days of inventory on hand',      unit: 'days',  better: 'lower' },
  { id: 'excess_obsolete_value',  group: 'Health',      label: 'Excess and obsolete stock value', unit: 'money', better: 'lower', money: true },
  { id: 'expiry_damage_losses',   group: 'Health',      label: 'Expiry and damage losses',       unit: 'money', better: 'lower', money: true },
  { id: 'replenishment_lead_time', group: 'Supply',     label: 'Replenishment lead time',        unit: 'days',  better: 'lower' },
  { id: 'supplier_fulfillment',   group: 'Supply',      label: 'Supplier on-time delivery',      unit: 'pct',   better: 'higher' },
  { id: 'order_fulfillment',      group: 'Service',     label: 'Order fulfillment accuracy',     unit: 'pct',   better: 'higher' },
  { id: 'carrying_cost',          group: 'Capital',     label: 'Inventory carrying cost (per year)', unit: 'money', better: 'lower', money: true },
  { id: 'working_capital',        group: 'Capital',     label: 'Working capital tied up in inventory', unit: 'money', better: 'lower', money: true },
];
const IDS = MEASURES.map(m => m.id);

async function readSetting(pool, orgId, key) {
  return (await pool.request().input('o', sql.Int, orgId).input('k', sql.NVarChar(100), key).query('SELECT value FROM settings WHERE organization_id = @o AND [key] = @k')).recordset[0]?.value ?? null;
}
async function writeSetting(pool, orgId, key, value) {
  await pool.request().input('o', sql.Int, orgId).input('k', sql.NVarChar(100), key).input('v', sql.NVarChar(1000), value)
    .query(`IF EXISTS (SELECT 1 FROM settings WHERE organization_id = @o AND [key] = @k) UPDATE settings SET value = @v, updated_at = GETDATE() WHERE organization_id = @o AND [key] = @k
            ELSE INSERT INTO settings (organization_id, [key], value) VALUES (@o, @k, @v)`);
}

/** Configured targets { id: number } and the annual carrying-cost rate (percent, null = not configured). */
async function loadConfig(pool, orgId) {
  let targets = {};
  try { const raw = JSON.parse(await readSetting(pool, orgId, TARGETS_KEY) || '{}'); for (const id of IDS) if (Number.isFinite(raw[id])) targets[id] = raw[id]; } catch { targets = {}; }
  const rate = Number(await readSetting(pool, orgId, CARRYING_KEY));
  return { targets, carrying_cost_rate: Number.isFinite(rate) && rate > 0 ? rate : null };
}

/** Validate and store targets. `null` for an id clears it. Returns the stored config. */
async function saveConfig(pool, orgId, body) {
  const bad = (m) => Object.assign(new Error(m), { status: 400, code: 'VALIDATION_FAILED' });
  const cur = await loadConfig(pool, orgId);
  const targets = { ...cur.targets };
  for (const [id, val] of Object.entries(body.targets || {})) {
    const m = MEASURES.find(x => x.id === id);
    if (!m) throw bad(`Unknown measure: ${id}`);
    if (val === null || val === '') { delete targets[id]; continue; }
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) throw bad(`${m.label}: the target must be zero or more`);
    if (m.unit === 'pct' && n > 100) throw bad(`${m.label}: a percentage target cannot exceed 100`);
    if (n > 1e12) throw bad(`${m.label}: the target is too large`);
    targets[id] = n;
  }
  await writeSetting(pool, orgId, TARGETS_KEY, JSON.stringify(targets));
  let rate = cur.carrying_cost_rate;
  if (body.carrying_cost_rate !== undefined) {
    if (body.carrying_cost_rate === null || body.carrying_cost_rate === '') rate = null;
    else {
      const n = Number(body.carrying_cost_rate);
      if (!Number.isFinite(n) || n <= 0 || n > 100) throw bad('The carrying-cost rate must be a percentage above 0 and at most 100');
      rate = n;
    }
    await writeSetting(pool, orgId, CARRYING_KEY, rate === null ? '' : String(rate));
  }
  return { targets, carrying_cost_rate: rate };
}

function statusOf(m, value, target) {
  if (value === null || value === undefined) return 'no_data';
  if (target === undefined || target === null) return 'no_target';
  if (m.better === 'higher') return value >= target ? 'on_target' : value >= target * (1 - TOLERANCE) ? 'watch' : 'off_target';
  return value <= target ? 'on_target' : value <= target * (1 + TOLERANCE) ? 'watch' : 'off_target';
}
// Suggested target: the organisation's own actual figure improved by 10 % (a starting point to adjust, not a benchmark).
function suggest(m, value) {
  if (value === null || value === undefined) return null;
  const s = m.better === 'higher' ? value * 1.1 : value * 0.9;
  return round2(m.unit === 'pct' ? Math.min(100, s) : s);
}

/** period: { start, end } inclusive 'YYYY-MM-DD'. scope: { orgId, branchId|null } */
async function compute(scope, period) {
  const pool = await getPool();
  const { orgId } = scope, branchId = scope.branchId ?? null;
  const bind = rq => rq.input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('from', sql.VarChar(10), period.start).input('to', sql.VarChar(10), period.end);
  const days = Math.max(1, Math.round((new Date(`${period.end}T12:00:00`) - new Date(`${period.start}T12:00:00`)) / 86400000) + 1);
  const cfg = await loadConfig(pool, orgId);
  const st = await Ls.loadSettings(pool, orgId);
  const methodRow = await readSetting(pool, orgId, 'valuation_method');
  const method = METHOD_INFO[methodRow] ? methodRow : 'standard';

  const [valuation, loss, classes, cogs, net, count, demand, lead, sup, orders, returns, unpaid] = await Promise.all([
    computeValuation(orgId, branchId, method, pool),
    Ls.summary(pool, { orgId, branchId }, period),
    Ls.classifyStock(pool, { orgId, branchId }, st),
    Ls.costOfSales(pool, { orgId, branchId, start: period.start, end: period.end }),
    bind(pool.request()).query(`SELECT ISNULL(SUM(m.qty_change * ISNULL(m.unit_cost, 0)), 0) AS v FROM stock_movements m JOIN tires t ON t.id = m.tire_id
      WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND m.created_at >= CAST(@from AS DATE)`),
    bind(pool.request()).query(`
      SELECT COUNT(CASE WHEN i.counted_qty IS NOT NULL THEN 1 END) AS lines, COUNT(CASE WHEN i.counted_qty IS NOT NULL AND i.variance = 0 THEN 1 END) AS exact,
             ISNULL(SUM(CASE WHEN i.counted_qty IS NOT NULL THEN ABS(ISNULL(i.variance, 0)) * t.cost_price END), 0) AS variance_value,
             ISNULL(SUM(CASE WHEN i.counted_qty IS NOT NULL THEN i.system_qty * t.cost_price END), 0) AS counted_value, COUNT(DISTINCT c.id) AS counts
      FROM stock_counts c JOIN stock_count_items i ON i.count_id = c.id JOIN tires t ON t.id = i.tire_id
      WHERE c.organization_id = @o AND (@b IS NULL OR c.branch_id = @b) AND c.status = 'completed' AND ${BOUNDS('c.completed_at')}`),
    bind(pool.request()).query(`
      SELECT COUNT(*) AS sold_items, COUNT(CASE WHEN t.stock <= 0 THEN 1 END) AS out_items
      FROM tires t WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND t.status = 'active'
        AND EXISTS (SELECT 1 FROM stock_movements m WHERE m.tire_id = t.id AND m.reason = 'sale' AND ${BOUNDS('m.created_at')})`),
    bind(pool.request()).query(`
      SELECT COUNT(*) AS pos, AVG(CAST(DATEDIFF(DAY, p.date, CAST(p.received_at AS DATE)) AS FLOAT)) AS avg_days,
             AVG(CAST(s.lead_time_days AS FLOAT)) AS promised_days
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.organization_id = @o AND (@b IS NULL OR p.branch_id = @b) AND p.status = 'received' AND p.received_at IS NOT NULL AND ${BOUNDS('p.received_at')}`),
    bind(pool.request()).query(`
      SELECT ISNULL(s.name, 'No supplier') AS supplier, COUNT(*) AS pos,
             COUNT(CASE WHEN CAST(p.received_at AS DATE) <= p.expected_date THEN 1 END) AS on_time,
             AVG(CAST(CASE WHEN CAST(p.received_at AS DATE) > p.expected_date THEN DATEDIFF(DAY, p.expected_date, CAST(p.received_at AS DATE)) ELSE 0 END AS FLOAT)) AS avg_days_late
      FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.organization_id = @o AND (@b IS NULL OR p.branch_id = @b) AND p.status = 'received' AND p.received_at IS NOT NULL AND p.expected_date IS NOT NULL AND ${BOUNDS('p.received_at')}
      GROUP BY s.name ORDER BY COUNT(CASE WHEN CAST(p.received_at AS DATE) <= p.expected_date THEN 1 END) * 1.0 / COUNT(*), COUNT(*) DESC`),
    bind(pool.request()).query(`SELECT COUNT(CASE WHEN status <> 'voided' THEN 1 END) AS orders, COUNT(CASE WHEN status = 'voided' THEN 1 END) AS voided,
      ISNULL(SUM(CASE WHEN status <> 'voided' THEN total END), 0) AS revenue FROM sales WHERE organization_id = @o AND (@b IS NULL OR branch_id = @b) AND ${BOUNDS('date')}`),
    bind(pool.request()).query(`SELECT COUNT(*) AS n FROM stock_movements WHERE organization_id = @o AND (@b IS NULL OR branch_id = @b) AND reason = 'customer_return' AND ${BOUNDS('created_at')}`),
    bind(pool.request()).query(`SELECT ISNULL(SUM(total - ISNULL(amount_paid, 0)), 0) AS v FROM purchases WHERE organization_id = @o AND (@b IS NULL OR branch_id = @b) AND status = 'received' AND total > ISNULL(amount_paid, 0)`),
  ]);

  const value = valuation.totals.value;
  const startValue = round2(value - Number(net.recordset[0].v));
  const avgValue = startValue > 0 ? (value + startValue) / 2 : value;
  const C = count.recordset[0], D = demand.recordset[0], L = lead.recordset[0], O = orders.recordset[0];
  const onTime = sup.recordset.reduce((a, r) => a + r.on_time, 0), onTimePos = sup.recordset.reduce((a, r) => a + r.pos, 0);
  const eo = round2(classes.summary.slow.value + classes.summary.non_moving.value + classes.summary.obsolete.value);
  const damageCauses = ['expiry', 'breakage', 'deterioration', 'contamination'];
  const dmg = loss.physical.by_cause.filter(g => damageCauses.includes(g.key));
  const dmgValue = round2(dmg.reduce((a, g) => a + g.value, 0));
  const turnover = cogs > 0 && avgValue > 0 ? round2((cogs / avgValue) * (365 / days)) : null;
  const doh = cogs > 0 && value > 0 ? Math.round(value / (cogs / days)) : null;
  const failed = O.voided + Number(returns.recordset[0].n);
  const orderBase = O.orders + O.voided;
  const annualRevenue = round2(Number(O.revenue) * (365 / days));
  const payables = round2(unpaid.recordset[0].v);

  const raw = {
    inventory_accuracy: { value: pct(C.exact, C.lines),
      basis: `Share of counted lines whose count matched the ledger exactly, in stock counts completed ${period.start} to ${period.end}.`,
      detail: { counts: C.counts, lines_counted: C.lines, exact_lines: C.exact, variance_value: round2(C.variance_value), value_accuracy_pct: C.counted_value > 0 ? round1((1 - C.variance_value / C.counted_value) * 100) : null } },
    stockout_rate: { value: pct(D.out_items, D.sold_items),
      basis: 'Active items that sold in the period and have no stock now, as a share of all items that sold in the period.',
      detail: { items_sold: D.sold_items, items_out_of_stock: D.out_items } },
    inventory_turnover: { value: turnover,
      basis: 'Cost of goods sold over the period divided by average inventory value (opening value rebuilt from the ledger, closing value now), annualised.',
      detail: { cost_of_sales: cogs, average_inventory_value: round2(avgValue), opening_value: startValue, closing_value: value, days } },
    days_on_hand: { value: doh,
      basis: 'Inventory value now divided by average daily cost of goods sold in the period.',
      detail: { inventory_value: value, daily_cost_of_sales: days > 0 ? round2(cogs / days) : 0 } },
    excess_obsolete_value: { value: eo,
      basis: 'At cost: slow-moving, non-moving and obsolete stock, per the organisation\'s obsolescence rules.',
      detail: { slow: classes.summary.slow, non_moving: classes.summary.non_moving, obsolete: classes.summary.obsolete, share_of_inventory_pct: pct(eo, value), suggested_provision: classes.suggested_provision } },
    expiry_damage_losses: { value: dmgValue,
      basis: 'At cost: approved write-offs and disposals for expiry, breakage, deterioration and contamination in the period.',
      detail: { by_cause: dmg, loss_rate_of_cost_of_sales_pct: pct(dmgValue, cogs), all_physical_loss_value: loss.physical.value } },
    replenishment_lead_time: { value: L.pos ? round1(L.avg_days) : null,
      basis: 'Average days from purchase order date to goods received, for purchase orders received in the period.',
      detail: { orders_received: L.pos, supplier_promised_days: L.promised_days == null ? null : round1(L.promised_days) } },
    supplier_fulfillment: { value: pct(onTime, onTimePos),
      basis: 'Share of purchase orders received on or before their expected date. In-full delivery is not measurable: receipts are recorded for the whole order, not per line.',
      detail: { orders_with_expected_date: onTimePos, on_time: onTime, suppliers: sup.recordset.slice(0, 8).map(r => ({ supplier: r.supplier, orders: r.pos, on_time: r.on_time, on_time_pct: pct(r.on_time, r.pos), avg_days_late: round1(r.avg_days_late) })) } },
    order_fulfillment: { value: orderBase > 0 ? round1(Math.max(0, 1 - failed / orderBase) * 100) : null,
      basis: 'Share of sales orders that were not voided and did not come back as a customer return, in the period.',
      detail: { orders: orderBase, voided: O.voided, customer_returns: Number(returns.recordset[0].n) } },
    carrying_cost: cfg.carrying_cost_rate == null
      ? { value: null, not_configured: true, basis: 'Set the annual carrying-cost rate (storage, insurance, handling, shrinkage and the cost of capital as a percentage of inventory value). It is an assumption of the business and is not guessed here.', detail: { average_inventory_value: round2(avgValue) } }
      : { value: round2(avgValue * cfg.carrying_cost_rate / 100), basis: `Average inventory value x the configured annual carrying-cost rate (${cfg.carrying_cost_rate}%).`,
          detail: { rate_pct: cfg.carrying_cost_rate, average_inventory_value: round2(avgValue), cost_for_period: round2(avgValue * cfg.carrying_cost_rate / 100 * days / 365) } },
    working_capital: { value: value,
      basis: 'Inventory value at cost under the configured valuation method. Detail shows what is still owed to suppliers and the size of inventory against annualised sales.',
      detail: { valuation_method: method, unpaid_supplier_balance: payables, net_of_supplier_credit: round2(value - payables), annualised_sales: annualRevenue, inventory_to_sales_pct: pct(value, annualRevenue) } },
  };

  const measures = MEASURES.map(m => {
    const r = raw[m.id];
    const target = cfg.targets[m.id] ?? null;
    return { id: m.id, group: m.group, label: m.label, unit: m.unit, better: m.better, money: !!m.money, value: r.value, target, suggested_target: target === null ? suggest(m, r.value) : null,
      status: r.not_configured ? 'not_configured' : statusOf(m, r.value, target), basis: r.basis, detail: r.detail };
  });
  return { period: { from: period.start, to: period.end, days }, measures, carrying_cost_rate: cfg.carrying_cost_rate,
    summary: { measured: measures.filter(m => m.value !== null).length, with_target: measures.filter(m => m.target !== null).length,
               on_target: measures.filter(m => m.status === 'on_target').length, watch: measures.filter(m => m.status === 'watch').length, off_target: measures.filter(m => m.status === 'off_target').length } };
}

/** Withhold money figures (and the money inside detail) from users who may not see cost. */
function redact(result) {
  const strip = d => JSON.parse(JSON.stringify(d ?? {}), (k, v) => (/value|cost|provision|payable|unpaid|sales|balance|credit|capital/i.test(k) && typeof v === 'number' ? null : v));
  return { ...result, measures: result.measures.map(m => (m.money ? { ...m, value: null, target: null, suggested_target: null, status: 'hidden', detail: {} }
    : { ...m, detail: m.id === 'inventory_turnover' || m.id === 'days_on_hand' ? {} : strip(m.detail) })) };
}

module.exports = { MEASURES, IDS, compute, redact, loadConfig, saveConfig, statusOf };
