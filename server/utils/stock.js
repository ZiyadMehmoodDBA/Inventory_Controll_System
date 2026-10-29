// Single entry point for every change to on-hand stock.
//
// Rules enforced here, so no route can bypass them:
//  - the balance change and its stock_movements row are written together, inside the caller's transaction;
//  - the balance is changed with one atomic UPDATE (no read-modify-write race);
//  - the item must belong to the caller's organisation;
//  - stock may not go below zero unless the organisation setting allow_negative_stock = '1';
//  - each movement is booked to one stock location of the item's branch (default: the branch's default location);
//    tires.stock stays the item total and always equals the sum of its location balances;
//  - items tracked by batch/lot or serial number book every movement to a batch; issues are allocated FEFO
//    (earliest expiry first, expired batches excluded), and reversals go back to the batches they came from;
//  - a movement carries qty before/after, unit cost, user and (optionally) an idempotency key,
//    so a retried posting is ignored instead of applied twice.
const { sql } = require('../db');
const { nextDocNumber } = require('./docNumber');

class StockError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Movement types written to stock_movements.reason.
const MOVEMENT = {
  SALE: 'sale', SALE_VOIDED: 'sale_voided', SALE_DELETED: 'sale_deleted',
  GRN_RECEIVED: 'grn_received', GRN_CANCELLED: 'grn_cancelled', PURCHASE_DELETED: 'purchase_deleted',
  TRANSFER_OUT: 'transfer_out', TRANSFER_IN: 'transfer_in',
  ADJUSTMENT: 'adjustment', OPENING_STOCK: 'opening_stock', OPENING_BALANCE: 'opening_balance',
};

// Adjustment reason codes. direction: 'out' must reduce stock, 'in' must increase, 'any' either.
// `loss` marks a physical stock loss and names its cause (utils/losses.js reports on these); it also switches on the write-off approval value rule.
const ADJUSTMENT_REASONS = {
  count_correction:   { label: 'Stock count correction', direction: 'any' },
  damage:             { label: 'Damaged / broken goods', direction: 'out', loss: 'breakage' },
  deterioration:      { label: 'Deterioration / spoilage', direction: 'out', loss: 'deterioration' },
  contamination:      { label: 'Contaminated goods',     direction: 'out', loss: 'contamination' },
  loss_theft:         { label: 'Theft',                  direction: 'out', loss: 'theft' },
  missing_stock:      { label: 'Missing / unexplained shortage', direction: 'out', loss: 'missing' },
  handling_error:     { label: 'Incorrect handling',     direction: 'out', loss: 'handling' },
  expiry_writeoff:    { label: 'Expired stock write-off', direction: 'out', loss: 'expiry' },
  obsolete_writeoff:  { label: 'Obsolete / unsaleable write-off', direction: 'out', loss: 'obsolete' },
  internal_use:       { label: 'Internal use / samples', direction: 'out' },
  return_to_supplier: { label: 'Returned to supplier',   direction: 'out' },
  found:              { label: 'Stock found',            direction: 'in' },
  customer_return:    { label: 'Customer return (restock)', direction: 'in' },
  other:              { label: 'Other (explain in notes)', direction: 'any' },
};

// A reservation holds stock until it is released, fulfilled or passes its expiry date.
const ACTIVE_RESERVATION = "status = 'active' AND (expires_at IS NULL OR expires_at >= CAST(GETDATE() AS DATE))";

async function reservedQty(transaction, tireId, locationId) {
  const r = await new sql.Request(transaction).input('t', sql.Int, tireId).input('l', sql.Int, locationId)
    .query(`SELECT ISNULL(SUM(qty), 0) AS n FROM stock_reservations WHERE tire_id = @t AND location_id = @l AND ${ACTIVE_RESERVATION}`);
  return r.recordset[0].n;
}

async function allowNegativeStock(transaction, orgId) {
  const r = await new sql.Request(transaction).input('o', sql.Int, orgId)
    .query("SELECT value FROM settings WHERE organization_id = @o AND [key] = 'allow_negative_stock'");
  return r.recordset[0]?.value === '1';
}

/** The branch's default location id; created ("Main Store") if the branch has none yet. */
async function defaultLocationId(transaction, orgId, branchId) {
  const q = () => new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
    .query('SELECT id FROM stock_locations WHERE organization_id = @o AND branch_id = @b AND is_default = 1 AND is_active = 1');
  let r = await q();
  if (r.recordset.length) return r.recordset[0].id;
  // No active default: promote the oldest active location, or create the first one.
  const any = await new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
    .query('SELECT TOP 1 id FROM stock_locations WHERE organization_id = @o AND branch_id = @b AND is_active = 1 ORDER BY id');
  if (any.recordset.length) {
    await new sql.Request(transaction).input('id', sql.Int, any.recordset[0].id).query('UPDATE stock_locations SET is_default = 1 WHERE id = @id');
    return any.recordset[0].id;
  }
  const made = await new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
    .query("INSERT INTO stock_locations (organization_id, branch_id, name, code, is_default) OUTPUT INSERTED.id VALUES (@o, @b, 'Main Store', 'MAIN', 1)");
  return made.recordset[0].id;
}

/** Validate an explicit location (same org + branch as the item, active) or fall back to the branch default. */
async function resolveLocation(transaction, orgId, branchId, locationId) {
  if (locationId == null) {
    const id = await defaultLocationId(transaction, orgId, branchId);
    const r = await new sql.Request(transaction).input('id', sql.Int, id).query('SELECT id, name, kind, temp_min_c, temp_max_c, inspection_interval_days FROM stock_locations WHERE id = @id');
    return r.recordset[0];
  }
  const r = await new sql.Request(transaction).input('id', sql.Int, locationId).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
    .query('SELECT id, name, is_active, kind, temp_min_c, temp_max_c, inspection_interval_days FROM stock_locations WHERE id = @id AND organization_id = @o AND branch_id = @b');
  const loc = r.recordset[0];
  if (!loc) throw new StockError('INVALID_LOCATION', 'Stock location not found for this branch', 400);
  if (!loc.is_active) throw new StockError('INVALID_LOCATION', `Stock location "${loc.name}" is inactive`, 400);
  return loc;
}

const { QA_JOINS, QA_COLUMNS, QUALITY_STATUSES, isRestricted } = require('./quality');
const hazmat = require('./hazmat');
const access = require('./access');
const todayStr = () => new Date().toISOString().slice(0, 10);

// Physical stock rotation: which units leave the shelf first. Deliberately separate from financial valuation (LIFO is a
// valuation method only; it is not offered as a picking rule).
const ROTATION_POLICIES = {
  fefo:           { label: 'FEFO — first expiry, first out', description: 'Earliest expiry date first; stock with no expiry last. Best for perishables and anything with a shelf life.' },
  fifo:           { label: 'FIFO — first in, first out',     description: 'Oldest received first, whatever its expiry. Best for non-perishable goods that age or go out of fashion.' },
  smallest_first: { label: 'Smallest batch first',            description: 'Use up the smallest batches first to clear partial lots and keep the shelf tidy.' },
  manual:         { label: 'Manual — choose the batch',      description: 'No automatic pick on sales: the person selling must choose the batch or serial number.' },
};
const recvDate = 'ISNULL(b.received_date, CAST(b.created_at AS DATE))';
/** ORDER BY clause (aliases b = stock_batches, x = batch_location_stock) that implements a rotation policy. */
function rotationOrderBy(policy) {
  const expiryLast = 'CASE WHEN b.expiry_date IS NULL THEN 1 ELSE 0 END, b.expiry_date';
  switch (policy) {
    case 'fifo':           return `ORDER BY ${recvDate}, b.created_at, b.id`;
    case 'smallest_first': return `ORDER BY x.qty, ${expiryLast}, ${recvDate}, b.id`;
    default:               return `ORDER BY ${expiryLast}, ${recvDate}, b.created_at, b.id`;   // fefo (and the fallback for manual)
  }
}
/** The rotation policy in force for an item: its own, else its category's, else the company default, else FEFO for expiring goods / FIFO for the rest. */
async function resolveRotation(conn, orgId, tireId) {
  const r = await new sql.Request(conn).input('t', sql.Int, tireId).input('o', sql.Int, orgId)
    .query(`SELECT t.rotation_policy AS item_p, c.rotation_policy AS cat_p, t.track_expiry,
                   (SELECT value FROM settings WHERE organization_id = @o AND [key] = 'rotation_policy') AS org_p
            FROM tires t LEFT JOIN item_categories c ON c.id = t.category_id WHERE t.id = @t AND t.organization_id = @o`);
  const x = r.recordset[0] || {};
  for (const [policy, source] of [[x.item_p, 'item'], [x.cat_p, 'category'], [x.org_p, 'company']]) {
    if (policy && ROTATION_POLICIES[policy]) return { policy, source };
  }
  return { policy: x.track_expiry ? 'fefo' : 'fifo', source: 'default' };
}

function normaliseExpiry(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new StockError('INVALID_EXPIRY', 'Expiry date must be a valid date (YYYY-MM-DD)');
  return d;
}

async function loadItem(transaction, orgId, tireId) {
  const r = await new sql.Request(transaction).input('id', sql.Int, tireId).input('o', sql.Int, orgId)
    .query(`SELECT t.id, t.branch_id, t.stock, t.tracking, t.track_expiry, t.shelf_life_days, ${hazmat.HZ_COLUMNS}, t.hazard_hold_reason, ${QA_COLUMNS}, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name
            FROM tires AS t WITH (UPDLOCK, ROWLOCK) ${QA_JOINS} WHERE t.id = @id AND t.organization_id = @o`);
  if (!r.recordset.length) throw new StockError('ITEM_NOT_FOUND', 'Inventory item not found', 404);
  return r.recordset[0];
}

async function getBatch(transaction, orgId, tireId, batchId) {
  const r = await new sql.Request(transaction).input('b', sql.Int, batchId).input('t', sql.Int, tireId).input('o', sql.Int, orgId)
    .query('SELECT id, batch_no, expiry_date, is_legacy, quality_status FROM stock_batches WHERE id = @b AND tire_id = @t AND organization_id = @o');
  if (!r.recordset.length) throw new StockError('INVALID_BATCH', 'Batch not found for this item', 400);
  return r.recordset[0];
}

const isExpired = b => b.expiry_date && new Date(b.expiry_date).toISOString().slice(0, 10) < todayStr();

/** Find or create the batch (or serial) `batchNo` of an item. New batches need an expiry date when the item tracks expiry. */
async function ensureBatch(transaction, { orgId, item, tireId, batchNo, expiryDate = null, unitCost = null, notes = null, forReceipt = true, receivedDate = null, mfgDate = null, userId = null }) {
  const no = String(batchNo ?? '').trim().slice(0, 60);
  if (!no) throw new StockError('BATCH_REQUIRED', `${item.tracking === 'serial' ? 'Serial number' : 'Batch / lot number'} is required for ${item.item_name}`);
  let expiry = normaliseExpiry(expiryDate);
  const mfg = normaliseExpiry(mfgDate);
  if (mfg && mfg > todayStr()) throw new StockError('MFG_IN_FUTURE', `Manufacturing date ${mfg} of ${item.item_name} is in the future`);
  if (mfg && expiry && expiry < mfg) throw new StockError('EXPIRY_BEFORE_MFG', `Expiry date ${expiry} of ${item.item_name} is before its manufacturing date ${mfg}`);
  const found = await new sql.Request(transaction).input('t', sql.Int, tireId).input('n', sql.NVarChar(60), no)
    .query('SELECT id, expiry_date FROM stock_batches WHERE tire_id = @t AND batch_no = @n');
  if (found.recordset.length) {
    const b = found.recordset[0];
    const existing = b.expiry_date ? new Date(b.expiry_date).toISOString().slice(0, 10) : null;
    if (expiry && existing && expiry !== existing) {
      throw new StockError('BATCH_EXPIRY_MISMATCH', `Batch ${no} already exists with expiry ${existing}. Use a different batch number for a different expiry.`, 409);
    }
    if (expiry && !existing) await new sql.Request(transaction).input('id', sql.Int, b.id).input('e', sql.Date, expiry).query('UPDATE stock_batches SET expiry_date = @e WHERE id = @id');
    if (mfg) await new sql.Request(transaction).input('id', sql.Int, b.id).input('m', sql.Date, mfg).query('UPDATE stock_batches SET mfg_date = @m WHERE id = @id AND mfg_date IS NULL');
    return b.id;
  }
  if (item.eff_require_mfg && !mfg) throw new StockError('MFG_REQUIRED', `Manufacturing date is required for ${item.item_name}`);
  if (item.track_expiry && !expiry) {
    // shelf life lets the expiry be worked out from the manufacturing date
    if (mfg && item.shelf_life_days) { const d = new Date(mfg + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + item.shelf_life_days); expiry = d.toISOString().slice(0, 10); }
    else throw new StockError('EXPIRY_REQUIRED', `Expiry date is required for ${item.item_name}${item.shelf_life_days ? ' (or a manufacturing date: shelf life is ' + item.shelf_life_days + ' days)' : ''}`);
  }
  if (forReceipt && expiry && expiry < todayStr()) throw new StockError('EXPIRED_BATCH', `Cannot receive ${item.item_name}: expiry date ${expiry} has already passed`);
  const ins = await new sql.Request(transaction)
    .input('o', sql.Int, orgId).input('b', sql.Int, item.branch_id).input('t', sql.Int, tireId).input('n', sql.NVarChar(60), no)
    .input('e', sql.Date, expiry).input('c', sql.Decimal(18, 2), unitCost).input('notes', sql.NVarChar(300), notes).input('rd', sql.Date, normaliseExpiry(receivedDate) || todayStr()).input('m', sql.Date, mfg)
    .query('INSERT INTO stock_batches (organization_id, branch_id, tire_id, batch_no, expiry_date, unit_cost, notes, received_date, mfg_date) OUTPUT INSERTED.id VALUES (@o, @b, @t, @n, @e, @c, @notes, @rd, @m)');
  const batchId = ins.recordset[0].id;
  // Not enough shelf life left on arrival: take it in, but hold it until someone decides.
  if (expiry && item.eff_min_remaining_days != null) {
    const left = Math.floor((new Date(expiry + 'T00:00:00Z') - new Date(todayStr() + 'T00:00:00Z')) / 86400000);
    if (left < item.eff_min_remaining_days) {
      const why = `Short shelf life on receipt: ${left} day(s) left, minimum ${item.eff_min_remaining_days}`;
      await new sql.Request(transaction).input('id', sql.Int, batchId).input('r', sql.NVarChar(500), why).input('u', sql.Int, userId)
        .query("UPDATE stock_batches SET quality_status = 'on_hold', status_reason = @r, status_changed_at = GETDATE(), status_changed_by = @u WHERE id = @id");
      await new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, item.branch_id).input('id', sql.Int, batchId).input('t', sql.Int, tireId).input('r', sql.NVarChar(500), why).input('u', sql.Int, userId)
        .query("INSERT INTO batch_quality_events (organization_id, branch_id, batch_id, tire_id, event_type, from_status, to_status, reason, user_id) VALUES (@o, @b, @id, @t, 'hold', 'released', 'on_hold', @r, @u)");
    }
  }
  return batchId;
}

/** Catch-all batch for stock that existed before tracking was switched on (or negative-stock remainders). */
async function legacyBatchId(transaction, orgId, tireId, item) {
  const f = await new sql.Request(transaction).input('t', sql.Int, tireId).query("SELECT id FROM stock_batches WHERE tire_id = @t AND batch_no = 'LEGACY'");
  if (f.recordset.length) return f.recordset[0].id;
  const ins = await new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, item.branch_id).input('t', sql.Int, tireId)
    .query("INSERT INTO stock_batches (organization_id, branch_id, tire_id, batch_no, is_legacy, notes) OUTPUT INSERTED.id VALUES (@o, @b, @t, 'LEGACY', 1, 'Stock held before batch tracking was enabled')");
  return ins.recordset[0].id;
}

/** Switch an item's tracking mode. Stock already on hand moves into the LEGACY batch so balances stay consistent. */
async function changeTracking(transaction, { orgId, tireId, tracking, trackExpiry }) {
  if (!['none', 'batch', 'serial'].includes(tracking)) throw new StockError('INVALID_TRACKING', 'Tracking must be none, batch or serial');
  const item = await loadItem(transaction, orgId, tireId);
  const modeChanged = item.tracking !== tracking;
  if (modeChanged) {
    if (item.tracking !== 'none' && Number(item.stock) !== 0) {
      throw new StockError('TRACKING_IN_USE', `${item.item_name} still has ${item.stock} units in stock. Adjust stock to zero before changing how it is tracked.`, 409);
    }
    if (item.tracking === 'none' && tracking !== 'none' && Number(item.stock) !== 0) {
      const legacy = await legacyBatchId(transaction, orgId, tireId, item);
      await new sql.Request(transaction).input('b', sql.Int, legacy).input('t', sql.Int, tireId)
        .query(`INSERT INTO batch_location_stock (batch_id, location_id, qty)
                SELECT @b, location_id, qty FROM item_location_stock x
                WHERE x.tire_id = @t AND x.qty <> 0 AND NOT EXISTS (SELECT 1 FROM batch_location_stock y WHERE y.batch_id = @b AND y.location_id = x.location_id)`);
    }
  }
  await new sql.Request(transaction).input('id', sql.Int, tireId).input('tr', sql.NVarChar(10), tracking).input('te', sql.Bit, trackExpiry ? 1 : 0)
    .query('UPDATE tires SET tracking = @tr, track_expiry = @te WHERE id = @id');
  return { before: item.tracking, after: tracking, converted: modeChanged && item.tracking === 'none' && tracking !== 'none' && Number(item.stock) !== 0 };
}

const VALUATION_METHODS = ['standard', 'average', 'fifo', 'lifo'];
async function valuationMethod(transaction, orgId) {
  const r = await new sql.Request(transaction).input('o', sql.Int, orgId)
    .query("SELECT value FROM settings WHERE organization_id = @o AND [key] = 'valuation_method'");
  const v = r.recordset[0]?.value;
  return VALUATION_METHODS.includes(v) ? v : 'standard';
}

/**
 * Cost bookkeeping for one posted movement (transfers move stock, not value, so they are skipped).
 *  stock in : adds a cost layer; under 'average' a goods receipt also re-averages the item's cost price.
 *  stock out: consumes the oldest layers (the newest under 'lifo'); under 'fifo' / 'lifo' the movement's unit cost becomes the cost actually consumed.
 * Stock that has no layer (e.g. negative stock) is costed at the current cost price.
 */
async function applyCost(transaction, ctx, o, row, movementId) {
  if (o.reason === MOVEMENT.TRANSFER_OUT || o.reason === MOVEMENT.TRANSFER_IN) return;
  const q = o.qtyChange, tireId = o.tireId;
  const current = Number(row.cost_price ?? 0);

  if (q > 0) {
    let cost = o.unitCost;
    if (cost === undefined || cost === null) {
      // reversals (void / cancel) return stock at the cost it originally left at
      if (o.reverseOf) {
        const rq = new sql.Request(transaction).input('t', sql.Int, tireId).input('ref', sql.Int, o.reverseOf.refId);
        const inList = o.reverseOf.reasons.map((r, i) => { rq.input('r' + i, sql.NVarChar(50), r); return '@r' + i; }).join(',');
        const orig = (await rq.query(`SELECT SUM(ABS(qty_change) * ISNULL(unit_cost, 0)) AS v, SUM(ABS(qty_change)) AS n FROM stock_movements
                                      WHERE tire_id = @t AND ref_id = @ref AND reason IN (${inList})`)).recordset[0];
        if (orig?.n) cost = Number(orig.v) / Number(orig.n);
      }
      cost = cost ?? current;
    }
    cost = Number(cost);
    await new sql.Request(transaction).input('t', sql.Int, tireId).input('q', sql.Int, q).input('c', sql.Decimal(18, 4), cost).input('m', sql.Int, movementId)
      .query('INSERT INTO stock_cost_layers (tire_id, qty_received, qty_remaining, unit_cost, movement_id) VALUES (@t, @q, @q, @c, @m)');
    if (ctx.method === 'average' && o.reason === MOVEMENT.GRN_RECEIVED) {
      const onHand = Math.max(Number(row.qty_before), 0);
      const avg = (onHand * current + q * cost) / (onHand + q);
      await new sql.Request(transaction).input('t', sql.Int, tireId).input('c', sql.Decimal(18, 2), Math.round(avg * 100) / 100)
        .query('UPDATE tires SET cost_price = @c WHERE id = @t');
    }
    return;
  }

  let need = -q, total = 0;
  const layers = (await new sql.Request(transaction).input('t', sql.Int, tireId)
    .query('SELECT id, qty_remaining, unit_cost FROM stock_cost_layers WITH (UPDLOCK) WHERE tire_id = @t AND qty_remaining > 0 ' + (ctx.method === 'lifo' ? 'ORDER BY created_at DESC, id DESC' : 'ORDER BY created_at, id'))).recordset;
  for (const l of layers) {
    if (need <= 0) break;
    const take = Math.min(need, l.qty_remaining);
    await new sql.Request(transaction).input('id', sql.Int, l.id).input('n', sql.Int, take)
      .query('UPDATE stock_cost_layers SET qty_remaining = qty_remaining - @n WHERE id = @id');
    total += take * Number(l.unit_cost); need -= take;
  }
  total += need * current;
  if (ctx.method === 'fifo' || ctx.method === 'lifo') {
    await new sql.Request(transaction).input('id', sql.Int, movementId).input('c', sql.Decimal(18, 4), Math.round((total / -q) * 10000) / 10000)
      .query('UPDATE stock_movements SET unit_cost = @c WHERE id = @id');
  }
}

/** Write one movement against one (batch, location). Guards run before any write so a refusal leaves nothing behind. */
async function postOne(transaction, ctx, o) {
  const { item, loc, allowNeg } = ctx;
  const { orgId, tireId, qtyChange, batchId = null } = o;
  await hazmat.guardMovement(transaction, ctx, o);
  const aq = Math.abs(qtyChange);
  const insufficient = (what, available) => new StockError('INSUFFICIENT_STOCK',
    `Insufficient stock for ${item.item_name}${what}: ${available} available, ${aq} required`, 409, { tireId, locationId: loc.id, batchId, available, required: aq });

  let batchBefore = null;
  if (batchId) {
    const bu = await new sql.Request(transaction).input('b', sql.Int, batchId).input('l', sql.Int, loc.id).input('q', sql.Int, qtyChange).input('neg', sql.Bit, allowNeg ? 1 : 0)
      .query(`UPDATE batch_location_stock SET qty = qty + @q OUTPUT DELETED.qty AS before_qty
              WHERE batch_id = @b AND location_id = @l AND (@neg = 1 OR @q >= 0 OR qty + @q >= 0)`);
    if (bu.recordset.length) batchBefore = bu.recordset[0].before_qty;
    else {
      const cur = await new sql.Request(transaction).input('b', sql.Int, batchId).input('l', sql.Int, loc.id)
        .query('SELECT qty FROM batch_location_stock WHERE batch_id = @b AND location_id = @l');
      if (cur.recordset.length || (qtyChange < 0 && !allowNeg)) {
        const bn = (await new sql.Request(transaction).input('b', sql.Int, batchId).query('SELECT batch_no FROM stock_batches WHERE id = @b')).recordset[0]?.batch_no;
        throw insufficient(` (batch ${bn}) at ${loc.name}`, cur.recordset[0]?.qty ?? 0);
      }
      batchBefore = 0;
      await new sql.Request(transaction).input('b', sql.Int, batchId).input('l', sql.Int, loc.id).input('q', sql.Int, qtyChange)
        .query('INSERT INTO batch_location_stock (batch_id, location_id, qty) VALUES (@b, @l, @q)');
    }
  }

  let locBefore;
  const locUpd = await new sql.Request(transaction)
    .input('t', sql.Int, tireId).input('l', sql.Int, loc.id).input('q', sql.Int, qtyChange).input('neg', sql.Bit, allowNeg ? 1 : 0)
    .query(`UPDATE item_location_stock SET qty = qty + @q OUTPUT DELETED.qty AS before_qty
            WHERE tire_id = @t AND location_id = @l AND (@neg = 1 OR @q >= 0 OR qty + @q >= 0)`);
  if (locUpd.recordset.length) {
    locBefore = locUpd.recordset[0].before_qty;
  } else {
    const cur = await new sql.Request(transaction).input('t', sql.Int, tireId).input('l', sql.Int, loc.id)
      .query('SELECT qty FROM item_location_stock WHERE tire_id = @t AND location_id = @l');
    if (cur.recordset.length || (qtyChange < 0 && !allowNeg)) {
      const available = cur.recordset[0]?.qty ?? 0;
      const multi = (await new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, item.branch_id)
        .query('SELECT COUNT(*) AS n FROM stock_locations WHERE organization_id = @o AND branch_id = @b AND is_active = 1')).recordset[0].n > 1;
      throw insufficient(multi ? ` at ${loc.name}` : '', available);
    }
    locBefore = 0;
    await new sql.Request(transaction).input('t', sql.Int, tireId).input('l', sql.Int, loc.id).input('q', sql.Int, qtyChange)
      .query('INSERT INTO item_location_stock (tire_id, location_id, qty) VALUES (@t, @l, @q)');
  }

  if (qtyChange < 0 && !o.ignoreReserved) {
    const reserved = await reservedQty(transaction, tireId, loc.id);
    if (reserved > 0 && locBefore + qtyChange < reserved) {
      throw new StockError('RESERVED_STOCK',
        `${item.item_name}: ${reserved} reserved, only ${Math.max(0, locBefore - reserved)} free to issue (${aq} requested). Release a reservation first.`, 409,
        { tireId, locationId: loc.id, reserved, free: Math.max(0, locBefore - reserved), required: aq });
    }
  }

  const upd = await new sql.Request(transaction)
    .input('id', sql.Int, tireId).input('o', sql.Int, orgId).input('q', sql.Int, qtyChange)
    .query(`UPDATE tires SET stock = stock + @q
            OUTPUT DELETED.stock AS qty_before, INSERTED.stock AS qty_after, INSERTED.branch_id, INSERTED.cost_price,
                   INSERTED.brand + ' ' + INSERTED.model + ' ' + INSERTED.size AS item_name
            WHERE id = @id AND organization_id = @o`);
  const row = upd.recordset[0];

  const ins = await new sql.Request(transaction)
    .input('tire_id', sql.Int, tireId).input('org', sql.Int, orgId).input('branch', sql.Int, row.branch_id).input('loc', sql.Int, loc.id).input('batch', sql.Int, batchId)
    .input('q', sql.Int, qtyChange).input('reason', sql.NVarChar(50), o.reason)
    .input('reference', sql.NVarChar(100), o.reference ?? null).input('ref_id', sql.Int, o.refId ?? null).input('notes', sql.NVarChar(500), o.notes ?? null)
    .input('before', sql.Int, row.qty_before).input('after', sql.Int, row.qty_after)
    .input('cost', sql.Decimal(18, 4), o.unitCost ?? row.cost_price).input('user', sql.Int, o.userId ?? null)
    .input('key', sql.NVarChar(100), o.idempotencyKey ?? null).input('name', sql.NVarChar(200), row.item_name)
    .query(`INSERT INTO stock_movements
              (tire_id, organization_id, branch_id, location_id, batch_id, qty_change, reason, reference, ref_id, notes,
               qty_before, qty_after, unit_cost, user_id, idempotency_key, item_name)
            OUTPUT INSERTED.id
            VALUES (@tire_id, @org, @branch, @loc, @batch, @q, @reason, @reference, @ref_id, @notes,
                    @before, @after, @cost, @user, @key, @name)`);

  await applyCost(transaction, ctx, o, row, ins.recordset[0].id);

  return { movementId: ins.recordset[0].id, before: row.qty_before, after: row.qty_after, itemName: row.item_name,
           locationId: loc.id, locationBefore: locBefore, locationAfter: locBefore + qtyChange, batchId, batchBefore };
}

async function sumQty(transaction, sqlText, params) {
  const rq = new sql.Request(transaction);
  for (const [k, t, v] of params) rq.input(k, t, v);
  return (await rq.query(sqlText)).recordset;
}

/** Quantities that can be reversed per (batch, location), from the movements of the original document. */
async function reversalCapacity(transaction, orgId, tireId, reverseOf, sign) {
  const reasons = reverseOf.reasons;
  const rq = new sql.Request(transaction).input('o', sql.Int, orgId).input('t', sql.Int, tireId).input('ref', sql.Int, reverseOf.refId);
  const inList = reasons.map((r, i) => { rq.input('r' + i, sql.NVarChar(50), r); return '@r' + i; }).join(',');
  const rows = (await rq.query(`SELECT batch_id, location_id, SUM(qty_change) AS net FROM stock_movements
                                WHERE organization_id = @o AND tire_id = @t AND ref_id = @ref AND batch_id IS NOT NULL AND reason IN (${inList})
                                GROUP BY batch_id, location_id ORDER BY batch_id`)).recordset;
  return rows.map(r => ({ batchId: r.batch_id, locationId: r.location_id, capacity: -sign * r.net })).filter(r => r.capacity > 0);
}

/** Decide which batches (and locations) a tracked movement hits. Returns [{ batchId, qty, locationId? }] summing to qtyChange. */
async function planTracked(transaction, ctx, o) {
  const { item, loc, allowNeg } = ctx;
  const q = o.qtyChange;
  const serial = item.tracking === 'serial';

  if (q > 0) {
    const assertSerialFree = async batchId => {
      if (!serial) return;
      const b = await getBatch(transaction, o.orgId, o.tireId, batchId);
      if (b.is_legacy) return;
      const held = (await sumQty(transaction, 'SELECT ISNULL(SUM(qty), 0) AS n FROM batch_location_stock WHERE batch_id = @b', [['b', sql.Int, batchId]]))[0].n;
      if (held > 0) throw new StockError('DUPLICATE_SERIAL', `Serial number ${b.batch_no} is already in stock`, 409);
    };
    if (o.batchId) {
      const b = await getBatch(transaction, o.orgId, o.tireId, o.batchId);
      if (serial && !b.is_legacy && q !== 1) throw new StockError('SERIAL_QTY', 'A serial number is a single unit', 400);
      await assertSerialFree(o.batchId);
      return [{ batchId: o.batchId, qty: q }];
    }
    if (o.reverseOf) {
      const cap = await reversalCapacity(transaction, o.orgId, o.tireId, o.reverseOf, 1);
      const parts = []; let left = q;
      for (const c of cap) { if (left <= 0) break; const take = Math.min(left, c.capacity); parts.push({ batchId: c.batchId, qty: take, locationId: c.locationId }); left -= take; }
      if (left > 0) parts.push({ batchId: await legacyBatchId(transaction, o.orgId, o.tireId, item), qty: left });
      for (const p of parts) await assertSerialFree(p.batchId);
      return parts;
    }
    if (serial) {
      const serials = Array.isArray(o.serials) ? o.serials.map(x => String(x).trim()).filter(Boolean) : (o.batch?.batchNo ? [String(o.batch.batchNo).trim()] : []);
      if (!serials.length) throw new StockError('BATCH_REQUIRED', `Serial numbers are required for ${item.item_name}`);
      if (serials.length !== q) throw new StockError('SERIAL_COUNT', `${item.item_name}: ${q} unit(s) received but ${serials.length} serial number(s) entered`, 400);
      if (new Set(serials.map(x => x.toLowerCase())).size !== serials.length) throw new StockError('DUPLICATE_SERIAL', 'The same serial number was entered twice', 400);
      const parts = [];
      for (const sn of serials) {
        const id = await ensureBatch(transaction, { orgId: o.orgId, item, tireId: o.tireId, batchNo: sn, expiryDate: o.batch?.expiryDate, unitCost: o.unitCost ?? null, receivedDate: o.batch?.receivedDate, mfgDate: o.batch?.mfgDate, userId: o.userId });
        await assertSerialFree(id);
        parts.push({ batchId: id, qty: 1 });
      }
      return parts;
    }
    if (!o.batch) throw new StockError('BATCH_REQUIRED', `Batch / lot number is required for ${item.item_name}`);
    const id = await ensureBatch(transaction, { orgId: o.orgId, item, tireId: o.tireId, batchNo: o.batch.batchNo, expiryDate: o.batch.expiryDate, unitCost: o.batch.unitCost ?? o.unitCost ?? null, receivedDate: o.batch.receivedDate, mfgDate: o.batch.mfgDate, userId: o.userId });
    return [{ batchId: id, qty: q }];
  }

  // ── issues ──
  const need = -q;
  if (o.batchId) {
    const b = await getBatch(transaction, o.orgId, o.tireId, o.batchId);
    if (!o.includeExpired && isExpired(b)) throw new StockError('EXPIRED_BATCH', `Batch ${b.batch_no} of ${item.item_name} expired on ${new Date(b.expiry_date).toISOString().slice(0, 10)}`, 409);
    if (!o.includeExpired && isRestricted(b.quality_status)) throw new StockError('BATCH_RESTRICTED', `Batch ${b.batch_no} of ${item.item_name} is ${QUALITY_STATUSES[b.quality_status]?.toLowerCase() ?? b.quality_status} and cannot be used`, 409, { batchId: b.id });
    return [{ batchId: o.batchId, qty: q }];
  }
  if (Array.isArray(o.serials) && o.serials.length) {
    if (o.serials.length !== need) throw new StockError('SERIAL_COUNT', `${need} unit(s) but ${o.serials.length} serial number(s) given`, 400);
    const parts = [];
    for (const sn of o.serials.map(x => String(x).trim())) {
      const r = await sumQty(transaction, `SELECT b.id, b.expiry_date, b.quality_status, ISNULL(x.qty, 0) AS qty FROM stock_batches b
        LEFT JOIN batch_location_stock x ON x.batch_id = b.id AND x.location_id = @l WHERE b.tire_id = @t AND b.batch_no = @n`,
        [['t', sql.Int, o.tireId], ['l', sql.Int, loc.id], ['n', sql.NVarChar(60), sn]]);
      if (!r.length || r[0].qty < 1) throw new StockError('SERIAL_NOT_FOUND', `Serial number ${sn} is not in stock at ${loc.name}`, 409);
      if (!o.includeExpired && isExpired(r[0])) throw new StockError('EXPIRED_BATCH', `Serial number ${sn} has expired`, 409);
      if (!o.includeExpired && isRestricted(r[0].quality_status)) throw new StockError('BATCH_RESTRICTED', `Serial number ${sn} is ${QUALITY_STATUSES[r[0].quality_status]?.toLowerCase() ?? r[0].quality_status} and cannot be used`, 409);
      parts.push({ batchId: r[0].id, qty: -1 });
    }
    return parts;
  }

  const parts = []; let left = need;
  if (o.reverseOf) {
    const cap = await reversalCapacity(transaction, o.orgId, o.tireId, o.reverseOf, -1);
    for (const c of cap) { if (left <= 0) break; const take = Math.min(left, c.capacity); parts.push({ batchId: c.batchId, qty: -take, locationId: c.locationId }); left -= take; }
  }
  if (left > 0) {
    // Pick by the item's rotation policy (default FEFO for expiring goods, FIFO otherwise). Expired batches are skipped unless writing them off.
    const rot = await resolveRotation(transaction, o.orgId, o.tireId);
    if (rot.policy === 'manual' && o.reason === MOVEMENT.SALE) {
      throw new StockError('MANUAL_ROTATION', `${item.item_name} is set to manual picking: choose the batch or serial number to sell`, 409, { tireId: o.tireId });
    }
    const rows = await sumQty(transaction, `SELECT b.id, b.expiry_date, x.qty FROM batch_location_stock x JOIN stock_batches b ON b.id = x.batch_id
      WHERE b.tire_id = @t AND x.location_id = @l AND x.qty > 0 ${o.includeExpired ? '' : "AND (b.expiry_date IS NULL OR b.expiry_date >= CAST(GETDATE() AS DATE)) AND b.quality_status = 'released'"}
      ${rotationOrderBy(rot.policy)}`,
      [['t', sql.Int, o.tireId], ['l', sql.Int, loc.id]]);
    for (const r of rows) {
      if (left <= 0) break;
      const used = parts.filter(p => p.batchId === r.id && !p.locationId).reduce((a, p) => a - p.qty, 0);
      const take = Math.min(left, r.qty - used);
      if (take > 0) { parts.push({ batchId: r.id, qty: -take }); left -= take; }
    }
  }
  if (left > 0) {
    if (allowNeg) {
      parts.push({ batchId: await legacyBatchId(transaction, o.orgId, o.tireId, item), qty: -left });
    } else {
      const available = parts.reduce((a, p) => a - p.qty, 0);
      let note = '';
      if (!o.includeExpired) {
        const ex = (await sumQty(transaction, `SELECT ISNULL(SUM(x.qty), 0) AS n FROM batch_location_stock x JOIN stock_batches b ON b.id = x.batch_id
          WHERE b.tire_id = @t AND x.location_id = @l AND x.qty > 0 AND b.expiry_date < CAST(GETDATE() AS DATE)`, [['t', sql.Int, o.tireId], ['l', sql.Int, loc.id]]))[0].n;
        const hd = (await sumQty(transaction, `SELECT ISNULL(SUM(x.qty), 0) AS n FROM batch_location_stock x JOIN stock_batches b ON b.id = x.batch_id
          WHERE b.tire_id = @t AND x.location_id = @l AND x.qty > 0 AND b.quality_status <> 'released' AND (b.expiry_date IS NULL OR b.expiry_date >= CAST(GETDATE() AS DATE))`, [['t', sql.Int, o.tireId], ['l', sql.Int, loc.id]]))[0].n;
        const parts2 = [];
        if (ex > 0) parts2.push(`${ex} expired`);
        if (hd > 0) parts2.push(`${hd} on quality hold, recalled or damaged`);
        if (parts2.length) note = ` (${parts2.join(' and ')} unit${ex + hd === 1 ? '' : 's'} excluded)`;
      }
      throw new StockError('INSUFFICIENT_STOCK', `Insufficient stock for ${item.item_name}: ${available} available${note}, ${need} required`, 409,
        { tireId: o.tireId, locationId: loc.id, available, required: need });
    }
  }
  return parts;
}

/**
 * Post a stock movement. `transaction` must already be begun.
 * Options: orgId, tireId, qtyChange, reason, reference, refId, notes, userId, idempotencyKey, unitCost, allowNegative,
 *   locationId (default: branch default location),
 *   tracked items: batchId | batch { batchNo, expiryDate, unitCost } | serials [..] | reverseOf { refId, reasons[] } | includeExpired.
 * Returns { duplicate, movementId, before, after, itemName, locationId, allocations: [{ batchId, qty, movementId }] }.
 */
async function postMovement(transaction, o) {
  const { orgId, tireId, qtyChange, idempotencyKey = null } = o;
  if (!Number.isInteger(qtyChange)) throw new StockError('INVALID_QUANTITY', 'Quantity must be a whole number');
  if (qtyChange === 0) return { duplicate: false, movementId: null, skipped: true, allocations: [] };

  if (idempotencyKey) {
    const dup = await new sql.Request(transaction).input('o', sql.Int, orgId).input('k', sql.NVarChar(100), idempotencyKey).input('kp', sql.NVarChar(110), idempotencyKey + ':b%')
      .query('SELECT TOP 1 id FROM stock_movements WHERE organization_id = @o AND (idempotency_key = @k OR idempotency_key LIKE @kp)');
    if (dup.recordset.length) return { duplicate: true, movementId: dup.recordset[0].id, allocations: [] };
  }

  const allowNeg = o.allowNegative ?? await allowNegativeStock(transaction, orgId);
  const item = await loadItem(transaction, orgId, tireId);
  const loc = await resolveLocation(transaction, orgId, item.branch_id, o.locationId ?? null);
  const ctx = { item, loc, allowNeg, method: await valuationMethod(transaction, orgId) };

  if (item.tracking === 'none') {
    if (o.batchId) throw new StockError('INVALID_BATCH', `${item.item_name} is not batch tracked`, 400);
    const r = await postOne(transaction, ctx, o);
    return { duplicate: false, ...r, allocations: [] };
  }

  const parts = await planTracked(transaction, ctx, o);
  const results = [];
  const locCache = new Map([[loc.id, loc]]);
  for (const p of parts) {
    let partLoc = loc;
    if (p.locationId && p.locationId !== loc.id) {
      if (!locCache.has(p.locationId)) {
        try { locCache.set(p.locationId, await resolveLocation(transaction, orgId, item.branch_id, p.locationId)); }
        catch { locCache.set(p.locationId, loc); }   // original location is gone or inactive: fall back
      }
      partLoc = locCache.get(p.locationId);
    }
    results.push(await postOne(transaction, { ...ctx, loc: partLoc }, {
      ...o, qtyChange: p.qty, batchId: p.batchId, idempotencyKey: idempotencyKey ? `${idempotencyKey}:b${p.batchId}` : null,
    }));
  }
  const first = results[0], last = results[results.length - 1];
  return { duplicate: false, movementId: first.movementId, before: first.before, after: last.after, itemName: first.itemName, locationId: first.locationId,
           allocations: results.map(r => ({ batchId: r.batchId, qty: r.after - r.before, movementId: r.movementId })) };
}

/**
 * A sale that fulfils a reservation uses up (all or part of) the hold, so the reserved stock can be issued.
 * Sales issue from the branch's default location, so the reservation must be held there.
 */
async function fulfilReservation(transaction, { orgId, reservationId, tireId, qty, saleId, userId }) {
  const r = await new sql.Request(transaction).input('id', sql.Int, reservationId).input('o', sql.Int, orgId)
    .query('SELECT * FROM stock_reservations WITH (UPDLOCK) WHERE id = @id AND organization_id = @o');
  const rv = r.recordset[0];
  if (!rv || rv.tire_id !== tireId) throw new StockError('RESERVATION_NOT_FOUND', 'Reservation not found for this item', 404);
  if (rv.status !== 'active') throw new StockError('RESERVATION_CLOSED', `Reservation is already ${rv.status}`, 409);
  if (rv.expires_at && new Date(rv.expires_at) < new Date(new Date().toISOString().slice(0, 10))) throw new StockError('RESERVATION_EXPIRED', 'This reservation has expired', 409);
  const def = await defaultLocationId(transaction, orgId, rv.branch_id);
  if (rv.location_id !== def) throw new StockError('RESERVATION_LOCATION', 'This reservation is held outside the selling location. Transfer the stock there first.', 409);
  const used = Math.min(qty, rv.qty);
  if (used >= rv.qty) {
    await new sql.Request(transaction).input('id', sql.Int, reservationId).input('s', sql.Int, saleId).input('u', sql.Int, userId ?? null)
      .query("UPDATE stock_reservations SET status = 'fulfilled', sale_id = @s, closed_at = GETDATE(), closed_by = @u WHERE id = @id");
  } else {
    await new sql.Request(transaction).input('id', sql.Int, reservationId).input('q', sql.Int, used).query('UPDATE stock_reservations SET qty = qty - @q WHERE id = @id');
  }
  return used;
}

/** Pending approval is needed for staff, and for managers above the organisation's threshold. */
// Staff always need approval; managers when the quantity exceeds adjustment_approval_threshold, or when a physical-loss write-off is worth more
// than loss_writeoff_approval_value (estValue = quantity at the item's current cost).
// With role permissions (user.perms): "post adjustments directly" is required to skip approval, restricted reasons need "approve restricted
// adjustments", and the role's approval limit caps the value a non-administrator may post without a higher authority.
async function needsApproval(transaction, orgId, user, qtyChange, { isLoss = false, estValue = 0, reasonCode = null } = {}) {
  const role = typeof user === 'string' ? user : user.role;
  if (role === 'org_admin' || role === 'demo') return false;
  if (user && user.perms) {
    // Count variances may be posted by an authority that can approve counts, even without the general right to post adjustments.
    if (!user.perms.has('stock.adjust_direct') && !(reasonCode === 'count_correction' && user.perms.has('stock.count_approve'))) return true;
    if (reasonCode && !user.perms.has('stock.approve_restricted') && (await require('./permissions').restrictedReasons(transaction, orgId)).includes(reasonCode)) return true;
    if (user.approvalLimit != null && estValue > user.approvalLimit) return true;
  } else if (role !== 'branch_manager') return true;
  const r = await new sql.Request(transaction).input('o', sql.Int, orgId)
    .query("SELECT [key], value FROM settings WHERE organization_id = @o AND [key] IN ('adjustment_approval_threshold', 'loss_writeoff_approval_value')");
  const get = k => r.recordset.find(x => x.key === k)?.value;
  const threshold = parseInt(get('adjustment_approval_threshold') ?? '0', 10);
  if (threshold > 0 && Math.abs(qtyChange) > threshold) return true;
  const valueLimit = Number(get('loss_writeoff_approval_value'));
  return isLoss && Number.isFinite(valueLimit) && valueLimit > 0 && estValue > valueLimit;
}

function validateAdjustment({ qtyChange, reasonCode, notes }) {
  const reason = ADJUSTMENT_REASONS[reasonCode];
  if (!Object.prototype.hasOwnProperty.call(ADJUSTMENT_REASONS, reasonCode)) throw new StockError('INVALID_REASON', 'A valid reason is required');
  if (!Number.isInteger(qtyChange) || qtyChange === 0) throw new StockError('INVALID_QUANTITY', 'Adjustment must be a non-zero whole number');
  if (Math.abs(qtyChange) > 1000000) throw new StockError('INVALID_QUANTITY', 'Adjustment quantity is too large');
  if (reason.direction === 'out' && qtyChange > 0) throw new StockError('INVALID_DIRECTION', `${reason.label} must reduce stock`);
  if (reason.direction === 'in' && qtyChange < 0) throw new StockError('INVALID_DIRECTION', `${reason.label} must increase stock`);
  if ((reasonCode === 'other' || reasonCode === 'missing_stock') && !String(notes || '').trim()) throw new StockError('NOTES_REQUIRED', `Notes are required when the reason is "${reason.label}"`);
}

/**
 * Record an adjustment document. Posts the movement immediately unless approval is needed,
 * in which case it is stored as pending. Returns { id, status, movementId? }.
 */
async function createAdjustment(transaction, { orgId, user, tireId, qtyChange, reasonCode, notes, locationId = null, batchId = null, batch = null }) {
  validateAdjustment({ qtyChange, reasonCode, notes });
  const item = await new sql.Request(transaction).input('id', sql.Int, tireId).input('o', sql.Int, orgId)
    .query("SELECT id, branch_id, tracking, track_expiry, cost_price, brand + ' ' + model + ' ' + size AS item_name FROM tires WHERE id = @id AND organization_id = @o");
  const tire = item.recordset[0];
  // Branch-scoped users may only touch their own branch's items.
  if (!tire || (user.branchId != null && tire.branch_id !== user.branchId)) throw new StockError('ITEM_NOT_FOUND', 'Inventory item not found', 404);

  const loc = await resolveLocation(transaction, orgId, tire.branch_id, locationId);
  await access.assertLocationAccess(transaction, orgId, user, loc.id, qtyChange < 0 ? 'issue' : 'receive');
  // Tracked items: an increase must say which batch / serial it adds to; a decrease may name one, otherwise FEFO picks.
  let adjBatchId = null;
  if (tire.tracking !== 'none') {
    if (batchId) { await getBatch(transaction, orgId, tireId, batchId); adjBatchId = batchId; }
    else if (qtyChange > 0) {
      if (!batch?.batchNo) throw new StockError('BATCH_REQUIRED', `${tire.tracking === 'serial' ? 'Serial number' : 'Batch / lot number'} is required to add stock to ${tire.item_name}`);
      adjBatchId = await ensureBatch(transaction, { orgId, item: tire, tireId, batchNo: batch.batchNo, expiryDate: batch.expiryDate });
    }
  } else if (batchId || batch) throw new StockError('INVALID_BATCH', `${tire.item_name} is not batch tracked`, 400);
  const pending = await needsApproval(transaction, orgId, user, qtyChange, { isLoss: !!ADJUSTMENT_REASONS[reasonCode].loss, estValue: Math.abs(qtyChange) * Number(tire.cost_price || 0), reasonCode });
  const ins = await new sql.Request(transaction)
    .input('o', sql.Int, orgId).input('b', sql.Int, tire.branch_id).input('t', sql.Int, tireId).input('n', sql.NVarChar(200), tire.item_name)
    .input('q', sql.Int, qtyChange).input('rc', sql.NVarChar(30), reasonCode).input('notes', sql.NVarChar(500), notes ? String(notes).slice(0, 500) : null)
    .input('st', sql.NVarChar(20), pending ? 'pending' : 'approved').input('u', sql.Int, user.userId).input('loc', sql.Int, loc.id).input('bt', sql.Int, adjBatchId)
    .query(`INSERT INTO stock_adjustments (organization_id, branch_id, tire_id, item_name, qty_change, reason_code, notes, status, requested_by,
                                            decided_by, decided_at, location_id, batch_id)
            OUTPUT INSERTED.id
            VALUES (@o, @b, @t, @n, @q, @rc, @notes, @st, @u, ${pending ? 'NULL, NULL' : '@u, GETDATE()'}, @loc, @bt)`);
  const id = ins.recordset[0].id;
  if (pending) return { id, status: 'pending' };

  const mv = await postMovement(transaction, {
    orgId, tireId, qtyChange, reason: MOVEMENT.ADJUSTMENT, reference: `ADJ-${id}`, refId: id, locationId: loc.id, batchId: adjBatchId ?? undefined, includeExpired: true,
    notes: `${ADJUSTMENT_REASONS[reasonCode].label}${notes ? `: ${notes}` : ''}`.slice(0, 500), userId: user.userId, idempotencyKey: `adj:${id}`,
  });
  await new sql.Request(transaction).input('id', sql.Int, id).input('m', sql.Int, mv.movementId)
    .query('UPDATE stock_adjustments SET movement_id = @m WHERE id = @id');
  return { id, status: 'approved', movementId: mv.movementId, before: mv.before, after: mv.after };
}

/** One line in a transfer's audit trail (dispatch, receipt, short receipt, cancellation). */
async function transferEvent(transaction, orgId, transferId, event, userId, note = null, details = null) {
  await new sql.Request(transaction).input('o', sql.Int, orgId).input('t', sql.Int, transferId).input('e', sql.NVarChar(24), event).input('u', sql.Int, userId ?? null)
    .input('n', sql.NVarChar(500), note ? String(note).slice(0, 500) : null).input('d', sql.NVarChar(1000), details ? JSON.stringify(details).slice(0, 1000) : null)
    .query('INSERT INTO transfer_events (organization_id, transfer_id, event, user_id, note, details) VALUES (@o, @t, @e, @u, @n, @d)');
}

/** The same product in another branch of the organisation: same SKU first, otherwise same brand, model and size. */
async function matchBranchItem(transaction, orgId, src, branchId) {
  const r = await new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('sku', sql.NVarChar(60), src.sku ?? null)
    .input('br', sql.NVarChar(100), src.brand ?? '').input('m', sql.NVarChar(100), src.model ?? '').input('s', sql.NVarChar(100), src.size ?? '')
    .query(`SELECT TOP 1 id, tracking FROM tires WHERE organization_id = @o AND branch_id = @b AND (sku = @sku OR (brand = @br AND model = @m AND size = @s))
            ORDER BY CASE WHEN sku = @sku THEN 0 ELSE 1 END, id`);
  return r.recordset[0] ?? null;
}

/** First transfer of a product into a branch that does not stock it yet: copy the item master (no stock, no hold) so the units have somewhere to land. */
async function cloneItemToBranch(transaction, orgId, srcTireId, branchId) {
  const cols = (await new sql.Request(transaction).query(
    "SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('tires') AND c.is_identity = 0 AND c.is_computed = 0 AND c.system_type_id <> 189")).recordset.map(c => c.name);
  const skip = new Set(['branch_id', 'stock', 'sku', 'barcode', 'created_at', 'updated_at', 'hazard_hold', 'hazard_hold_reason', 'lifecycle_status', 'lifecycle_note', 'lifecycle_set_at', 'lifecycle_set_by']);
  const list = cols.filter(c => !skip.has(c)).map(c => `[${c}]`).join(', ');
  const ins = await new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('src', sql.Int, srcTireId)
    .query(`INSERT INTO tires (branch_id, stock, ${list}) OUTPUT INSERTED.id SELECT @b, 0, ${list} FROM tires WHERE id = @src AND organization_id = @o`);
  const id = ins.recordset[0].id;
  await new sql.Request(transaction).input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('src', sql.Int, srcTireId).input('id', sql.Int, id)
    .query(`UPDATE tires SET
              sku = ISNULL((SELECT s.sku FROM tires s WHERE s.id = @src AND NOT EXISTS (SELECT 1 FROM tires x WHERE x.organization_id = @o AND x.branch_id = @b AND x.sku = s.sku)), 'SKU-' + RIGHT('000000' + CAST(@id AS NVARCHAR(10)), 6)),
              barcode = (SELECT s.barcode FROM tires s WHERE s.id = @src AND s.barcode IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tires x WHERE x.organization_id = @o AND x.branch_id = @b AND x.barcode = s.barcode))
            WHERE id = @id`);
  return id;
}

const isoDay = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * Move stock between two locations. All lines post together or not at all (caller's transaction).
 *  - Same branch: completes at once, or stays in transit until the destination confirms (inTransit).
 *  - Different branch: always in transit; only a manager or administrator may send it. The units leave the source branch now and
 *    only reach the destination branch when settleTransfer confirms receipt there.
 * Each line is a transfer_out (plus a transfer_in on completion) so history shows both sides. items: [{ tireId, qty }].
 */
async function transferStock(transaction, { orgId, user, fromLocationId, toLocationId, items, notes = null, inTransit = false, expectedAt = null, carrier = null, reference = null }) {
  if (!Number.isInteger(fromLocationId) || !Number.isInteger(toLocationId)) throw new StockError('INVALID_LOCATION', 'Choose both locations');
  if (fromLocationId === toLocationId) throw new StockError('SAME_LOCATION', 'Source and destination must be different locations');
  if (!Array.isArray(items) || !items.length) throw new StockError('NO_ITEMS', 'Add at least one item to transfer');
  if (items.length > 200) throw new StockError('TOO_MANY_ITEMS', 'A transfer can have at most 200 lines');
  const seen = new Set();
  for (const it of items) {
    if (!Number.isInteger(it.tireId) || !Number.isInteger(it.qty) || it.qty <= 0) throw new StockError('INVALID_QUANTITY', 'Each line needs an item and a positive whole quantity');
    if (seen.has(it.tireId)) throw new StockError('DUPLICATE_LINE', 'The same item appears twice; combine the quantities');
    seen.add(it.tireId);
  }
  if (expectedAt && (!/^\d{4}-\d{2}-\d{2}$/.test(String(expectedAt)) || Number.isNaN(new Date(`${expectedAt}T00:00:00Z`).getTime()))) throw new StockError('INVALID_DATE', 'Expected arrival must be a date (YYYY-MM-DD)');

  const locs = await new sql.Request(transaction).input('o', sql.Int, orgId).input('a', sql.Int, fromLocationId).input('b', sql.Int, toLocationId)
    .query('SELECT id, branch_id, name, is_active, kind, temp_min_c, temp_max_c, inspection_interval_days FROM stock_locations WHERE organization_id = @o AND id IN (@a, @b)');
  const from = locs.recordset.find(l => l.id === fromLocationId), to = locs.recordset.find(l => l.id === toLocationId);
  if (!from || !to) throw new StockError('INVALID_LOCATION', 'Stock location not found', 404);
  const cross = from.branch_id !== to.branch_id;
  if (cross && !(user.perms ? user.role === 'org_admin' || user.perms.has('stock.transfer_branch') : ['org_admin', 'branch_manager'].includes(user.role))) throw new StockError('CROSS_BRANCH_FORBIDDEN', 'Only a manager or administrator can send stock to another branch', 403);
  if (user.role !== 'org_admin' && user.branchId != null && from.branch_id !== user.branchId) throw new StockError('INVALID_LOCATION', 'Stock location not found', 404);
  if (!from.is_active || !to.is_active) throw new StockError('INVALID_LOCATION', 'Both locations must be active');
  await access.assertLocationAccess(transaction, orgId, user, from.id, 'issue');
  if (cross) inTransit = true;
  else if (!inTransit) await access.assertLocationAccess(transaction, orgId, user, to.id, 'receive');
  if (cross && !(await new sql.Request(transaction).input('b', sql.Int, to.branch_id).input('o', sql.Int, orgId).query('SELECT id FROM branches WHERE id = @b AND organization_id = @o')).recordset.length)
    throw new StockError('INVALID_LOCATION', 'Destination branch not found', 404);

  // Cross-branch: find the destination branch's copy of each product now, so a mismatch is reported before anything moves.
  const destTire = new Map();
  if (cross) {
    for (const it of items) {
      const src = (await new sql.Request(transaction).input('id', sql.Int, it.tireId).input('o', sql.Int, orgId)
        .query('SELECT id, branch_id, brand, model, size, sku, tracking, LTRIM(RTRIM(brand + \' \' + model + \' \' + size)) AS name FROM tires WHERE id = @id AND organization_id = @o')).recordset[0];
      if (!src || src.branch_id !== from.branch_id) throw new StockError('ITEM_NOT_FOUND', 'Inventory item not found', 404);
      const m = await matchBranchItem(transaction, orgId, src, to.branch_id);
      if (m && m.tracking !== src.tracking) throw new StockError('TRACKING_MISMATCH', `${src.name} is tracked differently at the destination branch (${m.tracking} instead of ${src.tracking}); align the item setup first`, 409);
      destTire.set(it.tireId, m?.id ?? null);
    }
  }

  // special-handling items: the load must be compatible and the destination suitable before anything moves
  await hazmat.assertTransferAllowed(transaction, orgId, items, to);
  const transferNo = await nextDocNumber(new sql.Request(transaction), 'stock_transfers', 'TRF');
  const hdr = await new sql.Request(transaction)
    .input('o', sql.Int, orgId).input('b', sql.Int, from.branch_id).input('no', sql.NVarChar(30), transferNo)
    .input('f', sql.Int, from.id).input('t', sql.Int, to.id).input('n', sql.NVarChar(500), notes ? String(notes).slice(0, 500) : null).input('u', sql.Int, user.userId ?? null)
    .input('st', sql.NVarChar(12), inTransit ? 'in_transit' : 'completed').input('tb', sql.Int, cross ? to.branch_id : null)
    .input('ex', sql.Date, expectedAt || null).input('ca', sql.NVarChar(100), carrier ? String(carrier).slice(0, 100) : null).input('rf', sql.NVarChar(100), reference ? String(reference).slice(0, 100) : null)
    .query(`INSERT INTO stock_transfers (organization_id, branch_id, transfer_no, from_location_id, to_location_id, notes, created_by, status, to_branch_id, expected_at, carrier, reference)
            OUTPUT INSERTED.id VALUES (@o, @b, @no, @f, @t, @n, @u, @st, @tb, @ex, @ca, @rf)`);
  const id = hdr.recordset[0].id;

  for (const it of items) {
    // postMovement verifies the item belongs to the org and to this branch's locations.
    const out = await postMovement(transaction, { orgId, tireId: it.tireId, qtyChange: -it.qty, reason: MOVEMENT.TRANSFER_OUT, reference: transferNo, refId: id,
      notes: `To ${to.name}${inTransit ? ' (in transit)' : ''}`, userId: user.userId, locationId: from.id, idempotencyKey: `trf:${id}:${it.tireId}:out`, includeExpired: to.kind !== 'normal', containment: to.kind !== 'normal' });
    const insLine = () => new sql.Request(transaction).input('tr', sql.Int, id).input('t', sql.Int, it.tireId).input('n', sql.NVarChar(200), out.itemName).input('q', sql.Int, it.qty).input('d', sql.Int, destTire.get(it.tireId) ?? null)
      .query('INSERT INTO stock_transfer_items (transfer_id, tire_id, item_name, qty, dest_tire_id) VALUES (@tr, @t, @n, @q, @d)');
    if (inTransit) { await insLine(); continue; }
    // Tracked items arrive in the same batches (and serials) they left from.
    const legs = out.allocations?.length ? out.allocations.map(al => ({ qty: -al.qty, batchId: al.batchId })) : [{ qty: it.qty, batchId: undefined }];
    for (const leg of legs) {
      await postMovement(transaction, { orgId, tireId: it.tireId, qtyChange: leg.qty, reason: MOVEMENT.TRANSFER_IN, reference: transferNo, refId: id,
        notes: `From ${from.name}`, userId: user.userId, locationId: to.id, batchId: leg.batchId, idempotencyKey: `trf:${id}:${it.tireId}:in${leg.batchId ? ':' + leg.batchId : ''}`, unitCost: undefined });
    }
    await insLine();
  }
  await transferEvent(transaction, orgId, id, 'dispatched', user.userId, notes, { from: from.name, to: to.name, lines: items.length, units: items.reduce((a, i) => a + i.qty, 0), cross_branch: cross, expected_at: expectedAt || null, carrier: carrier || null });
  return { id, transferNo, lines: items.length, from: from.name, to: to.name, status: inTransit ? 'in_transit' : 'completed', crossBranch: cross };
}

/**
 * Finish an in-transit transfer.
 *  receive: the destination confirms what arrived. `lines` ([{ tire_id, qty_received }], tire_id = the sent item) lets it report less than was sent;
 *           anything not received goes back to the source location ('return') or is written off as lost in transit ('write_off', manager only) and the
 *           transfer is flagged as having a discrepancy. Across branches the units are booked into the destination branch's copy of the item
 *           (created on first transfer), batches and serials recreated, at the cost they left with.
 *  cancel:  everything goes back to the source location.
 * Returns { id, transferNo, status, discrepancy, lines }.
 */
async function settleTransfer(transaction, { orgId, user, transferId, action, lines = null, shortAction = 'return', note = null }) {
  const r = await new sql.Request(transaction).input('id', sql.Int, transferId).input('o', sql.Int, orgId)
    .query('SELECT * FROM stock_transfers WITH (UPDLOCK) WHERE id = @id AND organization_id = @o');
  const tr = r.recordset[0];
  if (!tr) throw new StockError('NOT_FOUND', 'Transfer not found', 404);
  const receiving = action === 'receive';
  const destBranch = tr.to_branch_id ?? tr.branch_id, cross = destBranch !== tr.branch_id;
  // the destination confirms receipt; the sender cancels
  if (user.role !== 'org_admin' && user.branchId != null && (receiving ? destBranch : tr.branch_id) !== user.branchId) throw new StockError('NOT_FOUND', 'Transfer not found', 404);
  if (tr.status !== 'in_transit') throw new StockError('NOT_IN_TRANSIT', `Transfer ${tr.transfer_no} is already ${tr.status}`, 409);
  if (receiving) await access.assertLocationAccess(transaction, orgId, user, tr.to_location_id, 'receive');
  else await access.assertLocationAccess(transaction, orgId, user, tr.from_location_id, 'issue');
  if (!['return', 'write_off'].includes(shortAction)) throw new StockError('INVALID_ACTION', 'Short quantities are either returned to the source or written off');
  if (receiving && shortAction === 'write_off' && !(user.role === 'org_admin' || ((user.perms ? user.perms.has('stock.transfer_branch') : user.role === 'branch_manager') && (user.branchId == null || user.branchId === tr.branch_id))))
    throw new StockError('FORBIDDEN', 'Only an administrator or the sending branch\'s manager can write off units lost in transit', 403);

  const lineRows = (await new sql.Request(transaction).input('id', sql.Int, transferId).query('SELECT tire_id, item_name, qty, dest_tire_id FROM stock_transfer_items WHERE transfer_id = @id')).recordset;
  const recv = new Map(lineRows.map(l => [l.tire_id, receiving ? l.qty : 0]));
  if (receiving && Array.isArray(lines)) {
    for (const l of lines) {
      const row = lineRows.find(x => x.tire_id === Number(l.tire_id));
      const q = Number(l.qty_received);
      if (!row) throw new StockError('INVALID_LINE', 'That item is not part of this transfer');
      if (!Number.isInteger(q) || q < 0 || q > row.qty) throw new StockError('INVALID_QUANTITY', `${row.item_name}: received quantity must be a whole number from 0 to ${row.qty}`);
      recv.set(row.tire_id, q);
    }
  }
  const total = [...recv.values()].reduce((a, b) => a + b, 0);
  const short = lineRows.reduce((a, l) => a + l.qty - recv.get(l.tire_id), 0);
  if (receiving && short > 0 && !String(note || '').trim()) throw new StockError('NOTE_REQUIRED', 'Say what happened to the missing quantity (short, damaged, refused)');

  const names = (await new sql.Request(transaction).input('f', sql.Int, tr.from_location_id).input('t', sql.Int, tr.to_location_id)
    .query('SELECT id, name FROM stock_locations WHERE id IN (@f, @t)')).recordset;
  const fromName = names.find(n => n.id === tr.from_location_id)?.name ?? 'source', toName = names.find(n => n.id === tr.to_location_id)?.name ?? 'destination';
  const src = await resolveLocation(transaction, orgId, tr.branch_id, tr.from_location_id);
  const dest = total > 0 ? await resolveLocation(transaction, orgId, destBranch, tr.to_location_id) : null;
  const outs = (await new sql.Request(transaction).input('ref', sql.Int, transferId).input('o', sql.Int, orgId).input('no', sql.NVarChar(30), tr.transfer_no)
    .query("SELECT tire_id, batch_id, -qty_change AS qty, unit_cost FROM stock_movements WHERE organization_id = @o AND reason = 'transfer_out' AND ref_id = @ref AND reference = @no ORDER BY id")).recordset;

  const destOf = new Map(lineRows.map(l => [l.tire_id, l.dest_tire_id]));
  const resolveDest = async tireId => {
    if (!cross) return tireId;
    if (destOf.get(tireId)) return destOf.get(tireId);
    const s = (await new sql.Request(transaction).input('id', sql.Int, tireId).query('SELECT id, brand, model, size, sku, tracking FROM tires WHERE id = @id')).recordset[0];
    const m = await matchBranchItem(transaction, orgId, s, destBranch);
    const id = m?.id ?? await cloneItemToBranch(transaction, orgId, tireId, destBranch);
    destOf.set(tireId, id);
    await new sql.Request(transaction).input('tr', sql.Int, transferId).input('t', sql.Int, tireId).input('d', sql.Int, id)
      .query('UPDATE stock_transfer_items SET dest_tire_id = @d WHERE transfer_id = @tr AND tire_id = @t');
    return id;
  };

  const left = new Map(recv);
  for (const m of outs) {
    const take = Math.min(m.qty, left.get(m.tire_id) ?? 0);
    left.set(m.tire_id, (left.get(m.tire_id) ?? 0) - take);
    const missing = m.qty - take, sfx = m.batch_id ? ':' + m.batch_id : '';
    if (take > 0) {
      const dt = await resolveDest(m.tire_id);
      const o = { orgId, tireId: dt, qtyChange: take, reason: MOVEMENT.TRANSFER_IN, reference: tr.transfer_no, refId: transferId, userId: user.userId, locationId: dest.id,
        notes: `Received from ${fromName}${cross ? ' (other branch)' : ' (was in transit)'}`, idempotencyKey: `trf:${transferId}:${m.tire_id}:in${sfx}` };
      if (!cross) o.batchId = m.batch_id ?? undefined;
      else {
        if (m.unit_cost != null) o.unitCost = Number(m.unit_cost);
        if (m.batch_id) {
          const b = (await new sql.Request(transaction).input('b', sql.Int, m.batch_id).query('SELECT batch_no, expiry_date, mfg_date, received_date, unit_cost FROM stock_batches WHERE id = @b')).recordset[0];
          if (b) o.batch = { batchNo: b.batch_no, expiryDate: isoDay(b.expiry_date), mfgDate: isoDay(b.mfg_date), receivedDate: isoDay(b.received_date), unitCost: m.unit_cost != null ? Number(m.unit_cost) : (b.unit_cost != null ? Number(b.unit_cost) : null) };
        }
      }
      await postMovement(transaction, o);
    }
    if (missing > 0) {
      await postMovement(transaction, { orgId, tireId: m.tire_id, qtyChange: missing, reason: MOVEMENT.TRANSFER_IN, reference: tr.transfer_no, refId: transferId,
        notes: receiving ? `Returned to source (${missing} not received)` : 'Returned to source (transfer cancelled)', userId: user.userId, locationId: src.id, batchId: m.batch_id ?? undefined,
        idempotencyKey: `trf:${transferId}:${m.tire_id}:ret${sfx}` });
      if (receiving && shortAction === 'write_off') {
        await createAdjustment(transaction, { orgId, user: { userId: user.userId, role: user.role, branchId: null }, tireId: m.tire_id, qtyChange: -missing, reasonCode: 'missing_stock',
          notes: `Lost in transit on ${tr.transfer_no}: ${String(note).slice(0, 200)}`, locationId: src.id, batchId: m.batch_id ?? null });
      }
    }
  }

  for (const l of lineRows) {
    await new sql.Request(transaction).input('tr', sql.Int, transferId).input('t', sql.Int, l.tire_id).input('r', sql.Int, recv.get(l.tire_id)).input('s', sql.Int, l.qty - recv.get(l.tire_id))
      .query('UPDATE stock_transfer_items SET qty_received = @r, qty_short = @s WHERE transfer_id = @tr AND tire_id = @t');
  }
  const status = receiving ? 'received' : 'cancelled', discrepancy = receiving && short > 0;
  await new sql.Request(transaction).input('id', sql.Int, transferId).input('st', sql.NVarChar(12), status).input('u', sql.Int, user.userId ?? null)
    .input('n', sql.NVarChar(500), note ? String(note).slice(0, 500) : null).input('d', sql.Bit, discrepancy ? 1 : 0)
    .query('UPDATE stock_transfers SET status = @st, received_at = GETDATE(), received_by = @u, received_note = @n, has_discrepancy = @d WHERE id = @id');
  await transferEvent(transaction, orgId, transferId, receiving ? (discrepancy ? 'received_short' : 'received') : 'cancelled', user.userId, note,
    { at: toName, units_received: total, units_short: receiving ? short : 0, short_action: discrepancy ? shortAction : null });
  return { id: transferId, transferNo: tr.transfer_no, status, discrepancy, crossBranch: cross,
           lines: lineRows.map(l => ({ tire_id: l.tire_id, item_name: l.item_name, sent: l.qty, received: recv.get(l.tire_id), short: l.qty - recv.get(l.tire_id) })) };
}

module.exports = {
  defaultLocationId, resolveLocation, transferStock, settleTransfer, fulfilReservation, ROTATION_POLICIES, rotationOrderBy, resolveRotation, reservedQty, ACTIVE_RESERVATION, changeTracking, ensureBatch, valuationMethod, VALUATION_METHODS, StockError, MOVEMENT, ADJUSTMENT_REASONS, postMovement, createAdjustment, validateAdjustment, needsApproval };
