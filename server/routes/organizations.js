const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');

// GET /api/organizations — list all orgs (platform view)
router.get('/', async (req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request().query(`
      SELECT
        o.*,
        (SELECT COUNT(*) FROM branches b WHERE b.organization_id = o.id AND b.is_active = 1) AS branch_count,
        (SELECT COUNT(*) FROM users   u WHERE u.organization_id = o.id AND u.is_active   = 1) AS user_count
      FROM organizations o
      WHERE o.is_active = 1
      ORDER BY o.name ASC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/organizations/:id — get single org with its branches
router.get('/:id', async (req, res) => {
  try {
    const pool  = await getPool();
    const orgRes = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM organizations WHERE id = @id');
    if (!orgRes.recordset.length) return res.status(404).json({ error: 'Organization not found' });

    const branchRes = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM branches WHERE organization_id = @id AND is_active = 1 ORDER BY name');

    res.json({ ...orgRes.recordset[0], branches: branchRes.recordset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/organizations — create a new organization + first branch
router.post('/', async (req, res) => {
  try {
    const { name, type, address, phone, email, currency, branch_name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Organization name is required' });

    const pool = await getPool();

    // Auto-generate code from name
    const code = name.trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 20);

    // Ensure unique code
    const dup = await pool.request()
      .input('code', sql.NVarChar, code)
      .query('SELECT id FROM organizations WHERE code = @code');
    const finalCode = dup.recordset.length > 0 ? `${code}-${Date.now().toString().slice(-4)}` : code;

    const orgResult = await pool.request()
      .input('name',     sql.NVarChar, name.trim())
      .input('code',     sql.NVarChar, finalCode)
      .input('type',     sql.NVarChar, type     || 'retail')
      .input('address',  sql.NVarChar, address  || '')
      .input('phone',    sql.NVarChar, phone    || '')
      .input('email',    sql.NVarChar, email    || '')
      .input('currency', sql.NVarChar, currency || 'PKR')
      .query(`
        INSERT INTO organizations (name, code, type, address, phone, email, currency)
        OUTPUT INSERTED.*
        VALUES (@name, @code, @type, @address, @phone, @email, @currency)
      `);

    const org = orgResult.recordset[0];

    // Create first branch
    const firstBranchName = branch_name?.trim() || 'Main Branch';
    const branchResult = await pool.request()
      .input('org_id', sql.Int,      org.id)
      .input('name',   sql.NVarChar, firstBranchName)
      .input('code',   sql.NVarChar, 'MAIN')
      .input('address',sql.NVarChar, address || '')
      .input('phone',  sql.NVarChar, phone   || '')
      .query(`
        INSERT INTO branches (organization_id, name, code, address, phone)
        OUTPUT INSERTED.*
        VALUES (@org_id, @name, @code, @address, @phone)
      `);

    // Seed default settings for new org
    const defaultSettings = [
      ['company_name',        name.trim()],
      ['company_tagline',     'Your Tyre & Wheel Partner'],
      ['company_address',     address || ''],
      ['company_phone',       phone   || ''],
      ['company_email',       email   || ''],
      ['invoice_prefix',      'INV'],
      ['po_prefix',           'PO'],
      ['default_tax_rate',    '15'],
      ['payment_due_days',    '30'],
      ['default_sale_status', 'pending'],
      ['currency',            currency || 'PKR'],
      ['announcement',        ''],
    ];
    for (const [key, value] of defaultSettings) {
      await pool.request()
        .input('org_id', sql.Int,      org.id)
        .input('key',    sql.NVarChar, key)
        .input('value',  sql.NVarChar, value)
        .query(`INSERT INTO settings (organization_id, [key], value) VALUES (@org_id, @key, @value)`);
    }

    res.status(201).json({ org, branch: branchResult.recordset[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/organizations/:id — update org
router.put('/:id', async (req, res) => {
  try {
    const { name, type, address, phone, email, currency } = req.body || {};
    const pool = await getPool();

    const existing = await pool.request()
      .input('id', sql.Int, req.params.id)
      .query('SELECT * FROM organizations WHERE id = @id');
    if (!existing.recordset.length) return res.status(404).json({ error: 'Organization not found' });

    const row = existing.recordset[0];
    const result = await pool.request()
      .input('id',       sql.Int,      req.params.id)
      .input('name',     sql.NVarChar, name     ?? row.name)
      .input('type',     sql.NVarChar, type     ?? row.type)
      .input('address',  sql.NVarChar, address  ?? row.address)
      .input('phone',    sql.NVarChar, phone    ?? row.phone)
      .input('email',    sql.NVarChar, email    ?? row.email)
      .input('currency', sql.NVarChar, currency ?? row.currency)
      .query(`
        UPDATE organizations
        SET name = @name, type = @type, address = @address, phone = @phone, email = @email, currency = @currency
        OUTPUT INSERTED.*
        WHERE id = @id
      `);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
