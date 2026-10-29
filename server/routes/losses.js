// Waste, damage & obsolete inventory: loss register and reports, slow-moving / obsolete classification, supplier returns with credit tracking,
// repeated-loss patterns with recommended corrective actions. Reads the stock ledger and the adjustment / disposal documents (utils/losses.js);
// stock itself still moves only through adjustments, disposals and supplier returns (which create an adjustment). Physical losses and
// valuation changes are always reported separately.
// Mounted on /api/inventory before routes/inventory.js; unmatched paths fall through.
const express = require('express');
const router  = express.Router();
const { getPool, sql }  = require('../db');
const { requireRole }   = require('../middleware/auth');
const P = require('../utils/permissions');
const { writeAudit }    = require('../utils/audit');
const { getContext }    = require('../context');
const { nextDocNumber } = require('../utils/docNumber');
const { StockError, createAdjustment } = require('../utils/stock');
const Ls = require('../utils/losses');

const canManage = P.requirePermission('losses.manage');
const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const text = (v, max) => { const t = String(v ?? '').trim().slice(0, max); return t || null; };
const reasonOf = (v, label = 'A reason') => { const r = text(v, 500); if (!r || r.length < 3) throw new StockError('REASON_REQUIRED', `${label} is required`, 400); return r; };
const isoDate = v => { if (!v) return null; if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)) || Number.isNaN(new Date(`${v}T00:00:00`).getTime())) throw new StockError('INVALID_DATE', 'Dates must be YYYY-MM-DD', 400); return String(v); };

function fail(res, err) {
  if (err instanceof StockError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  console.error('[losses]', err.message);
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
  try { writeAudit(await getPool(), { orgId: ctx.orgId, branchId: ctx.branchId, userId: req.user.userId, action, entity, entityId: entityId || 0, before: null, after }); } catch { /* best effort */ }
};

router.use('/losses', (req, res, next) => (req.method !== 'GET' && req.user?.role === 'demo' ? res.status(403).json({ error: 'Not available in demo mode', code: 'DEMO' }) : next()));

const range = q => {
  const from = isoDate(q.from), to = isoDate(q.to);
  if (from && to && from > to) throw new StockError('INVALID_RANGE', 'The start date is after the end date', 400);
  const r = Ls.periodOf(from, to, 90);
  if ((new Date(`${r.end}T00:00:00Z`) - new Date(`${r.start}T00:00:00Z`)) > 800 * 86400000) throw new StockError('RANGE_TOO_LONG', 'Choose a period of at most about two years', 400);
  return r;
};

// ── Meta & settings ─────────────────────────────────────────────────────────
router.get('/losses/meta', async (req, res) => {
  try {
    const ctx = getContext(req);
    const { ADJUSTMENT_REASONS } = require('../utils/stock');
    res.json({
      causes: Object.entries(Ls.CAUSES).map(([value, label]) => ({ value, label, recommendation: Ls.RECOMMENDATIONS[value] })),
      reasons: Ls.LOSS_REASONS.map(code => ({ code, label: ADJUSTMENT_REASONS[code].label, cause: Ls.REASON_CAUSE[code] })),
      classes: Object.entries(Ls.CLASSES).map(([value, label]) => ({ value, label })),
      settings: await Ls.loadSettings(await getPool(), ctx.orgId),
    });
  } catch (err) { fail(res, err); }
});

const SETTING_RULES = {
  loss_writeoff_approval_value: [0, 1e12, true], obs_slow_days: [7, 3650], obs_nonmoving_days: [14, 3650], obs_obsolete_days: [30, 3650], obs_grace_days: [0, 365], obs_slow_cover_days: [30, 3650],
  obs_provision_slow: [0, 100], obs_provision_nonmoving: [0, 100], obs_provision_obsolete: [0, 100], loss_pattern_days: [30, 730], loss_pattern_min_events: [2, 50],
};
router.put('/losses/settings', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req), b = req.body || {}, pool = await getPool();
    const clean = {};
    for (const [key, [lo, hi, nullable]] of Object.entries(SETTING_RULES)) {
      if (!(key in b)) continue;
      const v = b[key];
      if (v === null || v === '') { if (!nullable && key.startsWith('loss_writeoff')) { clean[key] = null; continue; } clean[key] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new StockError('INVALID_SETTING', `${key.replace(/_/g, ' ')} must be between ${lo} and ${hi}`, 400);
      clean[key] = n;
    }
    const merged = { ...(await Ls.loadSettings(pool, ctx.orgId)), ...Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== null)) };
    if (!(merged.obs_slow_days < merged.obs_nonmoving_days && merged.obs_nonmoving_days < merged.obs_obsolete_days)) throw new StockError('INVALID_SETTING', 'Day thresholds must increase: slow < non-moving < obsolete', 400);
    for (const [key, v] of Object.entries(clean)) {
      if (v === null) await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(100), key).query('DELETE FROM settings WHERE organization_id = @o AND [key] = @k');
      else await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(100), key).input('v', sql.NVarChar(100), String(v))
        .query(`IF EXISTS (SELECT 1 FROM settings WHERE organization_id = @o AND [key] = @k) UPDATE settings SET value = @v WHERE organization_id = @o AND [key] = @k
                ELSE INSERT INTO settings (organization_id, [key], value) VALUES (@o, @k, @v)`);
    }
    await audit(req, ctx, 'UPDATE', 'loss_settings', 0, clean);
    res.json(await Ls.loadSettings(pool, ctx.orgId));
  } catch (err) { fail(res, err); }
});

// ── Reports ─────────────────────────────────────────────────────────────────
router.get('/losses/summary', async (req, res) => {
  try { res.json(await Ls.summary(await getPool(), getContext(req), range(req.query))); } catch (err) { fail(res, err); }
});

router.get('/losses/register', async (req, res) => {
  try {
    const ctx = getContext(req), { start, end } = range(req.query);
    const ev = await Ls.lossEvents(await getPool(), { ...ctx, start, end });
    let rows = ev.losses;
    if (req.query.cause) rows = rows.filter(x => x.cause === req.query.cause);
    if (req.query.source) rows = rows.filter(x => x.source === req.query.source);
    if (req.query.tire_id) rows = rows.filter(x => x.tire_id === int(req.query.tire_id));
    if (req.query.user_id) rows = rows.filter(x => x.recorded_by_id === int(req.query.user_id));
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 2000);
    res.json({ totals: Ls.total(rows), rows: rows.slice(0, limit), truncated: rows.length > limit });
  } catch (err) { fail(res, err); }
});

const BREAKDOWNS = {
  cause:    [x => x.cause, x => x.cause_label],
  reason:   [x => x.reason_label],
  item:     [x => x.tire_id, x => x.item_name],
  location: [x => x.location_id, x => x.location_name],
  user:     [x => x.recorded_by_id, x => x.recorded_by ?? `User ${x.recorded_by_id}`],
  supplier: [x => x.supplier_id, x => `Supplier ${x.supplier_id}`],
};
router.get('/losses/breakdown', async (req, res) => {
  try {
    const ctx = getContext(req), { start, end } = range(req.query), by = req.query.by || 'cause';
    if (!BREAKDOWNS[by]) throw new StockError('INVALID_BREAKDOWN', `by must be one of: ${Object.keys(BREAKDOWNS).join(', ')}`, 400);
    const pool = await getPool();
    const ev = await Ls.lossEvents(pool, { ...ctx, start, end });
    let rows = Ls.groupBy(ev.losses, ...BREAKDOWNS[by]).slice(0, 200);
    if (by === 'supplier') {
      const names = Object.fromEntries((await pool.request().input('o', sql.Int, ctx.orgId).query('SELECT id, name FROM suppliers WHERE organization_id = @o')).recordset.map(s => [s.id, s.name]));
      rows = rows.map(r => ({ ...r, label: names[r.key] ?? r.label }));
    }
    res.json({ by, totals: Ls.total(ev.losses), rows });
  } catch (err) { fail(res, err); }
});

// ── Slow-moving & obsolete ──────────────────────────────────────────────────
router.get('/losses/obsolescence', async (req, res) => {
  try {
    const ctx = getContext(req), pool = await getPool();
    const out = await Ls.classifyStock(pool, ctx, await Ls.loadSettings(pool, ctx.orgId));
    let rows = out.rows;
    if (req.query.class && Ls.CLASSES[req.query.class]) rows = rows.filter(r => r.class === req.query.class);
    else if (req.query.class !== 'all') rows = rows.filter(r => r.class !== 'active');
    res.json({ ...out, rows: rows.slice(0, 500), truncated: rows.length > 500 });
  } catch (err) { fail(res, err); }
});

router.put('/losses/items/:id/lifecycle', canManage, async (req, res) => {
  try {
    const ctx = getContext(req), id = int(req.params.id), status = req.body?.status ?? null;
    if (status !== null && !['discontinued', 'obsolete'].includes(status)) throw new StockError('INVALID_STATUS', 'Status must be discontinued, obsolete, or empty to clear it', 400);
    const note = status ? reasonOf(req.body?.note, 'A note explaining why the item is being retired') : text(req.body?.note, 300);
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).input('s', sql.NVarChar(12), status)
      .input('n', sql.NVarChar(300), note ? note.slice(0, 300) : null).input('u', sql.Int, req.user.userId ?? null)
      .query(`UPDATE tires SET lifecycle_status = @s, lifecycle_note = @n, lifecycle_set_at = CASE WHEN @s IS NULL THEN NULL ELSE GETDATE() END, lifecycle_set_by = CASE WHEN @s IS NULL THEN NULL ELSE @u END
              OUTPUT INSERTED.id, INSERTED.lifecycle_status WHERE id = @id AND organization_id = @o AND (@b IS NULL OR branch_id = @b)`);
    if (!r.recordset[0]) throw new StockError('NOT_FOUND', 'Item not found', 404);
    await audit(req, ctx, 'UPDATE', 'item_lifecycle', id, { status, note });
    res.json({ id, lifecycle_status: status, note });
  } catch (err) { fail(res, err); }
});

// ── Patterns & corrective actions ───────────────────────────────────────────
router.get('/losses/patterns', async (req, res) => {
  try {
    const ctx = getContext(req), pool = await getPool();
    res.json(await Ls.detectPatterns(pool, ctx, await Ls.loadSettings(pool, ctx.orgId), parseInt(req.query.days, 10) || null));
  } catch (err) { fail(res, err); }
});

router.get('/losses/actions', async (req, res) => {
  try {
    const ctx = getContext(req), pool = await getPool();
    const status = ['open', 'done', 'dismissed'].includes(req.query.status) ? req.query.status : null;
    const r = await pool.request().input('o', sql.Int, ctx.orgId).input('s', sql.NVarChar(12), status)
      .query(`SELECT TOP 200 a.id, a.pattern_key, a.title, a.detail, a.owner_name, a.due_date, a.status, a.resolution, a.created_at, a.closed_at, cu.name AS created_by_name, xu.name AS closed_by_name,
                     CASE WHEN a.status = 'open' AND a.due_date < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END AS overdue
              FROM loss_actions a LEFT JOIN users cu ON cu.id = a.created_by LEFT JOIN users xu ON xu.id = a.closed_by
              WHERE a.organization_id = @o AND (@s IS NULL OR a.status = @s) ORDER BY CASE a.status WHEN 'open' THEN 0 ELSE 1 END, a.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.post('/losses/actions', canManage, async (req, res) => {
  try {
    const ctx = getContext(req), b = req.body || {};
    const title = text(b.title, 200);
    if (!title || title.length < 3) throw new StockError('TITLE_REQUIRED', 'Describe the corrective action', 400);
    const due = isoDate(b.due_date);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(120), text(b.pattern_key, 120)).input('t', sql.NVarChar(200), title)
      .input('d', sql.NVarChar(1000), text(b.detail, 1000)).input('own', sql.NVarChar(100), text(b.owner_name, 100)).input('due', sql.Date, due).input('u', sql.Int, req.user.userId ?? null)
      .query('INSERT INTO loss_actions (organization_id, pattern_key, title, detail, owner_name, due_date, created_by) OUTPUT INSERTED.id VALUES (@o, @k, @t, @d, @own, @due, @u)');
    await audit(req, ctx, 'CREATE', 'loss_action', r.recordset[0].id, { title, pattern_key: b.pattern_key });
    res.status(201).json({ id: r.recordset[0].id, status: 'open' });
  } catch (err) { fail(res, err); }
});

router.put('/losses/actions/:id', canManage, async (req, res) => {
  try {
    const ctx = getContext(req), id = int(req.params.id), status = req.body?.status;
    if (!['open', 'done', 'dismissed'].includes(status)) throw new StockError('INVALID_STATUS', 'Status must be open, done or dismissed', 400);
    const resolution = status === 'open' ? null : reasonOf(req.body?.resolution, 'A note on what was done (or why it was dismissed)');
    const pool = await getPool();
    const r = await pool.request().input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).input('s', sql.NVarChar(12), status).input('r', sql.NVarChar(500), resolution).input('u', sql.Int, req.user.userId ?? null)
      .query(`UPDATE loss_actions SET status = @s, resolution = @r, closed_by = CASE WHEN @s = 'open' THEN NULL ELSE @u END, closed_at = CASE WHEN @s = 'open' THEN NULL ELSE GETDATE() END
              OUTPUT INSERTED.id WHERE id = @id AND organization_id = @o`);
    if (!r.recordset[0]) throw new StockError('NOT_FOUND', 'Action not found', 404);
    await audit(req, ctx, 'UPDATE', 'loss_action', id, { status, resolution });
    res.json({ id, status });
  } catch (err) { fail(res, err); }
});

// ── Supplier returns ────────────────────────────────────────────────────────
router.get('/losses/returns', async (req, res) => {
  try {
    const ctx = getContext(req), pool = await getPool();
    const rows = await Ls.supplierReturns(pool, { ...ctx, supplierId: req.query.supplier_id ? int(req.query.supplier_id) : null });
    const status = req.query.status;
    res.json({ totals: Ls.returnTotals(rows), rows: (status ? rows.filter(r => r.status === status) : rows).slice(0, 300) });
  } catch (err) { fail(res, err); }
});

// Stock leaves immediately (or after approval, as for any write-off) through a return_to_supplier adjustment; the document then tracks the credit note.
router.post('/losses/returns', async (req, res) => {
  try {
    const ctx = getContext(req), b = req.body || {};
    const supplierId = int(b.supplier_id), tireId = int(b.tire_id), qty = int(b.qty);
    if (!(supplierId > 0)) throw new StockError('SUPPLIER_REQUIRED', 'Choose the supplier', 400);
    if (!(tireId > 0)) throw new StockError('INVALID_ITEM', 'Choose the item', 400);
    if (!(qty > 0)) throw new StockError('INVALID_QTY', 'Quantity must be a positive whole number', 400);
    const reason = reasonOf(b.reason, 'A reason for the return');
    const reference = text(b.reference, 100);
    const out = await inTransaction(async tx => {
      const sup = (await new sql.Request(tx).input('s', sql.Int, supplierId).input('o', sql.Int, ctx.orgId).query('SELECT id, name FROM suppliers WHERE id = @s AND organization_id = @o')).recordset[0];
      if (!sup) throw new StockError('SUPPLIER_NOT_FOUND', 'Supplier not found', 404);
      const no = await nextDocNumber(new sql.Request(tx), 'supplier_returns', 'SRT');
      const adj = await createAdjustment(tx, { orgId: ctx.orgId, user: { orgId: ctx.orgId, branchId: req.user.branchId ?? null, userId: req.user.userId, role: req.user.role, perms: req.user.perms, approvalLimit: req.user.approvalLimit ?? null }, tireId, qtyChange: -qty,
        reasonCode: 'return_to_supplier', notes: `${no} to ${sup.name}${reference ? ` (${reference})` : ''}: ${reason}`.slice(0, 480),
        locationId: b.location_id ? int(b.location_id) : null, batchId: b.batch_id ? int(b.batch_id) : null });
      const item = (await new sql.Request(tx).input('t', sql.Int, tireId).query("SELECT branch_id, LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS name FROM tires WHERE id = @t")).recordset[0];
      const adjRow = (await new sql.Request(tx).input('a', sql.Int, adj.id).query('SELECT location_id, batch_id FROM stock_adjustments WHERE id = @a')).recordset[0];
      const r = await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('br', sql.Int, item.branch_id).input('no', sql.NVarChar(30), no).input('s', sql.Int, supplierId).input('t', sql.Int, tireId)
        .input('n', sql.NVarChar(200), item.name).input('bt', sql.Int, adjRow.batch_id ?? null).input('l', sql.Int, adjRow.location_id ?? null).input('q', sql.Int, qty).input('rs', sql.NVarChar(500), reason)
        .input('ref', sql.NVarChar(100), reference).input('a', sql.Int, adj.id).input('u', sql.Int, req.user.userId ?? null)
        .query(`INSERT INTO supplier_returns (organization_id, branch_id, return_no, supplier_id, tire_id, item_name, batch_id, location_id, qty, reason, reference, adjustment_id, created_by)
                OUTPUT INSERTED.id VALUES (@o, @br, @no, @s, @t, @n, @bt, @l, @q, @rs, @ref, @a, @u)`);
      return { id: r.recordset[0].id, return_no: no, adjustment_id: adj.id, status: adj.status === 'pending' ? 'awaiting_approval' : 'shipped', supplier: sup.name };
    });
    await audit(req, ctx, 'CREATE', 'supplier_return', out.id, out);
    res.status(out.status === 'awaiting_approval' ? 202 : 201).json(out);
  } catch (err) { fail(res, err); }
});

router.post('/losses/returns/:id/credit', canManage, async (req, res) => {
  try {
    const ctx = getContext(req), id = int(req.params.id), b = req.body || {};
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) throw new StockError('INVALID_AMOUNT', 'Credit amount must be zero or more', 400);
    const final = b.final === true || b.final === 'true';
    const out = await inTransaction(async tx => {
      const row = (await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, ctx.orgId)
        .query('SELECT r.*, a.status AS adj_status FROM supplier_returns r WITH (UPDLOCK) JOIN stock_adjustments a ON a.id = r.adjustment_id WHERE r.id = @id AND r.organization_id = @o')).recordset[0];
      if (!row) throw new StockError('NOT_FOUND', 'Supplier return not found', 404);
      if (row.adj_status !== 'approved') throw new StockError('NOT_SHIPPED', 'The return has not been approved, so there is nothing to credit yet', 409);
      if (row.closed_at) throw new StockError('ALREADY_CLOSED', 'This return is already closed', 409);
      if (!final && amount === 0) throw new StockError('INVALID_AMOUNT', 'Enter the credit received, or close the return as not credited', 400);
      const cur = (await Ls.supplierReturns(tx, { orgId: ctx.orgId, branchId: null })).find(x => x.id === id);
      const total = Ls.round2(Number(row.credit_amount) + amount);
      if (total > cur.value * 1.5 + 1) throw new StockError('CREDIT_TOO_HIGH', `Credit of ${total} is far above the value returned (${cur.value})`, 400);
      const close = final || total >= cur.value - 0.005;
      if (close && final && total < cur.value - 0.005 && !text(b.note, 300)) throw new StockError('NOTE_REQUIRED', 'Closing a return that was not credited in full needs a note saying why', 400);
      await new sql.Request(tx).input('id', sql.Int, id).input('c', sql.Decimal(18, 2), total).input('ref', sql.NVarChar(100), text(b.reference, 100) ?? row.credit_ref).input('u', sql.Int, req.user.userId ?? null).input('close', sql.Bit, close ? 1 : 0)
        .query(`UPDATE supplier_returns SET credit_amount = @c, credit_ref = @ref, credit_at = CASE WHEN @c > 0 THEN GETDATE() ELSE credit_at END,
                       closed_at = CASE WHEN @close = 1 THEN GETDATE() ELSE NULL END, closed_by = CASE WHEN @close = 1 THEN @u ELSE NULL END WHERE id = @id`);
      return { id, credit_amount: total, closed: close, value: cur.value, shortfall: close ? Math.max(0, Ls.round2(cur.value - total)) : 0 };
    });
    await audit(req, ctx, 'UPDATE', 'supplier_return', id, { ...out, note: b.note });
    res.json(out);
  } catch (err) { fail(res, err); }
});

// ── Alerts (Inventory badge) ────────────────────────────────────────────────
router.get('/losses/alerts', async (req, res) => {
  try {
    const ctx = getContext(req), pool = await getPool();
    const reasons = [...Ls.LOSS_REASONS, 'return_to_supplier'].map(x => `'${x}'`).join(', ');
    const [pend, exp, cls, act, ret] = await Promise.all([
      pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).query(`SELECT COUNT(*) AS n FROM stock_adjustments WHERE organization_id = @o AND branch_id = @b AND status = 'pending' AND reason_code IN (${reasons})`),
      Ls.exposure(pool, ctx),
      Ls.classifyStock(pool, ctx, await Ls.loadSettings(pool, ctx.orgId)),
      pool.request().input('o', sql.Int, ctx.orgId).query("SELECT COUNT(*) AS n FROM loss_actions WHERE organization_id = @o AND status = 'open' AND due_date < CAST(GETDATE() AS DATE)"),
      Ls.supplierReturns(pool, ctx),
    ]);
    const out = {
      pending_writeoffs: pend.recordset[0].n, expired_batches: exp.expired.batches, expired_value: exp.expired.value,
      non_moving_items: cls.summary.non_moving.items, obsolete_items: cls.summary.obsolete.items, at_risk_value: cls.at_risk_value,
      overdue_actions: act.recordset[0].n, credits_outstanding: Ls.returnTotals(ret).credit_outstanding,
    };
    res.json({ ...out, needs_attention: out.pending_writeoffs + out.expired_batches + out.obsolete_items + out.overdue_actions });
  } catch (err) { fail(res, err); }
});

module.exports = router;
