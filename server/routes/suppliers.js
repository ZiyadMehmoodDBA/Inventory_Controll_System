const P = require('../utils/permissions');
const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { nextEntityCode } = require('../utils/docNumber');

router.get('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const result = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT
          s.*,
          ISNULL((SELECT SUM(p.total)   FROM purchases p          WHERE p.supplier_id  = s.id AND p.organization_id = @orgId AND p.status != 'cancelled'), 0) AS total_invoiced,
          ISNULL((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.supplier_id = s.id AND pp.organization_id = @orgId), 0) AS total_paid,
          ISNULL((SELECT SUM(p.total)   FROM purchases p          WHERE p.supplier_id  = s.id AND p.organization_id = @orgId AND p.status != 'cancelled'), 0) -
          ISNULL((SELECT SUM(pp.amount) FROM purchase_payments pp WHERE pp.supplier_id = s.id AND pp.organization_id = @orgId), 0) AS balance_due,
          ISNULL((SELECT COUNT(*)       FROM purchases p          WHERE p.supplier_id  = s.id AND p.organization_id = @orgId AND p.status != 'cancelled'), 0) AS po_count
        FROM suppliers s
        WHERE s.organization_id = @orgId
        ORDER BY balance_due DESC, s.name ASC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const result = await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM suppliers WHERE id = @id AND organization_id = @orgId');
    if (!result.recordset.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', P.requirePermission('suppliers.manage'), async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { name, phone, email, address } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const pool = await getPool();
    const code = await nextEntityCode(pool.request(), 'suppliers');
    const result = await pool.request()
      .input('orgId',   sql.Int,      orgId)
      .input('code',    sql.NVarChar, code)
      .input('name',    sql.NVarChar, name)
      .input('phone',   sql.NVarChar, phone   || '')
      .input('email',   sql.NVarChar, email   || '')
      .input('address', sql.NVarChar, address || '')
      .query(`
        INSERT INTO suppliers (organization_id, code, name, phone, email, address)
        OUTPUT INSERTED.*
        VALUES (@orgId, @code, @name, @phone, @email, @address)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', P.requirePermission('suppliers.manage'), async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { name, phone, email, address, balance } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input('id',      sql.Int,         req.params.id)
      .input('orgId',   sql.Int,         orgId)
      .input('name',    sql.NVarChar,    name)
      .input('phone',   sql.NVarChar,    phone   || '')
      .input('email',   sql.NVarChar,    email   || '')
      .input('address', sql.NVarChar,    address || '')
      .input('balance', sql.Decimal(18,2), balance || 0)
      .query(`
        UPDATE suppliers SET name=@name, phone=@phone, email=@email, address=@address, balance=@balance
        OUTPUT INSERTED.*
        WHERE id = @id AND organization_id = @orgId
      `);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', P.requirePermission('suppliers.manage'), async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const check = await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT COUNT(*) AS cnt FROM purchases WHERE supplier_id = @id AND organization_id = @orgId');
    if (check.recordset[0].cnt > 0) {
      return res.status(400).json({ error: 'Cannot delete supplier with existing purchase records.' });
    }
    await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('DELETE FROM suppliers WHERE id = @id AND organization_id = @orgId');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk', P.requirePermission('suppliers.manage'), async (req, res) => {
  const { orgId } = getContext(req);
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows provided' });
  }
  const pool = await getPool();
  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const name = String(row.name || '').trim();
      if (!name) { errors.push({ row: i + 2, message: 'Name is required' }); continue; }
      const code = await nextEntityCode(pool.request(), 'suppliers');
      await pool.request()
        .input('orgId',   sql.Int,      orgId)
        .input('code',    sql.NVarChar, code)
        .input('name',    sql.NVarChar, name)
        .input('phone',   sql.NVarChar, String(row.phone   || ''))
        .input('email',   sql.NVarChar, String(row.email   || ''))
        .input('address', sql.NVarChar, String(row.address || ''))
        .query('INSERT INTO suppliers (organization_id,code,name,phone,email,address) VALUES (@orgId,@code,@name,@phone,@email,@address)');
      inserted++;
    } catch (err) {
      errors.push({ row: i + 2, message: err.message });
    }
  }
  res.json({ inserted, errors });
});

module.exports = router;
