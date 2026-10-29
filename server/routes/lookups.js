const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { getBusinessType } = require('../utils/businessTypes');

router.get('/tire-types', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM tire_types WHERE organization_id = @orgId ORDER BY sort_order, name');
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/tire-types', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });
    const pool = await getPool();

    const dup = await pool.request()
      .input('orgId', sql.Int,      orgId)
      .input('name',  sql.NVarChar, name.trim())
      .query('SELECT COUNT(*) AS cnt FROM tire_types WHERE LOWER(name) = LOWER(@name) AND organization_id = @orgId');
    if (dup.recordset[0].cnt > 0) {
      return res.status(400).json({ error: 'A tire type with this name already exists' });
    }

    const maxOrder = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query('SELECT ISNULL(MAX(sort_order), -1) AS mx FROM tire_types WHERE organization_id = @orgId');

    const result = await pool.request()
      .input('orgId',      sql.Int,      orgId)
      .input('name',       sql.NVarChar, name.trim())
      .input('sort_order', sql.Int,      maxOrder.recordset[0].mx + 1)
      .query(`
        INSERT INTO tire_types (organization_id, name, sort_order)
        OUTPUT INSERTED.*
        VALUES (@orgId, @name, @sort_order)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/tire-types/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { name, sort_order } = req.body;
    const pool = await getPool();

    if (name) {
      const dup = await pool.request()
        .input('orgId', sql.Int,      orgId)
        .input('name',  sql.NVarChar, name.trim())
        .input('id',    sql.Int,      req.params.id)
        .query('SELECT COUNT(*) AS cnt FROM tire_types WHERE LOWER(name) = LOWER(@name) AND organization_id = @orgId AND id <> @id');
      if (dup.recordset[0].cnt > 0) {
        return res.status(400).json({ error: 'A tire type with this name already exists' });
      }
    }

    const current = await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM tire_types WHERE id = @id AND organization_id = @orgId');
    if (!current.recordset.length) return res.status(404).json({ error: 'Not found' });

    const row    = current.recordset[0];
    const result = await pool.request()
      .input('id',         sql.Int,      req.params.id)
      .input('name',       sql.NVarChar, name?.trim() ?? row.name)
      .input('sort_order', sql.Int,      sort_order   ?? row.sort_order)
      .query(`UPDATE tire_types SET name = @name, sort_order = @sort_order OUTPUT INSERTED.* WHERE id = @id`);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/tire-types/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const check = await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT COUNT(*) AS cnt FROM tires t
        INNER JOIN tire_types tt ON t.type = tt.name
        WHERE tt.id = @id AND tt.organization_id = @orgId
      `);
    if (check.recordset[0].cnt > 0) {
      return res.status(400).json({ error: `Cannot delete — ${check.recordset[0].cnt} tire(s) use this type.` });
    }
    await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('DELETE FROM tire_types WHERE id = @id AND organization_id = @orgId');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tire-suggestions', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    // The tyre catalog (brands/models/sizes of tyres) only feeds tyre shops. Every other business sees
    // suggestions built from its own items, so a perfume shop never gets tyre brands.
    const useCatalog = (await getBusinessType(orgId)) === 'tyre_shop';

    const [brands, models, sizes, patterns, load_indexes] = await Promise.all([
      pool.request()
        .input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId)
        .query(`
          SELECT DISTINCT brand FROM tires
            WHERE organization_id=@orgId AND branch_id=@branchId AND brand IS NOT NULL AND brand<>''
          ${useCatalog ? `UNION
          SELECT brand FROM tire_catalog WHERE brand IS NOT NULL AND brand<>''` : ''}
          ORDER BY brand
        `),
      pool.request()
        .input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId)
        .query(`
          SELECT DISTINCT brand, model FROM tires
            WHERE organization_id=@orgId AND branch_id=@branchId AND model IS NOT NULL AND model<>''
          ${useCatalog ? `UNION
          SELECT brand, model FROM tire_catalog WHERE model IS NOT NULL AND model<>''` : ''}
          ORDER BY brand, model
        `),
      pool.request()
        .input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId)
        .query(`
          SELECT DISTINCT brand, model, size FROM tires
            WHERE organization_id=@orgId AND branch_id=@branchId AND size IS NOT NULL AND size<>''
          ${useCatalog ? `UNION
          SELECT brand, model, size FROM tire_catalog WHERE size IS NOT NULL AND size<>''` : ''}
          ORDER BY brand, model, size
        `),
      pool.request()
        .input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId)
        .query(`
          SELECT DISTINCT pattern FROM tires
            WHERE organization_id=@orgId AND branch_id=@branchId AND pattern IS NOT NULL AND pattern<>''
          ${useCatalog ? `UNION
          SELECT pattern FROM tire_catalog WHERE pattern IS NOT NULL AND pattern<>''` : ''}
          ORDER BY pattern
        `),
      pool.request()
        .input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId)
        .query(`
          SELECT DISTINCT load_index FROM tires
            WHERE organization_id=@orgId AND branch_id=@branchId AND load_index IS NOT NULL AND load_index<>''
          ${useCatalog ? `UNION
          SELECT load_index FROM tire_catalog WHERE load_index IS NOT NULL AND load_index<>''` : ''}
          ORDER BY load_index
        `),
    ]);

    res.json({
      brands:       brands.recordset.map(r => r.brand),
      models:       models.recordset.map(r => ({ brand: r.brand, model: r.model })),
      sizes:        sizes.recordset.map(r => ({ brand: r.brand, model: r.model, size: r.size })),
      patterns:     patterns.recordset.map(r => r.pattern),
      load_indexes: load_indexes.recordset.map(r => r.load_index),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
