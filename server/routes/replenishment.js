// Replenishment & stockout prevention API. Recommendations never commit to a supplier on their own:
// a purchase order exists only after an authorised user approves lines (POST /replenishment/orders).
// Mounted on /api/inventory before routes/inventory.js; unmatched paths fall through.
const express = require('express');
const router  = express.Router();
const { getPool, sql }  = require('../db');
const { requireRole }   = require('../middleware/auth');
const P = require('../utils/permissions');
const { writeAudit }    = require('../utils/audit');
const { getContext }    = require('../context');
const { nextDocNumber } = require('../utils/docNumber');
const IM = require('../utils/itemMaster');
const { StockError }    = require('../utils/stock');
const R  = require('../utils/replenishment');

const canManage = P.requirePermission('replenishment.approve');
// Everything under /replenishment can be read by anyone who reviews it; changes need the approve permission (or policy for settings).
router.use('/replenishment', (req, res, next) => (req.method === 'GET' ? P.requirePermission('replenishment.view', 'replenishment.approve')(req, res, next) : next()));
const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const today = () => new Date().toISOString().slice(0, 10);

function fail(res, err) {
  if (err instanceof StockError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  if (err && err.code && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error('[replenishment]', err.message);
  return res.status(500).json({ error: 'Operation failed' });
}
async function inTransaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try { const out = await fn(tx); await tx.commit(); return out; }
  catch (e) { try { await tx.rollback(); } catch { /* already rolled back */ } throw e; }
}
const audit = async (req, ctx, action, entity, entityId, after) => {
  try { writeAudit(await getPool(), { orgId: ctx.orgId, branchId: ctx.branchId, userId: req.user.userId, action, entity, entityId: entityId || 0, before: null, after }); } catch { /* audit is best effort */ }
};

// ── Plan ────────────────────────────────────────────────────────────────────
// Older reorder report: only items that need attention, in the shape the Reports modal already reads.
router.get('/replenishment', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const plan = await R.computePlan(orgId, branchId);
    const items = plan.items.filter(i => i.need_order || i.status === 'out_of_stock').map(i => ({
      ...i, reorder_level: i.reorder_point, avg_daily: i.daily_demand, status: i.status === 'out_of_stock' ? 'out' : 'low',
    })).sort((a, b) => a.available - b.available);
    res.json({ items, out_of_stock: items.filter(i => i.status === 'out').length, suggested_cost: R.round2(items.reduce((a, i) => a + i.suggested_cost, 0)) });
  } catch (err) { fail(res, err); }
});

router.get('/replenishment/plan', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const plan = await R.computePlan(orgId, branchId, { budget: req.query.budget });
    res.json(plan);
  } catch (err) { fail(res, err); }
});

// ── Company settings ────────────────────────────────────────────────────────
router.get('/replenishment/settings', async (req, res) => {
  try { res.json(await R.loadSettings(getContext(req).orgId)); } catch (err) { fail(res, err); }
});

router.put('/replenishment/settings', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const rules = {
      service_level:     v => { const n = Number(v); if (!(n >= 0 && n <= 0.999)) throw new StockError('INVALID_SETTING', 'Service level must be between 0 and 0.999 (0 turns automatic safety stock off)', 400); return String(n); },
      lookback_days:     v => { const n = int(v); if (!(n >= 14 && n <= 365)) throw new StockError('INVALID_SETTING', 'Demand history must be 14 to 365 days', 400); return String(n); },
      cover_days:        v => { const n = int(v); if (!(n >= 1 && n <= 365)) throw new StockError('INVALID_SETTING', 'Order cycle must be 1 to 365 days', 400); return String(n); },
      default_lead_days: v => { const n = int(v); if (!(n >= 0 && n <= 365)) throw new StockError('INVALID_SETTING', 'Default lead time must be 0 to 365 days', 400); return String(n); },
      excess_days:       v => { const n = int(v); if (!(n >= 30 && n <= 1000)) throw new StockError('INVALID_SETTING', 'Excess threshold must be 30 to 1000 days of cover', 400); return String(n); },
      mode:              v => { if (!['auto', 'manual'].includes(v)) throw new StockError('INVALID_SETTING', 'Reorder mode must be auto or manual', 400); return v; },
      budget:            v => { if (v === null || v === '') return null; const n = Number(v); if (!(n >= 0) || n > 1e12) throw new StockError('INVALID_SETTING', 'Budget must be zero or more (blank = no limit)', 400); return n > 0 ? String(n) : null; },
    };
    const pool = await getPool();
    const changed = {};
    for (const [k, parse] of Object.entries(rules)) {
      if (b[k] === undefined) continue;
      const v = parse(b[k]);
      changed[k] = v;
      const key = R.KEYS[k];
      if (v === null) await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(100), key).query('DELETE FROM settings WHERE organization_id = @o AND [key] = @k');
      else await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(100), key).input('v', sql.NVarChar(1000), v)
        .query(`IF EXISTS (SELECT 1 FROM settings WHERE organization_id = @o AND [key] = @k) UPDATE settings SET value = @v WHERE organization_id = @o AND [key] = @k
                ELSE INSERT INTO settings (organization_id, [key], value) VALUES (@o, @k, @v)`);
    }
    await audit(req, ctx, 'UPDATE', 'replenishment_settings', 0, changed);
    res.json(await R.loadSettings(ctx.orgId));
  } catch (err) { fail(res, err); }
});

// ── Item parameters ─────────────────────────────────────────────────────────
// minimum / maximum / reorder point / safety stock / lead time / MOQ / pack multiple / capacity / seasonality for one item.
router.put('/replenishment/params/:id', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const id = int(req.params.id);
    await inTransaction(async tx => {
      const cur = (await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
        .query('SELECT * FROM tires WITH (UPDLOCK) WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
      if (!cur) throw new StockError('NOT_FOUND', 'Item not found', 404);
      const vals = IM.parseExtra(b, cur);
      if (b.reorder_level !== undefined) {
        const n = Number(b.reorder_level);
        if (!Number.isInteger(n) || n < 0) throw new StockError('INVALID_REORDER_POINT', 'Reorder point must be a whole number, zero or more', 400);
      }
      const allowed = ['reorder_mode', 'safety_stock', 'lead_time_days', 'moq', 'order_multiple', 'capacity_units', 'min_stock', 'max_stock', 'reorder_qty', 'supplier_id', 'seasonality'];
      const only = Object.fromEntries(Object.entries(vals).filter(([k]) => allowed.includes(k)));
      if (b.reorder_level !== undefined) {
        await new sql.Request(tx).input('id', sql.Int, id).input('v', sql.Int, Number(b.reorder_level)).query('UPDATE tires SET reorder_level = @v WHERE id = @id');
      }
      await IM.applyExtra(tx, id, only);
      const before = {}, after = {};
      for (const k of [...Object.keys(only), ...(b.reorder_level !== undefined ? ['reorder_level'] : [])]) { before[k] = cur[k]; after[k] = k === 'reorder_level' ? Number(b.reorder_level) : only[k]; }
      await IM.logChanges(tx, { orgId: ctx.orgId, tireId: id, userId: req.user.userId, before, after });
    });
    await audit(req, ctx, 'UPDATE', 'replenishment_params', id, b);
    const plan = await R.computePlan(ctx.orgId, ctx.branchId);
    res.json(plan.items.find(i => i.tire_id === id));
  } catch (err) { fail(res, err); }
});

router.put('/replenishment/category-seasonality/:id', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const v = R.parseSeasonality(req.body?.factors);
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, int(req.params.id)).input('o', sql.Int, ctx.orgId).input('v', sql.NVarChar(200), v)
      .query('UPDATE item_categories SET seasonality = @v WHERE id = @id AND organization_id = @o');
    if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Category not found', 404);
    await audit(req, ctx, 'UPDATE', 'category_seasonality', int(req.params.id), { factors: v });
    res.json({ id: int(req.params.id), seasonality: v ? JSON.parse(v) : null });
  } catch (err) { fail(res, err); }
});

router.get('/replenishment/seasonality', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const cats = await pool.request().input('o', sql.Int, ctx.orgId).query('SELECT id, name, seasonality FROM item_categories WHERE organization_id = @o ORDER BY name');
    const items = await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
      .query("SELECT id, LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS name, seasonality FROM tires WHERE organization_id = @o AND branch_id = @b AND seasonality IS NOT NULL ORDER BY model");
    const parse = x => ({ ...x, seasonality: R.readSeasonality(x.seasonality) });
    res.json({ categories: cats.recordset.map(parse), items: items.recordset.map(parse) });
  } catch (err) { fail(res, err); }
});

// ── Suppliers: lead time and minimum order value ────────────────────────────
router.get('/replenishment/suppliers', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, ctx.orgId).query(`
      SELECT s.id, s.name, s.lead_time_days, s.min_order_value,
             ISNULL(o.n, 0) AS received_orders, o.avg_days AS observed_days, o.min_days, o.max_days, o.last_received
      FROM suppliers s
      OUTER APPLY (SELECT COUNT(*) AS n, AVG(CAST(DATEDIFF(DAY, p.created_at, p.received_at) AS FLOAT)) AS avg_days, MIN(DATEDIFF(DAY, p.created_at, p.received_at)) AS min_days,
                          MAX(DATEDIFF(DAY, p.created_at, p.received_at)) AS max_days, MAX(p.received_at) AS last_received
                   FROM purchases p WHERE p.supplier_id = s.id AND p.organization_id = @o AND p.status = 'received' AND p.received_at IS NOT NULL AND p.received_at >= DATEADD(DAY, -365, GETDATE())) o
      WHERE s.organization_id = @o ORDER BY s.name`);
    res.json(r.recordset.map(x => ({ ...x, observed_days: x.observed_days != null ? R.round2(x.observed_days) : null, min_order_value: x.min_order_value != null ? Number(x.min_order_value) : null })));
  } catch (err) { fail(res, err); }
});

router.put('/replenishment/suppliers/:id', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const sets = [], rq = (await getPool()).request().input('id', sql.Int, int(req.params.id)).input('o', sql.Int, ctx.orgId);
    if (b.lead_time_days !== undefined) {
      const n = b.lead_time_days === null || b.lead_time_days === '' ? null : int(b.lead_time_days);
      if (n !== null && !(n >= 0 && n <= 365)) throw new StockError('INVALID_LEAD_TIME', 'Lead time must be 0 to 365 days', 400);
      rq.input('lt', sql.Int, n); sets.push('lead_time_days = @lt');
    }
    if (b.min_order_value !== undefined) {
      const n = b.min_order_value === null || b.min_order_value === '' ? null : Number(b.min_order_value);
      if (n !== null && !(n >= 0 && n <= 1e12)) throw new StockError('INVALID_MIN_ORDER', 'Minimum order value must be zero or more', 400);
      rq.input('mv', sql.Decimal(18, 2), n); sets.push('min_order_value = @mv');
    }
    if (!sets.length) throw new StockError('NOTHING_TO_UPDATE', 'Nothing to update', 400);
    const r = await rq.query(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = @id AND organization_id = @o`);
    if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Supplier not found', 404);
    await audit(req, ctx, 'UPDATE', 'supplier_replenishment', int(req.params.id), b);
    res.json({ id: int(req.params.id), ...b });
  } catch (err) { fail(res, err); }
});

// ── Planned requirements (production orders, projects, promotions) ──────────
router.get('/replenishment/requirements', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
      .query(`SELECT q.id, q.tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, q.qty, q.needed_by, q.note, q.status, q.created_at, u.name AS user_name
              FROM replenishment_requirements q JOIN tires t ON t.id = q.tire_id LEFT JOIN users u ON u.id = q.created_by
              WHERE q.organization_id = @o AND q.branch_id = @b ORDER BY CASE q.status WHEN 'open' THEN 0 ELSE 1 END, q.needed_by`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.post('/replenishment/requirements', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const qty = int(b.qty), tireId = int(b.tire_id);
    if (!(qty > 0)) throw new StockError('INVALID_QTY', 'Quantity must be a positive whole number', 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.needed_by || ''))) throw new StockError('INVALID_DATE', 'Needed-by date is required (YYYY-MM-DD)', 400);
    const pool = await getPool();
    const t = (await pool.request().input('id', sql.Int, tireId).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
      .query('SELECT id FROM tires WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
    if (!t) throw new StockError('NOT_FOUND', 'Item not found', 404);
    const r = await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).input('t', sql.Int, tireId).input('q', sql.Int, qty)
      .input('d', sql.Date, b.needed_by).input('n', sql.NVarChar(300), b.note ? String(b.note).trim().slice(0, 300) : null).input('u', sql.Int, req.user.userId ?? null)
      .query('INSERT INTO replenishment_requirements (organization_id, branch_id, tire_id, qty, needed_by, note, created_by) OUTPUT INSERTED.id VALUES (@o, @b, @t, @q, @d, @n, @u)');
    await audit(req, ctx, 'CREATE', 'replenishment_requirement', r.recordset[0].id, b);
    res.status(201).json({ id: r.recordset[0].id });
  } catch (err) { fail(res, err); }
});

router.post('/replenishment/requirements/:id/close', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, int(req.params.id)).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
      .query("UPDATE replenishment_requirements SET status = 'closed', closed_at = GETDATE() WHERE id = @id AND organization_id = @o AND branch_id = @b AND status = 'open'");
    if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Open requirement not found', 404);
    await audit(req, ctx, 'UPDATE', 'replenishment_requirement', int(req.params.id), { status: 'closed' });
    res.json({ id: int(req.params.id), status: 'closed' });
  } catch (err) { fail(res, err); }
});

// ── Incoming supply ─────────────────────────────────────────────────────────
router.get('/replenishment/incoming', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
      .query(`SELECT p.id AS purchase_id, p.po_no, p.date, p.expected_date, s.name AS supplier_name, pi.tire_id, pi.tire_name AS item_name, pi.qty, pi.unit_price,
                     DATEDIFF(DAY, p.expected_date, CAST(GETDATE() AS DATE)) AS days_overdue
              FROM purchases p JOIN purchase_items pi ON pi.purchase_id = p.id LEFT JOIN suppliers s ON s.id = p.supplier_id
              WHERE p.organization_id = @o AND p.branch_id = @b AND p.status = 'pending' ORDER BY ISNULL(p.expected_date, p.date), p.id`);
    const rows = r.recordset.map(x => ({ ...x, overdue: x.days_overdue != null && x.days_overdue > 0, days_overdue: x.days_overdue != null && x.days_overdue > 0 ? x.days_overdue : 0 }));
    res.json({ rows, units: rows.reduce((a, x) => a + x.qty, 0), overdue_lines: rows.filter(x => x.overdue).length });
  } catch (err) { fail(res, err); }
});

// ── Approve recommendations -> purchase orders ─────────────────────────────
// body: { orders: [{ supplier_id, note?, expected_date?, lines: [{ tire_id, qty, reason? }] }], budget? }
// Quantities are checked against a fresh plan. Ordering more than recommended, or an item that is not recommended, needs a reason.
router.post('/replenishment/orders', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const orders = Array.isArray(req.body?.orders) ? req.body.orders : [];
    if (!orders.length) throw new StockError('NOTHING_APPROVED', 'Select at least one recommendation to approve', 400);
    const plan = await R.computePlan(ctx.orgId, ctx.branchId, { budget: req.body?.budget });
    const byTire = Object.fromEntries(plan.items.map(i => [i.tire_id, i]));
    const pool = await getPool();
    const seen = new Set();
    const prepared = [];
    for (const o of orders) {
      const supplierId = int(o.supplier_id);
      if (!(supplierId > 0)) throw new StockError('SUPPLIER_REQUIRED', 'Every order needs a supplier', 400);
      const sup = (await pool.request().input('s', sql.Int, supplierId).input('o', sql.Int, ctx.orgId).query('SELECT id, name FROM suppliers WHERE id = @s AND organization_id = @o')).recordset[0];
      if (!sup) throw new StockError('NOT_FOUND', 'Supplier not found', 404);
      const lines = Array.isArray(o.lines) ? o.lines : [];
      if (!lines.length) throw new StockError('NOTHING_APPROVED', `Order for ${sup.name} has no lines`, 400);
      const resolved = [];
      for (const l of lines) {
        const tireId = int(l.tire_id), qty = int(l.qty);
        if (!(qty > 0)) throw new StockError('INVALID_QTY', 'Quantities must be positive whole numbers', 400);
        const rec = byTire[tireId];
        if (!rec) throw new StockError('NOT_FOUND', `Item ${l.tire_id} is not an active item of this branch`, 404);
        if (seen.has(tireId)) throw new StockError('DUPLICATE_LINE', `${rec.item_name} appears twice`, 400);
        seen.add(tireId);
        if (rec.supplier_id != null && rec.supplier_id !== supplierId) throw new StockError('SUPPLIER_MISMATCH', `${rec.item_name} is supplied by ${rec.supplier_name}, not ${sup.name}`, 400);
        const reason = l.reason ? String(l.reason).trim().slice(0, 500) : '';
        if (rec.suggested_qty === 0 && reason.length < 3) throw new StockError('NOT_RECOMMENDED', `${rec.item_name} does not need ordering now (stock and incoming cover the reorder point). Give a reason to order it anyway.`, 409, { tireId });
        if (rec.suggested_qty > 0 && qty > rec.funded_qty && reason.length < 3) throw new StockError('EXCEEDS_RECOMMENDATION', `${rec.item_name}: ${qty} is more than the recommended ${rec.funded_qty}. Give a reason to order more.`, 409, { tireId, recommended: rec.funded_qty });
        resolved.push({ rec, qty, reason: reason || null });
      }
      prepared.push({ supplierId, supplierName: sup.name, note: o.note ? String(o.note).trim().slice(0, 300) : '', expected: o.expected_date || null, lines: resolved });
    }
    const prefix = (await require('../db').getSetting('po_prefix', 'PO', ctx.orgId)) || 'PO';
    const created = await inTransaction(async tx => {
      await IM.assertTransactable(tx, ctx.orgId, [...seen], 'purchase');
      const made = [];
      for (const p of prepared) {
        // serialise concurrent approvals: lock each item, then make sure no PO was raised for it since the plan was computed
        for (const l of p.lines) {
          await new sql.Request(tx).input('t', sql.Int, l.rec.tire_id).query('SELECT id FROM tires WITH (UPDLOCK) WHERE id = @t');
          const oo = (await new sql.Request(tx).input('t', sql.Int, l.rec.tire_id)
            .query("SELECT ISNULL(SUM(pi.qty), 0) AS n FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id WHERE pi.tire_id = @t AND pu.status = 'pending'")).recordset[0].n;
          if (oo !== l.rec.on_order) throw new StockError('PLAN_STALE', `${l.rec.item_name}: incoming orders changed since this plan was calculated. Refresh the recommendations.`, 409, { tireId: l.rec.tire_id });
        }
        const subtotal = R.round2(p.lines.reduce((a, l) => a + l.qty * l.rec.cost_price, 0));
        const lead = Math.max(...p.lines.map(l => l.rec.lead_time_days));
        const expected = p.expected && /^\d{4}-\d{2}-\d{2}$/.test(p.expected) ? p.expected : new Date(Date.now() + lead * 86400000).toISOString().slice(0, 10);
        const poNo = await nextDocNumber(new sql.Request(tx), 'purchases', prefix);
        const po = (await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).input('no', sql.NVarChar(50), poNo).input('s', sql.Int, p.supplierId)
          .input('d', sql.Date, today()).input('st', sql.Decimal(18, 2), subtotal).input('n', sql.NVarChar(500), ('Replenishment' + (p.note ? ': ' + p.note : '')).slice(0, 500)).input('e', sql.Date, expected)
          .query(`INSERT INTO purchases (organization_id, branch_id, po_no, supplier_id, date, subtotal, tax, total, status, notes, expected_date)
                  OUTPUT INSERTED.id VALUES (@o, @b, @no, @s, @d, @st, 0, @st, 'pending', @n, @e)`)).recordset[0];
        for (const l of p.lines) {
          const unit = l.rec.cost_price;
          await new sql.Request(tx).input('p', sql.Int, po.id).input('t', sql.Int, l.rec.tire_id).input('n', sql.NVarChar(200), l.rec.item_name).input('q', sql.Int, l.qty)
            .input('u', sql.Decimal(18, 2), unit).input('a', sql.Decimal(18, 2), R.round2(unit * l.qty))
            .query('INSERT INTO purchase_items (purchase_id, tire_id, tire_name, qty, unit_price, amount) VALUES (@p, @t, @n, @q, @u, @a)');
          const basis = JSON.stringify({ status: l.rec.status, reorder_point: l.rec.reorder_point, target: l.rec.target, position: l.rec.position, daily_demand: l.rec.daily_demand,
            lead_time_days: l.rec.lead_time_days, safety_stock: l.rec.safety_stock, constraints: l.rec.constraints });
          await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).input('p', sql.Int, po.id).input('t', sql.Int, l.rec.tire_id).input('n', sql.NVarChar(200), l.rec.item_name)
            .input('sq', sql.Int, l.rec.suggested_qty).input('oq', sql.Int, l.qty).input('u', sql.Decimal(18, 2), unit).input('r', sql.NVarChar(500), l.reason).input('ba', sql.NVarChar(1000), basis).input('uid', sql.Int, req.user.userId ?? null)
            .query(`INSERT INTO replenishment_approvals (organization_id, branch_id, purchase_id, tire_id, item_name, suggested_qty, ordered_qty, unit_cost, reason, basis, approved_by)
                    VALUES (@o, @b, @p, @t, @n, @sq, @oq, @u, @r, @ba, @uid)`);
        }
        made.push({ purchase_id: po.id, po_no: poNo, supplier_id: p.supplierId, supplier_name: p.supplierName, expected_date: expected, lines: p.lines.length, units: p.lines.reduce((a, l) => a + l.qty, 0), total: subtotal });
      }
      return made;
    });
    await audit(req, ctx, 'CREATE', 'replenishment_orders', created[0]?.purchase_id, { orders: created });
    res.status(201).json({ orders: created });
  } catch (err) { fail(res, err); }
});

router.get('/replenishment/approvals', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
      .query(`SELECT TOP 200 a.id, a.purchase_id, p.po_no, p.status AS po_status, a.tire_id, a.item_name, a.suggested_qty, a.ordered_qty, a.unit_cost, a.reason, a.basis, a.approved_at, u.name AS user_name
              FROM replenishment_approvals a JOIN purchases p ON p.id = a.purchase_id LEFT JOIN users u ON u.id = a.approved_by
              WHERE a.organization_id = @o AND a.branch_id = @b ORDER BY a.id DESC`);
    res.json(r.recordset.map(x => ({ ...x, basis: x.basis ? JSON.parse(x.basis) : null })));
  } catch (err) { fail(res, err); }
});

module.exports = router;
