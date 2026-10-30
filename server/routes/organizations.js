const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { writeAudit }   = require('../utils/audit');
const { AppError, handleError } = require('../utils/errors');
const { v, validate }  = require('../utils/validate');
const { isPlatformAdmin, requirePlatformAdmin } = require('../utils/platform');
const { requireRole }  = require('../middleware/auth');

// An organisation's record, branches and counts belong to that organisation. Only a platform administrator sees or creates others;
// everyone else can read and (as administrator) edit their own organisation and nothing else.
const fail = (res, e) => handleError(res, e, 'organizations');
const NOT_FOUND = () => new AppError('Organization not found', 404, 'NOT_FOUND');
const idOf = req => { const n = parseInt(req.params.id, 10); if (!Number.isInteger(n) || n < 1) throw NOT_FOUND(); return n; };
const mayReach = async (req, id) => id === req.user.orgId || await isPlatformAdmin(req.user);

const FIELDS = {
  name:     v.string({ min: 1, max: 100 }),
  type:     v.string({ max: 30, optional: true, nullable: true }),
  address:  v.string({ max: 300, optional: true, nullable: true }),
  phone:    v.string({ max: 40, optional: true, nullable: true }),
  email:    v.string({ max: 120, optional: true, nullable: true }),
  currency: v.string({ min: 3, max: 3, optional: true, nullable: true }),
};
const CREATE = { ...FIELDS, branch_name: v.string({ max: 100, optional: true, nullable: true }) };
const UPDATE = { ...FIELDS, name: v.string({ min: 1, max: 100, optional: true }) };

// GET /api/organizations: every organisation for a platform administrator, only your own for anyone else
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const all = await isPlatformAdmin(req.user);
    const rq = pool.request();
    if (!all) rq.input('own', sql.Int, req.user.orgId);
    const result = await rq.query(`
      SELECT
        o.*,
        (SELECT COUNT(*) FROM branches b WHERE b.organization_id = o.id AND b.is_active = 1) AS branch_count,
        (SELECT COUNT(*) FROM users   u WHERE u.organization_id = o.id AND u.is_active   = 1) AS user_count
      FROM organizations o
      WHERE o.is_active = 1 ${all ? '' : 'AND o.id = @own'}
      ORDER BY o.name ASC
    `);
    res.json(result.recordset);
  } catch (err) { fail(res, err); }
});

// GET /api/organizations/:id: one organisation with its branches (your own, or any for a platform administrator)
router.get('/:id', async (req, res) => {
  try {
    const id = idOf(req);
    if (!(await mayReach(req, id))) throw NOT_FOUND();     // 404, not 403: do not confirm that another organisation exists
    const pool  = await getPool();
    const orgRes = await pool.request().input('id', sql.Int, id).query('SELECT * FROM organizations WHERE id = @id');
    if (!orgRes.recordset.length) throw NOT_FOUND();
    const branchRes = await pool.request().input('id', sql.Int, id).query('SELECT * FROM branches WHERE organization_id = @id AND is_active = 1 ORDER BY name');
    res.json({ ...orgRes.recordset[0], branches: branchRes.recordset });
  } catch (err) { fail(res, err); }
});

// POST /api/organizations: create an organisation and its first branch. Platform administrators only (sign-up has its own route, /auth/register).
router.post('/', requirePlatformAdmin, async (req, res) => {
  try {
    const { name, type, address, phone, email, currency, branch_name } = validate(req.body, CREATE);
    const pool = await getPool();
    const code = name.toUpperCase().replace(/[^A-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
    const dup = await pool.request().input('code', sql.NVarChar, code).query('SELECT id FROM organizations WHERE code = @code');
    const finalCode = dup.recordset.length > 0 ? `${code}-${Date.now().toString().slice(-4)}` : code;

    const tx = new sql.Transaction(pool);
    await tx.begin();
    let org, branch;
    try {
      org = (await new sql.Request(tx)
        .input('name', sql.NVarChar, name).input('code', sql.NVarChar, finalCode).input('type', sql.NVarChar, type || 'retail')
        .input('address', sql.NVarChar, address || '').input('phone', sql.NVarChar, phone || '').input('email', sql.NVarChar, email || '').input('currency', sql.NVarChar, currency || 'PKR')
        .query(`INSERT INTO organizations (name, code, type, address, phone, email, currency) OUTPUT INSERTED.* VALUES (@name, @code, @type, @address, @phone, @email, @currency)`)).recordset[0];
      branch = (await new sql.Request(tx)
        .input('org_id', sql.Int, org.id).input('name', sql.NVarChar, branch_name || 'Main Branch').input('code', sql.NVarChar, 'MAIN').input('address', sql.NVarChar, address || '').input('phone', sql.NVarChar, phone || '')
        .query(`INSERT INTO branches (organization_id, name, code, address, phone) OUTPUT INSERTED.* VALUES (@org_id, @name, @code, @address, @phone)`)).recordset[0];
      const defaultSettings = [
        ['company_name', name], ['company_tagline', 'Your Tyre & Wheel Partner'], ['company_address', address || ''], ['company_phone', phone || ''], ['company_email', email || ''],
        ['invoice_prefix', 'INV'], ['po_prefix', 'PO'], ['default_tax_rate', '15'], ['payment_due_days', '30'], ['default_sale_status', 'pending'], ['currency', currency || 'PKR'], ['announcement', ''],
      ];
      for (const [key, value] of defaultSettings) {
        await new sql.Request(tx).input('org_id', sql.Int, org.id).input('key', sql.NVarChar, key).input('value', sql.NVarChar, value)
          .query('INSERT INTO settings (organization_id, [key], value) VALUES (@org_id, @key, @value)');
      }
      await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch { /* already rolled back */ } throw e; }
    writeAudit(pool, { orgId: req.user.orgId, branchId: getContext(req).branchId, userId: req.user.userId, action: 'CREATE', entity: 'organization', entityId: org.id, before: null, after: { id: org.id, name: org.name, code: org.code } });
    res.status(201).json({ org, branch });
  } catch (err) { fail(res, err); }
});

// PUT /api/organizations/:id: an administrator edits their own organisation (never another one)
router.put('/:id', requireRole('org_admin'), async (req, res) => {
  try {
    const id = idOf(req);
    if (id !== req.user.orgId) throw NOT_FOUND();
    const b = validate(req.body, UPDATE);
    const pool = await getPool();
    const existing = await pool.request().input('id', sql.Int, id).query('SELECT * FROM organizations WHERE id = @id');
    if (!existing.recordset.length) throw NOT_FOUND();
    const row = existing.recordset[0];
    const result = await pool.request()
      .input('id', sql.Int, id)
      .input('name', sql.NVarChar, b.name ?? row.name).input('type', sql.NVarChar, b.type ?? row.type).input('address', sql.NVarChar, b.address ?? row.address)
      .input('phone', sql.NVarChar, b.phone ?? row.phone).input('email', sql.NVarChar, b.email ?? row.email).input('currency', sql.NVarChar, b.currency ?? row.currency)
      .query(`UPDATE organizations SET name = @name, type = @type, address = @address, phone = @phone, email = @email, currency = @currency OUTPUT INSERTED.* WHERE id = @id`);
    writeAudit(pool, { orgId: id, branchId: getContext(req).branchId, userId: req.user.userId, action: 'UPDATE', entity: 'organization', entityId: id,
      before: { name: row.name, type: row.type, currency: row.currency }, after: { name: result.recordset[0].name, type: result.recordset[0].type, currency: result.recordset[0].currency } });
    res.json(result.recordset[0]);
  } catch (err) { fail(res, err); }
});

module.exports = router;
