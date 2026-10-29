// Configurable role-based access. A user has a base role (users.role: org_admin / branch_manager / staff / purchasing / demo) and optionally a
// custom role (users.access_role_id). Each organisation has one access_roles row per built-in role (editable) plus any custom roles; a role
// row holds its permission list and an optional approval limit (the largest adjustment value it may approve or post without a higher authority).
// The effective permissions are read from the database on every request (cached for a few seconds), never from the login token, so a change
// of role, or a deactivation, takes effect immediately.
const { getPool, sql } = require('../db');

// code -> [group, label, description]. `sensitive` permissions are never granted by default to staff roles and are logged when denied.
const CATALOGUE = [
  // Product master and stock information
  ['inventory.view',          'Products and stock', 'View products and stock', 'See items, stock levels, locations and positions.'],
  ['inventory.view_cost',     'Products and stock', 'See costs', 'See cost prices and unit costs on items, batches and documents.', true],
  ['inventory.manage_items',  'Products and stock', 'Manage product master data', 'Create and edit items, categories, units, barcodes and import catalogues.'],
  ['inventory.delete_items',  'Products and stock', 'Delete products', 'Delete items from the product master.', true],
  // Stock operations
  ['stock.receive',           'Stock operations', 'Record receipts', 'Receive goods against purchase orders and confirm incoming transfers.'],
  ['stock.transfer',          'Stock operations', 'Transfer stock', 'Move stock between locations of the branch.'],
  ['stock.transfer_branch',   'Stock operations', 'Transfer to other branches', 'Send stock to another branch and settle shortages.', true],
  ['stock.count',             'Stock operations', 'Record stock counts', 'Open counts and enter counted quantities.'],
  ['stock.count_approve',     'Stock operations', 'Approve stock counts', 'Post count variances directly, within the approval limit. Without it, a completed count raises adjustment requests for approval.'],
  ['stock.reserve',           'Stock operations', 'Reserve stock', 'Hold stock for customers and release holds made by others.'],
  ['stock.adjust_request',    'Stock operations', 'Request adjustments', 'Submit stock adjustments and report discrepancies for approval.'],
  ['stock.adjust_direct',     'Stock operations', 'Post adjustments directly', 'Post adjustments without a second approval, up to the approval limit.'],
  ['stock.approve',           'Stock operations', 'Approve adjustments', 'Approve or reject adjustments within the approval limit.'],
  ['stock.approve_restricted','Stock operations', 'Approve restricted adjustments', 'Approve restricted reasons (theft, missing stock, obsolete write-offs) and amounts above any limit.', true],
  ['locations.manage',        'Stock operations', 'Manage locations and warehouses', 'Create locations and warehouses and decide who may use them.'],
  // Quality, safety and losses
  ['quality.manage',          'Quality and safety', 'Manage quality', 'Hold, release, inspect, recall and dispose of batches.'],
  ['hazmat.manage',           'Quality and safety', 'Manage hazardous materials', 'Classify items, set permitted locations and record inspections and incidents.'],
  ['losses.manage',           'Quality and safety', 'Manage losses', 'Record supplier returns and disposals; classify obsolete stock.'],
  // Purchasing
  ['replenishment.view',      'Purchasing', 'Review replenishment', 'See reorder points, forecasts and recommendations.'],
  ['replenishment.approve',   'Purchasing', 'Approve replenishment', 'Turn recommendations into purchase orders and set item reorder rules.'],
  ['purchases.view',          'Purchasing', 'View purchase orders', 'See purchase orders and goods received.'],
  ['purchases.manage',        'Purchasing', 'Manage purchasing', 'Create, edit and receive purchase orders.'],
  ['suppliers.manage',        'Purchasing', 'Manage suppliers', 'Create and edit suppliers and their details.'],
  // Reports
  ['reports.inventory',       'Reports', 'Inventory dashboard and reports', 'Dashboard and the standard stock, movement, expiry, replenishment and count reports.'],
  ['reports.valuation',       'Reports', 'Valuation reports', 'Inventory valuation, margins and stock value.', true],
  ['reports.audit',           'Reports', 'Audit reports', 'Transaction audit and the reconciliation checks.', true],
  ['reports.export',          'Reports', 'Export reports', 'Download reports as CSV, Excel and PDF.'],
  // Policy and administration
  ['policy.configure',        'Administration', 'Configure inventory policies', 'Valuation method, replenishment, rotation, quality, hazard and loss policies and approval thresholds.', true],
  ['users.manage',            'Administration', 'Manage users', 'Create users, assign roles and branches, reset passwords.', true],
  ['roles.manage',            'Administration', 'Manage roles', 'Create roles and change what each role may do.', true],
];
const PERMISSIONS = CATALOGUE.map(([code, group, label, description, sensitive]) => ({ code, group, label, description, sensitive: !!sensitive }));
const CODES = new Set(PERMISSIONS.map(p => p.code));
const ALL = PERMISSIONS.map(p => p.code);

const without = (list, ...drop) => list.filter(c => !drop.includes(c));
const MANAGER = without(ALL, 'inventory.delete_items', 'stock.approve_restricted', 'reports.audit', 'policy.configure', 'users.manage', 'roles.manage');
const BUILTIN = {
  org_admin:      { name: 'Administrator',     description: 'Owner. Full access; configures policies, roles and users, approves restricted adjustments.', permissions: ALL, locked: true },
  branch_manager: { name: 'Manager',           description: 'Monitors the branch, reviews replenishment, approves counts, transfers and adjustments within the approval limit.', permissions: MANAGER },
  staff:          { name: 'Warehouse staff',   description: 'Records receipts, transfers and counts, requests adjustments and reports discrepancies.',
                    permissions: ['inventory.view', 'stock.receive', 'stock.transfer', 'stock.count', 'stock.reserve', 'stock.adjust_request', 'reports.inventory'] },
  purchasing:     { name: 'Purchasing / Finance', description: 'Reviews replenishment, runs purchasing and suppliers, reviews costs and valuation.',
                    permissions: ['inventory.view', 'inventory.view_cost', 'stock.receive', 'replenishment.view', 'replenishment.approve', 'purchases.view', 'purchases.manage', 'suppliers.manage', 'reports.inventory', 'reports.valuation', 'reports.export'] },
  demo:           { name: 'Demo',              description: 'Read-only sandbox.', permissions: ['inventory.view', 'inventory.view_cost', 'replenishment.view', 'purchases.view', 'reports.inventory', 'reports.valuation'], hidden: true },
};
const BASE_ROLES = Object.keys(BUILTIN);
// Adjustment reasons that only an authority with stock.approve_restricted may post or approve (organisation setting restricted_adjustment_reasons overrides).
const DEFAULT_RESTRICTED = ['loss_theft', 'missing_stock', 'obsolete_writeoff'];

const defaultsFor = role => (BUILTIN[role] ?? BUILTIN.staff).permissions;
const clean = list => [...new Set((Array.isArray(list) ? list : []).filter(c => CODES.has(c)))];

// ── cache ────────────────────────────────────────────────────────────────────
const cache = new Map();
const TTL = 15000;
const clearCache = () => cache.clear();

/** Make sure the organisation has an access_roles row for each built-in role (created on first use, then editable). */
const seeded = new Set();
async function ensureRoles(orgId, conn) {
  if (seeded.has(orgId)) return;
  const pool = conn ?? await getPool();
  for (const key of BASE_ROLES) {
    const b = BUILTIN[key];
    await pool.request().input('o', sql.Int, orgId).input('k', sql.NVarChar(30), key).input('n', sql.NVarChar(80), b.name).input('d', sql.NVarChar(300), b.description)
      .input('p', sql.NVarChar(sql.MAX), JSON.stringify(b.permissions))
      .query(`IF NOT EXISTS (SELECT 1 FROM access_roles WHERE organization_id = @o AND base_role = @k AND is_builtin = 1)
                INSERT INTO access_roles (organization_id, name, base_role, description, permissions, is_builtin) VALUES (@o, @n, @k, @d, @p, 1)`)
      .catch(e => { if (!/UX_access_roles|duplicate key|unique/i.test(e.message)) throw e; });
  }
  seeded.add(orgId);
}

/**
 * Who this request really is: current base role, branch, role permissions and approval limit, read from the database.
 * A signed token whose user row cannot be found (a user removed after login) keeps the token's role and the defaults for it.
 */
async function loadAccess(user) {
  const key = `${user.orgId}:${user.userId}:${user.role}:${user.branchId ?? ""}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const pool = await getPool();
  let value;
  const row = (await pool.request().input('u', sql.Int, user.userId).input('o', sql.Int, user.orgId)
    .query(`SELECT u.role, u.branch_id, u.is_active, u.access_role_id FROM users u WHERE u.id = @u AND u.organization_id = @o`)).recordset[0];
  if (!row) {
    value = { found: false, active: true, role: user.role, branchId: user.branchId ?? null, perms: new Set(user.role === 'org_admin' ? ALL : defaultsFor(user.role)), approvalLimit: null, roleName: BUILTIN[user.role]?.name ?? user.role, accessRoleId: null };
  } else {
    await ensureRoles(user.orgId, pool);
    const ar = (await pool.request().input('o', sql.Int, user.orgId).input('r', sql.Int, row.access_role_id).input('k', sql.NVarChar(30), row.role)
      .query(`SELECT TOP 1 id, name, base_role, permissions, approval_limit FROM access_roles
              WHERE organization_id = @o AND ((@r IS NOT NULL AND id = @r) OR (@r IS NULL AND is_builtin = 1 AND base_role = @k)) ORDER BY id`)).recordset[0];
    // A custom role carries its own base role; the built-in role of the user's base role applies when none is set.
    const base = ar?.base_role ?? row.role;
    let perms = base === 'org_admin' ? ALL : ar ? clean(JSON.parse(ar.permissions || '[]')) : defaultsFor(base);
    value = { found: true, active: !!row.is_active, role: base, branchId: base === 'org_admin' ? null : row.branch_id ?? null, perms: new Set(perms),
              approvalLimit: ar?.approval_limit != null ? Number(ar.approval_limit) : null, roleName: ar?.name ?? BUILTIN[base]?.name ?? base, accessRoleId: ar?.id ?? null };
  }
  cache.set(key, { until: Date.now() + TTL, value });
  return value;
}

const has = (user, code) => user?.role === 'org_admin' || !!user?.perms?.has(code);

/** Express middleware, after requireAuth: replaces the token's claims with the live ones and attaches req.user.perms. */
async function attachAccess(req, res, next) {
  if (!req.user) return next();
  try {
    const a = await loadAccess(req.user);
    if (!a.active) return res.status(401).json({ error: 'This account has been deactivated', code: 'ACCOUNT_DISABLED' });
    req.user.role = a.role; req.user.branchId = a.branchId; req.user.perms = a.perms; req.user.approvalLimit = a.approvalLimit; req.user.roleName = a.roleName; req.user.accessRoleId = a.accessRoleId;
    next();
  } catch (err) { console.error('[access]', err.message); res.status(500).json({ error: 'Could not verify your permissions' }); }
}

/** Route guard: the user needs at least one of the listed permissions. A refusal is logged to the audit trail. */
function requirePermission(...codes) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (codes.some(c => has(req.user, c))) return next();
    deny(req, codes[0]);
    res.status(403).json({ error: 'You do not have permission to do this', code: 'FORBIDDEN', permission: codes[0] });
  };
}
function deny(req, permission) {
  try {
    const { writeAudit } = require('./audit');
    if (!req.user?.orgId || req.method === 'GET') return;
    getPool().then(pool => writeAudit(pool, { orgId: req.user.orgId, branchId: req.user.branchId ?? 1, userId: req.user.userId, action: 'DENIED', entity: 'permission', entityId: 0,
      before: null, after: { permission, method: req.method, path: String(req.originalUrl || '').split('?')[0].slice(0, 120) } })).catch(() => {});
  } catch { /* logging must never break the refusal */ }
}

/** What the user object carried into stock utilities must hold: { userId, role, branchId, perms, approvalLimit }. */
const userCtx = (req, branchId) => ({ userId: req.user.userId, role: req.user.role, branchId: req.user.branchId ?? branchId ?? null, perms: req.user.perms, approvalLimit: req.user.approvalLimit ?? null });

async function restrictedReasons(conn, orgId) {
  const r = await (conn.request ? conn.request() : new sql.Request(conn)).input('o', sql.Int, orgId).query("SELECT value FROM settings WHERE organization_id = @o AND [key] = 'restricted_adjustment_reasons'");
  const v = r.recordset[0]?.value;
  return v == null ? DEFAULT_RESTRICTED : String(v).split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = { PERMISSIONS, CODES, ALL, BUILTIN, BASE_ROLES, DEFAULT_RESTRICTED, defaultsFor, clean, clearCache, ensureRoles, loadAccess, attachAccess, requirePermission, has, userCtx, restrictedReasons };
