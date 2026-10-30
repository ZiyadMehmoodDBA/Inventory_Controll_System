const express = require('express');
const router  = express.Router();
const { getPool, getSetting, sql } = require('../db');
const { getContext } = require('../context');
const { requireAuth, requireRole } = require('../middleware/auth');
const { writeAudit }               = require('../utils/audit');
const { postMovement, StockError, MOVEMENT, fulfilReservation } = require('../utils/stock');
const { assertLocationAccess } = require('../utils/access');
const { assertCompatibleLoad } = require('../utils/hazmat');
const { nextDocNumber } = require('../utils/docNumber');
const { assertTransactable } = require('../utils/itemMaster');
const { getBusinessType } = require('../utils/businessTypes');
const { AppError, handleError } = require('../utils/errors');
const { validate } = require('../utils/validate');
const S = require('../utils/schemas');

// Stock problems (insufficient stock, unknown item) are client errors, not server faults.
const sendError = (res, err) => err instanceof StockError
  ? res.status(err.status).json({ error: err.message, code: err.code, ...err.details })
  : handleError(res, err, 'sales');

router.get('/', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const { from, to } = req.query;
    const pool    = await getPool();
    const request = pool.request()
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .input('from', sql.Date, from || null)
      .input('to',   sql.Date, to   || null);
    const result = await request.query(`
      SELECT s.*, c.name AS customer_name, c.code AS customer_code
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.organization_id = @orgId AND s.branch_id = @branchId
        AND (@from IS NULL OR s.date >= @from)
        AND (@to   IS NULL OR s.date <= @to)
      ORDER BY s.created_at DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MUST be before /:id
router.get('/by-tire-type', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool   = await getPool();
    // Tyre shops break sales down by tyre type; every other business by item category.
    const byType = (await getBusinessType(orgId)) === 'tyre_shop';
    const group  = byType
      ? "ISNULL(NULLIF(LTRIM(RTRIM(t.type)), ''), 'Other')"
      : "ISNULL(c.name, 'Uncategorised')";
    const result = await pool.request()
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .query(`
        SELECT
          ${group} AS tire_type,
          COUNT(si.id)   AS item_count,
          SUM(si.amount) AS revenue
        FROM sale_items si
        INNER JOIN tires t ON si.tire_id = t.id
        LEFT JOIN item_categories c ON c.id = t.category_id
        INNER JOIN sales s ON si.sale_id = s.id
        WHERE s.organization_id = @orgId AND s.branch_id = @branchId
          AND s.status != 'voided'
        GROUP BY ${group}
        ORDER BY revenue DESC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MUST be before /:id
router.get('/stats/summary', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .query(`
        SELECT
          SUM(total) AS total_revenue,
          COUNT(*) AS total_sales,
          SUM(CASE WHEN status NOT IN ('paid', 'voided') THEN total ELSE 0 END) AS pending_amount,
          COUNT(CASE WHEN status NOT IN ('paid', 'voided') THEN 1 END) AS pending_count
        FROM sales
        WHERE organization_id = @orgId AND branch_id = @branchId
          AND status != 'voided'
      `);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MUST be before /:id
router.get('/stats/dashboard', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();

    const statsRes = await pool.request()
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .query(`
        SELECT
          ISNULL(SUM(CASE WHEN CAST(date AS DATE) = CAST(GETDATE() AS DATE) AND status != 'voided'
            THEN total ELSE 0 END), 0) AS today_revenue,
          ISNULL(SUM(CASE WHEN YEAR(date) = YEAR(GETDATE()) AND MONTH(date) = MONTH(GETDATE()) AND status != 'voided'
            THEN total ELSE 0 END), 0) AS month_revenue,
          ISNULL(COUNT(CASE WHEN CAST(date AS DATE) = CAST(GETDATE() AS DATE) AND status != 'voided'
            THEN 1 END), 0) AS today_invoices,
          ISNULL(COUNT(CASE WHEN YEAR(date) = YEAR(GETDATE()) AND MONTH(date) = MONTH(GETDATE()) AND status != 'voided'
            THEN 1 END), 0) AS month_invoices,
          (SELECT ISNULL(SUM(si.qty), 0) FROM sale_items si
           INNER JOIN sales s2 ON si.sale_id = s2.id
           WHERE s2.organization_id = @orgId AND s2.branch_id = @branchId
             AND CAST(s2.date AS DATE) = CAST(GETDATE() AS DATE)
             AND s2.status != 'voided') AS today_units,
          (SELECT ISNULL(SUM(si.qty), 0) FROM sale_items si
           INNER JOIN sales s2 ON si.sale_id = s2.id
           WHERE s2.organization_id = @orgId AND s2.branch_id = @branchId
             AND YEAR(s2.date) = YEAR(GETDATE()) AND MONTH(s2.date) = MONTH(GETDATE())
             AND s2.status != 'voided') AS month_units
        FROM sales
        WHERE organization_id = @orgId AND branch_id = @branchId
      `);

    const skusRes = await pool.request()
      .input('orgId',    sql.Int, orgId)
      .input('branchId', sql.Int, branchId)
      .query(`
        SELECT TOP 10
          t.brand + ' ' + t.model + ' ' + t.size AS sku_name,
          SUM(si.qty)    AS qty_sold,
          SUM(si.amount) AS revenue
        FROM sale_items si
        INNER JOIN tires t ON si.tire_id = t.id
        INNER JOIN sales s ON si.sale_id = s.id
        WHERE s.organization_id = @orgId AND s.branch_id = @branchId
          AND s.status != 'voided'
          AND s.date >= DATEADD(day, -30, GETDATE())
        GROUP BY t.brand, t.model, t.size
        ORDER BY qty_sold DESC
      `);

    res.json({ ...statsRes.recordset[0], top_skus: skusRes.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const saleRes = await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT s.*, c.name AS customer_name, c.code AS customer_code,
               c.phone AS customer_phone, c.email AS customer_email, c.address AS customer_address
        FROM sales s
        LEFT JOIN customers c ON s.customer_id = c.id
        WHERE s.id = @id AND s.organization_id = @orgId
      `);
    if (!saleRes.recordset.length) return res.status(404).json({ error: 'Not found' });

    const itemsRes = await pool.request()
      .input('sale_id', sql.Int, req.params.id)
      .query(`
        SELECT si.*, t.brand, t.model, t.size,
               p.name AS product_name, p.category AS product_category, p.unit AS product_unit
        FROM sale_items si
        LEFT JOIN tires    t ON si.tire_id    = t.id
        LEFT JOIN products p ON si.product_id = p.id
        WHERE si.sale_id = @sale_id
      `);
    res.json({ ...saleRes.recordset[0], items: itemsRes.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { orgId, branchId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    const {
      customer_id, date, items,
      tax_rate,
      discount: orderDiscount,       // order-level discount amount
      status: requestedStatus,
      notes,
      // POS payment fields (optional; if present, payment captured in same tx)
      payment_method, amount_paid,
      cash_given, cash_amount, card_amount,
      location_id,
    } = validate(req.body, S.SALE_BODY);

    // customer_id is optional — null means walk-in (no AR/ledger entry will be created)
    if (customer_id != null && customer_id !== '') {
      const own = await pool.request().input('c', sql.Int, customer_id).input('o', sql.Int, orgId).query('SELECT 1 AS ok FROM customers WHERE id = @c AND organization_id = @o');
      if (!own.recordset.length) return res.status(400).json({ error: 'Customer not found', code: 'INVALID_CUSTOMER' });
    }

    // Per-line discount support: amount = qty * price * (1 - disc%)
    const lineSubtotal = items.reduce((s, it) => {
      const disc = parseFloat(it.discount || 0);
      return s + (it.qty * it.unit_price * (1 - disc / 100));
    }, 0);
    if (orderDiscount > lineSubtotal + 0.005) throw new AppError('The order discount cannot exceed the order value', 400, 'DISCOUNT_TOO_LARGE');
    const subtotal = parseFloat(Math.max(0, lineSubtotal - parseFloat(orderDiscount || 0)).toFixed(2));
    const tax      = parseFloat((subtotal * (tax_rate / 100)).toFixed(2));
    const total    = parseFloat((subtotal + tax).toFixed(2));

    // POS: derive status from payment captured
    const paidAmt = parseFloat(amount_paid || 0);
    if (paidAmt > total + 0.005) throw new AppError(`The amount paid (${paidAmt.toFixed(2)}) is more than the sale total (${total.toFixed(2)})`, 400, 'OVERPAYMENT');
    if (payment_method === 'mixed' && Math.abs(Number(cash_amount || 0) + Number(card_amount || 0) - paidAmt) > 0.01)
      throw new AppError('Cash plus card must equal the amount paid', 400, 'SPLIT_MISMATCH');
    let finalStatus = requestedStatus;
    if (payment_method) {
      if (paidAmt >= total - 0.005)   finalStatus = 'paid';
      else if (paidAmt > 0)           finalStatus = 'partial';
      else                            finalStatus = 'pending';
    }

    const prefix = await getSetting('invoice_prefix', 'INV', orgId);

    await transaction.begin();
    await assertTransactable(transaction, orgId, items.map(it => it.tire_id), 'sale');
    // Optional: issue from a specific location instead of the branch default.
    const issueLocation = location_id || null;
    if (issueLocation) {
      const loc = await assertLocationAccess(transaction, orgId, { userId: req.user?.userId, role: req.user?.role, branchId: req.user?.branchId ?? branchId }, issueLocation, 'issue');
      if (loc.branch_id !== branchId) throw new StockError('INVALID_LOCATION', 'That location belongs to another branch', 400);
      if (!loc.is_active || loc.kind !== 'normal') throw new StockError('LOCATION_NOT_SELLABLE', `Cannot sell from ${loc.name}: it is ${loc.is_active ? loc.kind : 'inactive'}`, 409);
    }
    const invoiceNo = await nextDocNumber(new sql.Request(transaction), 'sales', prefix);

    const saleRes = await new sql.Request(transaction)
      .input('org_id',         sql.Int,          orgId)
      .input('branch_id',      sql.Int,          branchId)
      .input('invoice_no',     sql.NVarChar,     invoiceNo)
      .input('customer_id',    sql.Int,          customer_id)
      .input('date',           sql.Date,         date || new Date())
      .input('subtotal',       sql.Decimal(18,2), subtotal)
      .input('tax',            sql.Decimal(18,2), tax)
      .input('total',          sql.Decimal(18,2), total)
      .input('discount',       sql.Decimal(18,2), parseFloat(orderDiscount || 0))
      .input('tax_rate',       sql.Decimal(5,2),  parseFloat(tax_rate))
      .input('status',         sql.NVarChar,     finalStatus)
      .input('notes',          sql.NVarChar,     notes || '')
      .input('payment_method', sql.NVarChar,     payment_method || null)
      .input('cash_given',     sql.Decimal(18,2), cash_given ? parseFloat(cash_given) : null)
      .input('amount_paid',    sql.Decimal(18,2), paidAmt)
      .query(`
        INSERT INTO sales
          (organization_id,branch_id,invoice_no,customer_id,date,
           subtotal,tax,total,discount,tax_rate,status,notes,
           payment_method,cash_given,amount_paid)
        OUTPUT INSERTED.*
        VALUES
          (@org_id,@branch_id,@invoice_no,@customer_id,@date,
           @subtotal,@tax,@total,@discount,@tax_rate,@status,@notes,
           @payment_method,@cash_given,@amount_paid)
      `);
    const saleId = saleRes.recordset[0].id;

    await assertCompatibleLoad(transaction, orgId, items.map(i => i.tire_id).filter(Boolean));
    for (const item of items) {
      const disc      = parseFloat(item.discount || 0);
      const lineAmt   = parseFloat((item.qty * item.unit_price * (1 - disc / 100)).toFixed(2));
      const itemName  = item.tire_name || item.item_name || (item.tire_id ? `Tire #${item.tire_id}` : `Product #${item.product_id}`);
      const tireId    = item.tire_id    ? Number(item.tire_id)    : null;
      const productId = item.product_id ? Number(item.product_id) : null;

      await new sql.Request(transaction)
        .input('sale_id',    sql.Int,          saleId)
        .input('tire_id',    sql.Int,          tireId)
        .input('product_id', sql.Int,          productId)
        .input('tire_name',  sql.NVarChar,     itemName)
        .input('qty',        sql.Int,          item.qty)
        .input('unit_price', sql.Decimal(18,2), item.unit_price)
        .input('discount',   sql.Decimal(5,2),  disc)
        .input('amount',     sql.Decimal(18,2), lineAmt)
        .query(`INSERT INTO sale_items (sale_id,tire_id,product_id,tire_name,qty,unit_price,discount,amount)
                VALUES (@sale_id,@tire_id,@product_id,@tire_name,@qty,@unit_price,@discount,@amount)`);

      if (tireId) {
        // Selling against a reservation uses up the hold first, so the reserved units can be issued.
        if (item.reservation_id) await fulfilReservation(transaction, { orgId, reservationId: Number(item.reservation_id), tireId, qty: Number(item.qty), saleId, userId: req.user?.userId });
        await postMovement(transaction, {
          orgId, tireId, qtyChange: -Number(item.qty), reason: MOVEMENT.SALE, locationId: issueLocation,
          reference: invoiceNo, refId: saleId, userId: req.user?.userId, unitCost: undefined,
          // Optional pick of a specific batch or serial numbers; otherwise tracked items issue FEFO.
          batchId: item.batch_id ? Number(item.batch_id) : undefined,
          serials: Array.isArray(item.serials) && item.serials.length ? item.serials : undefined,
        });
      }
    }

    // Capture payment in the same transaction (POS checkout).
    // Walk-in sales (customer_id = null) skip sale_payments — no AR to track;
    // amount_paid + status on the sales row itself is sufficient.
    if (customer_id && payment_method && paidAmt > 0) {
      const payDate = date || new Date().toISOString().split('T')[0];
      if (payment_method === 'mixed') {
        const cAmt = parseFloat(cash_amount || 0);
        const kAmt = parseFloat(card_amount || 0);
        if (cAmt > 0) {
          await new sql.Request(transaction)
            .input('sale_id',   sql.Int,          saleId).input('cust_id',   sql.Int,          customer_id)
            .input('org_id',    sql.Int,          orgId) .input('branch_id', sql.Int,          branchId)
            .input('amount',    sql.Decimal(18,2), cAmt)  .input('method',    sql.NVarChar,     'cash')
            .input('date',      sql.Date,         payDate)
            .query(`INSERT INTO sale_payments (sale_id,customer_id,organization_id,branch_id,amount,payment_method,payment_date)
                    VALUES (@sale_id,@cust_id,@org_id,@branch_id,@amount,@method,@date)`);
        }
        if (kAmt > 0) {
          await new sql.Request(transaction)
            .input('sale_id',   sql.Int,          saleId).input('cust_id',   sql.Int,          customer_id)
            .input('org_id',    sql.Int,          orgId) .input('branch_id', sql.Int,          branchId)
            .input('amount',    sql.Decimal(18,2), kAmt)  .input('method',    sql.NVarChar,     'card')
            .input('date',      sql.Date,         payDate)
            .query(`INSERT INTO sale_payments (sale_id,customer_id,organization_id,branch_id,amount,payment_method,payment_date)
                    VALUES (@sale_id,@cust_id,@org_id,@branch_id,@amount,@method,@date)`);
        }
      } else {
        await new sql.Request(transaction)
          .input('sale_id',   sql.Int,          saleId).input('cust_id',   sql.Int,          customer_id)
          .input('org_id',    sql.Int,          orgId) .input('branch_id', sql.Int,          branchId)
          .input('amount',    sql.Decimal(18,2), Math.min(paidAmt, total))
          .input('method',    sql.NVarChar,     payment_method)
          .input('date',      sql.Date,         payDate)
          .query(`INSERT INTO sale_payments (sale_id,customer_id,organization_id,branch_id,amount,payment_method,payment_date)
                  VALUES (@sale_id,@cust_id,@org_id,@branch_id,@amount,@method,@date)`);
      }
    }

    await transaction.commit();
    writeAudit(pool, { orgId, branchId, userId: req.user?.userId,
      action: 'CREATE', entity: 'sales', entityId: saleId,
      before: null,
      after: { id: saleId, invoice_no: invoiceNo, date, customer_id, subtotal, tax, total, status: finalStatus, payment_method },
    });
    res.status(201).json({ ...saleRes.recordset[0], invoice_no: invoiceNo });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    sendError(res, err);
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = validate(req.body, S.STATUS_BODY);
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();

    // Capture old status for audit trail
    const beforeRes = await pool.request()
      .input('id', sql.Int, req.params.id).input('orgId', sql.Int, orgId)
      .query('SELECT id, invoice_no, status FROM sales WHERE id = @id AND organization_id = @orgId');
    const beforeRow = beforeRes.recordset[0] || null;
    if (!beforeRow) throw new AppError('Sale not found', 404, 'NOT_FOUND');
    if (beforeRow.status === 'voided') throw new AppError('A voided sale cannot change status', 409, 'SALE_VOIDED');

    await pool.request()
      .input('id',    sql.Int,      req.params.id)
      .input('orgId', sql.Int,      orgId)
      .input('status',sql.NVarChar, status)
      .query('UPDATE sales SET status = @status WHERE id = @id AND organization_id = @orgId AND status != \'voided\'');

    if (beforeRow) {
      writeAudit(pool, { orgId, branchId, userId: req.user?.userId,
        action: 'UPDATE', entity: 'sales', entityId: Number(req.params.id),
        before: { id: beforeRow.id, invoice_no: beforeRow.invoice_no, status: beforeRow.status },
        after:  { id: beforeRow.id, invoice_no: beforeRow.invoice_no, status },
      });
    }
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'sales');
  }
});

// Void a sale: restores stock, marks voided — never deletes. Admin only.
router.post('/:id/void', requireRole('org_admin'), async (req, res) => {
  const { orgId, branchId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const saleRes = await new sql.Request(transaction)
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT id, status FROM sales WHERE id = @id AND organization_id = @orgId');

    if (!saleRes.recordset.length) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Sale not found' });
    }
    if (saleRes.recordset[0].status === 'voided') {
      await transaction.rollback();
      return res.status(400).json({ error: 'Sale is already voided' });
    }

    const itemsRes = await new sql.Request(transaction)
      .input('sale_id', sql.Int, req.params.id)
      .query('SELECT tire_id, qty FROM sale_items WHERE sale_id = @sale_id');

    const voidedSale = await new sql.Request(transaction)
      .input('id', sql.Int, req.params.id)
      .query('SELECT invoice_no FROM sales WHERE id = @id');
    const voidInvoiceNo = voidedSale.recordset[0]?.invoice_no || '';

    for (const item of itemsRes.recordset) {
      if (item.tire_id) {
        await postMovement(transaction, {
          orgId, tireId: item.tire_id, qtyChange: Number(item.qty), reason: MOVEMENT.SALE_VOIDED,
          reference: voidInvoiceNo, refId: Number(req.params.id), userId: req.user?.userId,
          reverseOf: { refId: Number(req.params.id), reasons: [MOVEMENT.SALE] },
        });
      }
    }

    await new sql.Request(transaction)
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('UPDATE sales SET status = \'voided\' WHERE id = @id AND organization_id = @orgId');

    await transaction.commit();
    writeAudit(pool, { orgId, branchId, userId: req.user?.userId,
      action: 'UPDATE', entity: 'sales', entityId: Number(req.params.id),
      before: { id: Number(req.params.id), invoice_no: voidInvoiceNo, status: saleRes.recordset[0].status },
      after:  { id: Number(req.params.id), invoice_no: voidInvoiceNo, status: 'voided' },
    });
    res.json({ success: true });
  } catch (err) {
    await transaction.rollback();
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireRole('org_admin'), async (req, res) => {
  const { orgId, branchId } = getContext(req);
  const pool = await getPool();

  // Capture sale header before deletion for audit trail
  const saleBeforeRes = await pool.request()
    .input('id',    sql.Int, req.params.id)
    .input('orgId', sql.Int, orgId)
    .query('SELECT id, invoice_no, date, customer_id, total, status FROM sales WHERE id = @id AND organization_id = @orgId');
  const saleBefore = saleBeforeRes.recordset[0] || null;

  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const itemsRes = await new sql.Request(transaction)
      .input('sale_id', sql.Int, req.params.id)
      .query('SELECT tire_id, qty FROM sale_items WHERE sale_id = @sale_id');

    // A voided sale already returned its stock; restoring again would double-count it.
    if (saleBefore && saleBefore.status !== 'voided') {
      for (const item of itemsRes.recordset) {
        if (item.tire_id) {
          await postMovement(transaction, {
            orgId, tireId: item.tire_id, qtyChange: Number(item.qty), reason: MOVEMENT.SALE_DELETED,
            reference: saleBefore.invoice_no, refId: Number(req.params.id), userId: req.user?.userId,
            reverseOf: { refId: Number(req.params.id), reasons: [MOVEMENT.SALE] },
          });
        }
      }
    }

    await new sql.Request(transaction)
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('DELETE FROM sales WHERE id = @id AND organization_id = @orgId');

    await transaction.commit();
    writeAudit(pool, { orgId, branchId, userId: req.user?.userId,
      action: 'DELETE', entity: 'sales', entityId: Number(req.params.id),
      before: saleBefore, after: null,
    });
    res.json({ success: true });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    sendError(res, err);
  }
});

router.post('/bulk', async (req, res) => {
  const { orgId, branchId } = getContext(req);
  let invoices;
  try { ({ invoices } = validate(req.body, { invoices: S.BULK_LIST() })); } catch (e) { return handleError(res, e, 'sales'); }
  const pool   = await getPool();
  const prefix = await getSetting('invoice_prefix', 'INV', orgId);
  let inserted = 0;
  const errors = [];

  for (const raw of invoices) {
    const transaction = new sql.Transaction(pool);
    let inv = raw;
    try {
      inv = validate(raw, S.BULK_INVOICE);
      const custRes = await pool.request()
        .input('name',  sql.NVarChar, String(inv.customer_name || '').trim())
        .input('orgId', sql.Int,      orgId)
        .query('SELECT TOP 1 id FROM customers WHERE LOWER(name) = LOWER(@name) AND organization_id = @orgId');
      if (!custRes.recordset.length) {
        errors.push({ ref: inv.invoice_ref, message: `Customer "${inv.customer_name}" not found` });
        continue;
      }
      const customer_id = custRes.recordset[0].id;
      const items       = Array.isArray(inv.items) ? inv.items : [];
      if (!items.length) { errors.push({ ref: inv.invoice_ref, message: 'No line items' }); continue; }

      const resolvedItems = [];
      for (const item of items) {
        const itemName  = String(item.item_name || '').trim();
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
        resolvedItems.push({ item_name: itemName, qty: Number(item.qty), unit_price: parseFloat(item.unit_price) || 0, tire_id, product_id });
      }

      const taxRate  = parseFloat(inv.tax_rate || 0);
      const subtotal = resolvedItems.reduce((s, it) => s + it.qty * it.unit_price, 0);
      const tax      = parseFloat((subtotal * taxRate / 100).toFixed(2));
      const total    = parseFloat((subtotal + tax).toFixed(2));

      await transaction.begin();
      const invoice_no = await nextDocNumber(new sql.Request(transaction), 'sales', prefix);

      const saleRes = await new sql.Request(transaction)
        .input('org_id',     sql.Int,          orgId)
        .input('branch_id',  sql.Int,          branchId)
        .input('invoice_no', sql.NVarChar,     invoice_no)
        .input('customer_id',sql.Int,          customer_id)
        .input('date',       sql.Date,         inv.date || new Date())
        .input('subtotal',   sql.Decimal(18,2), subtotal)
        .input('tax',        sql.Decimal(18,2), tax)
        .input('total',      sql.Decimal(18,2), total)
        .input('status',     sql.NVarChar,     inv.status || 'pending')
        .input('notes',      sql.NVarChar,     inv.notes  || '')
        .input('tax_rate',   sql.Decimal(5,2), taxRate)
        .query(`INSERT INTO sales (organization_id,branch_id,invoice_no,customer_id,date,subtotal,tax,total,status,notes,tax_rate)
                OUTPUT INSERTED.id VALUES (@org_id,@branch_id,@invoice_no,@customer_id,@date,@subtotal,@tax,@total,@status,@notes,@tax_rate)`);
      const saleId = saleRes.recordset[0].id;

      await assertCompatibleLoad(transaction, orgId, resolvedItems.map(i => i.tire_id).filter(Boolean));
      for (const item of resolvedItems) {
        const amount = parseFloat((item.qty * item.unit_price).toFixed(2));
        await new sql.Request(transaction)
          .input('sale_id',    sql.Int,          saleId)
          .input('tire_id',    sql.Int,          item.tire_id)
          .input('product_id', sql.Int,          item.product_id)
          .input('tire_name',  sql.NVarChar,     item.item_name)
          .input('qty',        sql.Int,          item.qty)
          .input('unit_price', sql.Decimal(18,2), item.unit_price)
          .input('amount',     sql.Decimal(18,2), amount)
          .query(`INSERT INTO sale_items (sale_id,tire_id,product_id,tire_name,qty,unit_price,amount) VALUES (@sale_id,@tire_id,@product_id,@tire_name,@qty,@unit_price,@amount)`);
        if (item.tire_id) {
          await postMovement(transaction, {
            orgId, tireId: item.tire_id, qtyChange: -item.qty, reason: MOVEMENT.SALE,
            reference: invoice_no, refId: saleId, userId: req.user?.userId,
          });
        }
      }
      await transaction.commit();
      inserted++;
    } catch (err) {
      try { await transaction.rollback(); } catch {}
      errors.push({ ref: inv?.invoice_ref ?? raw?.invoice_ref, message: err.message });
    }
  }
  res.json({ inserted, errors });
});

module.exports = router;
