// Stock rotation (which units leave first) and inventory valuation records (adjustments, snapshots), kept apart on purpose.
// Mounted on /api/inventory before routes/inventory.js; unmatched paths fall through.
const express = require('express');
const router  = express.Router();
const { getPool, sql }  = require('../db');
const { requireRole }   = require('../middleware/auth');
const P = require('../utils/permissions');
const { writeAudit }    = require('../utils/audit');
const { getContext }    = require('../context');
const IM = require('../utils/itemMaster');
const { StockError, ROTATION_POLICIES, rotationOrderBy, resolveRotation, defaultLocationId, valuationMethod, ACTIVE_RESERVATION } = require('../utils/stock');
const { METHOD_INFO, LAYER_METHODS, computeValuation, round2 } = require('../utils/valuation');

const scope = req => ({ orgId: req.user.orgId, branchId: req.user.branchId ?? null, userId: req.user.userId, role: req.user.role, perms: req.user.perms, approvalLimit: req.user.approvalLimit ?? null });
const canManage = P.requirePermission('inventory.manage_items');
const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const dayOf = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
const ageDays = d => (d ? Math.max(0, Math.floor((Date.now() - new Date(dayOf(d) + 'T00:00:00Z').getTime()) / 86400000)) : null);

function fail(res, err) {
  if (err instanceof StockError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  console.error('[rotation]', err.message);
  return res.status(500).json({ error: 'Operation failed' });
}
async function inTransaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try { const out = await fn(tx); await tx.commit(); return out; }
  catch (e) { try { await tx.rollback(); } catch { /* already rolled back */ } throw e; }
}

// ── Rotation policies ───────────────────────────────────────────────────────
const policyList = Object.entries(ROTATION_POLICIES).map(([value, p]) => ({ value, ...p }));

router.get('/rotation', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const company = (await pool.request().input('o', sql.Int, orgId).query("SELECT value FROM settings WHERE organization_id = @o AND [key] = 'rotation_policy'")).recordset[0]?.value || null;
    const cats = await pool.request().input('o', sql.Int, orgId)
      .query(`SELECT c.id, c.name, c.parent_id, c.rotation_policy, (SELECT COUNT(*) FROM tires t WHERE t.category_id = c.id) AS item_count FROM item_categories c WHERE c.organization_id = @o ORDER BY c.name`);
    const items = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT t.id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS name, t.sku, t.tracking, t.track_expiry, t.rotation_policy
              FROM tires t WHERE t.organization_id = @o AND t.branch_id = @b AND t.rotation_policy IS NOT NULL ORDER BY t.model`);
    res.json({ policies: policyList, company: company && ROTATION_POLICIES[company] ? company : null, categories: cats.recordset, items: items.recordset,
               note: 'Rotation only decides which physical units are picked first. It never changes how stock is valued.' });
  } catch (err) { fail(res, err); }
});

// Set (or clear, with policy null) the rotation policy of the company, a category or one item.
router.put('/rotation', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const b = req.body || {};
    const policy = b.policy === null || b.policy === '' || b.policy === undefined ? null : String(b.policy).toLowerCase();
    if (policy && !ROTATION_POLICIES[policy]) throw new StockError('INVALID_ROTATION', 'Rotation policy must be one of: ' + Object.keys(ROTATION_POLICIES).join(', '));
    const target = String(b.scope || '');
    const pool = await getPool();
    if (target === 'company') {
      if (req.user.role !== 'org_admin') throw new StockError('FORBIDDEN', 'Only an administrator can set the company-wide rotation policy', 403);
      if (policy) {
        await pool.request().input('o', sql.Int, orgId).input('v', sql.NVarChar(50), policy)
          .query(`IF EXISTS (SELECT 1 FROM settings WHERE organization_id = @o AND [key] = 'rotation_policy') UPDATE settings SET value = @v WHERE organization_id = @o AND [key] = 'rotation_policy'
                  ELSE INSERT INTO settings (organization_id, [key], value) VALUES (@o, 'rotation_policy', @v)`);
      } else {
        await pool.request().input('o', sql.Int, orgId).query("DELETE FROM settings WHERE organization_id = @o AND [key] = 'rotation_policy'");
      }
    } else if (target === 'category') {
      const r = await pool.request().input('id', sql.Int, int(b.id)).input('o', sql.Int, orgId).input('p', sql.NVarChar(15), policy)
        .query('UPDATE item_categories SET rotation_policy = @p WHERE id = @id AND organization_id = @o');
      if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Category not found', 404);
    } else if (target === 'item') {
      await inTransaction(async tx => {
        const cur = (await new sql.Request(tx).input('id', sql.Int, int(b.id)).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
          .query('SELECT id, rotation_policy FROM tires WITH (UPDLOCK) WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
        if (!cur) throw new StockError('NOT_FOUND', 'Item not found', 404);
        await IM.applyExtra(tx, cur.id, { rotation_policy: policy });
        await IM.logChanges(tx, { orgId, tireId: cur.id, userId: req.user.userId, before: { rotation_policy: cur.rotation_policy }, after: { rotation_policy: policy } });
      });
    } else throw new StockError('INVALID_SCOPE', 'scope must be company, category or item');
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'UPDATE', entity: 'rotation_policy', entityId: int(b.id) || 0, before: null, after: { scope: target, policy } });
    res.json({ scope: target, id: b.id ?? null, policy });
  } catch (err) { fail(res, err); }
});

// ── Pick recommendation ─────────────────────────────────────────────────────
// Which stock to pick for `qty` units of an item, by the item's rotation policy. Only eligible stock is offered:
// expired batches and restricted (quarantine / damaged) locations are excluded, and reserved units are held back.
router.get('/pick-suggestion', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const tireId = int(req.query.tire_id);
    const need = Math.max(1, parseInt(req.query.qty, 10) || 1);
    const pool = await getPool();
    const it = (await pool.request().input('t', sql.Int, tireId).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query("SELECT id, branch_id, tracking, track_expiry, LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS name, uom FROM tires WHERE id = @t AND organization_id = @o AND branch_id = @b")).recordset[0];
    if (!it) throw new StockError('NOT_FOUND', 'Item not found', 404);
    const locId = req.query.location_id ? int(req.query.location_id) : await inTransaction(tx => defaultLocationId(tx, orgId, branchId));
    const loc = (await pool.request().input('l', sql.Int, locId).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query('SELECT id, name, kind FROM stock_locations WHERE id = @l AND organization_id = @o AND branch_id = @b')).recordset[0];
    if (!loc) throw new StockError('INVALID_LOCATION', 'Stock location not found', 404);
    const rot = await resolveRotation(pool, orgId, tireId);
    const reserved = (await pool.request().input('t', sql.Int, tireId).input('l', sql.Int, locId)
      .query(`SELECT ISNULL(SUM(qty), 0) AS n FROM stock_reservations WHERE tire_id = @t AND location_id = @l AND ${ACTIVE_RESERVATION}`)).recordset[0].n;
    const elsewhere = (await pool.request().input('t', sql.Int, tireId).input('l', sql.Int, locId)
      .query(`SELECT l.name, l.kind, x.qty FROM item_location_stock x JOIN stock_locations l ON l.id = x.location_id WHERE x.tire_id = @t AND x.location_id <> @l AND x.qty > 0 ORDER BY l.name`)).recordset;

    const plan = [], excluded = [];
    let eligibleTotal = 0;
    if (it.tracking === 'none') {
      const q = (await pool.request().input('t', sql.Int, tireId).input('l', sql.Int, locId).query('SELECT ISNULL(qty, 0) AS qty FROM item_location_stock WHERE tire_id = @t AND location_id = @l')).recordset[0]?.qty ?? 0;
      if (loc.kind !== 'normal') { if (q > 0) excluded.push({ reason: 'restricted_location', label: `${loc.name} is a ${loc.kind} location`, qty: q }); }
      else eligibleTotal = Math.max(0, q);
      if (eligibleTotal > 0) plan.push({ batch_id: null, batch_no: null, expiry_date: null, received_date: null, age_days: null, qty_here: eligibleTotal });
    } else {
      const rows = (await pool.request().input('t', sql.Int, tireId).input('l', sql.Int, locId)
        .query(`SELECT b.id AS batch_id, b.batch_no, b.expiry_date, b.quality_status, ISNULL(b.received_date, CAST(b.created_at AS DATE)) AS received_date, x.qty,
                       DATEDIFF(DAY, CAST(GETDATE() AS DATE), b.expiry_date) AS days_to_expiry
                FROM batch_location_stock x JOIN stock_batches b ON b.id = x.batch_id
                WHERE b.tire_id = @t AND x.location_id = @l AND x.qty > 0 ${rotationOrderBy(rot.policy === 'manual' ? 'fefo' : rot.policy)}`)).recordset;
      for (const r of rows) {
        const base = { batch_id: r.batch_id, batch_no: r.batch_no, expiry_date: dayOf(r.expiry_date), received_date: dayOf(r.received_date), age_days: ageDays(r.received_date), days_to_expiry: r.days_to_expiry, qty_here: r.qty };
        if (loc.kind !== 'normal') excluded.push({ ...base, reason: 'restricted_location', label: `${loc.name} is a ${loc.kind} location`, qty: r.qty });
        else if (r.days_to_expiry != null && r.days_to_expiry < 0) excluded.push({ ...base, reason: 'expired', label: `Expired ${-r.days_to_expiry} day(s) ago`, qty: r.qty });
        else if (r.quality_status && r.quality_status !== 'released') excluded.push({ ...base, reason: 'quality_hold', label: r.quality_status === 'on_hold' ? 'On quality hold' : r.quality_status === 'recalled' ? 'Recalled' : 'Damaged', qty: r.qty });
        else { plan.push(base); eligibleTotal += r.qty; }
      }
    }
    const free = Math.max(0, eligibleTotal - reserved);
    let left = Math.min(need, free);
    for (const p of plan) { const take = Math.min(left, p.qty_here); p.pick = take; left -= take; }
    const picks = plan.filter(p => p.pick > 0);
    res.json({
      item: { id: it.id, name: it.name, tracking: it.tracking }, location: { id: loc.id, name: loc.name, kind: loc.kind },
      policy: rot.policy, policy_label: ROTATION_POLICIES[rot.policy].label, source: rot.source,
      requested: need, eligible: eligibleTotal, reserved, free, picks, plan, excluded,
      shortfall: Math.max(0, need - free), elsewhere,
      note: rot.policy === 'manual' ? 'This item is set to manual picking, so sales will ask for the batch. The order below is a suggestion (earliest expiry first).'
        : reserved > 0 ? `${reserved} unit(s) are reserved; the pick assumes you take from the remaining free stock.` : null,
    });
  } catch (err) { fail(res, err); }
});

// ── Stock age ───────────────────────────────────────────────────────────────
const AGE_BUCKETS = [['0-30', 30], ['31-60', 60], ['61-90', 90], ['91-180', 180], ['181-365', 365], ['365+', Infinity]];
const bucketOf = days => AGE_BUCKETS.find(([, max]) => days <= max)[0];

// How long the stock on hand has been sitting. Batch-tracked items use batch receipt dates; other items assume the oldest
// units left first (physical FIFO), so the units still on the shelf are the newest receipts. Valued at current item / batch cost.
/** Stock age by receipt date (batch receipt dates for tracked items, oldest-first assumption otherwise). branchId null = every branch of the organisation. */
async function computeStockAge(orgId, branchId) {
    const pool = await getPool();
    const lines = {};   // tire_id -> { name, cost, rows: [{ days, qty, value }] }
    const batches = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null)
      .query(`SELECT t.id AS tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS name, t.sku, ISNULL(c.name, 'Uncategorised') AS category,
                     ISNULL(b.received_date, CAST(b.created_at AS DATE)) AS received_date, SUM(x.qty) AS qty, ISNULL(b.unit_cost, t.cost_price) AS cost
              FROM tires t JOIN stock_batches b ON b.tire_id = t.id JOIN batch_location_stock x ON x.batch_id = b.id LEFT JOIN item_categories c ON c.id = t.category_id
              WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND t.tracking <> 'none' AND x.qty > 0
              GROUP BY t.id, t.brand, t.model, t.size, t.sku, c.name, b.received_date, b.created_at, b.unit_cost, t.cost_price`);
    for (const r of batches.recordset) {
      const l = lines[r.tire_id] ??= { tire_id: r.tire_id, name: r.name, sku: r.sku, category: r.category, rows: [] };
      l.rows.push({ days: ageDays(r.received_date), qty: r.qty, value: r.qty * Number(r.cost) });
    }
    const plain = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null)
      .query(`SELECT t.id AS tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS name, t.sku, ISNULL(c.name, 'Uncategorised') AS category, t.stock, t.cost_price, t.created_at
              FROM tires t LEFT JOIN item_categories c ON c.id = t.category_id WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND t.tracking = 'none' AND t.stock > 0`);
    if (plain.recordset.length) {
      const mv = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId ?? null)
        .query(`SELECT m.tire_id, CAST(m.created_at AS DATE) AS d, m.qty_change FROM stock_movements m JOIN tires t ON t.id = m.tire_id
                WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND t.tracking = 'none' AND t.stock > 0 AND m.qty_change > 0 AND m.reason <> 'transfer_in'
                ORDER BY m.tire_id, m.created_at DESC, m.id DESC`);
      const byItem = {};
      for (const m of mv.recordset) (byItem[m.tire_id] ??= []).push(m);
      for (const t of plain.recordset) {
        const l = lines[t.tire_id] = { tire_id: t.tire_id, name: t.name, sku: t.sku, category: t.category, rows: [] };
        let left = t.stock;
        const receipts = byItem[t.tire_id] || [];
        for (const m of receipts) { if (left <= 0) break; const take = Math.min(left, m.qty_change); l.rows.push({ days: ageDays(m.d), qty: take, value: take * Number(t.cost_price) }); left -= take; }
        if (left > 0) l.rows.push({ days: ageDays(receipts.length ? receipts[receipts.length - 1].d : t.created_at), qty: left, value: left * Number(t.cost_price) });
      }
    }
    const totals = Object.fromEntries(AGE_BUCKETS.map(([k]) => [k, { units: 0, value: 0 }]));
    const items = Object.values(lines).map(l => {
      const buckets = Object.fromEntries(AGE_BUCKETS.map(([k]) => [k, { units: 0, value: 0 }]));
      let units = 0, value = 0, weighted = 0, oldest = 0;
      for (const r of l.rows) {
        const k = bucketOf(r.days); buckets[k].units += r.qty; buckets[k].value += r.value; totals[k].units += r.qty; totals[k].value += r.value;
        units += r.qty; value += r.value; weighted += r.days * r.qty; oldest = Math.max(oldest, r.days);
      }
      for (const k of Object.keys(buckets)) buckets[k].value = round2(buckets[k].value);
      return { tire_id: l.tire_id, name: l.name, sku: l.sku, category: l.category, units, value: round2(value), oldest_days: oldest, average_days: units ? Math.round(weighted / units) : 0, buckets };
    }).sort((a, b) => b.oldest_days - a.oldest_days).slice(0, 500);
    for (const k of Object.keys(totals)) totals[k].value = round2(totals[k].value);
    return ({ buckets: AGE_BUCKETS.map(([k]) => k), totals, items, slow_units: totals['181-365'].units + totals['365+'].units, slow_value: round2(totals['181-365'].value + totals['365+'].value),
               basis: 'Batch-tracked items use batch receipt dates; other items assume oldest units are used first. Valued at current item or batch cost.' });
}

router.get('/stock-age', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    res.json(await computeStockAge(orgId, branchId));
  } catch (err) { fail(res, err); }
});

// ── Expiry exposure ─────────────────────────────────────────────────────────
const EXP_BUCKETS = [['expired', -1], ['0-30', 30], ['31-60', 60], ['61-90', 90], ['91-180', 180], ['181+', Infinity]];
const expBucket = d => EXP_BUCKETS.find(([, max]) => d <= max)[0];

// Batches by time to expiry with their value, and how much of each is not expected to sell before it expires
// (recent sales rate applied in expiry order). Expired stock is counted as a total loss.
router.get('/expiry-exposure', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const horizon = Math.min(Math.max(parseInt(req.query.days, 10) || 90, 1), 365);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT b.id AS batch_id, t.id AS tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, b.batch_no, b.expiry_date,
                     DATEDIFF(DAY, CAST(GETDATE() AS DATE), b.expiry_date) AS days_to_expiry, SUM(x.qty) AS qty, ISNULL(b.unit_cost, t.cost_price) AS cost
              FROM stock_batches b JOIN tires t ON t.id = b.tire_id JOIN batch_location_stock x ON x.batch_id = b.id
              WHERE t.organization_id = @o AND t.branch_id = @b AND b.expiry_date IS NOT NULL AND x.qty > 0
              GROUP BY b.id, t.id, t.brand, t.model, t.size, b.batch_no, b.expiry_date, b.unit_cost, t.cost_price ORDER BY t.id, b.expiry_date`);
    const sold = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT m.tire_id, SUM(-m.qty_change) AS qty FROM stock_movements m JOIN tires t ON t.id = m.tire_id
              WHERE t.organization_id = @o AND t.branch_id = @b AND m.reason IN ('sale', 'sale_voided', 'sale_deleted') AND m.created_at >= DATEADD(DAY, -60, GETDATE()) GROUP BY m.tire_id`);
    const daily = Object.fromEntries(sold.recordset.map(x => [x.tire_id, Math.max(0, x.qty) / 60]));
    const buckets = Object.fromEntries(EXP_BUCKETS.map(([k]) => [k, { batches: 0, units: 0, value: 0 }]));
    const rows = []; let before = 0, lastItem = null;
    for (const x of r.recordset) {
      if (x.tire_id !== lastItem) { before = 0; lastItem = x.tire_id; }
      const d = x.days_to_expiry, value = x.qty * Number(x.cost);
      const demand = (daily[x.tire_id] || 0) * Math.max(0, d);
      const sellable = d < 0 ? 0 : Math.max(0, Math.min(x.qty, demand - before));
      const unsold = Math.ceil(x.qty - sellable - 1e-9);
      before += x.qty;
      const bk = buckets[expBucket(d)]; bk.batches++; bk.units += x.qty; bk.value += value;
      if (d <= horizon) rows.push({ batch_id: x.batch_id, tire_id: x.tire_id, item_name: x.item_name, batch_no: x.batch_no, expiry_date: dayOf(x.expiry_date), days_to_expiry: d, qty: x.qty,
        value: round2(value), daily_sales: round2(daily[x.tire_id] || 0), expected_unsold: unsold, at_risk_value: round2(unsold * Number(x.cost)) });
    }
    for (const k of Object.keys(buckets)) buckets[k].value = round2(buckets[k].value);
    rows.sort((a, b) => a.days_to_expiry - b.days_to_expiry);
    res.json({ horizon, buckets, rows, expired_value: buckets.expired.value, at_risk_value: round2(rows.reduce((a, x) => a + x.at_risk_value, 0)),
               basis: 'Expected unsold = units not covered by the last 60 days\' sales rate before the batch expires (earliest expiry sells first).' });
  } catch (err) { fail(res, err); }
});

// ── Valuation adjustments (revaluation, write-down) ────────────────────────
// Changes the COST of stock on hand without moving any units. The previous cost of every affected layer is kept.
router.post('/valuation-adjustments', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const s = scope(req);
    const { orgId, branchId } = getContext(req);
    const b = req.body || {};
    const tireId = int(b.tire_id);
    const newCost = Number(b.new_unit_cost);
    const reason = String(b.reason ?? '').trim();
    if (!Number.isInteger(tireId)) throw new StockError('INVALID_ITEM', 'Choose an item');
    if (!Number.isFinite(newCost) || newCost < 0 || newCost > 1e9) throw new StockError('INVALID_COST', 'New unit cost must be a number, zero or more');
    if (reason.length < 3) throw new StockError('REASON_REQUIRED', 'A reason is required for a valuation adjustment (for example "write-down to net realisable value")');
    const out = await inTransaction(async tx => {
      const t = (await new sql.Request(tx).input('id', sql.Int, tireId).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
        .query("SELECT id, branch_id, stock, cost_price, LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS name FROM tires WITH (UPDLOCK) WHERE id = @id AND organization_id = @o AND branch_id = @b")).recordset[0];
      if (!t) throw new StockError('NOT_FOUND', 'Item not found', 404);
      if (t.stock <= 0) throw new StockError('NO_STOCK', `${t.name} has no stock on hand to revalue`, 409);
      const method = await valuationMethod(tx, orgId);
      const layers = (await new sql.Request(tx).input('t', sql.Int, tireId).query('SELECT id, qty_remaining, unit_cost FROM stock_cost_layers WITH (UPDLOCK) WHERE tire_id = @t AND qty_remaining > 0 ORDER BY created_at, id')).recordset;
      const layerQty = layers.reduce((a, l) => a + l.qty_remaining, 0), layerValue = layers.reduce((a, l) => a + l.qty_remaining * Number(l.unit_cost), 0);
      const oldValue = LAYER_METHODS.includes(method)
        ? (layerQty > t.stock ? t.stock * (layerValue / layerQty) : layerValue) + (t.stock - Math.min(layerQty, t.stock)) * Number(t.cost_price)
        : t.stock * Number(t.cost_price);
      const oldUnit = oldValue / t.stock, newValue = t.stock * newCost;
      if (Math.abs(oldValue - newValue) < 0.005) throw new StockError('NO_CHANGE', 'The new cost gives the same stock value', 400);
      const adj = (await new sql.Request(tx).input('o', sql.Int, orgId).input('b', sql.Int, t.branch_id).input('t', sql.Int, tireId).input('n', sql.NVarChar(200), t.name)
        .input('q', sql.Int, t.stock).input('oc', sql.Decimal(18, 4), oldUnit).input('nc', sql.Decimal(18, 4), newCost).input('ov', sql.Decimal(18, 2), round2(oldValue)).input('nv', sql.Decimal(18, 2), round2(newValue))
        .input('r', sql.NVarChar(500), reason.slice(0, 500)).input('m', sql.NVarChar(20), method).input('u', sql.Int, s.userId ?? null)
        .query(`INSERT INTO valuation_adjustments (organization_id, branch_id, tire_id, item_name, qty, old_unit_cost, new_unit_cost, old_value, new_value, reason, method, user_id)
                OUTPUT INSERTED.id VALUES (@o, @b, @t, @n, @q, @oc, @nc, @ov, @nv, @r, @m, @u)`)).recordset[0].id;
      for (const l of layers) {
        await new sql.Request(tx).input('a', sql.Int, adj).input('l', sql.Int, l.id).input('q', sql.Int, l.qty_remaining).input('oc', sql.Decimal(18, 4), l.unit_cost).input('nc', sql.Decimal(18, 4), newCost)
          .query('INSERT INTO valuation_adjustment_layers (adjustment_id, layer_id, qty, old_cost, new_cost) VALUES (@a, @l, @q, @oc, @nc)');
      }
      await new sql.Request(tx).input('t', sql.Int, tireId).input('c', sql.Decimal(18, 4), newCost).query('UPDATE stock_cost_layers SET unit_cost = @c WHERE tire_id = @t AND qty_remaining > 0');
      await new sql.Request(tx).input('t', sql.Int, tireId).input('c', sql.Decimal(18, 2), Math.round(newCost * 100) / 100).query('UPDATE tires SET cost_price = @c WHERE id = @t');
      await IM.logChanges(tx, { orgId, tireId, userId: s.userId, before: { cost_price: t.cost_price }, after: { cost_price: Math.round(newCost * 100) / 100 } });
      return { id: adj, item_name: t.name, qty: t.stock, old_unit_cost: round2(oldUnit), new_unit_cost: newCost, old_value: round2(oldValue), new_value: round2(newValue), delta: round2(newValue - oldValue), method, layers: layers.length };
    });
    const pool = await getPool();
    writeAudit(pool, { orgId, branchId, userId: s.userId, action: 'CREATE', entity: 'valuation_adjustment', entityId: out.id, before: null, after: out });
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

router.get('/valuation-adjustments', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('t', sql.Int, parseInt(req.query.tire_id, 10) || null)
      .query(`SELECT TOP 200 a.id, a.tire_id, a.item_name, a.qty, a.old_unit_cost, a.new_unit_cost, a.old_value, a.new_value, a.new_value - a.old_value AS delta, a.reason, a.method, a.created_at, u.name AS user_name
              FROM valuation_adjustments a LEFT JOIN users u ON u.id = a.user_id
              WHERE a.organization_id = @o AND a.branch_id = @b AND (@t IS NULL OR a.tire_id = @t) ORDER BY a.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.get('/valuation-adjustments/:id', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const a = (await pool.request().input('id', sql.Int, int(req.params.id)).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query('SELECT * FROM valuation_adjustments WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
    if (!a) throw new StockError('NOT_FOUND', 'Adjustment not found', 404);
    const layers = (await pool.request().input('id', sql.Int, a.id)
      .query('SELECT l.layer_id, l.qty, l.old_cost, l.new_cost, c.created_at AS layer_date FROM valuation_adjustment_layers l LEFT JOIN stock_cost_layers c ON c.id = l.layer_id WHERE l.adjustment_id = @id ORDER BY l.layer_id')).recordset;
    res.json({ ...a, layers });
  } catch (err) { fail(res, err); }
});

// ── Valuation snapshots (period-end records) ────────────────────────────────
router.post('/valuation-snapshots', canManage, async (req, res) => {
  try {
    const s = scope(req);
    const out = await inTransaction(async tx => {
      const method = await valuationMethod(tx, s.orgId);
      const v = await computeValuation(s.orgId, s.branchId, method, tx);
      const id = (await new sql.Request(tx).input('o', sql.Int, s.orgId).input('b', sql.Int, s.branchId).input('m', sql.NVarChar(20), method)
        .input('u', sql.Int, v.totals.units).input('v', sql.Decimal(18, 2), v.totals.value).input('n', sql.NVarChar(500), req.body?.note ? String(req.body.note).trim().slice(0, 500) : null).input('uid', sql.Int, s.userId ?? null)
        .query('INSERT INTO valuation_snapshots (organization_id, branch_id, method, total_units, total_value, note, user_id) OUTPUT INSERTED.id VALUES (@o, @b, @m, @u, @v, @n, @uid)')).recordset[0].id;
      for (const i of v.items) {
        await new sql.Request(tx).input('s', sql.Int, id).input('t', sql.Int, i.tire_id).input('n', sql.NVarChar(200), i.item_name).input('c', sql.NVarChar(100), i.category)
          .input('q', sql.Int, i.stock).input('uc', sql.Decimal(18, 4), i.unit_cost).input('v', sql.Decimal(18, 2), i.value)
          .query('INSERT INTO valuation_snapshot_items (snapshot_id, tire_id, item_name, category, qty, unit_cost, value) VALUES (@s, @t, @n, @c, @q, @uc, @v)');
      }
      return { id, method, total_units: v.totals.units, total_value: v.totals.value, items: v.items.length };
    });
    const pool = await getPool();
    writeAudit(pool, { orgId: s.orgId, branchId: s.branchId, userId: s.userId, action: 'CREATE', entity: 'valuation_snapshot', entityId: out.id, before: null, after: out });
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

router.get('/valuation-snapshots', async (req, res) => {
  try {
    const s = scope(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, s.orgId).input('b', sql.Int, s.branchId)
      .query(`SELECT TOP 100 v.id, v.method, v.total_units, v.total_value, v.note, v.taken_at, u.name AS user_name FROM valuation_snapshots v LEFT JOIN users u ON u.id = v.user_id
              WHERE v.organization_id = @o AND (@b IS NULL OR v.branch_id = @b OR v.branch_id IS NULL) ORDER BY v.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.get('/valuation-snapshots/:id', async (req, res) => {
  try {
    const s = scope(req);
    const pool = await getPool();
    const h = (await pool.request().input('id', sql.Int, int(req.params.id)).input('o', sql.Int, s.orgId).query('SELECT * FROM valuation_snapshots WHERE id = @id AND organization_id = @o')).recordset[0];
    if (!h || (s.branchId != null && h.branch_id != null && h.branch_id !== s.branchId)) throw new StockError('NOT_FOUND', 'Snapshot not found', 404);
    const items = (await pool.request().input('id', sql.Int, h.id).query('SELECT tire_id, item_name, category, qty, unit_cost, value FROM valuation_snapshot_items WHERE snapshot_id = @id ORDER BY item_name')).recordset;
    res.json({ ...h, label: METHOD_INFO[h.method]?.label ?? h.method, items });
  } catch (err) { fail(res, err); }
});

module.exports = router;
module.exports.computeStockAge = computeStockAge;
