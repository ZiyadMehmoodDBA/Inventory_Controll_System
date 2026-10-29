// Stock ledger API: movements, adjustments (with approval) and reconciliation.
// Mounted before routes/inventory.js on /api/inventory; unmatched paths fall through to it.
const express = require('express');
const router  = express.Router();
const { getPool, sql }  = require('../db');
const { requireRole }   = require('../middleware/auth');
const P = require('../utils/permissions');
const { writeAudit }    = require('../utils/audit');
const { getContext }    = require('../context');
const LOCATION_KINDS = ['normal', 'quarantine', 'damaged'];
const { ACTIVE_RESERVATION } = require('../utils/stock');
const { StockError, ADJUSTMENT_REASONS, postMovement, createAdjustment, defaultLocationId, transferStock, valuationMethod, VALUATION_METHODS } = require('../utils/stock');

// Org comes from the token. Branch-scoped users are limited to their own branch.
const scope = req => ({ orgId: req.user.orgId, branchId: req.user.branchId ?? null, userId: req.user.userId, role: req.user.role, perms: req.user.perms, approvalLimit: req.user.approvalLimit ?? null });

function fail(res, err) {
  if (err instanceof StockError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  console.error('[stock]', err.message);
  return res.status(500).json({ error: 'Stock operation failed' });
}

async function inTransaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try { const out = await fn(tx); await tx.commit(); return out; }
  catch (e) { try { await tx.rollback(); } catch { /* already rolled back */ } throw e; }
}

router.get('/adjustments/reasons', (req, res) => {
  res.json(Object.entries(ADJUSTMENT_REASONS).map(([code, r]) => ({ code, ...r })));
});

// Movement history, newest first (optionally for one item and/or one location). Optional tire_id filter; keyset paging with ?before=<id>.
router.get('/movements', async (req, res) => {
  try {
    const s = scope(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const tireId = parseInt(req.query.tire_id, 10) || null;
    const before = parseInt(req.query.before, 10) || null;
    const locationId = parseInt(req.query.location_id, 10) || null;
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, s.orgId).input('b', sql.Int, s.branchId).input('t', sql.Int, tireId)
      .input('before', sql.Int, before).input('n', sql.Int, limit).input('loc', sql.Int, locationId)
      .query(`SELECT TOP (@n) m.id, m.tire_id, ISNULL(m.item_name, t.brand + ' ' + t.model + ' ' + t.size) AS item_name, m.branch_id,
                     m.qty_change, m.qty_before, m.qty_after, m.unit_cost, m.reason, m.reference, m.notes, m.user_id,
                     u.name AS user_name, m.created_at, m.location_id, sl.name AS location_name,
                     m.batch_id, sb.batch_no, sb.expiry_date
              FROM stock_movements m
              LEFT JOIN stock_batches sb ON sb.id = m.batch_id
              LEFT JOIN tires t ON t.id = m.tire_id
              LEFT JOIN users u ON u.id = m.user_id
              LEFT JOIN stock_locations sl ON sl.id = m.location_id
              WHERE m.organization_id = @o AND (@b IS NULL OR m.branch_id = @b)
                AND (@t IS NULL OR m.tire_id = @t) AND (@before IS NULL OR m.id < @before) AND (@loc IS NULL OR m.location_id = @loc)
              ORDER BY m.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.get('/adjustments', async (req, res) => {
  try {
    const s = scope(req);
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
    const mine = s.role === 'staff';   // staff see only their own requests
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, s.orgId).input('b', sql.Int, s.branchId).input('st', sql.NVarChar(20), status)
      .input('u', sql.Int, mine ? s.userId : null)
      .query(`SELECT TOP 200 a.id, a.tire_id, a.item_name, a.qty_change, a.reason_code, a.notes, a.status, a.requested_by,
                     ru.name AS requested_by_name, a.requested_at, a.decided_by, du.name AS decided_by_name, a.decided_at, a.decision_note,
                     a.location_id, sl.name AS location_name
              FROM stock_adjustments a
              LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users du ON du.id = a.decided_by
              LEFT JOIN stock_locations sl ON sl.id = a.location_id
              WHERE a.organization_id = @o AND (@b IS NULL OR a.branch_id = @b) AND (@st IS NULL OR a.status = @st)
                AND (@u IS NULL OR a.requested_by = @u)
              ORDER BY a.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.post('/adjustments', P.requirePermission('stock.adjust_request', 'stock.adjust_direct'), async (req, res) => {
  try {
    const s = scope(req);
    const { tire_id, qty_change, reason_code, notes, location_id, batch_id, batch_no, expiry_date } = req.body || {};
    const out = await inTransaction(tx => createAdjustment(tx, {
      orgId: s.orgId, user: s, tireId: parseInt(tire_id, 10), qtyChange: Number(qty_change), reasonCode: reason_code, notes,
      locationId: location_id ? parseInt(location_id, 10) : null,
      batchId: batch_id ? parseInt(batch_id, 10) : null,
      batch: batch_no ? { batchNo: batch_no, expiryDate: expiry_date || null } : null,
    }));
    const pool = await getPool();
    writeAudit(pool, { orgId: s.orgId, branchId: s.branchId, userId: s.userId, action: 'CREATE', entity: 'stock_adjustment', entityId: out.id,
      before: null, after: { tire_id, qty_change: Number(qty_change), reason_code, status: out.status } });
    res.status(out.status === 'pending' ? 202 : 201).json(out);
  } catch (err) { fail(res, err); }
});

async function decide(req, res, approve) {
  try {
    const s = scope(req);
    const id = parseInt(req.params.id, 10);
    const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
    const out = await inTransaction(async tx => {
      const r = await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, s.orgId)
        .query('SELECT * FROM stock_adjustments WITH (UPDLOCK) WHERE id = @id AND organization_id = @o');
      const a = r.recordset[0];
      if (!a || (s.branchId != null && a.branch_id !== s.branchId)) throw new StockError('NOT_FOUND', 'Adjustment not found', 404);
      if (a.status !== 'pending') throw new StockError('ALREADY_DECIDED', `Adjustment is already ${a.status}`, 409);
      if (a.requested_by === s.userId) throw new StockError('SELF_APPROVAL', 'You cannot approve or reject your own adjustment', 403);
      if (approve && s.role !== 'org_admin') {
        // Within assigned authority: restricted reasons need their own permission; the role's approval limit caps the value.
        if (!s.perms?.has('stock.approve_restricted') && (await P.restrictedReasons(tx, s.orgId)).includes(a.reason_code)) throw new StockError('RESTRICTED_REASON', 'This is a restricted adjustment. Only an authority with permission to approve restricted adjustments can approve it.', 403);
        if (s.approvalLimit != null) {
          const c = (await new sql.Request(tx).input('t', sql.Int, a.tire_id).query('SELECT cost_price FROM tires WHERE id = @t')).recordset[0];
          const value = Math.abs(a.qty_change) * Number(c?.cost_price || 0);
          if (value > s.approvalLimit) throw new StockError('APPROVAL_LIMIT', `This adjustment is worth ${value.toFixed(2)}, above your approval limit of ${s.approvalLimit.toFixed(2)}. It needs a higher authority.`, 403, { value, limit: s.approvalLimit });
        }
      }

      let movementId = null;
      if (approve) {
        const mv = await postMovement(tx, {
          orgId: s.orgId, tireId: a.tire_id, qtyChange: a.qty_change, reason: 'adjustment', reference: `ADJ-${a.id}`, refId: a.id, locationId: a.location_id ?? null, batchId: a.batch_id ?? undefined, includeExpired: true,
          notes: `${ADJUSTMENT_REASONS[a.reason_code]?.label ?? a.reason_code}${a.notes ? `: ${a.notes}` : ''}`.slice(0, 500),
          userId: s.userId, idempotencyKey: `adj:${a.id}`,
        });
        movementId = mv.movementId;
      }
      await new sql.Request(tx).input('id', sql.Int, id).input('st', sql.NVarChar(20), approve ? 'approved' : 'rejected')
        .input('u', sql.Int, s.userId).input('n', sql.NVarChar(300), note).input('m', sql.Int, movementId)
        .query('UPDATE stock_adjustments SET status = @st, decided_by = @u, decided_at = GETDATE(), decision_note = @n, movement_id = @m WHERE id = @id');
      return { id, status: approve ? 'approved' : 'rejected', movementId };
    });
    const pool = await getPool();
    writeAudit(pool, { orgId: s.orgId, branchId: s.branchId, userId: s.userId, action: 'UPDATE', entity: 'stock_adjustment', entityId: id,
      before: { status: 'pending' }, after: { status: out.status, note } });
    res.json(out);
  } catch (err) { fail(res, err); }
}

router.post('/adjustments/:id/approve', P.requirePermission('stock.approve'), (req, res) => decide(req, res, true));
router.post('/adjustments/:id/reject',  P.requirePermission('stock.approve'), (req, res) => decide(req, res, false));

// Items whose cached balance differs from the sum of their movements. Admin only.
router.get('/reconciliation', P.requirePermission('reports.audit'), async (req, res) => {
  try {
    const s = scope(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, s.orgId)
      .query(`SELECT t.id AS tire_id, t.brand + ' ' + t.model + ' ' + t.size AS item_name, t.branch_id, t.stock AS recorded_stock,
                     ISNULL(m.total, 0) AS ledger_total, t.stock - ISNULL(m.total, 0) AS difference
              FROM tires t OUTER APPLY (SELECT SUM(qty_change) AS total FROM stock_movements WHERE tire_id = t.id) m
              WHERE t.organization_id = @o AND t.stock <> ISNULL(m.total, 0)
              ORDER BY ABS(t.stock - ISNULL(m.total, 0)) DESC`);
    const loc = await pool.request().input('o', sql.Int, s.orgId)
      .query(`SELECT t.id AS tire_id, t.brand + ' ' + t.model + ' ' + t.size AS item_name, t.branch_id, t.stock AS recorded_stock,
                     ISNULL(x.total, 0) AS location_total, t.stock - ISNULL(x.total, 0) AS difference
              FROM tires t OUTER APPLY (SELECT SUM(qty) AS total FROM item_location_stock WHERE tire_id = t.id) x
              WHERE t.organization_id = @o AND t.stock <> ISNULL(x.total, 0)
              ORDER BY ABS(t.stock - ISNULL(x.total, 0)) DESC`);
    // tracked items: batch balances must add up to the item's location balances
    const bt = await pool.request().input('o', sql.Int, s.orgId)
      .query(`SELECT t.id AS tire_id, t.brand + ' ' + t.model + ' ' + t.size AS item_name, t.branch_id, t.stock AS recorded_stock,
                     ISNULL(x.total, 0) AS batch_total, t.stock - ISNULL(x.total, 0) AS difference
              FROM tires t OUTER APPLY (SELECT SUM(bl.qty) AS total FROM batch_location_stock bl JOIN stock_batches b ON b.id = bl.batch_id WHERE b.tire_id = t.id) x
              WHERE t.organization_id = @o AND t.tracking <> 'none' AND t.stock <> ISNULL(x.total, 0)
              ORDER BY ABS(t.stock - ISNULL(x.total, 0)) DESC`);
    const items = await pool.request().input('o', sql.Int, s.orgId).query('SELECT COUNT(*) AS n FROM tires WHERE organization_id = @o');
    res.json({ checked: items.recordset[0].n, mismatches: r.recordset.length, items: r.recordset,
               location_mismatches: loc.recordset.length, location_items: loc.recordset,
               batch_mismatches: bt.recordset.length, batch_items: bt.recordset });
  } catch (err) { fail(res, err); }
});

// ── Valuation, replenishment and margin ─────────────────────────────────────
const { METHOD_INFO, computeValuation } = require('../utils/valuation');
const METHOD_LABEL = Object.fromEntries(Object.entries(METHOD_INFO).map(([k, v]) => [k, v.label]));
const round2 = n => Math.round(n * 100) / 100;

router.get('/valuation-method', async (req, res) => {
  try {
    const s = scope(req);
    const method = await inTransaction(tx => valuationMethod(tx, s.orgId));
    const pool = await getPool();
    const h = await pool.request().input('o', sql.Int, s.orgId)
      .query('SELECT TOP 10 h.old_method, h.new_method, h.note, h.changed_at, u.name AS user_name FROM valuation_policy_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.organization_id = @o ORDER BY h.id DESC');
    res.json({ method, label: METHOD_LABEL[method], options: Object.entries(METHOD_INFO).map(([value, m]) => ({ value, label: m.label, description: m.description, needs_ack: !!m.needsAck })), history: h.recordset });
  } catch (err) { fail(res, err); }
});

router.put('/valuation-method', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const s = scope(req);
    const method = String(req.body?.method ?? '');
    if (!VALUATION_METHODS.includes(method)) throw new StockError('INVALID_METHOD', 'Valuation method must be one of: ' + VALUATION_METHODS.join(', '));
    if (METHOD_INFO[method].needsAck && req.body?.acknowledge_legal !== true) {
      throw new StockError('LEGAL_ACK_REQUIRED', `${METHOD_INFO[method].label} is not permitted under IFRS or in many jurisdictions. Confirm it is legal and approved for your business to enable it.`, 400);
    }
    const pool = await getPool();
    const before = await inTransaction(tx => valuationMethod(tx, s.orgId));
    if (before === method) return res.json({ method, label: METHOD_LABEL[method], unchanged: true });
    await pool.request().input('o', sql.Int, s.orgId).input('old', sql.NVarChar(20), before).input('new', sql.NVarChar(20), method)
      .input('n', sql.NVarChar(500), req.body?.note ? String(req.body.note).trim().slice(0, 500) : null).input('u', sql.Int, s.userId ?? null)
      .query('INSERT INTO valuation_policy_history (organization_id, old_method, new_method, note, user_id) VALUES (@o, @old, @new, @n, @u)');
    await pool.request().input('o', sql.Int, s.orgId).input('v', sql.NVarChar(50), method)
      .query(`IF EXISTS (SELECT 1 FROM settings WHERE organization_id = @o AND [key] = 'valuation_method')
                UPDATE settings SET value = @v WHERE organization_id = @o AND [key] = 'valuation_method'
              ELSE INSERT INTO settings (organization_id, [key], value) VALUES (@o, 'valuation_method', @v)`);
    writeAudit(pool, { orgId: s.orgId, branchId: s.branchId, userId: s.userId, action: 'UPDATE', entity: 'settings', entityId: 0,
      before: { valuation_method: before }, after: { valuation_method: method } });
    res.json({ method, label: METHOD_LABEL[method], previous: before });
  } catch (err) { fail(res, err); }
});

// Stock value per item at the organisation's valuation method, plus retail value and category totals.
router.get('/valuation', P.requirePermission('reports.valuation'), async (req, res) => {
  try {
    const s = scope(req);
    const pool = await getPool();
    const method = await inTransaction(tx => valuationMethod(tx, s.orgId));
    const v = await computeValuation(s.orgId, s.branchId, method, pool);
    res.json({ method, label: METHOD_LABEL[method], ...v });
  } catch (err) { fail(res, err); }
});

// Items at or below their reorder level (counting stock already on order), with a suggested order quantity
// that covers 30 days of recent sales or twice the reorder level, whichever is more.
// Replenishment (reorder report, recommendations, approvals) lives in routes/replenishment.js.

// Revenue, cost of goods sold and margin per item for sales dated in the range (default: last 30 days).
router.get('/margin', P.requirePermission('reports.valuation'), async (req, res) => {
  try {
    const s = scope(req);
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
    const to = isDate(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
    const from = isDate(req.query.from) ? req.query.from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, s.orgId).input('b', sql.Int, s.branchId).input('f', sql.Date, from).input('t', sql.Date, to)
      .query(`SELECT x.tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, x.units, x.revenue, ISNULL(c.cogs, 0) AS cogs
              FROM (SELECT si.tire_id, SUM(si.qty) AS units, SUM(si.amount) AS revenue
                    FROM sale_items si JOIN sales sa ON sa.id = si.sale_id
                    WHERE sa.organization_id = @o AND (@b IS NULL OR sa.branch_id = @b) AND sa.status <> 'voided' AND si.tire_id IS NOT NULL AND sa.date BETWEEN @f AND @t
                    GROUP BY si.tire_id) x
              JOIN tires t ON t.id = x.tire_id
              OUTER APPLY (SELECT SUM(-m.qty_change * ISNULL(m.unit_cost, 0)) AS cogs FROM stock_movements m JOIN sales sa ON sa.id = m.ref_id
                           WHERE m.tire_id = x.tire_id AND m.reason = 'sale' AND sa.organization_id = @o AND sa.status <> 'voided' AND sa.date BETWEEN @f AND @t) c
              ORDER BY x.revenue DESC`);
    const items = r.recordset.map(x => {
      const revenue = Number(x.revenue), cogs = Number(x.cogs), margin = revenue - cogs;
      return { tire_id: x.tire_id, item_name: x.item_name, units: x.units, revenue: round2(revenue), cogs: round2(cogs), margin: round2(margin),
               margin_pct: revenue ? Math.round(margin / revenue * 1000) / 10 : null };
    });
    const sum = k => round2(items.reduce((a, i) => a + i[k], 0));
    const revenue = sum('revenue'), cogs = sum('cogs');
    res.json({ from, to, items, totals: { units: items.reduce((a, i) => a + i.units, 0), revenue, cogs, margin: round2(revenue - cogs),
                                          margin_pct: revenue ? Math.round((revenue - cogs) / revenue * 1000) / 10 : null } });
  } catch (err) { fail(res, err); }
});

// ── Batches / serials and expiry ─────────────────────────────────────────────
// Batch balances per item and location, earliest expiry first (the order sales will draw them).
router.get('/batches', async (req, res) => {
  try {
    const s = scope(req);
    const tireId = parseInt(req.query.tire_id, 10) || null;
    const locationId = parseInt(req.query.location_id, 10) || null;
    const inStock = req.query.in_stock !== '0';
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, s.orgId).input('b', sql.Int, s.branchId).input('t', sql.Int, tireId).input('l', sql.Int, locationId)
      .query(`SELECT b.id AS batch_id, b.tire_id, b.batch_no, b.expiry_date, b.mfg_date, b.quality_status, b.is_legacy, b.unit_cost, b.created_at,
                     x.location_id, sl.name AS location_name, x.qty,
                     DATEDIFF(DAY, CAST(GETDATE() AS DATE), b.expiry_date) AS days_to_expiry
              FROM stock_batches b
              JOIN batch_location_stock x ON x.batch_id = b.id
              LEFT JOIN stock_locations sl ON sl.id = x.location_id
              WHERE b.organization_id = @o AND (@b IS NULL OR b.branch_id = @b) AND (@t IS NULL OR b.tire_id = @t) AND (@l IS NULL OR x.location_id = @l)
                ${inStock ? 'AND x.qty <> 0' : ''}
              ORDER BY CASE WHEN b.expiry_date IS NULL THEN 1 ELSE 0 END, b.expiry_date, b.created_at, b.id`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

// Where did a batch / serial number come from and go to: its balances and every movement that touched it.
router.get('/trace', async (req, res) => {
  try {
    const s = scope(req);
    const q = String(req.query.q ?? '').trim().slice(0, 60);
    if (!q) return res.json({ q, matches: [] });
    const pool = await getPool();
    const found = await pool.request().input('o', sql.Int, s.orgId).input('b', sql.Int, s.branchId).input('q', sql.NVarChar(60), q)
      .query(`SELECT TOP 20 b.id AS batch_id, b.tire_id, b.batch_no, b.expiry_date, b.is_legacy, t.tracking,
                     LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name,
                     DATEDIFF(DAY, CAST(GETDATE() AS DATE), b.expiry_date) AS days_to_expiry
              FROM stock_batches b JOIN tires t ON t.id = b.tire_id
              WHERE b.organization_id = @o AND (@b IS NULL OR b.branch_id = @b) AND b.batch_no = @q
              ORDER BY b.id`);
    const matches = [];
    for (const m of found.recordset) {
      const bal = await pool.request().input('id', sql.Int, m.batch_id)
        .query(`SELECT x.location_id, sl.name AS location_name, x.qty FROM batch_location_stock x
                LEFT JOIN stock_locations sl ON sl.id = x.location_id WHERE x.batch_id = @id AND x.qty <> 0`);
      const mv = await pool.request().input('id', sql.Int, m.batch_id)
        .query(`SELECT TOP 200 mv.id, mv.created_at, mv.reason, mv.qty_change, mv.reference, sl.name AS location_name, u.name AS user_name
                FROM stock_movements mv LEFT JOIN stock_locations sl ON sl.id = mv.location_id LEFT JOIN users u ON u.id = mv.user_id
                WHERE mv.batch_id = @id ORDER BY mv.id`);
      matches.push({ ...m, on_hand: bal.recordset.reduce((a, x) => a + x.qty, 0), balances: bal.recordset, movements: mv.recordset });
    }
    res.json({ q, matches });
  } catch (err) { fail(res, err); }
});

// Expired and soon-to-expire stock across all tracked items.
router.get('/expiry', async (req, res) => {
  try {
    const s = scope(req);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, s.orgId).input('b', sql.Int, s.branchId).input('d', sql.Int, days)
      .query(`SELECT b.id AS batch_id, b.tire_id, t.brand + ' ' + t.model + ' ' + t.size AS item_name, t.model, b.batch_no, b.expiry_date,
                     DATEDIFF(DAY, CAST(GETDATE() AS DATE), b.expiry_date) AS days_to_expiry,
                     SUM(x.qty) AS qty, CAST(SUM(x.qty * ISNULL(b.unit_cost, t.cost_price)) AS DECIMAL(18,2)) AS value
              FROM stock_batches b
              JOIN tires t ON t.id = b.tire_id
              JOIN batch_location_stock x ON x.batch_id = b.id
              WHERE b.organization_id = @o AND (@b IS NULL OR b.branch_id = @b) AND b.expiry_date IS NOT NULL AND x.qty > 0
                AND b.expiry_date <= DATEADD(DAY, @d, CAST(GETDATE() AS DATE))
              GROUP BY b.id, b.tire_id, t.brand, t.model, t.size, b.batch_no, b.expiry_date, b.unit_cost, t.cost_price
              ORDER BY b.expiry_date, t.model`);
    const rows = r.recordset;
    res.json({ days, expired: rows.filter(x => x.days_to_expiry < 0), expiring: rows.filter(x => x.days_to_expiry >= 0),
               expired_units: rows.filter(x => x.days_to_expiry < 0).reduce((a, x) => a + x.qty, 0),
               expiring_units: rows.filter(x => x.days_to_expiry >= 0).reduce((a, x) => a + x.qty, 0) });
  } catch (err) { fail(res, err); }
});

// ── Stock locations ──────────────────────────────────────────────────────────
// Locations belong to a branch (X-Branch-ID for org admins, like the item list). Every branch always has one default.
const canManage = P.requirePermission('locations.manage');
const cleanName = v => String(v ?? '').trim().slice(0, 100);
const cleanCode = v => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
const isDupKey = e => e && (e.number === 2601 || e.number === 2627);

router.get('/locations', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    // make sure the branch has its default before listing
    await inTransaction(tx => defaultLocationId(tx, orgId, branchId));
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT l.id, l.name, l.code, l.is_default, l.is_active, l.kind,
                     ISNULL((SELECT SUM(x.qty) FROM item_location_stock x WHERE x.location_id = l.id), 0) AS units,
                     (SELECT COUNT(*) FROM item_location_stock x WHERE x.location_id = l.id AND x.qty <> 0) AS items
              FROM stock_locations l WHERE l.organization_id = @o AND l.branch_id = @b
              ORDER BY l.is_default DESC, l.is_active DESC, l.name`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.post('/locations', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Location name is required' });
    const code = cleanCode(req.body?.code) || cleanCode(name).slice(0, 12) || 'LOC';
    const kind = req.body?.kind === undefined ? 'normal' : String(req.body.kind);
    if (!LOCATION_KINDS.includes(kind)) return res.status(400).json({ error: 'Location type must be one of: ' + LOCATION_KINDS.join(', '), code: 'INVALID_KIND' });
    const pool = await getPool();
    await inTransaction(tx => defaultLocationId(tx, orgId, branchId));
    try {
      const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('n', sql.NVarChar(100), name).input('c', sql.NVarChar(30), code).input('k', sql.NVarChar(12), kind)
        .query('INSERT INTO stock_locations (organization_id, branch_id, name, code, kind) OUTPUT INSERTED.* VALUES (@o, @b, @n, @c, @k)');
      writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'CREATE', entity: 'stock_location', entityId: r.recordset[0].id, after: { name, code } });
      res.status(201).json({ ...r.recordset[0], units: 0, items: 0 });
    } catch (e) {
      if (isDupKey(e)) return res.status(409).json({ error: `A location with code "${code}" already exists in this branch`, code: 'DUPLICATE_LOCATION' });
      throw e;
    }
  } catch (err) { fail(res, err); }
});

router.put('/locations/:id', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const id = parseInt(req.params.id, 10);
    const out = await inTransaction(async tx => {
      const r = await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
        .query('SELECT * FROM stock_locations WITH (UPDLOCK) WHERE id = @id AND organization_id = @o AND branch_id = @b');
      const loc = r.recordset[0];
      if (!loc) throw new StockError('NOT_FOUND', 'Location not found', 404);
      const body = req.body || {};
      const name = body.name !== undefined ? cleanName(body.name) : loc.name;
      if (!name) throw new StockError('INVALID_NAME', 'Location name is required');
      let active = body.is_active !== undefined ? !!body.is_active : !!loc.is_active;
      const makeDefault = body.is_default === true;
      const kind = body.kind !== undefined ? String(body.kind) : loc.kind;
      if (!LOCATION_KINDS.includes(kind)) throw new StockError('INVALID_KIND', 'Location type must be one of: ' + LOCATION_KINDS.join(', '));
      if (kind !== 'normal' && (makeDefault || loc.is_default)) throw new StockError('DEFAULT_LOCATION', 'The default (selling) location must be a normal location', 409);
      if (kind !== 'normal' && loc.kind === 'normal') {
        const rv = await new sql.Request(tx).input('l', sql.Int, id).query(`SELECT COUNT(*) AS n FROM stock_reservations WHERE location_id = @l AND ${ACTIVE_RESERVATION}`);
        if (rv.recordset[0].n > 0) throw new StockError('HAS_RESERVATIONS', 'Release the reservations held at this location before restricting it', 409);
      }

      if (!active && loc.is_active) {
        if (loc.is_default && !makeDefault) throw new StockError('DEFAULT_LOCATION', 'Make another location the default before deactivating this one', 409);
        const held = await new sql.Request(tx).input('l', sql.Int, id).query('SELECT COUNT(*) AS n FROM item_location_stock WHERE location_id = @l AND qty <> 0');
        if (held.recordset[0].n > 0) throw new StockError('LOCATION_NOT_EMPTY', `This location still holds stock for ${held.recordset[0].n} item(s). Transfer it out first.`, 409);
      }
      if (makeDefault) {
        if (!active) throw new StockError('INVALID_LOCATION', 'An inactive location cannot be the default');
        await new sql.Request(tx).input('o', sql.Int, orgId).input('b', sql.Int, branchId).query('UPDATE stock_locations SET is_default = 0 WHERE organization_id = @o AND branch_id = @b AND is_default = 1');
      }
      await new sql.Request(tx).input('id', sql.Int, id).input('n', sql.NVarChar(100), name).input('a', sql.Bit, active ? 1 : 0).input('d', sql.Bit, makeDefault ? 1 : (loc.is_default ? 1 : 0)).input('k', sql.NVarChar(12), kind)
        .query('UPDATE stock_locations SET name = @n, is_active = @a, is_default = @d, kind = @k WHERE id = @id');
      return { id, name, is_active: active, is_default: makeDefault || !!loc.is_default, kind };
    });
    const pool = await getPool();
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'UPDATE', entity: 'stock_location', entityId: id, after: out });
    res.json(out);
  } catch (err) { fail(res, err); }
});

// Balances by location: for one item (?tire_id=) or every item at one location (?location_id=).
router.get('/stock-by-location', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const tireId = parseInt(req.query.tire_id, 10) || null;
    const locationId = parseInt(req.query.location_id, 10) || null;
    if (!tireId && !locationId) return res.status(400).json({ error: 'tire_id or location_id is required' });
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('t', sql.Int, tireId).input('l', sql.Int, locationId)
      .query(`SELECT x.tire_id, x.location_id, l.name AS location_name, l.is_default, x.qty
              FROM item_location_stock x
              JOIN stock_locations l ON l.id = x.location_id
              JOIN tires t ON t.id = x.tire_id
              WHERE l.organization_id = @o AND l.branch_id = @b AND t.organization_id = @o AND t.branch_id = @b
                AND (@t IS NULL OR x.tire_id = @t) AND (@l IS NULL OR x.location_id = @l) AND x.qty <> 0
              ORDER BY l.is_default DESC, l.name`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

// ── Transfers between locations of one branch ──
router.get('/transfers', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT TOP 100 tr.id, tr.transfer_no, tr.notes, tr.created_at, tr.status, tr.received_at, tr.expected_at, tr.carrier, tr.has_discrepancy, tr.branch_id AS from_branch_id, ISNULL(tr.to_branch_id, tr.branch_id) AS to_branch_id, fl.name AS from_name, tl.name AS to_name, u.name AS created_by_name,
                     (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = tr.id) AS lines,
                     (SELECT ISNULL(SUM(i.qty), 0) FROM stock_transfer_items i WHERE i.transfer_id = tr.id) AS units
              FROM stock_transfers tr
              JOIN stock_locations fl ON fl.id = tr.from_location_id JOIN stock_locations tl ON tl.id = tr.to_location_id
              LEFT JOIN users u ON u.id = tr.created_by
              WHERE tr.organization_id = @o AND (tr.branch_id = @b OR tr.to_branch_id = @b)
              ORDER BY tr.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.post('/transfers', P.requirePermission('stock.transfer'), async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    if (req.user.role === 'demo') return res.status(403).json({ error: 'Not available in demo mode' });
    const b = req.body || {};
    const items = (Array.isArray(b.items) ? b.items : []).map(i => ({ tireId: parseInt(i.tire_id, 10), qty: Number(i.qty) }));
    const user = P.userCtx(req, branchId);
    const out = await inTransaction(tx => transferStock(tx, {
      orgId, user, fromLocationId: parseInt(b.from_location_id, 10), toLocationId: parseInt(b.to_location_id, 10), items, notes: b.notes, inTransit: b.in_transit === true,
      expectedAt: b.expected_at || null, carrier: b.carrier, reference: b.reference,
    }));
    const pool = await getPool();
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'CREATE', entity: 'stock_transfer', entityId: out.id,
      before: null, after: { transfer_no: out.transferNo, from: out.from, to: out.to, lines: out.lines, status: out.status, cross_branch: out.crossBranch } });
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

module.exports = router;
