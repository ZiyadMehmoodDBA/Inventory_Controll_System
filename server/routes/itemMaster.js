// Item master: categories + SKU/barcode lookup. Mounted before the inventory router.
const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { writeAudit }   = require('../utils/audit');
const { requireRole }  = require('../middleware/auth');
const P = require('../utils/permissions');

const canEdit = P.requirePermission('inventory.manage_items');
const cleanName = v => String(v ?? '').trim().slice(0, 100);

router.get('/categories', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const r = await (await getPool()).request()
      .input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId)
      .query(`SELECT c.id, c.name, c.parent_id,
                (SELECT COUNT(*) FROM tires t WHERE t.category_id = c.id AND t.organization_id = @orgId AND t.branch_id = @branchId) AS item_count
              FROM item_categories c WHERE c.organization_id = @orgId ORDER BY c.name`);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/categories', canEdit, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    const pool = await getPool();
    const parentId = req.body.parent_id ? Number(req.body.parent_id) : null;
    if (parentId) {
      const p = await pool.request().input('id', sql.Int, parentId).input('orgId', sql.Int, orgId)
        .query('SELECT id, parent_id FROM item_categories WHERE id = @id AND organization_id = @orgId');
      if (!p.recordset.length) return res.status(400).json({ error: 'Parent category not found' });
      if (p.recordset[0].parent_id) return res.status(400).json({ error: 'Categories can only be nested one level deep (category > sub-category)', code: 'CATEGORY_DEPTH' });
    }
    try {
      const r = await pool.request().input('orgId', sql.Int, orgId).input('name', sql.NVarChar, name).input('parent', sql.Int, parentId)
        .query('INSERT INTO item_categories (organization_id, name, parent_id) OUTPUT INSERTED.* VALUES (@orgId, @name, @parent)');
      writeAudit(pool, { orgId, branchId, userId: req.user?.userId, action: 'CREATE', entity: 'item_category', entityId: r.recordset[0].id, after: { name } });
      res.status(201).json({ ...r.recordset[0], item_count: 0 });
    } catch (e) {
      if (e.number === 2601 || e.number === 2627) return res.status(409).json({ error: `Category "${name}" already exists`, code: 'DUPLICATE_CATEGORY' });
      throw e;
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/categories/:id', canEdit, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    const pool = await getPool();
    // Re-parenting: two levels only (category > sub-category), never under itself or one of its own children.
    const movesParent = Object.prototype.hasOwnProperty.call(req.body, 'parent_id');
    const parentId = movesParent && req.body.parent_id ? Number(req.body.parent_id) : null;
    if (movesParent && parentId) {
      if (parentId === Number(req.params.id)) return res.status(400).json({ error: 'A category cannot be its own parent' });
      const chk = await pool.request().input('p', sql.Int, parentId).input('id', sql.Int, req.params.id).input('orgId', sql.Int, orgId)
        .query(`SELECT (SELECT parent_id FROM item_categories WHERE id = @p AND organization_id = @orgId) AS parent_of_parent,
                       (SELECT COUNT(*) FROM item_categories WHERE id = @p AND organization_id = @orgId) AS parent_exists,
                       (SELECT COUNT(*) FROM item_categories WHERE parent_id = @id AND organization_id = @orgId) AS children`);
      const c = chk.recordset[0];
      if (!c.parent_exists) return res.status(400).json({ error: 'Parent category not found' });
      if (c.parent_of_parent || c.children) return res.status(400).json({ error: 'Categories can only be nested one level deep (category > sub-category)', code: 'CATEGORY_DEPTH' });
    }
    try {
      const r = await pool.request().input('id', sql.Int, req.params.id).input('orgId', sql.Int, orgId).input('name', sql.NVarChar, name)
        .input('mp', sql.Bit, movesParent ? 1 : 0).input('parent', sql.Int, parentId)
        .query('UPDATE item_categories SET name = @name, parent_id = CASE WHEN @mp = 1 THEN @parent ELSE parent_id END OUTPUT INSERTED.* WHERE id = @id AND organization_id = @orgId');
      if (!r.recordset.length) return res.status(404).json({ error: 'Category not found' });
      writeAudit(pool, { orgId, branchId, userId: req.user?.userId, action: 'UPDATE', entity: 'item_category', entityId: r.recordset[0].id, after: { name } });
      res.json(r.recordset[0]);
    } catch (e) {
      if (e.number === 2601 || e.number === 2627) return res.status(409).json({ error: `Category "${name}" already exists`, code: 'DUPLICATE_CATEGORY' });
      throw e;
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/categories/:id', canEdit, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    // Refuse while any item (any branch of this org) or sub-category still uses it.
    const used = await pool.request().input('id', sql.Int, req.params.id).input('orgId', sql.Int, orgId)
      .query(`SELECT (SELECT COUNT(*) FROM tires WHERE category_id = @id AND organization_id = @orgId) AS items,
                     (SELECT COUNT(*) FROM item_categories WHERE parent_id = @id AND organization_id = @orgId) AS children`);
    const { items, children } = used.recordset[0];
    if (items || children) return res.status(409).json({ error: `Category is in use by ${items} item(s) and ${children} sub-categor${children === 1 ? 'y' : 'ies'}. Move them first.`, code: 'CATEGORY_IN_USE' });
    const r = await pool.request().input('id', sql.Int, req.params.id).input('orgId', sql.Int, orgId)
      .query('DELETE FROM item_categories OUTPUT DELETED.id, DELETED.name WHERE id = @id AND organization_id = @orgId');
    if (!r.recordset.length) return res.status(404).json({ error: 'Category not found' });
    writeAudit(pool, { orgId, branchId, userId: req.user?.userId, action: 'DELETE', entity: 'item_category', entityId: r.recordset[0].id, before: { name: r.recordset[0].name } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scanner / quick lookup: exact barcode or SKU match for the current branch.
router.get('/lookup', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const code = String(req.query.code ?? '').trim();
    if (!code) return res.status(400).json({ error: 'code is required' });
    const r = await (await getPool()).request()
      .input('orgId', sql.Int, orgId).input('branchId', sql.Int, branchId).input('code', sql.NVarChar, code)
      .query('SELECT TOP 1 * FROM tires WHERE organization_id = @orgId AND branch_id = @branchId AND is_active = 1 AND (barcode = @code OR sku = @code)');
    if (!r.recordset.length) return res.status(404).json({ error: 'No item with that barcode or SKU' });
    res.json(r.recordset[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
