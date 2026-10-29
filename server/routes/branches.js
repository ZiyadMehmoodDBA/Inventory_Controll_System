const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { invalidateBranchCache } = require('../middleware/validateBranchContext');

// GET /api/branches — list branches for the caller's org
router.get('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool   = await getPool();
    const result = await pool.request()
      .input('org_id', sql.Int, orgId)
      .query(`
        SELECT
          b.*,
          (SELECT COUNT(*) FROM sales     s WHERE s.branch_id = b.id) AS sale_count,
          (SELECT COUNT(*) FROM purchases p WHERE p.branch_id = b.id) AS po_count
        FROM branches b
        WHERE b.organization_id = @org_id AND b.is_active = 1
        ORDER BY b.name ASC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/branches/:id
router.get('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const result = await pool.request()
      .input('id',     sql.Int, req.params.id)
      .input('org_id', sql.Int, orgId)
      .query('SELECT * FROM branches WHERE id = @id AND organization_id = @org_id');
    if (!result.recordset.length) return res.status(404).json({ error: 'Branch not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/branches — create a new branch for the caller's org
router.post('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { name, code, address, phone, email } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Branch name is required' });
    if (!code?.trim()) return res.status(400).json({ error: 'Branch code is required' });

    const pool = await getPool();
    const cleanCode = code.trim().toUpperCase();

    const dup = await pool.request()
      .input('org_id', sql.Int,      orgId)
      .input('code',   sql.NVarChar, cleanCode)
      .query('SELECT id FROM branches WHERE organization_id = @org_id AND code = @code');
    if (dup.recordset.length > 0) {
      return res.status(409).json({ error: 'A branch with this code already exists in your organization' });
    }

    const result = await pool.request()
      .input('org_id',  sql.Int,      orgId)
      .input('name',    sql.NVarChar, name.trim())
      .input('code',    sql.NVarChar, cleanCode)
      .input('address', sql.NVarChar, address || '')
      .input('phone',   sql.NVarChar, phone   || '')
      .input('email',   sql.NVarChar, email   || '')
      .query(`
        INSERT INTO branches (organization_id, name, code, address, phone, email)
        OUTPUT INSERTED.*
        VALUES (@org_id, @name, @code, @address, @phone, @email)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/branches/:id — update branch
router.put('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { name, address, phone, email } = req.body || {};
    const pool = await getPool();

    const existing = await pool.request()
      .input('id',     sql.Int, req.params.id)
      .input('org_id', sql.Int, orgId)
      .query('SELECT * FROM branches WHERE id = @id AND organization_id = @org_id');
    if (!existing.recordset.length) return res.status(404).json({ error: 'Branch not found' });

    const row = existing.recordset[0];
    const result = await pool.request()
      .input('id',      sql.Int,      req.params.id)
      .input('name',    sql.NVarChar, name    ?? row.name)
      .input('address', sql.NVarChar, address ?? row.address)
      .input('phone',   sql.NVarChar, phone   ?? row.phone)
      .input('email',   sql.NVarChar, email   ?? row.email)
      .query(`
        UPDATE branches
        SET name = @name, address = @address, phone = @phone, email = @email
        OUTPUT INSERTED.*
        WHERE id = @id
      `);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/branches/:id — soft-delete (mark inactive)
router.delete('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();

    // Prevent deleting the last active branch
    const countRes = await pool.request()
      .input('org_id', sql.Int, orgId)
      .query('SELECT COUNT(*) AS cnt FROM branches WHERE organization_id = @org_id AND is_active = 1');
    if (countRes.recordset[0].cnt <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last branch — an organization must have at least one branch' });
    }

    const branchId = parseInt(req.params.id, 10);
    await pool.request()
      .input('id',     sql.Int, branchId)
      .input('org_id', sql.Int, orgId)
      .query('UPDATE branches SET is_active = 0 WHERE id = @id AND organization_id = @org_id');

    // Evict cache so org_admins can't target a deleted branch via X-Branch-ID.
    invalidateBranchCache(orgId, branchId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
