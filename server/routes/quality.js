// Expiry, shelf life and product quality: batch quality status (hold / release / damaged), recalls, inspections,
// customer returns, disposals / write-offs and alerts. Rules resolve item > profile > category profile > company default (utils/quality.js).
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
const { StockError, postMovement, MOVEMENT, defaultLocationId } = require('../utils/stock');
const Q = require('../utils/quality');

const canManage = P.requirePermission('quality.manage');
const isAdmin = req => req.user.role === 'org_admin';
const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const round2 = n => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const dayOf = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
const daysBetween = (a, b) => Math.floor((new Date(dayOf(b) + 'T00:00:00Z') - new Date(dayOf(a) + 'T00:00:00Z')) / 86400000);
const addDays = (d, n) => { const x = new Date(dayOf(d) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const text = (v, max) => { const t = String(v ?? '').trim().slice(0, max); return t || null; };

function fail(res, err) {
  if (err instanceof StockError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  if (err && err.code && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error('[quality]', err.message);
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
const reasonOf = (v, label = 'A reason') => { const r = text(v, 500); if (!r || r.length < 3) throw new StockError('REASON_REQUIRED', `${label} is required`, 400); return r; };

// Writes need a real user (the demo account is read-only here).
router.use('/quality', (req, res, next) => (req.method !== 'GET' && req.user?.role === 'demo' ? res.status(403).json({ error: 'Not available in demo mode', code: 'DEMO' }) : next()));

// ── Batch query shared by lists, alerts and details ─────────────────────────
const BASE = `
  SELECT b.id AS batch_id, b.tire_id, b.batch_no, b.expiry_date, b.mfg_date, b.quality_status, b.status_reason, b.status_changed_at, b.last_inspected_at,
         ISNULL(b.received_date, CAST(b.created_at AS DATE)) AS received_date, b.is_legacy, b.branch_id, ISNULL(b.unit_cost, t.cost_price) AS cost,
         LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, t.sku, t.tracking, t.track_expiry, t.shelf_life_days,
         q.qty, q.qty_normal, ${Q.QA_COLUMNS}
  FROM stock_batches b JOIN tires t ON t.id = b.tire_id ${Q.QA_JOINS}
  CROSS APPLY (SELECT ISNULL(SUM(x.qty), 0) AS qty, ISNULL(SUM(CASE WHEN l.kind = 'normal' THEN x.qty ELSE 0 END), 0) AS qty_normal
               FROM batch_location_stock x LEFT JOIN stock_locations l ON l.id = x.location_id WHERE x.batch_id = b.id) q`;

async function companyRules(conn, orgId) {
  const r = await conn.request().input('o', sql.Int, orgId).query("SELECT [key], value FROM settings WHERE organization_id = @o AND [key] LIKE 'qa[_]%'");
  const raw = Object.fromEntries(r.recordset.map(x => [x.key.slice(3), x.value]));
  const n = k => (raw[k] !== undefined && raw[k] !== '' && Number.isFinite(Number(raw[k])) ? Number(raw[k]) : null);
  return { near_expiry_days: n('near_expiry_days') ?? Q.DEFAULT_NEAR_EXPIRY, inspection_interval_days: n('inspection_interval_days'), min_remaining_days: n('min_remaining_days'),
           require_mfg_date: raw.require_mfg_date === '1', release_approval: raw.release_approval === 'admin' ? 'admin' : 'manager', stale_hold_days: n('stale_hold_days') ?? Q.DEFAULT_STALE_HOLD,
           disposal_admin_value: n('disposal_admin_value') };
}

/** Adds the derived shelf-life / inspection facts to a batch row. */
function decorate(r) {
  const t = today();
  const expiry = dayOf(r.expiry_date), mfg = dayOf(r.mfg_date);
  const daysLeft = expiry ? daysBetween(t, expiry) : null;
  const interval = r.eff_inspection_days > 0 ? r.eff_inspection_days : null;
  const base = r.last_inspected_at ? dayOf(r.last_inspected_at) : dayOf(r.received_date);
  const due = interval ? addDays(base, interval) : null;
  const dueIn = due ? daysBetween(t, due) : null;
  const total = mfg && expiry ? daysBetween(mfg, expiry) : null;
  return {
    batch_id: r.batch_id, tire_id: r.tire_id, item_name: r.item_name, sku: r.sku, tracking: r.tracking, batch_no: r.batch_no,
    mfg_date: mfg, expiry_date: expiry, days_left: daysLeft, shelf_used_pct: total && total > 0 ? Math.min(100, Math.max(0, Math.round((daysBetween(mfg, t) / total) * 100))) : null,
    received_date: dayOf(r.received_date), quality_status: r.quality_status, status_label: Q.QUALITY_STATUSES[r.quality_status] ?? r.quality_status, status_reason: r.status_reason,
    status_changed_at: r.status_changed_at, status_age_days: r.status_changed_at ? daysBetween(r.status_changed_at, t) : null,
    qty: r.qty, qty_normal: r.qty_normal, cost: Number(r.cost), value: round2(r.qty * Number(r.cost)),
    near_expiry_days: r.eff_near_expiry_days, min_remaining_days: r.eff_min_remaining_days, release_approval: r.eff_release_approval,
    expired: daysLeft != null && daysLeft < 0, near_expiry: daysLeft != null && daysLeft >= 0 && daysLeft <= r.eff_near_expiry_days,
    inspection_interval_days: interval, last_inspected_at: r.last_inspected_at, inspection_due: due, inspection_overdue: dueIn != null && dueIn < 0, inspection_days_overdue: dueIn != null && dueIn < 0 ? -dueIn : 0,
    inspection_due_soon: dueIn != null && dueIn >= 0 && dueIn <= 7,
    usable: r.quality_status === 'released' && !(daysLeft != null && daysLeft < 0),
  };
}

async function batchRows(pool, ctx, extraWhere = '', inputs = {}, top = 500) {
  const rq = pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId);
  for (const [k, [type, v]] of Object.entries(inputs)) rq.input(k, type, v);
  const r = await rq.query(`SELECT TOP ${top} * FROM (${BASE} WHERE b.organization_id = @o AND (@b IS NULL OR b.branch_id = @b) AND b.is_legacy = 0 ${extraWhere}) x ORDER BY CASE WHEN x.expiry_date IS NULL THEN 1 ELSE 0 END, x.expiry_date, x.batch_id`);
  return r.recordset.map(decorate);
}

async function lockBatch(tx, ctx, id) {
  const r = await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
    .query(`SELECT b.*, t.cost_price, t.tracking, ${Q.QA_COLUMNS}, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name
            FROM stock_batches AS b WITH (UPDLOCK, ROWLOCK) JOIN tires t ON t.id = b.tire_id ${Q.QA_JOINS}
            WHERE b.id = @id AND b.organization_id = @o AND (@b IS NULL OR b.branch_id = @b) AND b.is_legacy = 0`);
  if (!r.recordset.length) throw new StockError('NOT_FOUND', 'Batch not found', 404);
  return r.recordset[0];
}
const logEvent = (tx, ctx, userId, e) => new sql.Request(tx)
  .input('o', sql.Int, ctx.orgId).input('b', sql.Int, e.branchId ?? ctx.branchId).input('id', sql.Int, e.batchId).input('t', sql.Int, e.tireId).input('ty', sql.NVarChar(20), e.type)
  .input('f', sql.NVarChar(12), e.from ?? null).input('to', sql.NVarChar(12), e.to ?? null).input('rs', sql.NVarChar(12), e.result ?? null).input('q', sql.Int, e.qty ?? null)
  .input('r', sql.NVarChar(500), e.reason ?? null).input('ref', sql.NVarChar(100), e.reference ?? null).input('rc', sql.Int, e.recallId ?? null).input('u', sql.Int, userId ?? null)
  .query('INSERT INTO batch_quality_events (organization_id, branch_id, batch_id, tire_id, event_type, from_status, to_status, result, qty, reason, reference, recall_id, user_id) VALUES (@o, @b, @id, @t, @ty, @f, @to, @rs, @q, @r, @ref, @rc, @u)');

// ── Meta and company rules ──────────────────────────────────────────────────
router.get('/quality/meta', async (req, res) => {
  try {
    const ctx = getContext(req);
    res.json({ statuses: Object.entries(Q.QUALITY_STATUSES).map(([value, label]) => ({ value, label })), disposal_methods: Object.entries(Q.DISPOSAL_METHODS).map(([value, label]) => ({ value, label })),
               severities: Object.entries(Q.RECALL_SEVERITIES).map(([value, label]) => ({ value, label })), company: await companyRules(await getPool(), ctx.orgId) });
  } catch (err) { fail(res, err); }
});

router.get('/quality/rules', async (req, res) => {
  try { res.json(await companyRules(await getPool(), getContext(req).orgId)); } catch (err) { fail(res, err); }
});

router.put('/quality/rules', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const days = (label, lo, hi, nullable) => v => {
      if (v === null || v === '') { if (nullable) return null; throw new StockError('INVALID_RULE', `${label} is required`, 400); }
      const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new StockError('INVALID_RULE', `${label} must be a whole number from ${lo} to ${hi}`, 400);
      return n === 0 && nullable ? null : String(n);
    };
    const rules = {
      near_expiry_days: days('Near-expiry window', 0, 3650, false), inspection_interval_days: days('Inspection interval', 0, 3650, true), min_remaining_days: days('Minimum remaining shelf life', 0, 3650, true),
      stale_hold_days: days('Stale hold threshold', 1, 365, false),
      require_mfg_date: v => (v === true || v === '1' || v === 1 ? '1' : '0'),
      release_approval: v => { if (!['manager', 'admin'].includes(v)) throw new StockError('INVALID_RULE', 'Release approval must be manager or admin', 400); return v; },
      disposal_admin_value: v => { if (v === null || v === '') return null; const n = Number(v); if (!(n >= 0) || n > 1e12) throw new StockError('INVALID_RULE', 'Disposal approval value must be zero or more', 400); return n > 0 ? String(n) : null; },
    };
    const pool = await getPool();
    for (const [k, parse] of Object.entries(rules)) {
      if (b[k] === undefined) continue;
      const v = parse(b[k]);
      const key = 'qa_' + k;
      if (v === null) await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(100), key).query('DELETE FROM settings WHERE organization_id = @o AND [key] = @k');
      else await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(100), key).input('v', sql.NVarChar(1000), v)
        .query(`IF EXISTS (SELECT 1 FROM settings WHERE organization_id = @o AND [key] = @k) UPDATE settings SET value = @v WHERE organization_id = @o AND [key] = @k
                ELSE INSERT INTO settings (organization_id, [key], value) VALUES (@o, @k, @v)`);
    }
    await audit(req, ctx, 'UPDATE', 'quality_rules', 0, b);
    res.json(await companyRules(pool, ctx.orgId));
  } catch (err) { fail(res, err); }
});

// ── Quality profiles (rule sets by product type / regulation) ──────────────
function profileBody(b) {
  const days = (label, v) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 3650) throw new StockError('INVALID_RULE', `${label} must be a whole number from 0 to 3650`, 400); return n; };
  const name = text(b.name, 100);
  if (!name) throw new StockError('NAME_REQUIRED', 'Profile name is required', 400);
  const rel = b.release_approval === undefined || b.release_approval === '' || b.release_approval === null ? null : b.release_approval;
  if (rel && !['manager', 'admin'].includes(rel)) throw new StockError('INVALID_RULE', 'Release approval must be manager, admin or blank (company default)', 400);
  const mfg = b.require_mfg_date === undefined || b.require_mfg_date === null || b.require_mfg_date === '' || b.require_mfg_date === 'inherit' ? null : (b.require_mfg_date === true || b.require_mfg_date === 'yes' || b.require_mfg_date === 1 || b.require_mfg_date === '1');
  return { name, regulation: text(b.regulation, 200), near: days('Near-expiry window', b.near_expiry_days), insp: days('Inspection interval', b.inspection_interval_days), minrem: days('Minimum remaining shelf life', b.min_remaining_days), mfg, rel, notes: text(b.notes, 500) };
}
const profileRequest = (rq, p) => rq.input('n', sql.NVarChar(100), p.name).input('rg', sql.NVarChar(200), p.regulation).input('ne', sql.Int, p.near).input('ins', sql.Int, p.insp)
  .input('mr', sql.Int, p.minrem).input('mf', sql.Bit, p.mfg).input('ra', sql.NVarChar(10), p.rel).input('nt', sql.NVarChar(500), p.notes);

router.get('/quality/profiles', async (req, res) => {
  try {
    const ctx = getContext(req);
    const r = await (await getPool()).request().input('o', sql.Int, ctx.orgId).query(`
      SELECT p.id, p.name, p.regulation, p.near_expiry_days, p.inspection_interval_days, p.min_remaining_days, p.require_mfg_date, p.release_approval, p.notes,
             (SELECT COUNT(*) FROM tires t WHERE t.quality_profile_id = p.id) AS item_count, (SELECT COUNT(*) FROM item_categories c WHERE c.quality_profile_id = p.id) AS category_count
      FROM quality_profiles p WHERE p.organization_id = @o ORDER BY p.name`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.post('/quality/profiles', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const p = profileBody(req.body || {});
    try {
      const r = await profileRequest((await getPool()).request().input('o', sql.Int, ctx.orgId), p)
        .query('INSERT INTO quality_profiles (organization_id, name, regulation, near_expiry_days, inspection_interval_days, min_remaining_days, require_mfg_date, release_approval, notes) OUTPUT INSERTED.id VALUES (@o, @n, @rg, @ne, @ins, @mr, @mf, @ra, @nt)');
      await audit(req, ctx, 'CREATE', 'quality_profile', r.recordset[0].id, req.body);
      res.status(201).json({ id: r.recordset[0].id });
    } catch (e) { if (e.number === 2601 || e.number === 2627) throw new StockError('DUPLICATE_NAME', 'A profile with this name already exists', 409); throw e; }
  } catch (err) { fail(res, err); }
});

router.put('/quality/profiles/:id', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const p = profileBody(req.body || {});
    try {
      const r = await profileRequest((await getPool()).request().input('o', sql.Int, ctx.orgId).input('id', sql.Int, int(req.params.id)), p)
        .query('UPDATE quality_profiles SET name = @n, regulation = @rg, near_expiry_days = @ne, inspection_interval_days = @ins, min_remaining_days = @mr, require_mfg_date = @mf, release_approval = @ra, notes = @nt WHERE id = @id AND organization_id = @o');
      if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Profile not found', 404);
    } catch (e) { if (e.number === 2601 || e.number === 2627) throw new StockError('DUPLICATE_NAME', 'A profile with this name already exists', 409); throw e; }
    await audit(req, ctx, 'UPDATE', 'quality_profile', int(req.params.id), req.body);
    res.json({ id: int(req.params.id) });
  } catch (err) { fail(res, err); }
});

router.delete('/quality/profiles/:id', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const id = int(req.params.id);
    const use = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).query('SELECT (SELECT COUNT(*) FROM tires WHERE quality_profile_id = @id AND organization_id = @o) + (SELECT COUNT(*) FROM item_categories WHERE quality_profile_id = @id AND organization_id = @o) AS n')).recordset[0].n;
    if (use > 0) throw new StockError('PROFILE_IN_USE', `This profile is assigned to ${use} item(s) or categories. Unassign it first.`, 409);
    const r = await pool.request().input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).query('DELETE FROM quality_profiles WHERE id = @id AND organization_id = @o');
    if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Profile not found', 404);
    await audit(req, ctx, 'DELETE', 'quality_profile', id, {});
    res.json({ id });
  } catch (err) { fail(res, err); }
});

router.put('/quality/assign', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const pid = b.profile_id === null || b.profile_id === '' || b.profile_id === undefined ? null : int(b.profile_id);
    const pool = await getPool();
    if (pid !== null) {
      const ok = (await pool.request().input('p', sql.Int, pid).input('o', sql.Int, ctx.orgId).query('SELECT id FROM quality_profiles WHERE id = @p AND organization_id = @o')).recordset.length;
      if (!ok) throw new StockError('NOT_FOUND', 'Profile not found', 404);
    }
    if (b.scope === 'category') {
      const r = await pool.request().input('id', sql.Int, int(b.id)).input('o', sql.Int, ctx.orgId).input('p', sql.Int, pid).query('UPDATE item_categories SET quality_profile_id = @p WHERE id = @id AND organization_id = @o');
      if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Category not found', 404);
    } else if (b.scope === 'item') {
      await inTransaction(async tx => {
        const cur = (await new sql.Request(tx).input('id', sql.Int, int(b.id)).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
          .query('SELECT id, quality_profile_id FROM tires WITH (UPDLOCK) WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
        if (!cur) throw new StockError('NOT_FOUND', 'Item not found', 404);
        await IM.applyExtra(tx, cur.id, { quality_profile_id: pid });
        await IM.logChanges(tx, { orgId: ctx.orgId, tireId: cur.id, userId: req.user.userId, before: { quality_profile_id: cur.quality_profile_id }, after: { quality_profile_id: pid } });
      });
    } else throw new StockError('INVALID_SCOPE', 'scope must be item or category', 400);
    await audit(req, ctx, 'UPDATE', 'quality_assignment', int(b.id), b);
    res.json({ scope: b.scope, id: int(b.id), profile_id: pid });
  } catch (err) { fail(res, err); }
});

router.get('/quality/assignments', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const cats = await pool.request().input('o', sql.Int, ctx.orgId).query('SELECT id, name, quality_profile_id FROM item_categories WHERE organization_id = @o ORDER BY name');
    const items = await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
      .query("SELECT id, LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS name, quality_profile_id FROM tires WHERE organization_id = @o AND branch_id = @b AND quality_profile_id IS NOT NULL ORDER BY model");
    res.json({ categories: cats.recordset, items: items.recordset });
  } catch (err) { fail(res, err); }
});

// ── Batches ────────────────────────────────────────────────────────────────
router.get('/quality/batches', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const where = [], inputs = {};
    const status = String(req.query.status || '');
    if (status && Q.QUALITY_STATUSES[status]) { where.push('AND b.quality_status = @st'); inputs.st = [sql.NVarChar(12), status]; }
    if (req.query.tire_id) { where.push('AND b.tire_id = @t'); inputs.t = [sql.Int, int(req.query.tire_id)]; }
    const q = String(req.query.q || '').trim().slice(0, 60);
    if (q) { where.push("AND (b.batch_no LIKE @q OR t.brand + ' ' + t.model + ' ' + t.size LIKE @q OR t.sku LIKE @q)"); inputs.q = [sql.NVarChar(80), '%' + q + '%']; }
    if (req.query.all !== '1') where.push('AND q.qty > 0');
    let rows = await batchRows(pool, ctx, where.join(' '), inputs);
    const flag = String(req.query.flag || '');
    if (flag === 'expired') rows = rows.filter(r => r.expired);
    else if (flag === 'near') rows = rows.filter(r => r.near_expiry);
    else if (flag === 'inspection') rows = rows.filter(r => r.inspection_overdue);
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/quality/batches/:id', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const id = int(req.params.id);
    const row = (await batchRows(pool, ctx, 'AND b.id = @id', { id: [sql.Int, id] }, 1))[0];
    if (!row) throw new StockError('NOT_FOUND', 'Batch not found', 404);
    const balances = (await pool.request().input('id', sql.Int, id).query('SELECT x.location_id, l.name AS location_name, l.kind, x.qty FROM batch_location_stock x LEFT JOIN stock_locations l ON l.id = x.location_id WHERE x.batch_id = @id AND x.qty <> 0')).recordset;
    const events = (await pool.request().input('id', sql.Int, id).query('SELECT e.id, e.event_type, e.from_status, e.to_status, e.result, e.qty, e.reason, e.reference, e.recall_id, e.created_at, u.name AS user_name FROM batch_quality_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.batch_id = @id ORDER BY e.id DESC')).recordset;
    const recalls = (await pool.request().input('id', sql.Int, id).query('SELECT r.id, r.recall_no, r.title, r.status, r.severity FROM product_recall_batches rb JOIN product_recalls r ON r.id = rb.recall_id WHERE rb.batch_id = @id ORDER BY r.id DESC')).recordset;
    const disposals = (await pool.request().input('id', sql.Int, id).query('SELECT id, disposal_no, qty, method, reason, reference, value, created_at FROM quality_disposals WHERE batch_id = @id ORDER BY id DESC')).recordset;
    res.json({ ...row, balances, events, recalls, disposals });
  } catch (err) { fail(res, err); }
});

// Hold, release or mark damaged. Holding is open to any user as a precaution; releasing and damage decisions need a manager
// (an administrator where the product's profile says so). Recalled batches leave recall only when the recall is closed.
router.post('/quality/batches/:id/status', async (req, res) => {
  try {
    const ctx = getContext(req);
    const to = String(req.body?.status || '');
    if (to === 'recalled') throw new StockError('USE_RECALL', 'Open a recall to mark batches as recalled', 400);
    if (!['on_hold', 'released', 'damaged'].includes(to)) throw new StockError('INVALID_STATUS', 'Status must be on_hold, released or damaged', 400);
    const reason = reasonOf(req.body?.reason, to === 'released' ? 'A reason for the release decision' : 'A reason');
    const out = await inTransaction(async tx => {
      const b = await lockBatch(tx, ctx, int(req.params.id));
      if (b.quality_status === to) throw new StockError('NO_CHANGE', `Batch is already ${Q.QUALITY_STATUSES[to].toLowerCase()}`, 409);
      if (b.quality_status === 'recalled') throw new StockError('RECALLED', 'This batch is recalled. It can only be released by closing its recall.', 409);
      const manager = P.has(req.user, 'quality.manage');
      if ((to === 'released' || to === 'damaged') && !manager) throw new StockError('FORBIDDEN', 'Only a manager or administrator can release or write off a batch as damaged', 403);
      if (to === 'released' && b.eff_release_approval === 'admin' && !isAdmin(req)) throw new StockError('ADMIN_RELEASE_REQUIRED', 'Releasing this product needs an administrator (set by its quality profile)', 403);
      await new sql.Request(tx).input('id', sql.Int, b.id).input('s', sql.NVarChar(12), to).input('r', sql.NVarChar(500), reason).input('u', sql.Int, req.user.userId ?? null)
        .query('UPDATE stock_batches SET quality_status = @s, status_reason = @r, status_changed_at = GETDATE(), status_changed_by = @u WHERE id = @id');
      await logEvent(tx, ctx, req.user.userId, { batchId: b.id, tireId: b.tire_id, branchId: b.branch_id, type: to === 'released' ? 'release' : to === 'damaged' ? 'damage' : 'hold', from: b.quality_status, to, reason });
      return { batch_id: b.id, batch_no: b.batch_no, item_name: b.item_name, from: b.quality_status, to };
    });
    await audit(req, ctx, 'UPDATE', 'batch_quality', out.batch_id, out);
    res.json(out);
  } catch (err) { fail(res, err); }
});

router.post('/quality/batches/:id/inspections', async (req, res) => {
  try {
    const ctx = getContext(req);
    const result = String(req.body?.result || '');
    if (!['pass', 'fail'].includes(result)) throw new StockError('INVALID_RESULT', 'Result must be pass or fail', 400);
    const notes = result === 'fail' ? reasonOf(req.body?.notes, 'Notes describing the failure') : text(req.body?.notes, 500);
    const out = await inTransaction(async tx => {
      const b = await lockBatch(tx, ctx, int(req.params.id));
      await new sql.Request(tx).input('id', sql.Int, b.id).query('UPDATE stock_batches SET last_inspected_at = GETDATE() WHERE id = @id');
      await logEvent(tx, ctx, req.user.userId, { batchId: b.id, tireId: b.tire_id, branchId: b.branch_id, type: 'inspection', result, reason: notes });
      let held = false;
      if (result === 'fail' && b.quality_status === 'released') {
        const why = `Failed inspection: ${notes}`.slice(0, 500);
        await new sql.Request(tx).input('id', sql.Int, b.id).input('r', sql.NVarChar(500), why).input('u', sql.Int, req.user.userId ?? null)
          .query("UPDATE stock_batches SET quality_status = 'on_hold', status_reason = @r, status_changed_at = GETDATE(), status_changed_by = @u WHERE id = @id");
        await logEvent(tx, ctx, req.user.userId, { batchId: b.id, tireId: b.tire_id, branchId: b.branch_id, type: 'hold', from: 'released', to: 'on_hold', reason: why });
        held = true;
      }
      return { batch_id: b.id, result, placed_on_hold: held };
    });
    await audit(req, ctx, 'CREATE', 'batch_inspection', out.batch_id, out);
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

// ── Disposal / write-off / return to supplier ──────────────────────────────
router.post('/quality/batches/:id/dispose', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const b0 = req.body || {};
    const qty = int(b0.qty);
    if (!(qty > 0)) throw new StockError('INVALID_QTY', 'Quantity must be a positive whole number', 400);
    if (!Q.DISPOSAL_METHODS[b0.method]) throw new StockError('INVALID_METHOD', 'Method must be one of: ' + Object.keys(Q.DISPOSAL_METHODS).join(', '), 400);
    const reason = reasonOf(b0.reason, 'A reason for the disposal');
    const reference = text(b0.reference, 100);
    const lossCause = b0.loss_cause ? String(b0.loss_cause) : null;
    if (lossCause && !require('../utils/losses').CAUSES[lossCause]) throw new StockError('INVALID_CAUSE', 'Unknown loss cause', 400);
    const out = await inTransaction(async tx => {
      const b = await lockBatch(tx, ctx, int(req.params.id));
      const bal = (await new sql.Request(tx).input('id', sql.Int, b.id).query('SELECT x.location_id, x.qty FROM batch_location_stock x WITH (UPDLOCK) WHERE x.batch_id = @id AND x.qty > 0 ORDER BY x.qty DESC')).recordset;
      const use = b0.location_id ? bal.filter(x => x.location_id === int(b0.location_id)) : bal;
      const have = use.reduce((a, x) => a + x.qty, 0);
      if (have < qty) throw new StockError('INSUFFICIENT_BATCH_STOCK', `Batch ${b.batch_no} has only ${have} unit(s)${b0.location_id ? ' at that location' : ''}`, 409, { available: have });
      const unit = Number(b.unit_cost ?? b.cost_price), value = round2(qty * unit);
      const threshold = (await companyRules(tx.request ? { request: () => new sql.Request(tx) } : await getPool(), ctx.orgId)).disposal_admin_value;
      if (threshold != null && value > threshold && !isAdmin(req)) throw new StockError('ADMIN_APPROVAL_REQUIRED', `Disposals above ${threshold} need an administrator (this one is worth ${value})`, 403, { value, threshold });
      const open = (await new sql.Request(tx).input('id', sql.Int, b.id).query("SELECT TOP 1 r.id FROM product_recall_batches rb JOIN product_recalls r ON r.id = rb.recall_id WHERE rb.batch_id = @id AND r.status = 'open' ORDER BY r.id DESC")).recordset[0];
      const no = await nextDocNumber(new sql.Request(tx), 'quality_disposals', 'DSP');
      const d = (await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, b.branch_id).input('no', sql.NVarChar(30), no).input('bt', sql.Int, b.id).input('t', sql.Int, b.tire_id)
        .input('n', sql.NVarChar(200), b.item_name).input('bn', sql.NVarChar(60), b.batch_no).input('q', sql.Int, qty).input('m', sql.NVarChar(20), b0.method).input('r', sql.NVarChar(500), reason)
        .input('ref', sql.NVarChar(100), reference).input('s', sql.Int, b0.supplier_id ? int(b0.supplier_id) : null).input('uc', sql.Decimal(18, 4), unit).input('v', sql.Decimal(18, 2), value)
        .input('rc', sql.Int, open?.id ?? null).input('u', sql.Int, req.user.userId ?? null).input('lc', sql.NVarChar(20), lossCause)
        .query(`INSERT INTO quality_disposals (organization_id, branch_id, disposal_no, batch_id, tire_id, item_name, batch_no, qty, method, reason, reference, supplier_id, unit_cost, value, recall_id, user_id, loss_cause)
                OUTPUT INSERTED.id VALUES (@o, @b, @no, @bt, @t, @n, @bn, @q, @m, @r, @ref, @s, @uc, @v, @rc, @u, @lc)`)).recordset[0];
      let left = qty;
      for (const x of use) {
        if (left <= 0) break;
        const take = Math.min(left, x.qty);
        await postMovement(tx, { orgId: ctx.orgId, tireId: b.tire_id, qtyChange: -take, reason: MOVEMENT.ADJUSTMENT, reference: no, refId: d.id, locationId: x.location_id, batchId: b.id,
          includeExpired: true, userId: req.user.userId, notes: `${Q.DISPOSAL_METHODS[b0.method]}: ${reason}`.slice(0, 500), idempotencyKey: `dsp:${d.id}:${x.location_id}` });
        left -= take;
      }
      await logEvent(tx, ctx, req.user.userId, { batchId: b.id, tireId: b.tire_id, branchId: b.branch_id, type: 'disposal', qty, reason: `${Q.DISPOSAL_METHODS[b0.method]}: ${reason}`.slice(0, 500), reference: no, recallId: open?.id });
      return { id: d.id, disposal_no: no, batch_id: b.id, batch_no: b.batch_no, item_name: b.item_name, qty, method: b0.method, unit_cost: unit, value, recall_id: open?.id ?? null };
    });
    await audit(req, ctx, 'CREATE', 'quality_disposal', out.id, out);
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

router.get('/quality/disposals', async (req, res) => {
  try {
    const ctx = getContext(req);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 365, 1), 3650);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).input('d', sql.Int, days)
      .query(`SELECT TOP 500 d.id, d.disposal_no, d.item_name, d.batch_id, d.batch_no, d.qty, d.method, d.reason, d.reference, d.unit_cost, d.value, d.created_at, d.recall_id, rc.recall_no, u.name AS user_name, s.name AS supplier_name
              FROM quality_disposals d LEFT JOIN users u ON u.id = d.user_id LEFT JOIN product_recalls rc ON rc.id = d.recall_id LEFT JOIN suppliers s ON s.id = d.supplier_id
              WHERE d.organization_id = @o AND (@b IS NULL OR d.branch_id = @b) AND d.created_at >= DATEADD(DAY, -@d, GETDATE()) ORDER BY d.id DESC`);
    const rows = r.recordset;
    const by = {};
    for (const x of rows) { const m = by[x.method] ??= { method: x.method, label: Q.DISPOSAL_METHODS[x.method] ?? x.method, qty: 0, value: 0 }; m.qty += x.qty; m.value += Number(x.value); }
    res.json({ days, rows, totals: Object.values(by).map(m => ({ ...m, value: round2(m.value) })), total_value: round2(rows.reduce((a, x) => a + Number(x.value), 0)), total_qty: rows.reduce((a, x) => a + x.qty, 0) });
  } catch (err) { fail(res, err); }
});

// ── Customer returns ───────────────────────────────────────────────────────
// A returned unit is either put back into sellable stock (only if its batch is released and unexpired) or placed in quarantine
// until it has been inspected and a release or disposal decision is made.
router.post('/quality/returns', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const b0 = req.body || {};
    const qty = int(b0.qty);
    if (!(qty > 0)) throw new StockError('INVALID_QTY', 'Quantity must be a positive whole number', 400);
    if (!['quarantine', 'restock'].includes(b0.disposition)) throw new StockError('INVALID_DISPOSITION', 'Choose quarantine or restock', 400);
    const reason = reasonOf(b0.reason, 'A reason for the return');
    const out = await inTransaction(async tx => {
      const t = (await new sql.Request(tx).input('id', sql.Int, int(b0.tire_id)).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
        .query("SELECT id, branch_id, tracking, LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS item_name FROM tires WITH (UPDLOCK) WHERE id = @id AND organization_id = @o AND branch_id = @b")).recordset[0];
      if (!t) throw new StockError('NOT_FOUND', 'Item not found', 404);
      let batch = null;
      if (t.tracking !== 'none') {
        const rq = new sql.Request(tx).input('t', sql.Int, t.id).input('o', sql.Int, ctx.orgId);
        const r = b0.batch_id ? await rq.input('id', sql.Int, int(b0.batch_id)).query('SELECT id, batch_no, expiry_date, quality_status FROM stock_batches WHERE id = @id AND tire_id = @t AND organization_id = @o AND is_legacy = 0')
          : await rq.input('n', sql.NVarChar(60), String(b0.batch_no || '').trim()).query('SELECT id, batch_no, expiry_date, quality_status FROM stock_batches WHERE batch_no = @n AND tire_id = @t AND organization_id = @o AND is_legacy = 0');
        batch = r.recordset[0];
        if (!batch) throw new StockError('BATCH_NOT_FOUND', `${t.item_name} is tracked by batch: give the batch or serial number the customer received`, 400);
      }
      let loc;
      if (b0.disposition === 'restock') {
        if (batch && batch.quality_status !== 'released') throw new StockError('RETURN_NOT_RESTOCKABLE', `Batch ${batch.batch_no} is ${Q.QUALITY_STATUSES[batch.quality_status].toLowerCase()}; place the return in quarantine instead`, 409);
        if (batch && batch.expiry_date && dayOf(batch.expiry_date) < today()) throw new StockError('RETURN_NOT_RESTOCKABLE', `Batch ${batch.batch_no} is past its expiry date; place the return in quarantine and dispose of it`, 409);
        loc = { id: await defaultLocationId(tx, ctx.orgId, t.branch_id), name: 'default location' };
      } else {
        let q = (await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, t.branch_id)
          .query("SELECT TOP 1 id, name FROM stock_locations WHERE organization_id = @o AND branch_id = @b AND kind = 'quarantine' AND is_active = 1 ORDER BY id")).recordset[0];
        if (!q) q = (await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, t.branch_id)
          .query("INSERT INTO stock_locations (organization_id, branch_id, name, code, kind) OUTPUT INSERTED.id, INSERTED.name VALUES (@o, @b, 'Returns quarantine', 'RETQ', 'quarantine')")).recordset[0];
        loc = q;
      }
      const ref = text(b0.reference, 100) || 'Customer return';
      await postMovement(tx, { orgId: ctx.orgId, tireId: t.id, qtyChange: qty, reason: MOVEMENT.ADJUSTMENT, reference: ref, locationId: loc.id, batchId: batch?.id, userId: req.user.userId,
        notes: `Customer return (${b0.disposition}): ${reason}`.slice(0, 500) });
      if (batch) await logEvent(tx, ctx, req.user.userId, { batchId: batch.id, tireId: t.id, branchId: t.branch_id, type: 'customer_return', qty, reason: `${b0.disposition}: ${reason}`.slice(0, 500), reference: ref });
      return { tire_id: t.id, item_name: t.item_name, batch_no: batch?.batch_no ?? null, qty, disposition: b0.disposition, location: loc.name };
    });
    await audit(req, ctx, 'CREATE', 'customer_return', out.tire_id, out);
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

// ── Recalls ────────────────────────────────────────────────────────────────
async function recallBatchFacts(tx, batchId) {
  const q = (await new sql.Request(tx).input('id', sql.Int, batchId).query('SELECT ISNULL(SUM(qty), 0) AS n FROM batch_location_stock WHERE batch_id = @id')).recordset[0].n;
  const sold = (await new sql.Request(tx).input('id', sql.Int, batchId).query("SELECT ISNULL(SUM(-qty_change), 0) AS n FROM stock_movements WHERE batch_id = @id AND reason IN ('sale', 'sale_voided', 'sale_deleted')")).recordset[0].n;
  return { onHand: q, sold: Math.max(0, sold) };
}
async function addToRecall(tx, ctx, req, recall, batchIds) {
  const added = [];
  for (const raw of batchIds) {
    const b = await lockBatch(tx, ctx, int(raw));
    const dup = (await new sql.Request(tx).input('r', sql.Int, recall.id).input('b', sql.Int, b.id).query('SELECT 1 AS x FROM product_recall_batches WHERE recall_id = @r AND batch_id = @b')).recordset.length;
    if (dup) continue;
    const f = await recallBatchFacts(tx, b.id);
    await new sql.Request(tx).input('r', sql.Int, recall.id).input('b', sql.Int, b.id).input('t', sql.Int, b.tire_id).input('n', sql.NVarChar(200), b.item_name).input('bn', sql.NVarChar(60), b.batch_no)
      .input('oh', sql.Int, f.onHand).input('s', sql.Int, f.sold).input('p', sql.NVarChar(12), b.quality_status)
      .query('INSERT INTO product_recall_batches (recall_id, batch_id, tire_id, item_name, batch_no, qty_on_hand, qty_sold, prior_status) VALUES (@r, @b, @t, @n, @bn, @oh, @s, @p)');
    if (b.quality_status !== 'recalled') {
      await new sql.Request(tx).input('id', sql.Int, b.id).input('r', sql.NVarChar(500), `Recall ${recall.recall_no}: ${recall.title}`.slice(0, 500)).input('u', sql.Int, req.user.userId ?? null)
        .query("UPDATE stock_batches SET quality_status = 'recalled', status_reason = @r, status_changed_at = GETDATE(), status_changed_by = @u WHERE id = @id");
    }
    await logEvent(tx, ctx, req.user.userId, { batchId: b.id, tireId: b.tire_id, branchId: b.branch_id, type: 'recall', from: b.quality_status, to: 'recalled', reason: recall.title, reference: recall.recall_no, recallId: recall.id, qty: f.onHand });
    added.push({ batch_id: b.id, batch_no: b.batch_no, item_name: b.item_name, qty_on_hand: f.onHand, qty_sold: f.sold });
  }
  return added;
}

router.post('/quality/recalls', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const b0 = req.body || {};
    const title = text(b0.title, 200);
    if (!title) throw new StockError('TITLE_REQUIRED', 'Give the recall a title', 400);
    const reason = text(b0.reason, 1000);
    if (!reason || reason.length < 3) throw new StockError('REASON_REQUIRED', 'Describe why the products are being recalled', 400);
    const severity = b0.severity || 'class2';
    if (!Q.RECALL_SEVERITIES[severity]) throw new StockError('INVALID_SEVERITY', 'Severity must be one of: ' + Object.keys(Q.RECALL_SEVERITIES).join(', '), 400);
    const ids = [...new Set((Array.isArray(b0.batch_ids) ? b0.batch_ids : []).map(int))];
    if (!ids.length || ids.some(n => !(n > 0))) throw new StockError('BATCHES_REQUIRED', 'Choose at least one batch to recall', 400);
    const out = await inTransaction(async tx => {
      const no = await nextDocNumber(new sql.Request(tx), 'product_recalls', 'RCL');
      const rc = (await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId ?? 0).input('no', sql.NVarChar(30), no).input('t', sql.NVarChar(200), title).input('r', sql.NVarChar(1000), reason)
        .input('s', sql.NVarChar(10), severity).input('src', sql.NVarChar(200), text(b0.source, 200)).input('u', sql.Int, req.user.userId ?? null)
        .query('INSERT INTO product_recalls (organization_id, branch_id, recall_no, title, reason, severity, source, created_by) OUTPUT INSERTED.id VALUES (@o, @b, @no, @t, @r, @s, @src, @u)')).recordset[0];
      const batches = await addToRecall(tx, ctx, req, { id: rc.id, recall_no: no, title }, ids);
      return { id: rc.id, recall_no: no, title, severity, batches };
    });
    await audit(req, ctx, 'CREATE', 'product_recall', out.id, { recall_no: out.recall_no, batches: out.batches.length });
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

router.get('/quality/recalls', async (req, res) => {
  try {
    const ctx = getContext(req);
    const st = ['open', 'closed'].includes(req.query.status) ? req.query.status : null;
    const r = await (await getPool()).request().input('o', sql.Int, ctx.orgId).input('st', sql.NVarChar(10), st)
      .query(`SELECT r.id, r.recall_no, r.title, r.severity, r.source, r.status, r.created_at, r.closed_at, u.name AS user_name,
                     (SELECT COUNT(*) FROM product_recall_batches WHERE recall_id = r.id) AS batches,
                     (SELECT ISNULL(SUM(x.qty), 0) FROM product_recall_batches rb JOIN batch_location_stock x ON x.batch_id = rb.batch_id WHERE rb.recall_id = r.id) AS on_hand,
                     (SELECT ISNULL(SUM(qty_sold), 0) FROM product_recall_batches WHERE recall_id = r.id) AS sold
              FROM product_recalls r LEFT JOIN users u ON u.id = r.created_by WHERE r.organization_id = @o AND (@st IS NULL OR r.status = @st) ORDER BY r.id DESC`);
    res.json(r.recordset.map(x => ({ ...x, severity_label: Q.RECALL_SEVERITIES[x.severity] ?? x.severity })));
  } catch (err) { fail(res, err); }
});

router.get('/quality/recalls/:id', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const id = int(req.params.id);
    const rc = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).query('SELECT r.*, u.name AS user_name, c.name AS closed_by_name FROM product_recalls r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN users c ON c.id = r.closed_by WHERE r.id = @id AND r.organization_id = @o')).recordset[0];
    if (!rc) throw new StockError('NOT_FOUND', 'Recall not found', 404);
    const batches = (await pool.request().input('id', sql.Int, id).query(`
      SELECT rb.batch_id, rb.tire_id, rb.item_name, rb.batch_no, rb.qty_on_hand AS qty_at_recall, rb.qty_sold, rb.prior_status, rb.disposition, b.quality_status,
             (SELECT ISNULL(SUM(x.qty), 0) FROM batch_location_stock x WHERE x.batch_id = rb.batch_id) AS qty_now,
             (SELECT ISNULL(SUM(d.qty), 0) FROM quality_disposals d WHERE d.batch_id = rb.batch_id AND d.recall_id = rb.recall_id) AS qty_disposed
      FROM product_recall_batches rb JOIN stock_batches b ON b.id = rb.batch_id WHERE rb.recall_id = @id ORDER BY rb.item_name, rb.batch_no`)).recordset;
    const sales = (await pool.request().input('id', sql.Int, id).query(`
      SELECT TOP 300 mv.batch_id, rb.batch_no, rb.item_name, mv.reference, -mv.qty_change AS qty, mv.created_at, mv.reason
      FROM product_recall_batches rb JOIN stock_movements mv ON mv.batch_id = rb.batch_id
      WHERE rb.recall_id = @id AND mv.reason IN ('sale', 'sale_voided', 'sale_deleted') ORDER BY mv.id DESC`)).recordset;
    res.json({ ...rc, severity_label: Q.RECALL_SEVERITIES[rc.severity] ?? rc.severity, batches, sales });
  } catch (err) { fail(res, err); }
});

router.post('/quality/recalls/:id/batches', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const ids = [...new Set((Array.isArray(req.body?.batch_ids) ? req.body.batch_ids : []).map(int))];
    if (!ids.length || ids.some(n => !(n > 0))) throw new StockError('BATCHES_REQUIRED', 'Choose at least one batch', 400);
    const out = await inTransaction(async tx => {
      const rc = (await new sql.Request(tx).input('id', sql.Int, int(req.params.id)).input('o', sql.Int, ctx.orgId).query('SELECT id, recall_no, title, status FROM product_recalls WITH (UPDLOCK) WHERE id = @id AND organization_id = @o')).recordset[0];
      if (!rc) throw new StockError('NOT_FOUND', 'Recall not found', 404);
      if (rc.status !== 'open') throw new StockError('RECALL_CLOSED', 'This recall is closed', 409);
      return addToRecall(tx, ctx, req, rc, ids);
    });
    await audit(req, ctx, 'UPDATE', 'product_recall', int(req.params.id), { added: out.length });
    res.status(201).json({ added: out });
  } catch (err) { fail(res, err); }
});

// Closing is an administrator decision. Every batch must be resolved: disposed (no stock left), released after clearance, or retained.
router.post('/quality/recalls/:id/close', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const note = reasonOf(req.body?.note, 'A closure note');
    const given = Object.fromEntries((Array.isArray(req.body?.resolutions) ? req.body.resolutions : []).map(x => [int(x.batch_id), x.disposition]));
    const out = await inTransaction(async tx => {
      const rc = (await new sql.Request(tx).input('id', sql.Int, int(req.params.id)).input('o', sql.Int, ctx.orgId).query('SELECT id, recall_no, title, status FROM product_recalls WITH (UPDLOCK) WHERE id = @id AND organization_id = @o')).recordset[0];
      if (!rc) throw new StockError('NOT_FOUND', 'Recall not found', 404);
      if (rc.status !== 'open') throw new StockError('RECALL_CLOSED', 'This recall is already closed', 409);
      const batches = (await new sql.Request(tx).input('id', sql.Int, rc.id).query('SELECT batch_id, tire_id, batch_no, item_name FROM product_recall_batches WHERE recall_id = @id')).recordset;
      const unresolved = [], plan = [];
      for (const b of batches) {
        const f = await recallBatchFacts(tx, b.batch_id);
        let d = given[b.batch_id];
        if (!d && f.onHand === 0) d = 'disposed';
        if (!['release', 'disposed', 'retain'].includes(d)) { unresolved.push(`${b.item_name} ${b.batch_no}`); continue; }
        if (d === 'disposed' && f.onHand > 0) throw new StockError('STOCK_REMAINS', `${b.item_name} batch ${b.batch_no} still has ${f.onHand} unit(s) in stock. Dispose of them, release the batch or retain it.`, 409, { batchId: b.batch_id, onHand: f.onHand });
        plan.push({ b, d });
      }
      if (unresolved.length) throw new StockError('UNRESOLVED_BATCHES', `Decide what happens to: ${unresolved.join(', ')}`, 400, { unresolved });
      for (const { b, d } of plan) {
        await new sql.Request(tx).input('r', sql.Int, rc.id).input('b', sql.Int, b.batch_id).input('d', sql.NVarChar(10), d).query('UPDATE product_recall_batches SET disposition = @d WHERE recall_id = @r AND batch_id = @b');
        if (d === 'release') {
          const why = `Recall ${rc.recall_no} closed, batch cleared: ${note}`.slice(0, 500);
          await new sql.Request(tx).input('id', sql.Int, b.batch_id).input('r', sql.NVarChar(500), why).input('u', sql.Int, req.user.userId ?? null)
            .query("UPDATE stock_batches SET quality_status = 'released', status_reason = @r, status_changed_at = GETDATE(), status_changed_by = @u WHERE id = @id");
          await logEvent(tx, ctx, req.user.userId, { batchId: b.batch_id, tireId: b.tire_id, type: 'release', from: 'recalled', to: 'released', reason: why, reference: rc.recall_no, recallId: rc.id });
        } else {
          await logEvent(tx, ctx, req.user.userId, { batchId: b.batch_id, tireId: b.tire_id, type: 'recall_close', from: 'recalled', to: 'recalled', reason: `${d === 'disposed' ? 'Disposed' : 'Retained'}: ${note}`.slice(0, 500), reference: rc.recall_no, recallId: rc.id });
        }
      }
      await new sql.Request(tx).input('id', sql.Int, rc.id).input('u', sql.Int, req.user.userId ?? null).input('n', sql.NVarChar(1000), note)
        .query("UPDATE product_recalls SET status = 'closed', closed_at = GETDATE(), closed_by = @u, closure_note = @n WHERE id = @id");
      return { id: rc.id, recall_no: rc.recall_no, status: 'closed', released: plan.filter(p => p.d === 'release').length, disposed: plan.filter(p => p.d === 'disposed').length, retained: plan.filter(p => p.d === 'retain').length };
    });
    await audit(req, ctx, 'UPDATE', 'product_recall', out.id, out);
    res.json(out);
  } catch (err) { fail(res, err); }
});

// ── Alerts ─────────────────────────────────────────────────────────────────
router.get('/quality/alerts', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const rules = await companyRules(pool, ctx.orgId);
    const rows = await batchRows(pool, ctx, 'AND q.qty > 0', {}, 2000);
    const pick = f => rows.filter(f);
    const expired = pick(r => r.expired && r.qty_normal > 0);
    const near = pick(r => r.near_expiry && r.quality_status === 'released');
    const overdue = pick(r => r.inspection_overdue).sort((a, b) => b.inspection_days_overdue - a.inspection_days_overdue);
    const dueSoon = pick(r => r.inspection_due_soon);
    const holds = pick(r => r.quality_status === 'on_hold').map(r => ({ ...r, stale: (r.status_age_days ?? 0) >= rules.stale_hold_days }));
    const recalled = pick(r => r.quality_status === 'recalled');
    const damaged = pick(r => r.quality_status === 'damaged');
    const sum = list => ({ batches: list.length, units: list.reduce((a, r) => a + r.qty, 0), value: round2(list.reduce((a, r) => a + r.value, 0)) });
    const summary = { expired: sum(expired), near_expiry: sum(near), inspection_overdue: sum(overdue), inspection_due_soon: sum(dueSoon), on_hold: sum(holds), stale_holds: sum(holds.filter(h => h.stale)), recalled: sum(recalled), damaged: sum(damaged) };
    const open_recalls = (await pool.request().input('o', sql.Int, ctx.orgId).query("SELECT COUNT(*) AS n FROM product_recalls WHERE organization_id = @o AND status = 'open'")).recordset[0].n;
    const needs = summary.expired.batches + summary.near_expiry.batches + summary.inspection_overdue.batches + summary.stale_holds.batches + summary.recalled.batches + summary.damaged.batches;
    res.json({ summary, open_recalls, needs_attention: needs, stale_hold_days: rules.stale_hold_days, expired, near_expiry: near, inspection_overdue: overdue, inspection_due_soon: dueSoon, on_hold: holds, recalled, damaged });
  } catch (err) { fail(res, err); }
});

module.exports = router;
