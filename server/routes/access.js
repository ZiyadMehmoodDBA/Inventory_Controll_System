// Roles and permissions: what the signed-in user may do, and (for administrators) the role definitions.
const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { writeAudit }   = require('../utils/audit');
const P = require('../utils/permissions');
const { AppError, handleError } = require('../utils/errors');
const { v, validate } = require('../utils/validate');
const A = require('../utils/stock');

const actorBranch = req => req.user.branchId ?? 1;
const fail = (res, err) => handleError(res, err, 'access');
const bad = (message, status = 400, code = 'INVALID_REQUEST') => new AppError(message, status, code);

// The signed-in user: role, permissions and approval limit (what the screens use to show or hide actions).
router.get('/me', (req, res) => {
  res.json({ role: req.user.role, role_name: req.user.roleName, permissions: req.user.role === 'org_admin' ? P.ALL : [...req.user.perms], approval_limit: req.user.approvalLimit ?? null });
});

const manage = P.requirePermission('roles.manage', 'users.manage');
const manageRoles = P.requirePermission('roles.manage');

router.get('/permissions', manage, (req, res) => res.json({ permissions: P.PERMISSIONS, base_roles: P.BASE_ROLES.filter(r => !P.BUILTIN[r].hidden).map(k => ({ key: k, name: P.BUILTIN[k].name })) }));

async function listRoles(orgId) {
  await P.ensureRoles(orgId);
  const pool = await getPool();
  const r = await pool.request().input('o', sql.Int, orgId).query(`
    SELECT r.id, r.name, r.base_role, r.description, r.permissions, r.approval_limit, r.is_builtin,
           (SELECT COUNT(*) FROM users u WHERE u.organization_id = r.organization_id AND u.is_active = 1
              AND ((u.access_role_id = r.id) OR (r.is_builtin = 1 AND u.access_role_id IS NULL AND u.role = r.base_role))) AS users
    FROM access_roles r WHERE r.organization_id = @o ORDER BY r.is_builtin DESC, r.id`);
  return r.recordset.filter(x => !(x.is_builtin && P.BUILTIN[x.base_role]?.hidden)).map(x => ({
    ...x, is_builtin: !!x.is_builtin, locked: x.base_role === 'org_admin' && !!x.is_builtin,
    permissions: x.base_role === 'org_admin' && x.is_builtin ? P.ALL : P.clean(JSON.parse(x.permissions || '[]')),
    approval_limit: x.approval_limit == null ? null : Number(x.approval_limit),
  }));
}

router.get('/roles', manage, async (req, res) => {
  try { res.json(await listRoles(getContext(req).orgId)); } catch (err) { fail(res, err); }
});

// A role editor may not hand out more than they hold themselves (an administrator holds everything).
function assertSubset(req, perms) {
  if (req.user.role === 'org_admin') return;
  const over = perms.filter(c => !req.user.perms.has(c));
  if (over.length) throw bad(`You cannot grant permissions you do not hold: ${over.join(', ')}`, 403, 'ESCALATION');
}
// The contract of the role endpoints. Unknown permission codes are dropped by P.clean (a role can only ever hold catalogue permissions).
const ROLE_BODY = {
  name:           v.string({ min: 1, max: 80, optional: true }),
  description:    v.string({ max: 300, optional: true, nullable: true }),
  permissions:    v.array(v.string({ max: 60 }), { max: 200, optional: true }),
  approval_limit: v.number({ min: 0, max: 1e10, optional: true, nullable: true, emptyIsNull: true }),
  base_role:      v.string({ max: 30, optional: true }),
};
function readBody(req, { creating }) {
  const b = validate(req.body, ROLE_BODY);
  if (creating && !b.name) throw new AppError('A role name is required', 400, 'VALIDATION_FAILED', { fields: { name: 'A role name is required' } });
  return { name: b.name ?? '', description: b.description ?? null, perms: P.clean(b.permissions), hasPerms: b.permissions !== undefined, limit: b.approval_limit ?? null, hasLimit: b.approval_limit !== undefined, base: b.base_role };
}
const dupName = e => /UX_access_roles_name|duplicate key/i.test(e.message);

router.post('/roles', manageRoles, async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const b = readBody(req, { creating: true });
    if (!['branch_manager', 'staff', 'purchasing'].includes(b.base)) throw bad('Base role must be manager, warehouse staff or purchasing');
    assertSubset(req, b.perms);
    await P.ensureRoles(orgId);
    const pool = await getPool();
    let r;
    try {
      r = await pool.request().input('o', sql.Int, orgId).input('n', sql.NVarChar(80), b.name).input('b', sql.NVarChar(30), b.base).input('d', sql.NVarChar(300), b.description)
        .input('p', sql.NVarChar(sql.MAX), JSON.stringify(b.perms)).input('l', sql.Decimal(14, 2), b.limit)
        .query('INSERT INTO access_roles (organization_id, name, base_role, description, permissions, approval_limit, is_builtin) OUTPUT INSERTED.id VALUES (@o, @n, @b, @d, @p, @l, 0)');
    } catch (e) { if (dupName(e)) throw bad('A role with this name already exists', 409, 'DUPLICATE'); throw e; }
    const id = r.recordset[0].id;
    writeAudit(pool, { orgId, branchId: actorBranch(req), userId: req.user.userId, action: 'CREATE', entity: 'access_role', entityId: id, before: null, after: { name: b.name, base_role: b.base, permissions: b.perms, approval_limit: b.limit } });
    res.status(201).json((await listRoles(orgId)).find(x => x.id === id));
  } catch (err) { fail(res, err); }
});

async function loadRole(orgId, id) {
  const pool = await getPool();
  const row = (await pool.request().input('o', sql.Int, orgId).input('i', sql.Int, id).query('SELECT * FROM access_roles WHERE id = @i AND organization_id = @o')).recordset[0];
  if (!row) throw bad('Role not found', 404, 'NOT_FOUND');
  return row;
}

router.put('/roles/:id', manageRoles, async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = parseInt(req.params.id, 10);
    const row = await loadRole(orgId, id);
    if (row.is_builtin && row.base_role === 'org_admin') throw bad('The administrator role always has every permission and cannot be changed', 403, 'LOCKED');
    const b = readBody(req, { creating: false });
    if (req.user.role !== 'org_admin' && (req.user.accessRoleId === id || (row.is_builtin && row.base_role === req.user.role && req.user.accessRoleId == null))) throw bad('You cannot change your own role', 403, 'SELF_CHANGE');
    const before = { name: row.name, permissions: P.clean(JSON.parse(row.permissions || '[]')), approval_limit: row.approval_limit == null ? null : Number(row.approval_limit) };
    const perms = b.hasPerms ? b.perms : before.permissions;
    // Taking permissions away is always allowed; adding some is limited to what the editor holds.
    assertSubset(req, perms.filter(c => !before.permissions.includes(c)));
    const name = row.is_builtin ? row.name : (b.name || row.name);
    const pool = await getPool();
    try {
      await pool.request().input('i', sql.Int, id).input('n', sql.NVarChar(80), name).input('d', sql.NVarChar(300), b.description ?? row.description)
        .input('p', sql.NVarChar(sql.MAX), JSON.stringify(perms)).input('l', sql.Decimal(14, 2), b.hasLimit ? b.limit : before.approval_limit)
        .query('UPDATE access_roles SET name = @n, description = @d, permissions = @p, approval_limit = @l, updated_at = GETDATE() WHERE id = @i');
    } catch (e) { if (dupName(e)) throw bad('A role with this name already exists', 409, 'DUPLICATE'); throw e; }
    P.clearCache();
    writeAudit(pool, { orgId, branchId: actorBranch(req), userId: req.user.userId, action: 'UPDATE', entity: 'access_role', entityId: id, before, after: { name, permissions: perms, approval_limit: b.hasLimit ? b.limit : before.approval_limit } });
    res.json((await listRoles(orgId)).find(x => x.id === id));
  } catch (err) { fail(res, err); }
});

router.post('/roles/:id/reset', manageRoles, async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = parseInt(req.params.id, 10);
    const row = await loadRole(orgId, id);
    if (!row.is_builtin || row.base_role === 'org_admin') throw bad('Only a built-in role can be reset to its defaults', 400);
    const perms = P.defaultsFor(row.base_role);
    assertSubset(req, perms.filter(c => !JSON.parse(row.permissions || '[]').includes(c)));
    const pool = await getPool();
    await pool.request().input('i', sql.Int, id).input('p', sql.NVarChar(sql.MAX), JSON.stringify(perms)).query('UPDATE access_roles SET permissions = @p, approval_limit = NULL, updated_at = GETDATE() WHERE id = @i');
    P.clearCache();
    writeAudit(pool, { orgId, branchId: actorBranch(req), userId: req.user.userId, action: 'UPDATE', entity: 'access_role', entityId: id, before: { permissions: JSON.parse(row.permissions || '[]') }, after: { permissions: perms, reset: true } });
    res.json((await listRoles(orgId)).find(x => x.id === id));
  } catch (err) { fail(res, err); }
});

router.delete('/roles/:id', manageRoles, async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = parseInt(req.params.id, 10);
    const row = await loadRole(orgId, id);
    if (row.is_builtin) throw bad('Built-in roles cannot be deleted', 400, 'BUILTIN');
    const pool = await getPool();
    const n = (await pool.request().input('i', sql.Int, id).query('SELECT COUNT(*) AS n FROM users WHERE access_role_id = @i')).recordset[0].n;
    if (n > 0) throw bad(`${n} user(s) still have this role. Give them another role first.`, 409, 'IN_USE');
    await pool.request().input('i', sql.Int, id).query('DELETE FROM access_roles WHERE id = @i');
    P.clearCache();
    writeAudit(pool, { orgId, branchId: actorBranch(req), userId: req.user.userId, action: 'DELETE', entity: 'access_role', entityId: id, before: { name: row.name }, after: null });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// Restricted adjustment reasons: only an authority with "approve restricted adjustments" may post or approve these.
router.get('/policy', manage, async (req, res) => {
  try {
    const pool = await getPool();
    res.json({ restricted_reasons: await P.restrictedReasons(pool, getContext(req).orgId),
      reasons: Object.entries(A.ADJUSTMENT_REASONS).filter(([, v]) => v.direction !== 'in').map(([code, v]) => ({ code, label: v.label })) });
  } catch (err) { fail(res, err); }
});
router.put('/policy', manageRoles, async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const list = validate(req.body, { restricted_reasons: v.array(v.string({ max: 40 }), { max: 50, unique: true }) }).restricted_reasons;
    const unknown = list.filter(c => !Object.prototype.hasOwnProperty.call(A.ADJUSTMENT_REASONS, c));
    if (unknown.length) throw bad(`Unknown reason: ${unknown[0]}`);
    const pool = await getPool();
    await pool.request().input('o', sql.Int, orgId).input('v', sql.NVarChar(500), list.join(','))
      .query(`IF EXISTS (SELECT 1 FROM settings WHERE organization_id = @o AND [key] = 'restricted_adjustment_reasons') UPDATE settings SET value = @v WHERE organization_id = @o AND [key] = 'restricted_adjustment_reasons'
              ELSE INSERT INTO settings (organization_id, [key], value) VALUES (@o, 'restricted_adjustment_reasons', @v)`);
    writeAudit(pool, { orgId, branchId: actorBranch(req), userId: req.user.userId, action: 'UPDATE', entity: 'access_policy', entityId: 0, before: null, after: { restricted_reasons: list } });
    res.json({ restricted_reasons: list });
  } catch (err) { fail(res, err); }
});

module.exports = router;
