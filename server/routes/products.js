const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { writeAudit }   = require('../utils/audit');

router.get('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM products WHERE organization_id = @orgId ORDER BY category, name');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { code, name, description, category, unit, cost_price, sale_price, is_active } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const pool   = await getPool();
    const result = await pool.request()
      .input('orgId',       sql.Int,          orgId)
      .input('code',        sql.NVarChar,     code?.trim()        || null)
      .input('name',        sql.NVarChar,     name.trim())
      .input('description', sql.NVarChar,     description?.trim() || '')
      .input('category',    sql.NVarChar,     category?.trim()    || '')
      .input('unit',        sql.NVarChar,     unit?.trim()        || 'pcs')
      .input('cost_price',  sql.Decimal(18,2), Number(cost_price) || 0)
      .input('sale_price',  sql.Decimal(18,2), Number(sale_price) || 0)
      .input('is_active',   sql.Bit,           is_active !== false ? 1 : 0)
      .query(`
        INSERT INTO products (organization_id, code, name, description, category, unit, cost_price, sale_price, is_active)
        OUTPUT INSERTED.*
        VALUES (@orgId, @code, @name, @description, @category, @unit, @cost_price, @sale_price, @is_active)
      `);
    const row = result.recordset[0];
    writeAudit(pool, { orgId, branchId: 1, userId: req.user?.userId,
      action: 'CREATE', entity: 'products', entityId: row.id,
      before: null, after: { id: row.id, name: row.name, category: row.category, sale_price: row.sale_price, is_active: row.is_active },
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { code, name, description, category, unit, cost_price, sale_price, is_active } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const pool = await getPool();

    // Capture before for audit
    const beforeRes = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT id, name, category, sale_price, cost_price, is_active FROM products WHERE id = @id');
    const beforeRow = beforeRes.recordset[0] || null;

    const result = await pool.request()
      .input('id',          sql.Int,           req.params.id)
      .input('orgId',       sql.Int,           orgId)
      .input('code',        sql.NVarChar,     code?.trim()        || null)
      .input('name',        sql.NVarChar,     name.trim())
      .input('description', sql.NVarChar,     description?.trim() || '')
      .input('category',    sql.NVarChar,     category?.trim()    || '')
      .input('unit',        sql.NVarChar,     unit?.trim()        || 'pcs')
      .input('cost_price',  sql.Decimal(18,2), Number(cost_price) || 0)
      .input('sale_price',  sql.Decimal(18,2), Number(sale_price) || 0)
      .input('is_active',   sql.Bit,           is_active !== false ? 1 : 0)
      .query(`
        UPDATE products
        SET code=@code, name=@name, description=@description, category=@category,
            unit=@unit, cost_price=@cost_price, sale_price=@sale_price, is_active=@is_active
        OUTPUT INSERTED.*
        WHERE id = @id AND organization_id = @orgId
      `);
    if (!result.recordset.length) return res.status(404).json({ error: 'Not found' });
    const row = result.recordset[0];
    if (beforeRow) {
      writeAudit(pool, { orgId, branchId: 1, userId: req.user?.userId,
        action: 'UPDATE', entity: 'products', entityId: row.id,
        before: { id: beforeRow.id, name: beforeRow.name, category: beforeRow.category, sale_price: beforeRow.sale_price, cost_price: beforeRow.cost_price, is_active: beforeRow.is_active },
        after:  { id: row.id,       name: row.name,       category: row.category,       sale_price: row.sale_price,       cost_price: row.cost_price,       is_active: row.is_active },
      });
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();

    // Capture before deletion for audit
    const beforeRes = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT id, name, category, sale_price, is_active FROM products WHERE id = @id');
    const beforeRow = beforeRes.recordset[0] || null;

    const usedRes = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query(`
        SELECT COUNT(*) AS cnt FROM (
          SELECT product_id FROM sale_items     WHERE product_id = @id
          UNION ALL
          SELECT product_id FROM purchase_items WHERE product_id = @id
        ) x
      `);
    if (usedRes.recordset[0].cnt > 0) {
      return res.status(409).json({ error: 'Cannot delete — product is used in existing transactions. Deactivate it instead.' });
    }
    await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('DELETE FROM products WHERE id = @id AND organization_id = @orgId');

    writeAudit(pool, { orgId, branchId: 1, userId: req.user?.userId,
      action: 'DELETE', entity: 'products', entityId: Number(req.params.id),
      before: beforeRow, after: null,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
