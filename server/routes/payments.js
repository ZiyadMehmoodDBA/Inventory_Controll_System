const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');

// POST /api/payments/sale
router.post('/sale', async (req, res) => {
  const { orgId, branchId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    const { sale_id, amount, payment_date, payment_method = 'cash', reference_no = '', notes = '' } = req.body;
    if (!sale_id || !amount) return res.status(400).json({ error: 'sale_id and amount are required' });
    if (Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

    await transaction.begin();

    const saleRes = await new sql.Request(transaction)
      .input('id',    sql.Int, sale_id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT id, total, amount_paid, status, customer_id, invoice_no FROM sales WHERE id = @id AND organization_id = @orgId');
    if (!saleRes.recordset.length) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Sale not found' });
    }

    const sale        = saleRes.recordset[0];
    const newPaid     = parseFloat((Number(sale.amount_paid || 0) + Number(amount)).toFixed(2));
    const saleTotal   = Number(sale.total);
    const payDate     = payment_date || new Date().toISOString().slice(0, 10);

    let newStatus = 'pending';
    if (newPaid >= saleTotal) newStatus = 'paid';
    else if (newPaid > 0)     newStatus = 'partial';

    const payRes = await new sql.Request(transaction)
      .input('org_id',         sql.Int,          orgId)
      .input('branch_id',      sql.Int,          branchId)
      .input('sale_id',        sql.Int,          sale_id)
      .input('customer_id',    sql.Int,          sale.customer_id)
      .input('amount',         sql.Decimal(18,2), Number(amount))
      .input('payment_date',   sql.Date,         payDate)
      .input('payment_method', sql.NVarChar,     payment_method)
      .input('reference_no',   sql.NVarChar,     reference_no)
      .input('notes',          sql.NVarChar,     notes)
      .query(`
        INSERT INTO sale_payments (organization_id, branch_id, sale_id, customer_id, amount, payment_date, payment_method, reference_no, notes)
        OUTPUT INSERTED.*
        VALUES (@org_id, @branch_id, @sale_id, @customer_id, @amount, @payment_date, @payment_method, @reference_no, @notes)
      `);

    await new sql.Request(transaction)
      .input('id',          sql.Int,          sale_id)
      .input('amount_paid', sql.Decimal(18,2), newPaid)
      .input('status',      sql.NVarChar,     newStatus)
      .query('UPDATE sales SET amount_paid = @amount_paid, status = @status WHERE id = @id');

    await new sql.Request(transaction)
      .input('org_id',      sql.Int,          orgId)
      .input('branch_id',   sql.Int,          branchId)
      .input('entry_date',  sql.Date,         payDate)
      .input('entity_type', sql.NVarChar,     'customer')
      .input('entity_id',   sql.Int,          sale.customer_id)
      .input('entry_type',  sql.NVarChar,     'payment')
      .input('credit',      sql.Decimal(18,2), Number(amount))
      .input('description', sql.NVarChar,     `Payment received (${payment_method})`)
      .input('ref_no',      sql.NVarChar,     sale.invoice_no)
      .input('sale_id',     sql.Int,          sale_id)
      .query(`
        INSERT INTO ledger_entries (organization_id, branch_id, entry_date, entity_type, entity_id, entry_type, debit, credit, description, reference_no, sale_id)
        VALUES (@org_id, @branch_id, @entry_date, @entity_type, @entity_id, @entry_type, 0, @credit, @description, @ref_no, @sale_id)
      `);

    await transaction.commit();
    res.status(201).json({
      payment:         payRes.recordset[0],
      new_status:      newStatus,
      new_amount_paid: newPaid,
      balance_due:     parseFloat((saleTotal - newPaid).toFixed(2)),
    });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

router.get('/sale/:saleId', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('sale_id', sql.Int, req.params.saleId)
      .input('orgId',   sql.Int, orgId)
      .query('SELECT * FROM sale_payments WHERE sale_id = @sale_id AND organization_id = @orgId ORDER BY payment_date ASC, created_at ASC');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/sale/:id', async (req, res) => {
  const { orgId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const payRes = await new sql.Request(transaction)
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM sale_payments WHERE id = @id AND organization_id = @orgId');
    if (!payRes.recordset.length) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Payment not found' });
    }
    const payment = payRes.recordset[0];

    await new sql.Request(transaction)
      .input('id', sql.Int, req.params.id)
      .query('DELETE FROM sale_payments WHERE id = @id');

    const recalc = await new sql.Request(transaction)
      .input('sale_id', sql.Int, payment.sale_id)
      .query('SELECT ISNULL(SUM(amount), 0) AS total_paid FROM sale_payments WHERE sale_id = @sale_id');
    const newPaid = Number(recalc.recordset[0].total_paid);

    const saleRes = await new sql.Request(transaction)
      .input('id', sql.Int, payment.sale_id)
      .query('SELECT total, status FROM sales WHERE id = @id');
    const saleTotal  = Number(saleRes.recordset[0].total);
    const prevStatus = saleRes.recordset[0].status;

    let newStatus = 'pending';
    if (newPaid >= saleTotal)          newStatus = 'paid';
    else if (newPaid > 0)              newStatus = 'partial';
    else if (prevStatus === 'overdue') newStatus = 'overdue';

    await new sql.Request(transaction)
      .input('id',          sql.Int,          payment.sale_id)
      .input('amount_paid', sql.Decimal(18,2), newPaid)
      .input('status',      sql.NVarChar,     newStatus)
      .query('UPDATE sales SET amount_paid = @amount_paid, status = @status WHERE id = @id');

    await transaction.commit();
    res.json({ success: true, new_status: newStatus, new_amount_paid: newPaid });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/purchase
router.post('/purchase', async (req, res) => {
  const { orgId, branchId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    const { purchase_id, amount, payment_date, payment_method = 'cash', reference_no = '', notes = '' } = req.body;
    if (!purchase_id || !amount) return res.status(400).json({ error: 'purchase_id and amount are required' });
    if (Number(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

    await transaction.begin();

    const purchRes = await new sql.Request(transaction)
      .input('id',    sql.Int, purchase_id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT id, total, amount_paid, status, supplier_id, po_no FROM purchases WHERE id = @id AND organization_id = @orgId');
    if (!purchRes.recordset.length) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Purchase not found' });
    }

    const purch   = purchRes.recordset[0];
    const newPaid = parseFloat((Number(purch.amount_paid || 0) + Number(amount)).toFixed(2));
    const payDate = payment_date || new Date().toISOString().slice(0, 10);

    const payRes = await new sql.Request(transaction)
      .input('org_id',         sql.Int,          orgId)
      .input('branch_id',      sql.Int,          branchId)
      .input('purchase_id',    sql.Int,          purchase_id)
      .input('supplier_id',    sql.Int,          purch.supplier_id)
      .input('amount',         sql.Decimal(18,2), Number(amount))
      .input('payment_date',   sql.Date,         payDate)
      .input('payment_method', sql.NVarChar,     payment_method)
      .input('reference_no',   sql.NVarChar,     reference_no)
      .input('notes',          sql.NVarChar,     notes)
      .query(`
        INSERT INTO purchase_payments (organization_id, branch_id, purchase_id, supplier_id, amount, payment_date, payment_method, reference_no, notes)
        OUTPUT INSERTED.*
        VALUES (@org_id, @branch_id, @purchase_id, @supplier_id, @amount, @payment_date, @payment_method, @reference_no, @notes)
      `);

    await new sql.Request(transaction)
      .input('id',          sql.Int,          purchase_id)
      .input('amount_paid', sql.Decimal(18,2), newPaid)
      .query('UPDATE purchases SET amount_paid = @amount_paid WHERE id = @id');

    await new sql.Request(transaction)
      .input('org_id',      sql.Int,          orgId)
      .input('branch_id',   sql.Int,          branchId)
      .input('entry_date',  sql.Date,         payDate)
      .input('entity_type', sql.NVarChar,     'supplier')
      .input('entity_id',   sql.Int,          purch.supplier_id)
      .input('entry_type',  sql.NVarChar,     'purchase_payment')
      .input('debit',       sql.Decimal(18,2), Number(amount))
      .input('description', sql.NVarChar,     `Payment to supplier (${payment_method})`)
      .input('ref_no',      sql.NVarChar,     purch.po_no)
      .input('purchase_id', sql.Int,          purchase_id)
      .query(`
        INSERT INTO ledger_entries (organization_id, branch_id, entry_date, entity_type, entity_id, entry_type, debit, credit, description, reference_no, purchase_id)
        VALUES (@org_id, @branch_id, @entry_date, @entity_type, @entity_id, @entry_type, @debit, 0, @description, @ref_no, @purchase_id)
      `);

    await transaction.commit();
    res.status(201).json({
      payment:         payRes.recordset[0],
      new_amount_paid: newPaid,
      balance_due:     parseFloat((Number(purch.total) - newPaid).toFixed(2)),
    });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

router.get('/purchase/:purchaseId', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('purchase_id', sql.Int, req.params.purchaseId)
      .input('orgId',       sql.Int, orgId)
      .query('SELECT * FROM purchase_payments WHERE purchase_id = @purchase_id AND organization_id = @orgId ORDER BY payment_date ASC, created_at ASC');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/purchase/:id', async (req, res) => {
  const { orgId } = getContext(req);
  const pool        = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const payRes = await new sql.Request(transaction)
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM purchase_payments WHERE id = @id AND organization_id = @orgId');
    if (!payRes.recordset.length) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Payment not found' });
    }
    const payment = payRes.recordset[0];

    await new sql.Request(transaction)
      .input('id', sql.Int, req.params.id)
      .query('DELETE FROM purchase_payments WHERE id = @id');

    const recalc = await new sql.Request(transaction)
      .input('purchase_id', sql.Int, payment.purchase_id)
      .query('SELECT ISNULL(SUM(amount), 0) AS total_paid FROM purchase_payments WHERE purchase_id = @purchase_id');
    const newPaid = Number(recalc.recordset[0].total_paid);

    await new sql.Request(transaction)
      .input('id',          sql.Int,          payment.purchase_id)
      .input('amount_paid', sql.Decimal(18,2), newPaid)
      .query('UPDATE purchases SET amount_paid = @amount_paid WHERE id = @id');

    await transaction.commit();
    res.json({ success: true, new_amount_paid: newPaid });
  } catch (err) {
    try { await transaction.rollback(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
