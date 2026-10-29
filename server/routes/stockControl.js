// Stock control API: stock position, reservations, physical counts and settling in-transit transfers.
// Mounted on /api/inventory before routes/inventory.js; unmatched paths fall through.
const express = require('express');
const router  = express.Router();
const { getPool, sql }  = require('../db');
const { requireRole }   = require('../middleware/auth');
const P = require('../utils/permissions');
const { writeAudit }    = require('../utils/audit');
const { getContext }    = require('../context');
const { StockError, ACTIVE_RESERVATION, defaultLocationId, createAdjustment, settleTransfer } = require('../utils/stock');
const { nextDocNumber } = require('../utils/docNumber');
const { assertLocationAccess } = require('../utils/access');
const { POSITION_APPLY, POSITION_COLUMNS } = require('../utils/stockPosition');

function fail(res, err) {
  if (err instanceof StockError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  console.error('[stockControl]', err.message);
  return res.status(500).json({ error: 'Stock operation failed' });
}

async function inTransaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try { const out = await fn(tx); await tx.commit(); return out; }
  catch (e) { try { await tx.rollback(); } catch { /* already rolled back */ } throw e; }
}

const userOf = (req, branchId) => P.userCtx(req, branchId);
const noDemo = req => { if (req.user.role === 'demo') throw new StockError('DEMO', 'Not available in demo mode', 403); };
const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };

// ── Stock position ──────────────────────────────────────────────────────────
// Every item with stock, reserved, in-transit or on-order quantities (?q= filters by name / SKU).
router.get('/position', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const q = String(req.query.q || '').trim().slice(0, 60);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('q', sql.NVarChar(60), '%' + q + '%')
      .query(`SELECT t.id AS tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, t.sku, t.uom, t.status, t.stock AS on_hand, ${POSITION_COLUMNS}
              FROM tires t ${POSITION_APPLY}
              WHERE t.organization_id = @o AND t.branch_id = @b
                AND (t.stock <> 0 OR rsv.qty > 0 OR tt.qty > 0 OR oo.qty > 0)
                AND (@q = '%%' OR t.brand + ' ' + t.model + ' ' + t.size LIKE @q OR t.sku LIKE @q)
              ORDER BY t.brand, t.model, t.size`);
    const items = r.recordset;
    const sum = k => items.reduce((a, i) => a + Number(i[k] || 0), 0);
    res.json({ items, totals: { on_hand: sum('on_hand'), reserved: sum('reserved'), available: sum('available'), quarantined: sum('quarantined'),
                                expired: sum('expired'), held: sum('held'), in_transit: sum('in_transit'), on_order: sum('on_order') } });
  } catch (err) { fail(res, err); }
});

// One item: balances per location, reservations, transfers on the way and open purchase orders.
router.get('/position/:tireId', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const tireId = int(req.params.tireId);
    const pool = await getPool();
    const head = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('t', sql.Int, tireId)
      .query(`SELECT t.id AS tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, t.sku, t.uom, t.tracking, t.stock AS on_hand, ${POSITION_COLUMNS}
              FROM tires t ${POSITION_APPLY} WHERE t.id = @t AND t.organization_id = @o AND t.branch_id = @b`);
    if (!head.recordset.length) throw new StockError('NOT_FOUND', 'Item not found', 404);
    const rq = () => pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('t', sql.Int, tireId);
    const locs = await rq().query(`
      SELECT l.id AS location_id, l.name, l.kind, l.is_default, ISNULL(x.qty, 0) AS on_hand,
             ISNULL(rv.qty, 0) AS reserved,
             CASE WHEN l.kind = 'normal' THEN ISNULL(ex.qty, 0) ELSE 0 END AS expired,
             CASE WHEN l.kind = 'normal' THEN ISNULL(hd.qty, 0) ELSE 0 END AS held,
             CASE WHEN l.kind = 'normal' THEN CASE WHEN ISNULL(x.qty, 0) - ISNULL(rv.qty, 0) - ISNULL(ex.qty, 0) - ISNULL(hd.qty, 0) < 0 THEN 0 ELSE ISNULL(x.qty, 0) - ISNULL(rv.qty, 0) - ISNULL(ex.qty, 0) - ISNULL(hd.qty, 0) END ELSE 0 END AS available,
             CASE WHEN l.kind <> 'normal' THEN ISNULL(x.qty, 0) ELSE 0 END AS quarantined
      FROM stock_locations l
      LEFT JOIN item_location_stock x ON x.location_id = l.id AND x.tire_id = @t
      OUTER APPLY (SELECT SUM(r.qty) AS qty FROM stock_reservations r WHERE r.tire_id = @t AND r.location_id = l.id AND ${ACTIVE_RESERVATION}) rv
      OUTER APPLY (SELECT SUM(bl.qty) AS qty FROM batch_location_stock bl JOIN stock_batches b ON b.id = bl.batch_id
                   WHERE b.tire_id = @t AND bl.location_id = l.id AND b.expiry_date IS NOT NULL AND b.expiry_date < CAST(GETDATE() AS DATE)) ex
      OUTER APPLY (SELECT SUM(bl.qty) AS qty FROM batch_location_stock bl JOIN stock_batches b ON b.id = bl.batch_id
                   WHERE b.tire_id = @t AND bl.location_id = l.id AND b.quality_status <> 'released' AND (b.expiry_date IS NULL OR b.expiry_date >= CAST(GETDATE() AS DATE))) hd
      WHERE l.organization_id = @o AND l.branch_id = @b AND (l.is_active = 1 OR ISNULL(x.qty, 0) <> 0)
      ORDER BY l.is_default DESC, l.name`);
    const reservations = await rq().query(`
      SELECT r.id, r.qty, r.reference, r.notes, r.expires_at, r.created_at, l.name AS location_name, u.name AS created_by_name
      FROM stock_reservations r JOIN stock_locations l ON l.id = r.location_id LEFT JOIN users u ON u.id = r.created_by
      WHERE r.tire_id = @t AND r.organization_id = @o AND r.status = 'active' AND (r.expires_at IS NULL OR r.expires_at >= CAST(GETDATE() AS DATE)) ORDER BY r.id DESC`);
    const transit = await rq().query(`
      SELECT tr.id, tr.transfer_no, i.qty, fl.name AS from_name, tl.name AS to_name, tr.created_at
      FROM stock_transfer_items i JOIN stock_transfers tr ON tr.id = i.transfer_id
      JOIN stock_locations fl ON fl.id = tr.from_location_id JOIN stock_locations tl ON tl.id = tr.to_location_id
      WHERE i.tire_id = @t AND tr.organization_id = @o AND tr.status = 'in_transit' ORDER BY tr.id DESC`);
    const orders = await rq().query(`
      SELECT p.id, p.po_no AS po_number, pi.qty, p.date AS date, s.name AS supplier_name
      FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE pi.tire_id = @t AND p.organization_id = @o AND p.status = 'pending' ORDER BY p.id DESC`);
    res.json({ ...head.recordset[0], locations: locs.recordset, reservations: reservations.recordset, in_transit_transfers: transit.recordset, open_orders: orders.recordset });
  } catch (err) { fail(res, err); }
});

// ── Reservations ────────────────────────────────────────────────────────────
router.get('/reservations', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const status = ['active', 'released', 'fulfilled', 'all'].includes(req.query.status) ? req.query.status : 'active';
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('st', sql.NVarChar(12), status)
      .input('t', sql.Int, parseInt(req.query.tire_id, 10) || null)
      .query(`SELECT TOP 300 r.id, r.tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, t.sku, r.location_id, l.name AS location_name,
                     r.qty, r.status, r.reference, r.notes, r.expires_at, r.sale_id, r.created_at, r.closed_at, u.name AS created_by_name,
                     CAST(CASE WHEN r.status = 'active' AND r.expires_at IS NOT NULL AND r.expires_at < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END AS BIT) AS is_expired
              FROM stock_reservations r JOIN tires t ON t.id = r.tire_id JOIN stock_locations l ON l.id = r.location_id LEFT JOIN users u ON u.id = r.created_by
              WHERE r.organization_id = @o AND r.branch_id = @b AND (@st = 'all' OR r.status = @st) AND (@t IS NULL OR r.tire_id = @t)
              ORDER BY r.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

// Hold stock for an order or requirement. Only free stock in a normal (non-restricted) location can be reserved.
router.post('/reservations', P.requirePermission('stock.reserve'), async (req, res) => {
  try {
    noDemo(req);
    const { orgId, branchId } = getContext(req);
    const b = req.body || {};
    const tireId = int(b.tire_id), qty = int(b.qty);
    if (!Number.isInteger(tireId)) throw new StockError('INVALID_ITEM', 'Choose an item');
    if (!Number.isInteger(qty) || qty <= 0) throw new StockError('INVALID_QUANTITY', 'Quantity must be a positive whole number');
    const expires = b.expires_at ? String(b.expires_at).slice(0, 10) : null;
    if (expires && (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || expires < new Date().toISOString().slice(0, 10))) throw new StockError('INVALID_DATE', 'Expiry date must be today or later');
    const out = await inTransaction(async tx => {
      const it = await new sql.Request(tx).input('t', sql.Int, tireId).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
        .query("SELECT id, branch_id, status, LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS name FROM tires WHERE id = @t AND organization_id = @o AND branch_id = @b");
      const item = it.recordset[0];
      if (!item) throw new StockError('NOT_FOUND', 'Item not found', 404);
      if (item.status === 'inactive') throw new StockError('ITEM_INACTIVE', `${item.name} is inactive and cannot be reserved`, 409);
      const locId = b.location_id ? int(b.location_id) : await defaultLocationId(tx, orgId, item.branch_id);
      const lc = await new sql.Request(tx).input('l', sql.Int, locId).input('o', sql.Int, orgId).input('b', sql.Int, item.branch_id)
        .query('SELECT id, name, kind, is_active FROM stock_locations WHERE id = @l AND organization_id = @o AND branch_id = @b');
      const loc = lc.recordset[0];
      if (!loc || !loc.is_active) throw new StockError('INVALID_LOCATION', 'Stock location not found', 404);
      if (loc.kind !== 'normal') throw new StockError('RESTRICTED_LOCATION', `${loc.name} is a ${loc.kind} location; its stock cannot be reserved`, 409);
      // Lock the balance row so a concurrent sale or reservation waits, then measure what is free.
      const bal = await new sql.Request(tx).input('t', sql.Int, tireId).input('l', sql.Int, locId)
        .query('SELECT qty FROM item_location_stock WITH (UPDLOCK, HOLDLOCK) WHERE tire_id = @t AND location_id = @l');
      const onHand = bal.recordset[0]?.qty ?? 0;
      const held = await new sql.Request(tx).input('t', sql.Int, tireId).input('l', sql.Int, locId)
        .query(`SELECT (SELECT ISNULL(SUM(qty), 0) FROM stock_reservations WHERE tire_id = @t AND location_id = @l AND ${ACTIVE_RESERVATION}) AS reserved,
                       (SELECT ISNULL(SUM(bl.qty), 0) FROM batch_location_stock bl JOIN stock_batches sb ON sb.id = bl.batch_id
                        WHERE sb.tire_id = @t AND bl.location_id = @l AND sb.expiry_date IS NOT NULL AND sb.expiry_date < CAST(GETDATE() AS DATE)) AS expired,
                       (SELECT ISNULL(SUM(bl.qty), 0) FROM batch_location_stock bl JOIN stock_batches sb ON sb.id = bl.batch_id
                        WHERE sb.tire_id = @t AND bl.location_id = @l AND sb.quality_status <> 'released' AND (sb.expiry_date IS NULL OR sb.expiry_date >= CAST(GETDATE() AS DATE))) AS onhold`);
      const free = onHand - held.recordset[0].reserved - held.recordset[0].expired - held.recordset[0].onhold;
      if (qty > free) {
        throw new StockError('INSUFFICIENT_AVAILABLE', `${item.name}: only ${Math.max(0, free)} available at ${loc.name} (${onHand} on hand, ${held.recordset[0].reserved} reserved${held.recordset[0].expired ? `, ${held.recordset[0].expired} expired` : ''}${held.recordset[0].onhold ? `, ${held.recordset[0].onhold} on quality hold` : ''}); ${qty} requested`,
          409, { available: Math.max(0, free), on_hand: onHand, reserved: held.recordset[0].reserved, required: qty });
      }
      const ins = await new sql.Request(tx).input('o', sql.Int, orgId).input('b', sql.Int, item.branch_id).input('t', sql.Int, tireId).input('l', sql.Int, locId).input('q', sql.Int, qty)
        .input('ref', sql.NVarChar(100), b.reference ? String(b.reference).trim().slice(0, 100) : null).input('n', sql.NVarChar(500), b.notes ? String(b.notes).trim().slice(0, 500) : null)
        .input('x', sql.Date, expires).input('u', sql.Int, req.user.userId ?? null)
        .query(`INSERT INTO stock_reservations (organization_id, branch_id, tire_id, location_id, qty, reference, notes, expires_at, created_by)
                OUTPUT INSERTED.id VALUES (@o, @b, @t, @l, @q, @ref, @n, @x, @u)`);
      return { id: ins.recordset[0].id, tire_id: tireId, qty, location_id: locId, location_name: loc.name, item_name: item.name, available_after: free - qty };
    });
    const pool = await getPool();
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'CREATE', entity: 'stock_reservation', entityId: out.id, before: null, after: { tire_id: tireId, qty, location_id: out.location_id } });
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

router.post('/reservations/:id/release', P.requirePermission('stock.reserve'), async (req, res) => {
  try {
    noDemo(req);
    const { orgId, branchId } = getContext(req);
    const id = int(req.params.id);
    const out = await inTransaction(async tx => {
      const r = await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
        .query('SELECT id, status, qty, tire_id, created_by FROM stock_reservations WITH (UPDLOCK) WHERE id = @id AND organization_id = @o AND branch_id = @b');
      const rv = r.recordset[0];
      if (!rv) throw new StockError('NOT_FOUND', 'Reservation not found', 404);
      if (rv.status !== 'active') throw new StockError('ALREADY_CLOSED', `Reservation is already ${rv.status}`, 409);
      if (req.user.role === 'staff' && rv.created_by !== req.user.userId) throw new StockError('FORBIDDEN', 'Only the person who made a reservation, or a manager, can release it', 403);
      await new sql.Request(tx).input('id', sql.Int, id).input('u', sql.Int, req.user.userId ?? null)
        .query("UPDATE stock_reservations SET status = 'released', closed_at = GETDATE(), closed_by = @u WHERE id = @id");
      return { id, status: 'released', qty: rv.qty };
    });
    const pool = await getPool();
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'UPDATE', entity: 'stock_reservation', entityId: id, before: { status: 'active' }, after: { status: 'released' } });
    res.json(out);
  } catch (err) { fail(res, err); }
});

// ── Transfers in transit ────────────────────────────────────────────────────
for (const action of ['receive', 'cancel']) {
  router.post(`/transfers/:id/${action}`, async (req, res) => {
    try {
      noDemo(req);
      const { orgId, branchId } = getContext(req);
      const b = req.body || {};
      const out = await inTransaction(tx => settleTransfer(tx, { orgId, user: userOf(req, branchId), transferId: int(req.params.id), action,
        lines: Array.isArray(b.lines) ? b.lines : null, shortAction: b.short_action || 'return', note: b.note }));
      const pool = await getPool();
      writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'UPDATE', entity: 'stock_transfer', entityId: out.id, before: { status: 'in_transit' }, after: { status: out.status, discrepancy: out.discrepancy } });
      res.json(out);
    } catch (err) { fail(res, err); }
  });
}

// ── Physical stock counts ───────────────────────────────────────────────────
const canCount = P.requirePermission('stock.count');

router.get('/counts', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT TOP 100 c.id, c.count_no, c.status, c.notes, c.created_at, c.completed_at, l.name AS location_name, u.name AS created_by_name,
                     (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = c.id) AS lines,
                     (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = c.id AND i.counted_qty IS NOT NULL) AS counted,
                     (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = c.id AND i.counted_qty IS NOT NULL AND i.counted_qty <> i.system_qty) AS variances
              FROM stock_counts c JOIN stock_locations l ON l.id = c.location_id LEFT JOIN users u ON u.id = c.created_by
              WHERE c.organization_id = @o AND c.branch_id = @b ORDER BY c.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

async function loadCount(tx, orgId, branchId, id, lock = false) {
  const r = await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
    .query(`SELECT c.*, l.name AS location_name FROM stock_counts c ${lock ? 'WITH (UPDLOCK)' : ''} JOIN stock_locations l ON l.id = c.location_id
            WHERE c.id = @id AND c.organization_id = @o AND c.branch_id = @b`);
  if (!r.recordset.length) throw new StockError('NOT_FOUND', 'Stock count not found', 404);
  return r.recordset[0];
}

router.get('/counts/:id', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const c = await loadCount(pool, orgId, branchId, int(req.params.id));
    const lines = await pool.request().input('c', sql.Int, c.id)
      .query(`SELECT i.id, i.tire_id, i.batch_id, i.item_name, i.batch_no, t.sku, i.system_qty, i.counted_qty, i.variance, i.adjustment_id, a.status AS adjustment_status
              FROM stock_count_items i LEFT JOIN tires t ON t.id = i.tire_id LEFT JOIN stock_adjustments a ON a.id = i.adjustment_id
              WHERE i.count_id = @c ORDER BY i.item_name, i.batch_no`);
    res.json({ ...c, lines: lines.recordset });
  } catch (err) { fail(res, err); }
});

// Start a count of one location: snapshots every item (every batch, for tracked items) that has stock there.
router.post('/counts', canCount, async (req, res) => {
  try {
    noDemo(req);
    const { orgId, branchId } = getContext(req);
    const b = req.body || {};
    const out = await inTransaction(async tx => {
      const locId = b.location_id ? int(b.location_id) : await defaultLocationId(tx, orgId, branchId);
      const lc = await new sql.Request(tx).input('l', sql.Int, locId).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
        .query('SELECT id, name, is_active FROM stock_locations WHERE id = @l AND organization_id = @o AND branch_id = @b');
      if (!lc.recordset.length) throw new StockError('INVALID_LOCATION', 'Stock location not found', 404);
      await assertLocationAccess(tx, orgId, userOf(req, branchId), locId, 'count');
      const open = await new sql.Request(tx).input('l', sql.Int, locId).query("SELECT count_no FROM stock_counts WITH (UPDLOCK, HOLDLOCK) WHERE location_id = @l AND status = 'open'");
      if (open.recordset.length) throw new StockError('COUNT_OPEN', `Count ${open.recordset[0].count_no} is still open for this location. Finish or cancel it first.`, 409);
      const countNo = await nextDocNumber(new sql.Request(tx), 'stock_counts', 'CNT', 'count_no');
      const hdr = await new sql.Request(tx).input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('no', sql.NVarChar(30), countNo).input('l', sql.Int, locId)
        .input('n', sql.NVarChar(500), b.notes ? String(b.notes).trim().slice(0, 500) : null).input('u', sql.Int, req.user.userId ?? null)
        .query('INSERT INTO stock_counts (organization_id, branch_id, count_no, location_id, notes, created_by) OUTPUT INSERTED.id VALUES (@o, @b, @no, @l, @n, @u)');
      const id = hdr.recordset[0].id;
      const cat = b.category_id ? int(b.category_id) : null;
      await new sql.Request(tx).input('c', sql.Int, id).input('l', sql.Int, locId).input('o', sql.Int, orgId).input('cat', sql.Int, cat)
        .query(`INSERT INTO stock_count_items (count_id, tire_id, batch_id, item_name, batch_no, system_qty)
                SELECT @c, t.id, NULL, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)), NULL, x.qty
                FROM item_location_stock x JOIN tires t ON t.id = x.tire_id
                WHERE x.location_id = @l AND x.qty <> 0 AND t.organization_id = @o AND t.tracking = 'none' AND (@cat IS NULL OR t.category_id = @cat)
                UNION ALL
                SELECT @c, t.id, sb.id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)), sb.batch_no, bl.qty
                FROM batch_location_stock bl JOIN stock_batches sb ON sb.id = bl.batch_id JOIN tires t ON t.id = sb.tire_id
                WHERE bl.location_id = @l AND bl.qty <> 0 AND t.organization_id = @o AND t.tracking <> 'none' AND (@cat IS NULL OR t.category_id = @cat)`);
      const n = await new sql.Request(tx).input('c', sql.Int, id).query('SELECT COUNT(*) AS n FROM stock_count_items WHERE count_id = @c');
      return { id, count_no: countNo, location_name: lc.recordset[0].name, lines: n.recordset[0].n };
    });
    const pool = await getPool();
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'CREATE', entity: 'stock_count', entityId: out.id, before: null, after: { count_no: out.count_no, lines: out.lines } });
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

// Enter counted quantities: lines: [{ id, counted_qty }] (null clears). Or add an item not in the snapshot: { add: { tire_id, batch_id?, counted_qty } }.
router.put('/counts/:id/lines', canCount, async (req, res) => {
  try {
    noDemo(req);
    const { orgId, branchId } = getContext(req);
    const id = int(req.params.id);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (lines.length > 2000) throw new StockError('TOO_MANY_ITEMS', 'Too many lines in one request');
    const out = await inTransaction(async tx => {
      const c = await loadCount(tx, orgId, branchId, id, true);
      await assertLocationAccess(tx, orgId, userOf(req, branchId), c.location_id, 'count');
      if (c.status !== 'open') throw new StockError('COUNT_CLOSED', `Count ${c.count_no} is ${c.status}`, 409);
      for (const ln of lines) {
        const lineId = int(ln.id);
        const cq = ln.counted_qty === null || ln.counted_qty === '' || ln.counted_qty === undefined ? null : int(ln.counted_qty);
        if (cq !== null && (!Number.isInteger(cq) || cq < 0 || cq > 1000000)) throw new StockError('INVALID_QUANTITY', 'Counted quantity must be a whole number, zero or more');
        await new sql.Request(tx).input('id', sql.Int, lineId).input('c', sql.Int, id).input('q', sql.Int, cq)
          .query('UPDATE stock_count_items SET counted_qty = @q, variance = CASE WHEN @q IS NULL THEN NULL ELSE @q - system_qty END WHERE id = @id AND count_id = @c');
      }
      const add = req.body?.add;
      if (add) {
        const tireId = int(add.tire_id), batchId = add.batch_id ? int(add.batch_id) : null, cq = int(add.counted_qty);
        if (!Number.isInteger(cq) || cq < 0) throw new StockError('INVALID_QUANTITY', 'Counted quantity must be a whole number, zero or more');
        const it = await new sql.Request(tx).input('t', sql.Int, tireId).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
          .query("SELECT id, tracking, LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS name FROM tires WHERE id = @t AND organization_id = @o AND branch_id = @b");
        const item = it.recordset[0];
        if (!item) throw new StockError('NOT_FOUND', 'Item not found', 404);
        if (item.tracking !== 'none' && !batchId) throw new StockError('BATCH_REQUIRED', `${item.name} is batch/serial tracked: choose the batch`, 400);
        if (item.tracking === 'none' && batchId) throw new StockError('INVALID_BATCH', `${item.name} is not batch tracked`, 400);
        let batchNo = null, sys = 0;
        if (batchId) {
          const bt = await new sql.Request(tx).input('b', sql.Int, batchId).input('t', sql.Int, tireId).query('SELECT batch_no FROM stock_batches WHERE id = @b AND tire_id = @t');
          if (!bt.recordset.length) throw new StockError('INVALID_BATCH', 'Batch not found for this item', 400);
          batchNo = bt.recordset[0].batch_no;
          sys = (await new sql.Request(tx).input('b', sql.Int, batchId).input('l', sql.Int, c.location_id).query('SELECT qty FROM batch_location_stock WHERE batch_id = @b AND location_id = @l')).recordset[0]?.qty ?? 0;
        } else {
          sys = (await new sql.Request(tx).input('t', sql.Int, tireId).input('l', sql.Int, c.location_id).query('SELECT qty FROM item_location_stock WHERE tire_id = @t AND location_id = @l')).recordset[0]?.qty ?? 0;
        }
        const ex = await new sql.Request(tx).input('c', sql.Int, id).input('t', sql.Int, tireId).input('b', sql.Int, batchId)
          .query('SELECT id FROM stock_count_items WHERE count_id = @c AND tire_id = @t AND ((batch_id IS NULL AND @b IS NULL) OR batch_id = @b)');
        if (ex.recordset.length) {
          await new sql.Request(tx).input('id', sql.Int, ex.recordset[0].id).input('q', sql.Int, cq).query('UPDATE stock_count_items SET counted_qty = @q, variance = @q - system_qty WHERE id = @id');
        } else {
          await new sql.Request(tx).input('c', sql.Int, id).input('t', sql.Int, tireId).input('b', sql.Int, batchId).input('n', sql.NVarChar(200), item.name).input('bn', sql.NVarChar(60), batchNo)
            .input('s', sql.Int, sys).input('q', sql.Int, cq)
            .query('INSERT INTO stock_count_items (count_id, tire_id, batch_id, item_name, batch_no, system_qty, counted_qty, variance) VALUES (@c, @t, @b, @n, @bn, @s, @q, @q - @s)');
        }
      }
      const s = await new sql.Request(tx).input('c', sql.Int, id)
        .query('SELECT COUNT(*) AS lines, SUM(CASE WHEN counted_qty IS NOT NULL THEN 1 ELSE 0 END) AS counted FROM stock_count_items WHERE count_id = @c');
      return s.recordset[0];
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

// Finish the count: every counted line that differs from the CURRENT recorded balance becomes a stock adjustment
// (reason "count correction"), so it follows the normal authorisation rules; uncounted lines are left alone.
router.post('/counts/:id/complete', canCount, async (req, res) => {
  try {
    noDemo(req);
    const { orgId, branchId } = getContext(req);
    const id = int(req.params.id);
    const user = userOf(req, branchId);
    const out = await inTransaction(async tx => {
      const c = await loadCount(tx, orgId, branchId, id, true);
      await assertLocationAccess(tx, orgId, user, c.location_id, 'count');
      if (c.status !== 'open') throw new StockError('COUNT_CLOSED', `Count ${c.count_no} is already ${c.status}`, 409);
      const lines = (await new sql.Request(tx).input('c', sql.Int, id).query('SELECT * FROM stock_count_items WHERE count_id = @c AND counted_qty IS NOT NULL ORDER BY id')).recordset;
      const total = (await new sql.Request(tx).input('c', sql.Int, id).query('SELECT COUNT(*) AS n FROM stock_count_items WHERE count_id = @c')).recordset[0].n;
      let applied = 0, pending = 0, unchanged = 0, moved = 0, units = 0;
      for (const ln of lines) {
        const cur = ln.batch_id
          ? (await new sql.Request(tx).input('b', sql.Int, ln.batch_id).input('l', sql.Int, c.location_id).query('SELECT qty FROM batch_location_stock WHERE batch_id = @b AND location_id = @l')).recordset[0]?.qty ?? 0
          : (await new sql.Request(tx).input('t', sql.Int, ln.tire_id).input('l', sql.Int, c.location_id).query('SELECT qty FROM item_location_stock WHERE tire_id = @t AND location_id = @l')).recordset[0]?.qty ?? 0;
        if (cur !== ln.system_qty) moved++;
        const delta = ln.counted_qty - cur;
        if (delta === 0) { unchanged++; continue; }
        const adj = await createAdjustment(tx, { orgId, user, tireId: ln.tire_id, qtyChange: delta, reasonCode: 'count_correction', notes: `Stock count ${c.count_no}`, locationId: c.location_id, batchId: ln.batch_id });
        await new sql.Request(tx).input('id', sql.Int, ln.id).input('a', sql.Int, adj.id).query('UPDATE stock_count_items SET adjustment_id = @a WHERE id = @id');
        adj.status === 'pending' ? pending++ : applied++;
        units += Math.abs(delta);
      }
      await new sql.Request(tx).input('id', sql.Int, id).input('u', sql.Int, req.user.userId ?? null)
        .query("UPDATE stock_counts SET status = 'completed', completed_at = GETDATE(), completed_by = @u WHERE id = @id");
      return { id, count_no: c.count_no, status: 'completed', counted: lines.length, uncounted: total - lines.length, unchanged, adjustments_applied: applied, adjustments_pending: pending, units_adjusted: units, moved_since_snapshot: moved };
    });
    const pool = await getPool();
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'UPDATE', entity: 'stock_count', entityId: id, before: { status: 'open' }, after: out });
    res.json(out);
  } catch (err) { fail(res, err); }
});

router.post('/counts/:id/cancel', canCount, async (req, res) => {
  try {
    noDemo(req);
    const { orgId, branchId } = getContext(req);
    const id = int(req.params.id);
    await inTransaction(async tx => {
      const c = await loadCount(tx, orgId, branchId, id, true);
      if (c.status !== 'open') throw new StockError('COUNT_CLOSED', `Count ${c.count_no} is already ${c.status}`, 409);
      await new sql.Request(tx).input('id', sql.Int, id).query("UPDATE stock_counts SET status = 'cancelled', completed_at = GETDATE() WHERE id = @id");
    });
    res.json({ id, status: 'cancelled' });
  } catch (err) { fail(res, err); }
});

module.exports = router;
