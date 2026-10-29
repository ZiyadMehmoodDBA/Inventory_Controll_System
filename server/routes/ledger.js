const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');

router.get('/summary', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();

    const recvRes = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT
          ISNULL(SUM(s.total), 0)        AS total_invoiced,
          ISNULL(SUM(s.amount_paid), 0)  AS total_collected,
          ISNULL(SUM(s.total) - SUM(s.amount_paid), 0) AS total_receivable,
          COUNT(CASE WHEN s.status IN ('pending','overdue') THEN 1 END) AS unpaid_count,
          COUNT(CASE WHEN s.status = 'partial' THEN 1 END) AS partial_count
        FROM sales s
        WHERE s.organization_id = @orgId AND s.status != 'voided'
      `);

    const payRes = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT
          ISNULL(SUM(p.total), 0)        AS total_purchased,
          ISNULL(SUM(p.amount_paid), 0)  AS total_paid_out,
          ISNULL(SUM(p.total) - SUM(p.amount_paid), 0) AS total_payable
        FROM purchases p
        WHERE p.organization_id = @orgId AND p.status != 'cancelled'
      `);

    const recv = recvRes.recordset[0];
    const pay  = payRes.recordset[0];

    res.json({
      total_invoiced:   Number(recv.total_invoiced),
      total_collected:  Number(recv.total_collected),
      total_receivable: Number(recv.total_receivable),
      unpaid_count:     Number(recv.unpaid_count),
      partial_count:    Number(recv.partial_count),
      total_purchased:  Number(pay.total_purchased),
      total_paid_out:   Number(pay.total_paid_out),
      total_payable:    Number(pay.total_payable),
      net_position:     Number(recv.total_collected) - Number(pay.total_paid_out),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/customers', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT
          c.id, c.code, c.name, c.phone, c.email, c.address,
          ISNULL(SUM(s.total), 0)                              AS total_invoiced,
          ISNULL(SUM(s.amount_paid), 0)                        AS total_paid,
          ISNULL(SUM(s.total) - SUM(s.amount_paid), 0)        AS balance,
          COUNT(s.id)                                           AS invoice_count,
          COUNT(CASE WHEN s.status IN ('pending','overdue') THEN 1 END) AS unpaid_count,
          COUNT(CASE WHEN s.status = 'partial' THEN 1 END)    AS partial_count,
          MAX(s.date)                                           AS last_transaction
        FROM customers c
        LEFT JOIN sales s ON s.customer_id = c.id AND s.organization_id = @orgId AND s.status != 'voided'
        WHERE c.organization_id = @orgId
        GROUP BY c.id, c.code, c.name, c.phone, c.email, c.address
        ORDER BY balance DESC, c.name ASC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/suppliers', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT
          s.id, s.code, s.name, s.phone, s.email, s.address,
          ISNULL(SUM(p.total), 0)                             AS total_purchased,
          ISNULL(SUM(p.amount_paid), 0)                       AS total_paid,
          ISNULL(SUM(p.total) - SUM(p.amount_paid), 0)       AS balance,
          COUNT(p.id)                                          AS po_count,
          MAX(p.date)                                          AS last_transaction
        FROM suppliers s
        LEFT JOIN purchases p ON p.supplier_id = s.id AND p.organization_id = @orgId AND p.status != 'cancelled'
        WHERE s.organization_id = @orgId
        GROUP BY s.id, s.code, s.name, s.phone, s.email, s.address
        ORDER BY balance DESC, s.name ASC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/customer/:id/statement', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const custId = req.params.id;

    const custRes = await pool.request()
      .input('id',    sql.Int, custId)
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM customers WHERE id = @id AND organization_id = @orgId');
    if (!custRes.recordset.length) return res.status(404).json({ error: 'Customer not found' });

    const stmtRes = await pool.request()
      .input('customer_id', sql.Int, custId)
      .input('orgId',       sql.Int, orgId)
      .query(`
        SELECT entry_date, entry_type, reference_no, description, debit, credit, sort_ts
        FROM (
          SELECT
            s.date          AS entry_date,
            'Invoice'       AS entry_type,
            s.invoice_no    AS reference_no,
            'Sales Invoice' AS description,
            s.total         AS debit,
            CAST(0 AS DECIMAL(18,2)) AS credit,
            s.created_at    AS sort_ts
          FROM sales s
          WHERE s.customer_id = @customer_id AND s.organization_id = @orgId AND s.status != 'voided'

          UNION ALL

          SELECT
            sp.payment_date AS entry_date,
            'Payment'       AS entry_type,
            CASE WHEN ISNULL(sp.reference_no,'') != '' THEN sp.reference_no
                 ELSE 'RCP-' + CAST(sp.id AS NVARCHAR) END AS reference_no,
            CASE WHEN ISNULL(sp.notes,'') != '' THEN sp.notes
                 ELSE 'Payment received (' + sp.payment_method + ')' END AS description,
            CAST(0 AS DECIMAL(18,2)) AS debit,
            sp.amount       AS credit,
            sp.created_at   AS sort_ts
          FROM sale_payments sp
          WHERE sp.customer_id = @customer_id AND sp.organization_id = @orgId
        ) combined
        ORDER BY entry_date ASC, sort_ts ASC
      `);

    let runningBalance = 0;
    const entries = stmtRes.recordset.map(row => {
      runningBalance = parseFloat((runningBalance + Number(row.debit) - Number(row.credit)).toFixed(2));
      return { ...row, running_balance: runningBalance };
    });

    const totalDebit  = entries.reduce((s, r) => s + Number(r.debit),  0);
    const totalCredit = entries.reduce((s, r) => s + Number(r.credit), 0);

    res.json({
      customer: custRes.recordset[0],
      entries,
      summary: {
        total_invoiced: parseFloat(totalDebit.toFixed(2)),
        total_paid:     parseFloat(totalCredit.toFixed(2)),
        balance_due:    parseFloat((totalDebit - totalCredit).toFixed(2)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/supplier/:id/statement', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const suppId = req.params.id;

    const suppRes = await pool.request()
      .input('id',    sql.Int, suppId)
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM suppliers WHERE id = @id AND organization_id = @orgId');
    if (!suppRes.recordset.length) return res.status(404).json({ error: 'Supplier not found' });

    const stmtRes = await pool.request()
      .input('supplier_id', sql.Int, suppId)
      .input('orgId',       sql.Int, orgId)
      .query(`
        SELECT entry_date, entry_type, reference_no, description, debit, credit, sort_ts
        FROM (
          SELECT
            p.date          AS entry_date,
            'Purchase'      AS entry_type,
            p.po_no         AS reference_no,
            'Purchase Order' AS description,
            CAST(0 AS DECIMAL(18,2)) AS debit,
            p.total         AS credit,
            p.created_at    AS sort_ts
          FROM purchases p
          WHERE p.supplier_id = @supplier_id AND p.organization_id = @orgId AND p.status != 'cancelled'

          UNION ALL

          SELECT
            pp.payment_date AS entry_date,
            'Payment'       AS entry_type,
            CASE WHEN ISNULL(pp.reference_no,'') != '' THEN pp.reference_no
                 ELSE 'PAY-' + CAST(pp.id AS NVARCHAR) END AS reference_no,
            CASE WHEN ISNULL(pp.notes,'') != '' THEN pp.notes
                 ELSE 'Payment to supplier (' + pp.payment_method + ')' END AS description,
            pp.amount       AS debit,
            CAST(0 AS DECIMAL(18,2)) AS credit,
            pp.created_at   AS sort_ts
          FROM purchase_payments pp
          WHERE pp.supplier_id = @supplier_id AND pp.organization_id = @orgId
        ) combined
        ORDER BY entry_date ASC, sort_ts ASC
      `);

    let runningBalance = 0;
    const entries = stmtRes.recordset.map(row => {
      runningBalance = parseFloat((runningBalance + Number(row.credit) - Number(row.debit)).toFixed(2));
      return { ...row, running_balance: runningBalance };
    });

    const totalCredit = entries.reduce((s, r) => s + Number(r.credit), 0);
    const totalDebit  = entries.reduce((s, r) => s + Number(r.debit),  0);

    res.json({
      supplier: suppRes.recordset[0],
      entries,
      summary: {
        total_purchased: parseFloat(totalCredit.toFixed(2)),
        total_paid:      parseFloat(totalDebit.toFixed(2)),
        balance_due:     parseFloat((totalCredit - totalDebit).toFixed(2)),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/customer/:id/unpaid-invoices', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('customer_id', sql.Int, req.params.id)
      .input('orgId',       sql.Int, orgId)
      .query(`
        SELECT s.id, s.invoice_no AS ref_no, s.date, s.total,
               ISNULL(s.amount_paid, 0) AS amount_paid,
               s.total - ISNULL(s.amount_paid, 0) AS balance_due,
               s.status
        FROM sales s
        WHERE s.customer_id = @customer_id AND s.organization_id = @orgId
          AND s.status IN ('pending','partial','overdue')
          AND (s.total - ISNULL(s.amount_paid, 0)) > 0.005
        ORDER BY s.date ASC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/supplier/:id/unpaid-pos', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('supplier_id', sql.Int, req.params.id)
      .input('orgId',       sql.Int, orgId)
      .query(`
        SELECT p.id, p.po_no AS ref_no, p.date, p.total,
               ISNULL(p.amount_paid, 0) AS amount_paid,
               p.total - ISNULL(p.amount_paid, 0) AS balance_due,
               p.status
        FROM purchases p
        WHERE p.supplier_id = @supplier_id AND p.organization_id = @orgId
          AND p.status != 'cancelled'
          AND (p.total - ISNULL(p.amount_paid, 0)) > 0.005
        ORDER BY p.date ASC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
