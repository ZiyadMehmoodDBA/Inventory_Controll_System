const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { writeAudit }   = require('../utils/audit');
const { requireModule, getBusinessType } = require('../utils/businessTypes');
const { StockError, MOVEMENT, postMovement, createAdjustment, changeTracking } = require('../utils/stock');
const { requireRole } = require('../middleware/auth');
const P = require('../utils/permissions');
const IM = require('../utils/itemMaster');
const { POSITION_APPLY, POSITION_COLUMNS } = require('../utils/stockPosition');

const canManage = P.requirePermission('inventory.manage_items');

// Tracking mode is only touched when the request carries it.
const trackingFrom = b => b.tracking === undefined ? null : { tracking: String(b.tracking), trackExpiry: b.tracking !== 'none' && !!b.track_expiry };

// Item-master field cleanup shared by create/update. Blank SKU/barcode -> null (SKU is auto-generated on create).
function masterFields(b) {
  const clean = (v, n) => { const t = String(v ?? '').trim().slice(0, n); return t || null; };
  const uom = String(b.uom ?? 'pcs').trim().toLowerCase() || 'pcs';
  return {
    sku: clean(b.sku, 60), barcode: clean(b.barcode, 60), description: clean(b.description, 500),
    uom: IM.uomOf(uom, 'Unit of measure'),
    category_id: b.category_id ? Number(b.category_id) : null,
    is_active: b.is_active === false || b.is_active === 0 || b.is_active === '0' ? 0 : 1,
  };
}
async function checkCategory(request, orgId, categoryId) {
  if (!categoryId) return true;
  const r = await request.input('catId', sql.Int, categoryId).input('catOrg', sql.Int, orgId)
    .query('SELECT id FROM item_categories WHERE id = @catId AND organization_id = @catOrg');
  return r.recordset.length > 0;
}
// Tyre shops identify items by brand + model + size. Every other business only needs a name (stored in "model").
const requiresSpec = async orgId => (await getBusinessType(orgId)) === 'tyre_shop';
const missingFieldsMessage = tyre => tyre ? 'Brand, model, and size are required' : 'Item name is required';
const isDup = e => e && (e.number === 2601 || e.number === 2627);
const dupMessage = e => /UX_tires_barcode/.test(e.message) ? 'Another item already uses that barcode' : 'Another item already uses that SKU';

const sendError = (res, err) => isDup(err)
  ? res.status(409).json({ error: dupMessage(err), code: 'DUPLICATE_IDENTIFIER' })
  : err instanceof StockError
  ? res.status(err.status).json({ error: err.message, code: err.code, ...err.details })
  : res.status(500).json({ error: err.message });

// Cost is shown only to roles with "see costs": the cost column is blanked server-side, not just hidden on screen.
const seesCost = req => P.has(req.user, 'inventory.view_cost');
const hideCost = (req, rows) => { if (!seesCost(req)) for (const x of rows) if (x && 'cost_price' in x) x.cost_price = null; return rows; };

router.get('/', P.requirePermission('inventory.view'), async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .query(`SELECT t.*, ${POSITION_COLUMNS} FROM tires t ${POSITION_APPLY} WHERE t.organization_id = @orgId AND t.branch_id = @branchId ORDER BY t.brand, t.model`);
    res.json(hideCost(req, result.recordset));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── GET /inventory/catalog-brands — list all brands available in tire_catalog ── */
router.get('/catalog-brands', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query('SELECT DISTINCT brand FROM tire_catalog ORDER BY brand');
    res.json(result.recordset.map(r => r.brand));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Allowed values for the item form (units, types, statuses, tax classes).
router.get('/meta', (req, res) => res.json({
  uoms: IM.UOMS, item_types: Object.entries(IM.ITEM_TYPES).map(([value, label]) => ({ value, label })), statuses: IM.STATUSES, tax_classes: IM.TAX_CLASSES,
}));

const csvCell = v => {
  if (v === null || v === undefined) return '';
  const t = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  return /[",\r\n]/.test(t) || /^[=+\-@]/.test(t) ? '"' + (/^[=+\-@]/.test(t) ? "'" : '') + t.replace(/"/g, '""') + '"' : t;
};

// Every item of the branch with its master data, as CSV that the import accepts again.
router.get('/export', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const tyre = await requiresSpec(orgId);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT t.*, c.name AS cat, pc.name AS parent_cat, sp.name AS supplier_name
              FROM tires t
              LEFT JOIN item_categories c ON c.id = t.category_id
              LEFT JOIN item_categories pc ON pc.id = c.parent_id
              LEFT JOIN suppliers sp ON sp.id = t.supplier_id
              WHERE t.organization_id = @o AND t.branch_id = @b ORDER BY t.brand, t.model`);
    const cv = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query('SELECT v.tire_id, v.uom, v.factor FROM item_uom_conversions v JOIN tires t ON t.id = v.tire_id WHERE t.organization_id = @o AND t.branch_id = @b ORDER BY v.uom');
    const convByItem = {};
    for (const c of cv.recordset) (convByItem[c.tire_id] ??= []).push(c.uom + '=' + Number(c.factor));
    for (const row of r.recordset) row.conversions = (convByItem[row.id] || []).join(';');
    hideCost(req, r.recordset);
    const cols = [
      ['sku', 'sku'], ['barcode', 'barcode'], ...(tyre ? [['brand', 'brand']] : [['brand', 'brand']]), ['model', 'model'], ...(tyre ? [['size', 'size'], ['type', 'type']] : [['size', 'size']]),
      ['item_type', 'item_type'], ['category', x => (x.parent_cat ? x.parent_cat + ' > ' + x.cat : x.cat)], ['manufacturer', 'manufacturer'], ['supplier', 'supplier_name'],
      ['description', 'description'], ['uom', 'uom'], ['purchase_uom', 'purchase_uom'], ['sales_uom', 'sales_uom'], ['conversions', 'conversions'],
      ['pack_size', 'pack_size'], ['length_cm', 'length_cm'], ['width_cm', 'width_cm'], ['height_cm', 'height_cm'], ['weight_kg', 'weight_kg'], ['volume_l', 'volume_l'],
      ['cost_price', 'cost_price'], ['sale_price', 'sale_price'], ['tax_class', 'tax_class'], ['tax_rate', 'tax_rate'],
      ['min_stock', 'min_stock'], ['reorder_level', 'reorder_level'], ['max_stock', 'max_stock'], ['reorder_qty', 'reorder_qty'],
      ['tracking', 'tracking'], ['track_expiry', x => (x.track_expiry ? 1 : 0)], ['shelf_life_days', 'shelf_life_days'], ['storage_conditions', 'storage_conditions'],
      ['storage_requirements', 'storage_requirements'], ['handling_instructions', 'handling_instructions'], ['safety_requirements', 'safety_requirements'],
      ['status', 'status'], ['stock', 'stock'],
    ];
    const lines = [cols.map(c => c[0]).join(',')];
    for (const row of r.recordset) lines.push(cols.map(([, g]) => csvCell(typeof g === 'function' ? g(row) : row[g])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="products-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
  } catch (err) { sendError(res, err); }
});

router.get('/:id/history', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const own = await pool.request().input('id', sql.Int, req.params.id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query('SELECT id FROM tires WHERE id = @id AND organization_id = @o AND branch_id = @b');
    if (!own.recordset.length) return res.status(404).json({ error: 'Not found' });
    const r = await pool.request().input('id', sql.Int, req.params.id).input('o', sql.Int, orgId)
      .query(`SELECT TOP 300 h.id, h.field, h.changed_at, u.name AS user_name,
                     CASE h.field WHEN 'category_id' THEN (SELECT name FROM item_categories WHERE id = TRY_CAST(h.old_value AS INT))
                                  WHEN 'supplier_id' THEN (SELECT name FROM suppliers WHERE id = TRY_CAST(h.old_value AS INT)) ELSE h.old_value END AS old_value,
                     CASE h.field WHEN 'category_id' THEN (SELECT name FROM item_categories WHERE id = TRY_CAST(h.new_value AS INT))
                                  WHEN 'supplier_id' THEN (SELECT name FROM suppliers WHERE id = TRY_CAST(h.new_value AS INT)) ELSE h.new_value END AS new_value
              FROM product_history h LEFT JOIN users u ON u.id = h.user_id
              WHERE h.tire_id = @id AND h.organization_id = @o ORDER BY h.id DESC`);
    res.json(r.recordset);
  } catch (err) { sendError(res, err); }
});

// Quick status change: active / inactive / discontinued. History is kept and stock is untouched.
router.patch('/:id/status', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const status = String(req.body?.status ?? '').toLowerCase();
    if (!IM.STATUSES.includes(status)) throw new StockError('INVALID_STATUS', 'Status must be one of: ' + IM.STATUSES.join(', '));
    const pool = await getPool();
    const tx = new sql.Transaction(pool);
    await tx.begin();
    let out;
    try {
      const b = await new sql.Request(tx).input('id', sql.Int, req.params.id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
        .query('SELECT id, status FROM tires WITH (UPDLOCK) WHERE id = @id AND organization_id = @o AND branch_id = @b');
      if (!b.recordset.length) { await tx.rollback(); return res.status(404).json({ error: 'Not found' }); }
      const before = b.recordset[0];
      if (before.status !== status) {
        await IM.applyExtra(tx, before.id, { status });
        await IM.logChanges(tx, { orgId, tireId: before.id, userId: req.user?.userId, before: { status: before.status }, after: { status } });
      }
      out = { id: before.id, status };
      await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch { /* ignore */ } throw e; }
    writeAudit(pool, { orgId, branchId, userId: req.user?.userId, action: 'UPDATE', entity: 'inventory', entityId: out.id, before: null, after: { status } });
    res.json(out);
  } catch (err) { sendError(res, err); }
});

router.get('/:id', P.requirePermission('inventory.view'), async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('id',       sql.Int, req.params.id)
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .query('SELECT * FROM tires WHERE id = @id AND organization_id = @orgId AND branch_id = @branchId');
    if (!result.recordset.length) return res.status(404).json({ error: 'Not found' });
    res.json(hideCost(req, [{ ...result.recordset[0], conversions: await IM.loadConversions(pool.request(), result.recordset[0].id) }])[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    if (!seesCost(req)) {
      const cur = await (await getPool()).request().input('id', sql.Int, req.params.id).input('o', sql.Int, orgId).query('SELECT cost_price FROM tires WHERE id = @id AND organization_id = @o');
      req.body = { ...req.body, cost_price: cur.recordset[0]?.cost_price ?? 0 };
    }
    const {
      brand, model, size, type, stock, cost_price, sale_price, reorder_level,
      pattern, load_index, speed_index, dot,
    } = req.body;
    const mf = masterFields(req.body);
    const tyre = await requiresSpec(orgId);
    if (tyre ? (!brand || !model || !size) : !String(model || '').trim()) return res.status(400).json({ error: missingFieldsMessage(tyre) });
    const openingQty = Number(stock || 0);
    if (!Number.isInteger(openingQty) || openingQty < 0) return res.status(400).json({ error: 'Opening stock must be a whole number of zero or more' });
    const extra = IM.parseExtra(req.body, {});
    const conversions = IM.parseConversions(req.body.conversions, mf.uom);
    const pool = await getPool();
    const tx   = new sql.Transaction(pool);
    await tx.begin();
    let row;
    try {
    if (!await checkCategory(new sql.Request(tx), orgId, mf.category_id)) { await tx.rollback(); return res.status(400).json({ error: 'Category not found' }); }
    const result = await new sql.Request(tx)
      .input('sku',         sql.NVarChar,      mf.sku)
      .input('barcode',     sql.NVarChar,      mf.barcode)
      .input('description', sql.NVarChar,      mf.description)
      .input('uom',         sql.NVarChar,      mf.uom)
      .input('category_id', sql.Int,           mf.category_id)
      .input('is_active',   sql.Bit,           mf.is_active)
      .input('orgId',         sql.Int,           orgId)
      .input('branchId',      sql.Int,           branchId)
      .input('brand',         sql.NVarChar,      brand || '')
      .input('model',         sql.NVarChar,      model)
      .input('size',          sql.NVarChar,      size || '')
      .input('type',          sql.NVarChar,      type || (tyre ? 'Passenger' : null))
      .input('stock',         sql.Int,           0)
      .input('cost_price',    sql.Decimal(18,2), cost_price || 0)
      .input('sale_price',    sql.Decimal(18,2), sale_price || 0)
      .input('reorder_level', sql.Int,           reorder_level || 10)
      .input('pattern',       sql.NVarChar,      pattern     || null)
      .input('load_index',    sql.NVarChar,      load_index  || null)
      .input('speed_index',   sql.NVarChar,      speed_index || null)
      .input('dot',           sql.NVarChar,      dot         || null)
      .query(`
        INSERT INTO tires
          (organization_id, branch_id, brand, model, size, type, stock, cost_price, sale_price,
           reorder_level, pattern, load_index, speed_index, dot, sku, barcode, description, uom, category_id, is_active)
        OUTPUT INSERTED.*
        VALUES
          (@orgId, @branchId, @brand, @model, @size, @type, @stock, @cost_price, @sale_price,
           @reorder_level, @pattern, @load_index, @speed_index, @dot, @sku, @barcode, @description, @uom, @category_id, @is_active)
      `);
    row = result.recordset[0];
    if (!row.sku) {
      const g = await new sql.Request(tx).input('id', sql.Int, row.id)
        .query("UPDATE tires SET sku = 'SKU-' + RIGHT('000000' + CAST(id AS NVARCHAR(10)), 6) OUTPUT INSERTED.sku WHERE id = @id");
      row.sku = g.recordset[0].sku;
    }
    if (extra.supplier_id && !(await new sql.Request(tx).input('sup', sql.Int, extra.supplier_id).input('so', sql.Int, orgId).query('SELECT id FROM suppliers WHERE id = @sup AND organization_id = @so')).recordset.length) {
      throw new StockError('SUPPLIER_NOT_FOUND', 'Preferred supplier not found', 400);
    }
    await IM.applyExtra(tx, row.id, extra);
    if (conversions?.length) await IM.saveConversions(tx, row.id, conversions);
    await IM.logCreated(tx, { orgId, tireId: row.id, userId: req.user?.userId, name: [brand, model, size].filter(Boolean).join(' ') });
    // Opening stock is a ledger movement like any other.
    if (openingQty > 0) {
      const mv = await postMovement(tx, { orgId, tireId: row.id, qtyChange: openingQty, reason: MOVEMENT.OPENING_STOCK, reference: 'OPENING', userId: req.user?.userId, unitCost: Number(cost_price || 0) });
      row.stock = mv.after;
    }
    const tr = trackingFrom(req.body);
    if (tr && tr.tracking !== 'none') {
      await changeTracking(tx, { orgId, tireId: row.id, ...tr });   // opening stock moves into the LEGACY batch
      row.tracking = tr.tracking; row.track_expiry = tr.trackExpiry;
    }
    Object.assign(row, (await new sql.Request(tx).input('id', sql.Int, row.id).query('SELECT * FROM tires WHERE id = @id')).recordset[0], { stock: row.stock });
    row.conversions = conversions ?? [];
    await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch { /* ignore */ } throw e; }
    writeAudit(pool, { orgId, branchId, userId: req.user?.userId,
      action: 'CREATE', entity: 'inventory', entityId: row.id,
      before: null, after: { id: row.id, brand: row.brand, model: row.model, size: row.size, stock: row.stock, sale_price: row.sale_price },
    });
    res.status(201).json(row);
  } catch (err) {
    sendError(res, err);
  }
});

router.put('/:id', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const {
      brand, model, size, type, stock, cost_price, sale_price, reorder_level,
      pattern, load_index, speed_index, dot,
    } = req.body;
    const mf = masterFields(req.body);
    const tyre = await requiresSpec(orgId);
    if (tyre ? (!brand || !model || !size) : !String(model || '').trim()) return res.status(400).json({ error: missingFieldsMessage(tyre) });
    const pool = await getPool();
    const tx   = new sql.Transaction(pool);
    await tx.begin();
    let row, beforeRow, adjustment = null;
    try {
      if (!await checkCategory(new sql.Request(tx), orgId, mf.category_id)) { await tx.rollback(); return res.status(400).json({ error: 'Category not found' }); }
      // Lock the row so the stock difference below is computed against the real balance.
      const beforeRes = await new sql.Request(tx)
        .input('id', sql.Int, req.params.id).input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId)
        .query('SELECT * FROM tires WITH (UPDLOCK) WHERE id = @id AND organization_id = @orgId AND branch_id = @branchId');
      beforeRow = beforeRes.recordset[0] || null;
      if (!beforeRow) { await tx.rollback(); return res.json(undefined); }

      // Stock is NOT written here. A changed quantity becomes a logged adjustment (pending approval where required).
      const requested = stock === undefined || stock === null || stock === '' ? beforeRow.stock : Number(stock);
      if (!Number.isInteger(requested)) { await tx.rollback(); return res.status(400).json({ error: 'Stock must be a whole number' }); }
      if (beforeRow.tracking !== 'none' && requested !== beforeRow.stock) {
        await tx.rollback();
        return res.status(400).json({ error: 'Stock of a batch / serial tracked item is changed with Adjust Stock or a goods receipt, not here', code: 'TRACKED_STOCK' });
      }
      const extra = IM.parseExtra(req.body, beforeRow);
      const conversions = IM.parseConversions(req.body.conversions, mf.uom);
      const beforeConv = await IM.loadConversions(new sql.Request(tx), beforeRow.id);
      if (extra.supplier_id && !(await new sql.Request(tx).input('sup', sql.Int, extra.supplier_id).input('so', sql.Int, orgId).query('SELECT id FROM suppliers WHERE id = @sup AND organization_id = @so')).recordset.length) {
        throw new StockError('SUPPLIER_NOT_FOUND', 'Preferred supplier not found', 400);
      }
      const tr = trackingFrom(req.body);
      if (tr && (tr.tracking !== beforeRow.tracking || tr.trackExpiry !== !!beforeRow.track_expiry)) {
        await changeTracking(tx, { orgId, tireId: beforeRow.id, ...tr });
      }

      const result = await new sql.Request(tx)
        .input('id',            sql.Int,           req.params.id)
        .input('orgId',         sql.Int,           orgId)
        .input('branchId',      sql.Int,           branchId)
        .input('brand',         sql.NVarChar,      brand || '')
        .input('model',         sql.NVarChar,      model)
        .input('size',          sql.NVarChar,      size || '')
        .input('type',          sql.NVarChar,      type || (tyre ? 'Passenger' : null))
        .input('cost_price',    sql.Decimal(18,2), cost_price || 0)
        .input('sale_price',    sql.Decimal(18,2), sale_price || 0)
        .input('reorder_level', sql.Int,           reorder_level || 10)
        .input('pattern',       sql.NVarChar,      pattern     || null)
        .input('load_index',    sql.NVarChar,      load_index  || null)
        .input('speed_index',   sql.NVarChar,      speed_index || null)
        .input('dot',           sql.NVarChar,      dot         || null)
        .input('sku',         sql.NVarChar,      mf.sku)
        .input('barcode',     sql.NVarChar,      mf.barcode)
        .input('description', sql.NVarChar,      mf.description)
        .input('uom',         sql.NVarChar,      mf.uom)
        .input('category_id', sql.Int,           mf.category_id)
        .input('is_active',   sql.Bit,           mf.is_active)
        .query(`
          UPDATE tires SET
            brand=@brand, model=@model, size=@size, type=@type,
            cost_price=@cost_price, sale_price=@sale_price, reorder_level=@reorder_level,
            pattern=@pattern, load_index=@load_index, speed_index=@speed_index, dot=@dot,
            sku=COALESCE(@sku, sku), barcode=@barcode, description=@description, uom=@uom,
            category_id=@category_id
          OUTPUT INSERTED.*
          WHERE id = @id AND organization_id = @orgId AND branch_id = @branchId
        `);
      row = result.recordset[0];
      await IM.applyExtra(tx, beforeRow.id, extra);
      if (conversions !== undefined) await IM.saveConversions(tx, beforeRow.id, conversions);
      const fresh = (await new sql.Request(tx).input('id', sql.Int, beforeRow.id).query('SELECT * FROM tires WHERE id = @id')).recordset[0];
      await IM.logChanges(tx, { orgId, tireId: beforeRow.id, userId: req.user?.userId,
        before: { ...beforeRow, conversions: beforeConv }, after: { ...fresh, conversions: conversions !== undefined ? conversions : beforeConv } });
      Object.assign(row, fresh, { stock: row.stock });
      row.conversions = conversions !== undefined ? conversions : beforeConv;

      const delta = requested - beforeRow.stock;
      if (delta !== 0) {
        adjustment = await createAdjustment(tx, {
          orgId, user: { userId: req.user?.userId, role: req.user?.role, branchId: req.user?.branchId ?? null },
          tireId: row.id, qtyChange: delta, reasonCode: 'count_correction', notes: 'Changed from the item edit form',
        });
        if (adjustment.status === 'approved') row.stock = adjustment.after;
      }
      await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch { /* ignore */ } throw e; }

    if (row && beforeRow) {
      writeAudit(pool, { orgId, branchId, userId: req.user?.userId,
        action: 'UPDATE', entity: 'inventory', entityId: row.id,
        before: { id: beforeRow.id, brand: beforeRow.brand, model: beforeRow.model, size: beforeRow.size, stock: beforeRow.stock, cost_price: beforeRow.cost_price, sale_price: beforeRow.sale_price, reorder_level: beforeRow.reorder_level },
        after:  { id: row.id,       brand: row.brand,       model: row.model,       size: row.size,       stock: row.stock,       cost_price: row.cost_price,       sale_price: row.sale_price,       reorder_level: row.reorder_level, ...(adjustment ? { adjustment: { id: adjustment.id, status: adjustment.status } } : {}) },
      });
    }
    res.json(adjustment?.status === 'pending' ? { ...row, pending_adjustment: adjustment } : row);
  } catch (err) {
    sendError(res, err);
  }
});

router.delete('/:id', P.requirePermission('inventory.delete_items'), async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();

    // Capture before deletion for audit
    const beforeRes = await pool.request()
      .input('id', sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT id, brand, model, size, type, stock, sale_price FROM tires WHERE id = @id AND organization_id = @orgId');
    const beforeRow = beforeRes.recordset[0] || null;

    if (beforeRow) {
      const h = (await pool.request().input('id', sql.Int, req.params.id)
        .query(`SELECT (SELECT COUNT(*) FROM stock_movements WHERE tire_id = @id) AS movements,
                       (SELECT COUNT(*) FROM stock_adjustments WHERE tire_id = @id) AS adjustments,
                       (SELECT COUNT(*) FROM stock_transfer_items WHERE tire_id = @id) AS transfers`)).recordset[0];
      if (h.movements || h.adjustments || h.transfers) {
        return res.status(409).json({ code: 'ITEM_HAS_HISTORY',
          error: `Cannot delete ${[beforeRow.brand, beforeRow.model, beforeRow.size].filter(Boolean).join(' ')}: it appears in stock history. Mark it inactive or discontinued instead — its history is kept.` });
      }
    }
    if (beforeRow && Number(beforeRow.stock) !== 0) {
      return res.status(400).json({ error: `Cannot delete ${beforeRow.brand} ${beforeRow.model} ${beforeRow.size}: ${beforeRow.stock} units are still in stock. Adjust stock to zero first so the write-off is recorded.` });
    }
    const saleCheck = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT COUNT(*) AS cnt FROM sale_items WHERE tire_id = @id');
    if (saleCheck.recordset[0].cnt > 0) {
      return res.status(409).json({ code: 'ITEM_HAS_HISTORY', error: 'Cannot delete this item — it appears in existing sales records. Mark it inactive or discontinued instead.' });
    }
    const poCheck = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT COUNT(*) AS cnt FROM purchase_items WHERE tire_id = @id');
    if (poCheck.recordset[0].cnt > 0) {
      return res.status(409).json({ code: 'ITEM_HAS_HISTORY', error: 'Cannot delete this item — it appears in existing purchase orders. Mark it inactive or discontinued instead.' });
    }
    await pool.request()
      .input('id',       sql.Int, req.params.id)
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .query(`DELETE FROM tires WHERE id = @id AND organization_id = @orgId AND branch_id = @branchId;
              IF @@ROWCOUNT > 0 BEGIN
                DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE tire_id = @id);
                DELETE FROM stock_batches WHERE tire_id = @id;
                DELETE FROM item_location_stock WHERE tire_id = @id;
                DELETE FROM item_uom_conversions WHERE tire_id = @id;
                DELETE FROM stock_cost_layers WHERE tire_id = @id;
              END`);

    writeAudit(pool, { orgId, branchId, userId: req.user?.userId,
      action: 'DELETE', entity: 'inventory', entityId: Number(req.params.id),
      before: beforeRow, after: null,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── POST /inventory/import-catalog — bulk import catalog entries into tires ── */
router.post('/import-catalog', canManage, requireModule('tyreCatalog'), async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const { brands } = req.body; // optional string[]
    const pool  = await getPool();
    const dbReq = pool.request()
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId);

    let brandFilter = '';
    if (Array.isArray(brands) && brands.length > 0) {
      const paramList = brands.map((b, i) => {
        dbReq.input(`br${i}`, sql.NVarChar, b);
        return `@br${i}`;
      });
      brandFilter = `AND tc.brand IN (${paramList.join(',')})`;
    }

    const result = await dbReq.query(`
      INSERT INTO tires
        (organization_id, branch_id, brand, model, size, type, pattern, load_index, speed_index,
         stock, cost_price, sale_price, reorder_level)
      SELECT
        @orgId, @branchId,
        tc.brand, tc.model, tc.size,
        ISNULL(tc.tire_type, 'Passenger'),
        tc.pattern, tc.load_index, tc.speed_index,
        0, 0, 0, 10
      FROM tire_catalog tc
      WHERE NOT EXISTS (
        SELECT 1 FROM tires t
        WHERE t.brand = tc.brand AND t.model = tc.model AND t.size = tc.size
          AND t.organization_id = @orgId AND t.branch_id = @branchId
      )
      ${brandFilter}
    `);

    await new sql.Request(pool).input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId)
      .query("UPDATE tires SET sku = 'SKU-' + RIGHT('000000' + CAST(id AS NVARCHAR(10)), 6) WHERE sku IS NULL AND organization_id = @orgId AND branch_id = @branchId");
    res.json({ inserted: result.rowsAffected[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk', canManage, async (req, res) => {
  const { orgId, branchId } = getContext(req);
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows provided' });
  }
  const pool = await getPool();
  let inserted = 0;
  const errors = [];
  const tyre = await requiresSpec(orgId);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const brand = String(row.brand || '').trim();
      const model = String(row.model || '').trim();
      const size  = String(row.size  || '').trim();
      if (tyre ? (!brand || !model || !size) : !model) {
        errors.push({ row: i + 2, message: tyre ? 'brand, model, and size are required' : 'model (item name) is required' });
        continue;
      }
      const extra = IM.parseExtra(row, {});
      const uom = IM.uomOf(row.uom, 'Unit of measure') || 'pcs';
      const conversions = IM.parseConversions(typeof row.conversions === 'string' ? row.conversions.split(/[;,]/).map(x => x.trim()).filter(Boolean).map(x => { const [u, f] = x.split('='); return { uom: u, factor: f }; }) : row.conversions, uom);
      const trackMode = row.tracking ? String(row.tracking).trim().toLowerCase() : null;
      if (trackMode && !['none', 'batch', 'serial'].includes(trackMode)) throw new StockError('INVALID_TRACKING', 'tracking must be none, batch or serial');
      const openingQty = parseInt(row.stock || 0, 10);
      if (!Number.isInteger(openingQty) || openingQty < 0) {
        errors.push({ row: i + 2, message: 'stock must be a whole number of zero or more' });
        continue;
      }
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
      const ins = await new sql.Request(tx)
        .input('orgId',         sql.Int,           orgId)
        .input('branchId',      sql.Int,           branchId)
        .input('brand',         sql.NVarChar,      brand)
        .input('model',         sql.NVarChar,      model)
        .input('size',          sql.NVarChar,      size)
        .input('type',          sql.NVarChar,      String(row.type || '') || (tyre ? 'Passenger' : null))
        .input('cost_price',    sql.Decimal(18,2), parseFloat(row.cost_price  || 0))
        .input('sale_price',    sql.Decimal(18,2), parseFloat(row.sale_price  || 0))
        .input('stock',         sql.Int,           0)
        .input('reorder_level', sql.Int,           parseInt(row.reorder_level || 5))
        .input('pattern',       sql.NVarChar,      String(row.pattern     || '') || null)
        .input('load_index',    sql.NVarChar,      String(row.load_index  || '') || null)
        .input('speed_index',   sql.NVarChar,      String(row.speed_index || '') || null)
        .input('dot',           sql.NVarChar,      String(row.dot         || '') || null)
        .input('sku',           sql.NVarChar,      String(row.sku         || '').trim().slice(0, 60) || null)
        .input('barcode',       sql.NVarChar,      String(row.barcode     || '').trim().slice(0, 60) || null)
        .query(`
          INSERT INTO tires
            (organization_id, branch_id, brand, model, size, type, cost_price, sale_price, stock, reorder_level,
             pattern, load_index, speed_index, dot, sku, barcode)
          OUTPUT INSERTED.id
          VALUES
            (@orgId, @branchId, @brand, @model, @size, @type, @cost_price, @sale_price, @stock, @reorder_level,
             @pattern, @load_index, @speed_index, @dot, @sku, @barcode)
        `);
      await new sql.Request(tx).input('id', sql.Int, ins.recordset[0].id)
        .query("UPDATE tires SET sku = 'SKU-' + RIGHT('000000' + CAST(id AS NVARCHAR(10)), 6) WHERE id = @id AND sku IS NULL");
      // category (a "Parent > Child" path is created if missing), supplier by name, description and unit
      let categoryId = null;
      const path = String(row.category || '').split('>').map(x => x.trim()).filter(Boolean).slice(0, 2);
      let parent = null;
      for (const nm of path) {
        const f = await new sql.Request(tx).input('o', sql.Int, orgId).input('n', sql.NVarChar(100), nm.slice(0, 100)).input('p', sql.Int, parent)
          .query('SELECT id FROM item_categories WHERE organization_id = @o AND LOWER(name) = LOWER(@n)');
        parent = f.recordset.length ? f.recordset[0].id
          : (await new sql.Request(tx).input('o', sql.Int, orgId).input('n', sql.NVarChar(100), nm.slice(0, 100)).input('p', sql.Int, parent)
              .query('INSERT INTO item_categories (organization_id, name, parent_id) OUTPUT INSERTED.id VALUES (@o, @n, @p)')).recordset[0].id;
        categoryId = parent;
      }
      if (row.supplier && extra.supplier_id === undefined) {
        const sp = await new sql.Request(tx).input('o', sql.Int, orgId).input('n', sql.NVarChar(200), String(row.supplier).trim())
          .query('SELECT TOP 1 id FROM suppliers WHERE organization_id = @o AND LOWER(name) = LOWER(@n)');
        if (!sp.recordset.length) throw new StockError('SUPPLIER_NOT_FOUND', 'supplier "' + String(row.supplier).trim() + '" does not exist', 400);
        extra.supplier_id = sp.recordset[0].id;
      }
      await new sql.Request(tx).input('id', sql.Int, ins.recordset[0].id).input('u', sql.NVarChar(20), uom).input('c', sql.Int, categoryId)
        .input('d', sql.NVarChar(500), String(row.description || '').trim().slice(0, 500) || null)
        .query('UPDATE tires SET uom = @u, category_id = @c, description = @d WHERE id = @id');
      await IM.applyExtra(tx, ins.recordset[0].id, extra);
      if (conversions?.length) await IM.saveConversions(tx, ins.recordset[0].id, conversions);
      await IM.logCreated(tx, { orgId, tireId: ins.recordset[0].id, userId: req.user?.userId, name: [brand, model, size].filter(Boolean).join(' ') });
      if (openingQty > 0) {
        await postMovement(tx, { orgId, tireId: ins.recordset[0].id, qtyChange: openingQty, reason: MOVEMENT.OPENING_STOCK, reference: 'IMPORT', userId: req.user?.userId, unitCost: parseFloat(row.cost_price || 0) });
      }
      if (trackMode && trackMode !== 'none') await changeTracking(tx, { orgId, tireId: ins.recordset[0].id, tracking: trackMode, trackExpiry: ['1', 'true', 'yes'].includes(String(row.track_expiry ?? '').toLowerCase()) });
      await tx.commit();
      } catch (e) { try { await tx.rollback(); } catch { /* ignore */ } throw e; }
      inserted++;
    } catch (err) {
      errors.push({ row: i + 2, message: isDup(err) ? dupMessage(err) : err.message });
    }
  }
  res.json({ inserted, errors });
});

module.exports = router;
