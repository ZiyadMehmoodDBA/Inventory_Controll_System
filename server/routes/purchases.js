const P = require('../utils/permissions');
const express = require('express');
const router  = express.Router();
const { postMovement, StockError, MOVEMENT } = require('../utils/stock');
const { nextDocNumber } = require('../utils/docNumber');
const { assertTransactable } = require('../utils/itemMaster');
const { assertLocationAccess } = require('../utils/access');

// Stock problems are client errors (409/404), not server faults.
const sendError = (res, err) => err instanceof StockError
  ? res.status(err.status).json({ error: err.message, code: err.code, ...err.details })
  : res.status(500).json({ error: err.message });

// Batch/lot, expiry and serial numbers typed on a receipt line. Serials arrive as an array or a comma/newline list.
const parseSerials = v => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,;]+/)).map(x => String(x).trim()).filter(Boolean);
const lineBatch = it => {
  const serials = parseSerials(it.serials);
  return {
    batch:   it.batch_no ? { batchNo: it.batch_no, expiryDate: it.expiry_date || null, unitCost: Number(it.unit_price), receivedDate: it.received_date || null, mfgDate: it.mfg_date || null } : undefined,
    serials: serials.length ? serials : undefined,
  };
};
const storedBatch = row => lineBatch({ batch_no: row.batch_no, expiry_date: row.expiry_date, mfg_date: row.mfg_date, unit_price: row.unit_price, serials: row.serials ? JSON.parse(row.serials) : [] });
const batchCols = it => ({ batch_no: it.batch_no ? String(it.batch_no).slice(0, 60) : null, expiry_date: it.expiry_date || null, mfg_date: it.mfg_date || null, serials: parseSerials(it.serials).length ? JSON.stringify(parseSerials(it.serials)) : null });

const badQty = items => items.find(it => (it.tire_id || it.product_id) && (!Number.isInteger(Number(it.qty)) || Number(it.qty) <= 0));
const { getPool, getSetting, sql } = require('../db');
const { getContext } = require('../context');

router.get('/', P.requirePermission('purchases.view', 'purchases.manage', 'stock.receive'), async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .query(`
        SELECT p.*, s.name AS supplier_name, s.code AS supplier_code
        FROM purchases p
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        WHERE p.organization_id = @orgId AND p.branch_id = @branchId
        ORDER BY p.created_at DESC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', P.requirePermission('purchases.view', 'purchases.manage', 'stock.receive'), async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const poRes = await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT p.*, s.name AS supplier_name, s.code AS supplier_code,
               s.phone AS supplier_phone, s.email AS supplier_email, s.address AS supplier_address
        FROM purchases p
        LEFT JOIN suppliers s ON p.supplier_id = s.id
        WHERE p.id = @id AND p.organization_id = @orgId
      `);
    if (!poRes.recordset.length) return res.status(404).json({ error: 'Not found' });

    const itemsRes = await pool.request()
      .input('purchase_id', sql.Int, req.params.id)
      .query(`
        SELECT pi.*, t.brand, t.model, t.size,
               p.name AS product_name, p.category AS product_category, p.unit AS product_unit
        FROM purchase_items pi
        LEFT JOIN tires    t ON pi.tire_id    = t.id
        LEFT JOIN products p ON pi.product_id = p.id
        WHERE pi.purchase_id = @purchase_id
      `);
    res.json({ ...poRes.recordset[0], items: itemsRes.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', P.requirePermission('purchases.manage'), async (req, res) => {
  const { orgId, branchId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    const { supplier_id, date, items, status = 'pending', notes, expected_date } = req.body;
    const receiveLocation = req.body.location_id ? parseInt(req.body.location_id, 10) : null;
    if (!supplier_id) return res.status(400).json({ error: 'Supplier is required' });
    if (!items?.length) return res.status(400).json({ error: 'At least one item is required' });
    if (badQty(items)) return res.status(400).json({ error: 'Item quantities must be positive whole numbers' });

    const prefix = await getSetting('po_prefix', 'PO', orgId);

    const subtotal = items.reduce((s, it) => s + (it.qty * it.unit_price), 0);
    const total    = parseFloat(subtotal.toFixed(2));

    await transaction.begin();
    await assertTransactable(transaction, orgId, items.map(it => it.tire_id), 'purchase');
    if (receiveLocation) {
      const loc = await assertLocationAccess(transaction, orgId, { userId: req.user?.userId, role: req.user?.role, branchId: req.user?.branchId ?? branchId }, receiveLocation, 'receive');
      if (loc.branch_id !== branchId) throw new StockError('INVALID_LOCATION', 'That location belongs to another branch', 400);
      if (!loc.is_active) throw new StockError('INVALID_LOCATION', `Stock location "${loc.name}" is inactive`, 400);
    }
    const poNo = await nextDocNumber(new sql.Request(transaction), 'purchases', prefix);

    const poRes = await new sql.Request(transaction)
      .input('org_id',     sql.Int,          orgId)
      .input('branch_id',  sql.Int,          branchId)
      .input('po_no',      sql.NVarChar,     poNo)
      .input('supplier_id',sql.Int,          supplier_id)
      .input('date',       sql.Date,         date || new Date())
      .input('subtotal',   sql.Decimal(18,2), subtotal)
      .input('tax',        sql.Decimal(18,2), 0)
      .input('total',      sql.Decimal(18,2), total)
      .input('status',     sql.NVarChar,     status)
      .input('notes',      sql.NVarChar,     notes || '')
      .input('expected',   sql.Date,         /^\d{4}-\d{2}-\d{2}$/.test(String(expected_date || '')) ? expected_date : null)
      .input('loc',        sql.Int,          receiveLocation)
      .query(`
        INSERT INTO purchases (organization_id, branch_id, po_no, supplier_id, date, subtotal, tax, total, status, notes, expected_date, received_at, location_id)
        OUTPUT INSERTED.*
        VALUES (@org_id, @branch_id, @po_no, @supplier_id, @date, @subtotal, @tax, @total, @status, @notes, @expected, CASE WHEN @status = 'received' THEN GETDATE() END, @loc)
      `);
    const purchaseId = poRes.recordset[0].id;

    for (const item of items) {
      const itemName  = item.tire_name || item.item_name || (item.tire_id ? `Tire #${item.tire_id}` : `Product #${item.product_id}`);
      const amount    = parseFloat((item.qty * item.unit_price).toFixed(2));
      const tireId    = item.tire_id    ? Number(item.tire_id)    : null;
      const productId = item.product_id ? Number(item.product_id) : null;
      await new sql.Request(transaction)
        .input('purchase_id', sql.Int,          purchaseId)
        .input('tire_id',     sql.Int,          tireId)
        .input('product_id',  sql.Int,          productId)
        .input('tire_name',   sql.NVarChar,     itemName)
        .input('qty',         sql.Int,          item.qty)
        .input('unit_price',  sql.Decimal(18,2), item.unit_price)
        .input('amount',      sql.Decimal(18,2), amount)
        .input('batch_no',    sql.NVarChar(60), batchCols(item).batch_no)
        .input('expiry_date', sql.Date,         batchCols(item).expiry_date)
        .input('serials',     sql.NVarChar(sql.MAX), batchCols(item).serials)
        .input('mfg_date',    sql.Date,         batchCols(item).mfg_date)
        .query(`INSERT INTO purchase_items (purchase_id,tire_id,product_id,tire_name,qty,unit_price,amount,batch_no,expiry_date,serials,mfg_date) VALUES (@purchase_id,@tire_id,@product_id,@tire_name,@qty,@unit_price,@amount,@batch_no,@expiry_date,@serials,@mfg_date)`);

      if (status === 'received' && tireId) {
        await postMovement(transaction, {
          orgId, tireId, qtyChange: Number(item.qty), reason: MOVEMENT.GRN_RECEIVED, unitCost: Number(item.unit_price),
          reference: poNo, refId: purchaseId, userId: req.user?.userId, locationId: receiveLocation, ...lineBatch(item),
        });
      }
    }

    await transaction.commit();
    res.status(201).json({ ...poRes.recordset[0], po_no: poNo });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    sendError(res, err);
  }
});

router.patch('/:id/status', P.requirePermission('purchases.manage', 'stock.receive'), async (req, res) => {
  const { orgId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    const { status } = req.body;
    if (!['pending', 'received', 'cancelled'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    await transaction.begin();

    const current = await new sql.Request(transaction)
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT status, po_no, location_id FROM purchases WHERE id = @id AND organization_id = @orgId');
    if (!current.recordset.length) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Purchase not found' });
    }
    const poRef = current.recordset[0].po_no;

    await new sql.Request(transaction)
      .input('id',     sql.Int,      req.params.id)
      .input('orgId',  sql.Int,      orgId)
      .input('status', sql.NVarChar, status)
      .query("UPDATE purchases SET status = @status, received_at = CASE WHEN @status = 'received' THEN ISNULL(received_at, GETDATE()) ELSE received_at END WHERE id = @id AND organization_id = @orgId");

    if (status === 'received' && current.recordset[0]?.status !== 'received') {
      const itemsRes = await new sql.Request(transaction)
        .input('purchase_id', sql.Int, req.params.id)
        .query('SELECT tire_id, qty, unit_price, batch_no, expiry_date, mfg_date, serials FROM purchase_items WHERE purchase_id = @purchase_id');
      for (const item of itemsRes.recordset) {
        if (item.tire_id) {
          await postMovement(transaction, {
            orgId, tireId: item.tire_id, qtyChange: Number(item.qty), reason: MOVEMENT.GRN_RECEIVED,
            reference: poRef, refId: Number(req.params.id), userId: req.user?.userId, locationId: current.recordset[0].location_id ?? null, ...storedBatch(item),
          });
        }
      }
    }

    if (status === 'cancelled' && current.recordset[0]?.status === 'received') {
      const itemsRes = await new sql.Request(transaction)
        .input('purchase_id', sql.Int, req.params.id)
        .query('SELECT tire_id, qty FROM purchase_items WHERE purchase_id = @purchase_id');
      for (const item of itemsRes.recordset) {
        if (item.tire_id) {
          // No silent clamping: if the goods were already sold, the cancel is refused with a clear error.
          await postMovement(transaction, {
            orgId, tireId: item.tire_id, qtyChange: -Number(item.qty), reason: MOVEMENT.GRN_CANCELLED,
            reference: poRef, refId: Number(req.params.id), userId: req.user?.userId,
            reverseOf: { refId: Number(req.params.id), reasons: [MOVEMENT.GRN_RECEIVED] },
          });
        }
      }
    }

    await transaction.commit();
    res.json({ success: true });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    sendError(res, err);
  }
});

router.delete('/:id', P.requirePermission('purchases.manage'), async (req, res) => {
  const { orgId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const poRes = await new sql.Request(transaction)
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT status, po_no FROM purchases WHERE id = @id AND organization_id = @orgId');
    if (!poRes.recordset.length) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Purchase not found' });
    }

    if (poRes.recordset[0].status === 'received') {
      const itemsRes = await new sql.Request(transaction)
        .input('purchase_id', sql.Int, req.params.id)
        .query('SELECT tire_id, qty FROM purchase_items WHERE purchase_id = @purchase_id');
      for (const item of itemsRes.recordset) {
        if (item.tire_id) {
          await postMovement(transaction, {
            orgId, tireId: item.tire_id, qtyChange: -Number(item.qty), reason: MOVEMENT.PURCHASE_DELETED,
            reference: poRes.recordset[0].po_no, refId: Number(req.params.id), userId: req.user?.userId,
            reverseOf: { refId: Number(req.params.id), reasons: [MOVEMENT.GRN_RECEIVED] },
          });
        }
      }
    }

    await new sql.Request(transaction)
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('DELETE FROM purchases WHERE id = @id AND organization_id = @orgId');

    await transaction.commit();
    res.json({ success: true });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    sendError(res, err);
  }
});

router.post('/bulk', P.requirePermission('purchases.manage'), async (req, res) => {
  const { orgId, branchId } = getContext(req);
  const { pos } = req.body;
  if (!Array.isArray(pos) || pos.length === 0) {
    return res.status(400).json({ error: 'No purchase orders provided' });
  }
  const pool   = await getPool();
  const prefix = await getSetting('po_prefix', 'PO', orgId);
  let inserted = 0;
  const errors = [];

  for (const po of pos) {
    const transaction = new sql.Transaction(pool);
    try {
      const suppRes = await pool.request()
        .input('name',  sql.NVarChar, String(po.supplier_name || '').trim())
        .input('orgId', sql.Int,      orgId)
        .query('SELECT TOP 1 id FROM suppliers WHERE LOWER(name) = LOWER(@name) AND organization_id = @orgId');
      if (!suppRes.recordset.length) {
        errors.push({ ref: po.po_ref, message: `Supplier "${po.supplier_name}" not found` });
        continue;
      }
      const supplier_id = suppRes.recordset[0].id;
      const items       = Array.isArray(po.items) ? po.items : [];
      if (!items.length) { errors.push({ ref: po.po_ref, message: 'No line items' }); continue; }

      const resolvedItems = [];
      for (const item of items) {
        const itemName = String(item.item_name || '').trim();
        let tire_id = null, product_id = null;
        const prodRes = await pool.request()
          .input('n',     sql.NVarChar, itemName)
          .input('orgId', sql.Int,      orgId)
          .query('SELECT TOP 1 id FROM products WHERE LOWER(name) = LOWER(@n) AND is_active = 1 AND organization_id = @orgId');
        if (prodRes.recordset.length) {
          product_id = prodRes.recordset[0].id;
        } else {
          const tireRes = await pool.request()
            .input('n',        sql.NVarChar, itemName)
            .input('orgId',    sql.Int,      orgId)
            .input('branchId', sql.Int,      branchId)
            .query("SELECT TOP 1 id FROM tires WHERE organization_id = @orgId AND branch_id = @branchId AND is_active = 1 AND (LOWER(LTRIM(RTRIM(CONCAT(brand,' ',model,' ',size)))) = LOWER(@n) OR LOWER(model) = LOWER(@n) OR sku = @n OR barcode = @n) ORDER BY CASE WHEN sku = @n OR barcode = @n THEN 0 ELSE 1 END");
          if (tireRes.recordset.length) tire_id = tireRes.recordset[0].id;
        }
        if (!Number.isInteger(Number(item.qty)) || Number(item.qty) <= 0) throw new Error(`Invalid quantity for "${itemName}"`);
        resolvedItems.push({ item_name: itemName, qty: Number(item.qty), unit_price: parseFloat(item.unit_price) || 0, tire_id, product_id, batch_no: item.batch_no, expiry_date: item.expiry_date, serials: item.serials });
      }

      const subtotal = resolvedItems.reduce((s, it) => s + it.qty * it.unit_price, 0);
      const total    = parseFloat(subtotal.toFixed(2));
      const status   = po.status || 'pending';

      await transaction.begin();
      const po_no = await nextDocNumber(new sql.Request(transaction), 'purchases', prefix);

      const poRes = await new sql.Request(transaction)
        .input('org_id',     sql.Int,          orgId)
        .input('branch_id',  sql.Int,          branchId)
        .input('po_no',      sql.NVarChar,     po_no)
        .input('supplier_id',sql.Int,          supplier_id)
        .input('date',       sql.Date,         po.date || new Date())
        .input('subtotal',   sql.Decimal(18,2), subtotal)
        .input('tax',        sql.Decimal(18,2), 0)
        .input('total',      sql.Decimal(18,2), total)
        .input('status',     sql.NVarChar,     status)
        .input('notes',      sql.NVarChar,     po.notes || '')
        .query(`INSERT INTO purchases (organization_id,branch_id,po_no,supplier_id,date,subtotal,tax,total,status,notes)
                OUTPUT INSERTED.id VALUES (@org_id,@branch_id,@po_no,@supplier_id,@date,@subtotal,@tax,@total,@status,@notes)`);
      const purchaseId = poRes.recordset[0].id;

      for (const item of resolvedItems) {
        const amount = parseFloat((item.qty * item.unit_price).toFixed(2));
        await new sql.Request(transaction)
          .input('purchase_id', sql.Int,          purchaseId)
          .input('tire_id',     sql.Int,          item.tire_id)
          .input('product_id',  sql.Int,          item.product_id)
          .input('tire_name',   sql.NVarChar,     item.item_name)
          .input('qty',         sql.Int,          item.qty)
          .input('unit_price',  sql.Decimal(18,2), item.unit_price)
          .input('amount',      sql.Decimal(18,2), amount)
          .input('batch_no',    sql.NVarChar(60), batchCols(item).batch_no)
          .input('expiry_date', sql.Date,         batchCols(item).expiry_date)
          .input('serials',     sql.NVarChar(sql.MAX), batchCols(item).serials)
          .input('mfg_date',    sql.Date,         batchCols(item).mfg_date)
          .query(`INSERT INTO purchase_items (purchase_id,tire_id,product_id,tire_name,qty,unit_price,amount,batch_no,expiry_date,serials,mfg_date) VALUES (@purchase_id,@tire_id,@product_id,@tire_name,@qty,@unit_price,@amount,@batch_no,@expiry_date,@serials,@mfg_date)`);
        if (status === 'received' && item.tire_id) {
          await postMovement(transaction, {
            orgId, tireId: item.tire_id, qtyChange: item.qty, reason: MOVEMENT.GRN_RECEIVED, unitCost: item.unit_price,
            reference: po_no, refId: purchaseId, userId: req.user?.userId, ...lineBatch(item),
          });
        }
      }
      await transaction.commit();
      inserted++;
    } catch (err) {
      try { await transaction.rollback(); } catch {}
      errors.push({ ref: po.po_ref, message: err.message });
    }
  }
  res.json({ inserted, errors });
});

module.exports = router;
