const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { writeAudit }   = require('../utils/audit');
const P = require('../utils/permissions');
const { AppError, handleError } = require('../utils/errors');
const { v, validate } = require('../utils/validate');

// User management needs the "manage users" permission (administrators by default).
router.use(P.requirePermission('users.manage'));

const VALID_ROLES = ['org_admin', 'branch_manager', 'staff', 'purchasing'];
const err = (message, status = 400, code = 'INVALID_REQUEST') => new AppError(message, status, code);
const fail = (res, e) => handleError(res, e, 'users');

// The contracts of the user endpoints (shared by create and update; create adds email and password).
const USER_BODY = {
  name:           v.string({ min: 1, max: 100 }),
  phone:          v.string({ max: 50, optional: true, nullable: true }),
  role:           v.string({ max: 30, optional: true }),
  access_role_id: v.int({ min: 1, optional: true, nullable: true, emptyIsNull: true }),
  branch_id:      v.int({ min: 1, optional: true, nullable: true, emptyIsNull: true }),
};
const CREATE_BODY = { ...USER_BODY,
  email:    v.string({ min: 3, max: 100, pattern: /^[^\s@]+@[^\s@]+$/ }),
  password: v.string({ min: 8, max: 200, trim: false }),
};
const audit = (req, action, id, before, after) => getPool().then(pool => writeAudit(pool, { orgId: req.user.orgId, branchId: req.user.branchId ?? 1, userId: req.user.userId, action, entity: 'user', entityId: id, before, after })).catch(() => {});

/**
 * Which role a request asks for: access_role_id (a role of this organisation, built-in or custom) or a plain base role.
 * Returns the base role to store in users.role and the custom role id (null for a built-in role).
 * Only an administrator may hand out the administrator role, and nobody may hand out more than they hold.
 */
async function resolveRole(req, orgId, { role, access_role_id }) {
  const pool = await getPool();
  let base = role, custom = null, perms;
  if (access_role_id !== undefined && access_role_id !== null && access_role_id !== '') {
    await P.ensureRoles(orgId);
    const r = (await pool.request().input('o', sql.Int, orgId).input('i', sql.Int, parseInt(access_role_id, 10)).query('SELECT id, base_role, permissions, is_builtin FROM access_roles WHERE id = @i AND organization_id = @o')).recordset[0];
    if (!r || (r.is_builtin && P.BUILTIN[r.base_role]?.hidden)) throw err('Role not found', 404, 'NOT_FOUND');
    base = r.base_role; custom = r.is_builtin ? null : r.id;
    perms = base === 'org_admin' ? P.ALL : P.clean(JSON.parse(r.permissions || '[]'));
  } else {
    if (!VALID_ROLES.includes(base)) throw err(`Role must be one of: ${VALID_ROLES.join(', ')}`);
    perms = base === 'org_admin' ? P.ALL : P.defaultsFor(base);
  }
  if (req.user.role !== 'org_admin') {
    if (base === 'org_admin') throw err('Only an administrator can give the administrator role', 403, 'ESCALATION');
    const over = perms.filter(c => !req.user.perms.has(c));
    if (over.length) throw err(`You cannot assign a role with permissions you do not hold: ${over.join(', ')}`, 403, 'ESCALATION');
  }
  return { base, custom };
}

// A user who is not an administrator may not change an administrator's account.
async function assertMayChange(req, orgId, id) {
  const pool = await getPool();
  const t = (await pool.request().input('i', sql.Int, id).input('o', sql.Int, orgId).query('SELECT id, role, access_role_id, is_active FROM users WHERE id = @i AND organization_id = @o')).recordset[0];
  if (!t) throw err('User not found', 404, 'NOT_FOUND');
  if (t.role === 'org_admin' && req.user.role !== 'org_admin') throw err('Only an administrator can change an administrator account', 403, 'ESCALATION');
  return t;
}

// The last active administrator can never be demoted or deactivated: the organisation would be locked out.
async function assertNotLastAdmin(orgId, id) {
  const pool = await getPool();
  const n = (await pool.request().input('o', sql.Int, orgId).input('i', sql.Int, id).query("SELECT COUNT(*) AS n FROM users WHERE organization_id = @o AND role = 'org_admin' AND is_active = 1 AND id <> @i")).recordset[0].n;
  if (n === 0) throw err('This is the only active administrator. Make another user an administrator first.', 409, 'LAST_ADMIN');
}

// GET /api/users — list all users in this organisation
router.get('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const result = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT u.id, u.name, u.email, u.phone, u.role, u.access_role_id, ar.name AS custom_role_name,
               u.branch_id, b.name AS branch_name,
               u.is_active, u.created_at
        FROM users u
        LEFT JOIN branches b ON b.id = u.branch_id
        LEFT JOIN access_roles ar ON ar.id = u.access_role_id
        WHERE u.organization_id = @orgId AND u.role <> 'demo'
        ORDER BY u.name
      `);
    res.json(result.recordset.map(u => ({ ...u, role_name: u.custom_role_name ?? P.BUILTIN[u.role]?.name ?? u.role })));
  } catch (e) { fail(res, e); }
});

// POST /api/users — create a new staff account in this org
router.post('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { name, email, phone, password, role, branch_id, access_role_id } = validate(req.body, CREATE_BODY);
    const picked = await resolveRole(req, orgId, { role, access_role_id });

    const pool = await getPool();
    if (branch_id) {
      const okBranch = (await pool.request().input('b', sql.Int, parseInt(branch_id, 10)).input('o', sql.Int, orgId).query('SELECT 1 AS ok FROM branches WHERE id = @b AND organization_id = @o')).recordset.length;
      if (!okBranch) return res.status(400).json({ error: 'Branch not found' });
    }

    // Global email uniqueness check (users are unique by email across all orgs)
    const dup = await pool.request()
      .input('email', sql.NVarChar, email.toLowerCase().trim())
      .query('SELECT id FROM users WHERE email = @email');
    if (dup.recordset.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.request()
      .input('orgId',    sql.Int,      orgId)
      .input('name',     sql.NVarChar, name.trim())
      .input('email',    sql.NVarChar, email.toLowerCase().trim())
      .input('phone',    sql.NVarChar, phone?.trim() || '')
      .input('hash',     sql.NVarChar, hash)
      .input('role',     sql.NVarChar, picked.base)
      .input('arole',    sql.Int,      picked.custom)
      .input('branchId', sql.Int,      branch_id || null)
      .query(`
        INSERT INTO users (organization_id, name, email, phone, password_hash, role, access_role_id, branch_id, is_active)
        OUTPUT INSERTED.id, INSERTED.name, INSERTED.email, INSERTED.phone,
               INSERTED.role, INSERTED.access_role_id, INSERTED.branch_id, INSERTED.is_active, INSERTED.created_at
        VALUES (@orgId, @name, @email, @phone, @hash, @role, @arole, @branchId, 1)
      `);
    audit(req, 'CREATE', result.recordset[0].id, null, { email: result.recordset[0].email, role: picked.base, access_role_id: picked.custom });
    res.status(201).json(result.recordset[0]);
  } catch (e) { fail(res, e); }
});

// PUT /api/users/:id — update name, phone, role, branch (not password)
router.put('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = parseInt(req.params.id, 10);
    const { name, phone, role, branch_id, access_role_id } = validate(req.body, USER_BODY);
    const target = await assertMayChange(req, orgId, id);
    const picked = await resolveRole(req, orgId, { role, access_role_id });

    // Prevent an admin from demoting their own account (to avoid lockout)
    if (id === req.user.userId && (picked.base !== req.user.role || picked.custom !== (req.user.accessRoleId ?? null))) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }
    if (target.role === 'org_admin' && picked.base !== 'org_admin') await assertNotLastAdmin(orgId, id);

    const pool = await getPool();
    const result = await pool.request()
      .input('id',       sql.Int,      id)
      .input('orgId',    sql.Int,      orgId)
      .input('name',     sql.NVarChar, name.trim())
      .input('phone',    sql.NVarChar, phone?.trim() || '')
      .input('role',     sql.NVarChar, picked.base)
      .input('arole',    sql.Int,      picked.custom)
      .input('branchId', sql.Int,      branch_id || null)
      .query(`
        UPDATE users
        SET name=@name, phone=@phone, role=@role, access_role_id=@arole, branch_id=@branchId
        OUTPUT INSERTED.id, INSERTED.name, INSERTED.email, INSERTED.phone,
               INSERTED.role, INSERTED.access_role_id, INSERTED.branch_id, INSERTED.is_active
        WHERE id=@id AND organization_id=@orgId
      `);
    if (!result.recordset.length) return res.status(404).json({ error: 'User not found' });
    P.clearCache();
    audit(req, 'UPDATE', id, { role: target.role, access_role_id: target.access_role_id }, { role: picked.base, access_role_id: picked.custom, branch_id: branch_id || null });
    res.json(result.recordset[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /api/users/:id/password — admin resets another user's password
router.patch('/:id/password', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { password } = req.body;
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    // Admins may not reset their own password via this endpoint (use login flow)
    if (Number(req.params.id) === req.user.userId) {
      return res.status(400).json({ error: 'Use the account settings to change your own password' });
    }
    await assertMayChange(req, orgId, parseInt(req.params.id, 10));
    const pool = await getPool();
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.request()
      .input('id',    sql.Int,      req.params.id)
      .input('orgId', sql.Int,      orgId)
      .input('hash',  sql.NVarChar, hash)
      .query(`UPDATE users SET password_hash=@hash OUTPUT INSERTED.id WHERE id=@id AND organization_id=@orgId`);
    if (!result.recordset.length) return res.status(404).json({ error: 'User not found' });
    audit(req, 'UPDATE', parseInt(req.params.id, 10), null, { password_reset: true });
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// PATCH /api/users/:id/status — activate or deactivate
router.patch('/:id/status', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = parseInt(req.params.id, 10);
    const is_active = req.body.is_active !== false;   // default true

    if (id === req.user.userId && !is_active) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }
    const target = await assertMayChange(req, orgId, id);
    if (!is_active && target.role === 'org_admin') await assertNotLastAdmin(orgId, id);

    const pool = await getPool();
    const result = await pool.request()
      .input('id',       sql.Int, id)
      .input('orgId',    sql.Int, orgId)
      .input('isActive', sql.Bit, is_active ? 1 : 0)
      .query(`
        UPDATE users SET is_active=@isActive
        OUTPUT INSERTED.id, INSERTED.is_active
        WHERE id=@id AND organization_id=@orgId
      `);
    if (!result.recordset.length) return res.status(404).json({ error: 'User not found' });
    P.clearCache();
    audit(req, 'UPDATE', id, { is_active: !!target.is_active }, { is_active });
    res.json(result.recordset[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
