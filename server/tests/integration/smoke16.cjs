process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 500)}`); };
const day = n => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
(async () => {
  const pool = await getPool();
  const mkOrg = async nm => {
    const org = (await pool.request().input('n', sql.NVarChar(100), nm).query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@n, 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    return { org, br };
  };
  const A = await mkOrg('SMOKE ORG16'), B = await mkOrg('SMOKE ORG16B');
  const { org, br } = A;
  const east = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'East', 'EAST')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'P Supply', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR))")).recordset[0].id;
  const mkUser = async (o, role, branch, nm) => (await pool.request().input('o', sql.Int, o).input('b', sql.Int, branch).input('r', sql.NVarChar(50), role).input('n', sql.NVarChar(100), nm)
    .query("INSERT INTO users (name, email, password_hash, role, organization_id, branch_id) OUTPUT INSERTED.id VALUES (@n, @n + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR) + '@smoke16.test', 'x', @r, @o, @b)")).recordset[0].id;
  const U = {
    admin: await mkUser(org, 'org_admin', null, 'p admin'), mgr: await mkUser(org, 'branch_manager', br, 'p mgr'), staff: await mkUser(org, 'staff', br, 'p staff'),
    purch: await mkUser(org, 'purchasing', br, 'p purch'), staff2: await mkUser(org, 'staff', br, 'p staff2'), adminB: await mkUser(B.org, 'org_admin', null, 'p adminB'), staffB: await mkUser(B.org, 'staff', B.br, 'p staffB'),
  };
  const tok = (o, role, uid, branch) => jwt.sign({ userId: uid, orgId: o.org, branchId: role === 'org_admin' ? null : branch, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const T = { admin: tok(A, 'org_admin', U.admin), mgr: tok(A, 'branch_manager', U.mgr, br), staff: tok(A, 'staff', U.staff, br), purch: tok(A, 'purchasing', U.purch, br), staff2: tok(A, 'staff', U.staff2, br), adminB: tok(B, 'org_admin', U.adminB), staffB: tok(B, 'staff', U.staffB, B.br) };
  const call = async (m, p, body, t = T.admin, branch = br) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(branch) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const forbidden = (r, perm) => r.status === 403 && r.body?.code === 'FORBIDDEN' && (!perm || r.body.permission === perm);
  let n = 0;
  const mk = async (model, extra = {}) => { const r = await call('POST', '/inventory', { model, cost_price: 10, sale_price: 20, ...extra }); if (r.status !== 201 && r.status !== 200) throw new Error('create ' + model + JSON.stringify(r.body)); return r.body.id; };
  const adjust = (t, tire, qty, code, extra = {}) => call('POST', '/inventory/adjustments', { tire_id: tire, qty_change: qty, reason_code: code, notes: `n${++n}`, ...extra }, t);
  const audits = async (q) => (await pool.request().input('o', sql.Int, org).query(`SELECT action, entity, after_json FROM audit_logs WHERE organization_id = @o AND ${q}`)).recordset;
  try {
    // ── data ──
    const I1 = await mk('Perm item', { supplier_id: sup, stock: 0, reorder_level: 20 });
    let r = await call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: I1, tire_name: 'x', qty: 200, unit_price: 10 }] });
    check('seed: admin receives stock', r.status === 201, JSON.stringify(r.body));
    const locs = (await call('GET', '/inventory/locations')).body, L1 = locs.find(l => l.is_default).id;
    const L2 = (await call('POST', '/inventory/locations', { name: 'Perm bay 2' })).body.id;

    // ── identity and role catalogue ──
    r = await call('GET', '/access/me', null, T.admin);
    check('admin has every permission', r.body.role === 'org_admin' && r.body.permissions.length >= 28 && r.body.permissions.includes('roles.manage'), JSON.stringify(r.body).slice(0, 200));
    r = await call('GET', '/access/me', null, T.mgr);
    check('manager: approve and replenishment but no policy, users, restricted', r.body.permissions.includes('stock.approve') && r.body.permissions.includes('replenishment.approve') && !r.body.permissions.includes('policy.configure') && !r.body.permissions.includes('users.manage') && !r.body.permissions.includes('stock.approve_restricted') && !r.body.permissions.includes('reports.audit'), JSON.stringify(r.body.permissions));
    r = await call('GET', '/access/me', null, T.staff);
    check('warehouse staff: record and request, no cost, no approval', r.body.permissions.includes('stock.receive') && r.body.permissions.includes('stock.count') && r.body.permissions.includes('stock.adjust_request') && !r.body.permissions.includes('inventory.view_cost') && !r.body.permissions.includes('stock.approve') && !r.body.permissions.includes('stock.adjust_direct'), JSON.stringify(r.body.permissions));
    r = await call('GET', '/access/me', null, T.purch);
    check('purchasing: costs, valuation, replenishment, purchasing, no stock approval', r.body.permissions.includes('inventory.view_cost') && r.body.permissions.includes('reports.valuation') && r.body.permissions.includes('purchases.manage') && !r.body.permissions.includes('stock.approve') && !r.body.permissions.includes('stock.adjust_request'), JSON.stringify(r.body.permissions));
    check('role name is reported', (await call('GET', '/access/me', null, T.purch)).body.role_name === 'Purchasing / Finance');
    r = await call('GET', '/access/me', null, 'garbage');
    check('no token: 401', r.status === 401);
    r = await call('GET', '/access/roles');
    const roles = r.body;
    check('admin lists the four built-in roles', r.status === 200 && ['org_admin', 'branch_manager', 'staff', 'purchasing'].every(k => roles.some(x => x.base_role === k && x.is_builtin)) && !roles.some(x => x.base_role === 'demo'), JSON.stringify(roles.map(x => x.name)));
    check('administrator role is locked and holds everything', roles.find(x => x.base_role === 'org_admin').locked === true && roles.find(x => x.base_role === 'org_admin').permissions.length >= 28);
    check('role lists show user counts', roles.find(x => x.base_role === 'staff').users === 2 && roles.find(x => x.base_role === 'org_admin').users === 1, JSON.stringify(roles.map(x => [x.name, x.users])));
    check('manager cannot read roles', forbidden(await call('GET', '/access/roles', null, T.mgr)));
    check('staff cannot read the permission catalogue', forbidden(await call('GET', '/access/permissions', null, T.staff)));
    r = await call('GET', '/access/permissions');
    check('catalogue groups permissions and flags sensitive ones', r.body.permissions.length >= 28 && r.body.permissions.some(p => p.sensitive) && r.body.permissions.every(p => p.group && p.label && p.description));

    // ── warehouse staff on the backend ──
    r = await call('GET', '/inventory', null, T.staff);
    check('staff can view items but cost is blanked by the server', r.status === 200 && r.body.length >= 1 && r.body.every(x => x.cost_price === null), JSON.stringify(r.body[0]));
    r = await call('GET', `/inventory/${I1}`, null, T.staff);
    check('single item also hides cost', r.status === 200 && r.body.cost_price === null);
    r = await call('GET', '/inventory', null, T.admin);
    check('administrator still sees cost', r.body.some(x => Number(x.cost_price) === 10));
    check('staff cannot create items', forbidden(await call('POST', '/inventory', { model: 'Nope', cost_price: 1, sale_price: 2 }, T.staff), 'inventory.manage_items'));
    check('staff cannot edit items', forbidden(await call('PUT', `/inventory/${I1}`, { model: 'Perm item', cost_price: 1, sale_price: 2, stock: 200 }, T.staff)));
    check('staff cannot delete items', forbidden(await call('DELETE', `/inventory/${I1}`, null, T.staff)));
    check('staff cannot bulk import', forbidden(await call('POST', '/inventory/bulk', { items: [] }, T.staff)));
    check('staff cannot create categories', forbidden(await call('POST', '/inventory/categories', { name: 'Nope' }, T.staff)));
    check('staff cannot create locations', forbidden(await call('POST', '/inventory/locations', { name: 'Nope' }, T.staff), 'locations.manage'));
    check('staff cannot open replenishment', forbidden(await call('GET', '/inventory/replenishment', null, T.staff)));
    check('staff cannot approve replenishment orders', forbidden(await call('POST', '/inventory/replenishment/orders', {}, T.staff)));
    check('staff cannot read valuation', forbidden(await call('GET', '/inventory/valuation', null, T.staff), 'reports.valuation'));
    check('staff cannot read margin', forbidden(await call('GET', '/inventory/margin', null, T.staff)));
    check('staff cannot change valuation method', forbidden(await call('PUT', '/inventory/valuation-method', { method: 'fifo' }, T.staff), 'policy.configure'));
    check('staff cannot change replenishment policy', forbidden(await call('PUT', '/inventory/replenishment/settings', {}, T.staff), 'policy.configure'));
    check('staff cannot change quality profiles', forbidden(await call('POST', '/inventory/quality/profiles', { name: 'x' }, T.staff)));
    check('staff cannot manage hazmat classes', forbidden(await call('POST', '/inventory/hazmat/classes', { code: 'X', name: 'X' }, T.staff)));
    check('staff cannot read reconciliation', forbidden(await call('GET', '/inventory/reconciliation', null, T.staff), 'reports.audit'));
    check('staff cannot read the audit log', forbidden(await call('GET', '/audit', null, T.staff)));
    check('staff cannot approve adjustments', forbidden(await call('POST', '/inventory/adjustments/1/approve', {}, T.staff), 'stock.approve'));
    check('staff cannot manage users', forbidden(await call('GET', '/users', null, T.staff), 'users.manage'));
    check('staff cannot create suppliers', forbidden(await call('POST', '/suppliers', { name: 'Nope' }, T.staff), 'suppliers.manage'));
    check('staff cannot create purchase orders', forbidden(await call('POST', '/purchases', { supplier_id: sup, date: day(0), items: [{ tire_id: I1, tire_name: 'x', qty: 1, unit_price: 1 }] }, T.staff), 'purchases.manage'));
    check('staff may still read suppliers (to pick one)', (await call('GET', '/suppliers', null, T.staff)).status === 200);
    check('staff can open the inventory dashboard', (await call('GET', '/inventory/insights/dashboard', null, T.staff)).status === 200);
    r = await call('GET', '/inventory/insights/dashboard', null, T.staff);
    check('dashboard values are removed without cost permission', r.body.kpis.inventory_value === null && r.body.kpis.units > 0, JSON.stringify(r.body.kpis).slice(0, 220));
    r = await call('GET', '/inventory/insights/reports/current_stock', null, T.staff);
    check('report hides cost and value columns', r.status === 200 && !r.body.columns.some(c => /cost|value/i.test(c.key)) && r.body.rows.every(x => !('unit_cost' in x) && !('value' in x)), JSON.stringify(r.body.columns.map(c => c.key)));
    check('staff valuation report refused', forbidden(await call('GET', '/inventory/insights/reports/valuation', null, T.staff)));
    check('staff audit report refused', forbidden(await call('GET', '/inventory/insights/reports/audit', null, T.staff)));
    check('staff cannot export reports', forbidden(await call('GET', '/inventory/insights/reports/current_stock/export', null, T.staff), 'reports.export'));
    check('staff cannot build Excel/PDF exports either', forbidden(await call('GET', '/inventory/insights/reports/current_stock?export=xlsx', null, T.staff)));
    r = await call('GET', '/inventory/insights/reports', null, T.staff);
    check('staff report list omits valuation and audit', r.body.length === 10 && r.body.every(x => x.exportable === false));

    // staff operations that are allowed
    r = await call('POST', '/inventory/transfers', { from_location_id: L1, to_location_id: L2, items: [{ tire_id: I1, qty: 5 }] }, T.staff);
    check('staff can transfer between locations of the branch', r.status === 201, JSON.stringify(r.body));
    const eastLoc = (await call('GET', '/inventory/locations', null, T.admin, east)).body.find(l => l.is_default).id;
    r = await call('POST', '/inventory/transfers', { from_location_id: L1, to_location_id: eastLoc, items: [{ tire_id: I1, qty: 1 }] }, T.staff);
    check('staff cannot send stock to another branch', r.status === 403 && r.body.code === 'CROSS_BRANCH_FORBIDDEN', JSON.stringify(r.body));
    r = await call('POST', '/inventory/transfers', { from_location_id: L1, to_location_id: eastLoc, items: [{ tire_id: I1, qty: 1 }] }, T.mgr);
    check('manager can send stock to another branch', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', '/inventory/counts', { location_id: L1 }, T.staff);
    check('staff can open a stock count', r.status === 201, JSON.stringify(r.body));
    const cnt = r.body.id;
    r = await call('POST', '/inventory/reservations', { tire_id: I1, qty: 2, location_id: L1, note: 'hold' }, T.staff);
    check('staff can reserve stock', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'pending', items: [{ tire_id: I1, tire_name: 'x', qty: 4, unit_price: 10 }] }, T.purch);
    check('purchasing creates a purchase order', r.status === 201, JSON.stringify(r.body));
    const po = r.body.id;
    r = await call('PATCH', `/purchases/${po}/status`, { status: 'received' }, T.staff);
    check('staff can record the receipt of a purchase order', r.status === 200, JSON.stringify(r.body));
    check('staff can read purchase orders to receive them', (await call('GET', '/purchases', null, T.staff)).status === 200);
    r = await adjust(T.staff, I1, -3, 'damage');
    check('staff adjustment is only a request', r.status === 202 && r.body.status === 'pending', JSON.stringify(r.body));
    const reqNormal = r.body.id;

    // ── purchasing role ──
    r = await call('GET', '/inventory', null, T.purch);
    check('purchasing sees cost', r.status === 200 && r.body.some(x => Number(x.cost_price) === 10));
    check('purchasing sees valuation', (await call('GET', '/inventory/valuation', null, T.purch)).status === 200);
    check('purchasing reviews replenishment', (await call('GET', '/inventory/replenishment', null, T.purch)).status === 200);
    check('purchasing may manage suppliers', (await call('POST', '/suppliers', { name: 'Purch supplier' }, T.purch)).status === 201);
    check('purchasing cannot edit stock items', forbidden(await call('PUT', `/inventory/${I1}`, { model: 'Perm item', cost_price: 1, sale_price: 2 }, T.purch)));
    check('purchasing cannot request stock adjustments', forbidden(await adjust(T.purch, I1, -1, 'damage'), 'stock.adjust_request'));
    check('purchasing cannot approve adjustments', forbidden(await call('POST', `/inventory/adjustments/${reqNormal}/approve`, {}, T.purch)));
    check('purchasing cannot read the audit report', forbidden(await call('GET', '/inventory/insights/reports/audit', null, T.purch)));
    r = await call('GET', '/inventory/insights/reports/valuation', null, T.purch);
    check('purchasing reads valuation report with values', r.status === 200 && r.body.columns.some(c => c.key === 'value') && r.body.totals.value > 0);
    check('purchasing may export', (await call('GET', '/inventory/insights/reports/current_stock/export', null, T.purch)).status === 200);

    // ── approval authority ──
    // manager approves a normal request within authority
    r = await call('POST', `/inventory/adjustments/${reqNormal}/approve`, {}, T.mgr);
    check('manager approves an ordinary adjustment', r.status === 200 && r.body.status === 'approved', JSON.stringify(r.body));
    // restricted reason: staff request waits for restricted authority
    r = await adjust(T.staff, I1, -4, 'loss_theft');
    const reqTheft = r.body.id;
    check('restricted reason requested by staff is pending', r.status === 202);
    r = await call('POST', `/inventory/adjustments/${reqTheft}/approve`, {}, T.mgr);
    check('manager cannot approve a restricted adjustment', r.status === 403 && r.body.code === 'RESTRICTED_REASON', JSON.stringify(r.body));
    r = await adjust(T.mgr, I1, -1, 'loss_theft');
    check('manager posting a restricted reason becomes a request', r.status === 202 && r.body.status === 'pending', JSON.stringify(r.body));
    const reqMgrTheft = r.body.id;
    r = await call('POST', `/inventory/adjustments/${reqTheft}/approve`, {}, T.admin);
    check('administrator approves the restricted adjustment', r.status === 200 && r.body.status === 'approved', JSON.stringify(r.body));
    check('administrator approves the manager request too', (await call('POST', `/inventory/adjustments/${reqMgrTheft}/approve`, {}, T.admin)).status === 200);
    // approval limit on the Manager role
    const mgrRole = roles.find(x => x.base_role === 'branch_manager');
    r = await call('PUT', `/access/roles/${mgrRole.id}`, { approval_limit: 50 });
    check('administrator sets the manager approval limit', r.status === 200 && r.body.approval_limit === 50, JSON.stringify(r.body));
    r = await adjust(T.staff, I1, -10, 'damage');
    const reqBig = r.body.id;                           // 10 units x 10 = 100 > 50
    r = await call('POST', `/inventory/adjustments/${reqBig}/approve`, {}, T.mgr);
    check('manager cannot approve above the approval limit', r.status === 403 && r.body.code === 'APPROVAL_LIMIT' && r.body.value === 100 && r.body.limit === 50, JSON.stringify(r.body));
    r = await adjust(T.staff, I1, -4, 'damage');
    check('manager approves within the limit (4 x 10)', (await call('POST', `/inventory/adjustments/${r.body.id}/approve`, {}, T.mgr)).status === 200);
    r = await adjust(T.mgr, I1, -2, 'damage');
    check('manager posts directly within the limit', r.status === 201 && r.body.status === 'approved', JSON.stringify(r.body));
    r = await adjust(T.mgr, I1, -9, 'damage');
    check('manager request above the limit waits for approval', r.status === 202 && r.body.status === 'pending', JSON.stringify(r.body));
    const reqMgrBig = r.body.id;
    check('administrator is not limited', (await call('POST', `/inventory/adjustments/${reqBig}/approve`, {}, T.admin)).status === 200);
    check('administrator approves the manager request above the limit', (await call('POST', `/inventory/adjustments/${reqMgrBig}/approve`, {}, T.admin)).status === 200);
    r = await call('POST', `/access/roles/${mgrRole.id}/reset`, {});
    check('reset restores defaults and clears the limit', r.status === 200 && r.body.approval_limit === null && r.body.permissions.includes('stock.approve'));
    // restricted list is configurable
    r = await call('PUT', '/access/policy', { restricted_reasons: ['damage'] });
    check('administrator changes the restricted reasons', r.status === 200 && r.body.restricted_reasons.join() === 'damage');
    r = await adjust(T.mgr, I1, -1, 'damage');
    check('damage is now restricted: manager request waits', r.status === 202, JSON.stringify(r.body));
    r = await adjust(T.mgr, I1, -1, 'loss_theft');
    check('theft is no longer restricted: manager posts directly', r.status === 201 && r.body.status === 'approved', JSON.stringify(r.body));
    check('restricted reasons must be real reasons', (await call('PUT', '/access/policy', { restricted_reasons: ['nonsense'] })).status === 400);
    await call('PUT', '/access/policy', { restricted_reasons: ['loss_theft', 'missing_stock', 'obsolete_writeoff'] });
    check('manager cannot change the restricted list', forbidden(await call('PUT', '/access/policy', { restricted_reasons: [] }, T.mgr)));
    // count approval authority: staff count variance waits; manager (count_approve) posts directly
    const cd = (await call('GET', `/inventory/counts/${cnt}`, null, T.staff)).body;
    const lines = (cd.items || cd.lines || []).map(l => ({ id: l.id, counted_qty: l.tire_id === I1 ? l.system_qty - 1 : l.system_qty }));
    await call('PUT', `/inventory/counts/${cnt}/lines`, { lines }, T.staff);
    r = await call('POST', `/inventory/counts/${cnt}/complete`, {}, T.staff);
    check('staff completes a count; its variance is a pending request', r.status === 200, JSON.stringify(r.body));
    const pend = (await call('GET', '/inventory/adjustments?status=pending', null, T.mgr)).body;
    check('count variance awaits approval', pend.some(a => a.reason_code === 'count_correction'), JSON.stringify(pend.map(a => a.reason_code)));

    // ── custom roles ──
    r = await call('POST', '/access/roles', { name: 'Stock auditor', base_role: 'staff', description: 'Reads reports', permissions: ['inventory.view', 'reports.inventory', 'reports.audit', 'reports.export', 'bogus.permission'] });
    check('administrator creates a custom role (unknown permission ignored)', r.status === 201 && r.body.permissions.length === 4 && !r.body.permissions.includes('bogus.permission') && !r.body.is_builtin, JSON.stringify(r.body));
    const auditor = r.body;
    check('duplicate role name is refused', (await call('POST', '/access/roles', { name: 'Stock auditor', base_role: 'staff', permissions: [] })).status === 409);
    check('administrator base role cannot be cloned', (await call('POST', '/access/roles', { name: 'Fake admin', base_role: 'org_admin', permissions: [] })).status === 400);
    check('role needs a name', (await call('POST', '/access/roles', { base_role: 'staff', permissions: [] })).status === 400);
    check('approval limit must be a number', (await call('POST', '/access/roles', { name: 'Bad limit', base_role: 'staff', permissions: [], approval_limit: -5 })).status === 400);
    check('manager cannot create roles', forbidden(await call('POST', '/access/roles', { name: 'Hack', base_role: 'staff', permissions: [] }, T.mgr)));
    r = await call('PUT', `/users/${U.staff2}`, { name: 'p staff2', access_role_id: auditor.id, branch_id: br });
    check('administrator assigns the custom role to a user', r.status === 200 && r.body.access_role_id === auditor.id && r.body.role === 'staff', JSON.stringify(r.body));
    r = await call('GET', '/access/me', null, T.staff2);
    check('the user now has exactly that role (live, same token)', r.body.role_name === 'Stock auditor' && r.body.permissions.length === 4, JSON.stringify(r.body));
    check('custom role can read the audit report', (await call('GET', '/inventory/insights/reports/audit', null, T.staff2)).status === 200);
    check('custom role cannot receive stock', forbidden(await call('POST', '/inventory/counts', { location_id: L1 }, T.staff2)));
    r = await call('PUT', `/access/roles/${auditor.id}`, { permissions: ['inventory.view', 'reports.inventory'] });
    check('administrator removes permissions from the role', r.status === 200 && r.body.permissions.length === 2);
    check('removal applies immediately: audit report now refused', forbidden(await call('GET', '/inventory/insights/reports/audit', null, T.staff2)));
    check('the role cannot be deleted while a user has it', (await call('DELETE', `/access/roles/${auditor.id}`)).status === 409);
    r = await call('GET', '/users');
    check('user list shows role names', r.body.find(u => u.id === U.staff2).role_name === 'Stock auditor' && r.body.find(u => u.id === U.mgr).role_name === 'Manager', JSON.stringify(r.body.map(u => u.role_name)));
    r = await call('PUT', `/users/${U.staff2}`, { name: 'p staff2', role: 'staff', branch_id: br });
    check('assigning a plain base role clears the custom role', r.status === 200 && r.body.access_role_id === null);
    check('now the role can be deleted', (await call('DELETE', `/access/roles/${auditor.id}`)).status === 200);
    check('deleted role is gone', (await call('PUT', `/access/roles/${auditor.id}`, { name: 'x' })).status === 404);

    // ── cannot lock out or escalate ──
    const adminRole = roles.find(x => x.base_role === 'org_admin'), staffRole = roles.find(x => x.base_role === 'staff');
    check('administrator role cannot be edited', (await call('PUT', `/access/roles/${adminRole.id}`, { permissions: [] })).status === 403);
    check('built-in roles cannot be deleted', (await call('DELETE', `/access/roles/${staffRole.id}`)).status === 400);
    check('built-in role names are fixed', (await call('PUT', `/access/roles/${staffRole.id}`, { name: 'Renamed' })).body.name === 'Warehouse staff');
    check('administrator cannot demote themselves', (await call('PUT', `/users/${U.admin}`, { name: 'p admin', role: 'staff' })).status === 400);
    check('administrator cannot deactivate themselves', (await call('PATCH', `/users/${U.admin}/status`, { is_active: false })).status === 400);
    // a delegated user manager
    r = await call('POST', '/access/roles', { name: 'HR lead', base_role: 'branch_manager', permissions: ['users.manage', 'roles.manage', 'inventory.view', 'stock.receive', 'stock.transfer', 'stock.count', 'stock.reserve', 'stock.adjust_request', 'reports.inventory'] });
    const hr = r.body;
    await call('PUT', `/users/${U.mgr}`, { name: 'p mgr', access_role_id: hr.id, branch_id: br });
    r = await call('GET', '/users', null, T.mgr);
    check('delegated user manager can list users', r.status === 200);
    check('delegate cannot hand out permissions they lack', (await call('POST', '/access/roles', { name: 'Escalate', base_role: 'staff', permissions: ['stock.approve_restricted'] }, T.mgr)).body?.code === 'ESCALATION');
    check('delegate cannot edit their own role', (await call('PUT', `/access/roles/${hr.id}`, { permissions: ['users.manage', 'roles.manage', 'inventory.view', 'stock.receive', 'policy.configure'] }, T.mgr)).status === 403);
    check('delegate cannot create an administrator', (await call('POST', '/users', { name: 'evil', email: 'evil@smoke16.test', password: 'password123', role: 'org_admin' }, T.mgr)).body?.code === 'ESCALATION');
    check('delegate cannot touch an administrator account', (await call('PATCH', `/users/${U.admin}/password`, { password: 'password123' }, T.mgr)).status === 403);
    check('delegate cannot deactivate an administrator', (await call('PATCH', `/users/${U.admin}/status`, { is_active: false }, T.mgr)).status === 403);
    check('delegate cannot assign a role above their own', (await call('PUT', `/users/${U.staff2}`, { name: 'p staff2', access_role_id: mgrRole.id, branch_id: br }, T.mgr)).body?.code === 'ESCALATION');
    r = await call('POST', '/users', { name: 'new recv', email: `recv${Date.now()}@smoke16.test`, password: 'password123', access_role_id: staffRole.id, branch_id: br }, T.mgr);
    check('delegate can create a user with a role they hold', r.status === 201 && r.body.role === 'staff', JSON.stringify(r.body));
    await call('PUT', `/users/${U.mgr}`, { name: 'p mgr', role: 'branch_manager', branch_id: br });
    check('removing the delegation takes it away at once', forbidden(await call('GET', '/users', null, T.mgr)));
    r = await call('POST', '/users', { name: 'Second admin', email: `adm${Date.now()}@smoke16.test`, password: 'password123', role: 'org_admin' });
    check('administrator can create another administrator', r.status === 201 && r.body.role === 'org_admin');
    check('invalid base role is refused', (await call('POST', '/users', { name: 'x', email: 'x@smoke16.test', password: 'password123', role: 'superuser' })).status === 400);
    check('unknown role id is refused', (await call('POST', '/users', { name: 'x', email: 'x2@smoke16.test', password: 'password123', access_role_id: 999999 })).status === 404);

    // ── live effect of account changes ──
    check('before: staff2 token works', (await call('GET', '/inventory', null, T.staff2)).status === 200);
    await call('PATCH', `/users/${U.staff2}/status`, { is_active: false });
    r = await call('GET', '/inventory', null, T.staff2);
    check('deactivated account is refused at once', r.status === 401 && r.body.code === 'ACCOUNT_DISABLED', JSON.stringify(r.body));
    await call('PATCH', `/users/${U.staff2}/status`, { is_active: true });
    await call('PUT', `/users/${U.staff2}`, { name: 'p staff2', role: 'purchasing', branch_id: br });
    r = await call('GET', '/access/me', null, T.staff2);
    check('role change in the database overrides the old token', r.body.role === 'purchasing' && r.body.permissions.includes('purchases.manage'), JSON.stringify(r.body));

    // ── isolation between organisations ──
    r = await call('GET', '/access/roles', null, T.adminB, B.br);
    check('other organisation gets its own roles', r.status === 200 && r.body.every(x => x.name) && !r.body.some(x => x.id === auditor.id || x.id === hr.id) && r.body.length === 4, JSON.stringify(r.body.map(x => x.name)));
    check('cannot edit another organisation role', (await call('PUT', `/access/roles/${hr.id}`, { description: 'x' }, T.adminB, B.br)).status === 404);
    check('cannot delete another organisation role', (await call('DELETE', `/access/roles/${hr.id}`, null, T.adminB, B.br)).status === 404);
    check('cannot assign another organisation role', (await call('PUT', `/users/${U.staffB}`, { name: 'p staffB', access_role_id: hr.id, branch_id: B.br }, T.adminB, B.br)).status === 404);
    check('cannot edit another organisation user', (await call('PUT', `/users/${U.staff}`, { name: 'x', role: 'staff' }, T.adminB, B.br)).status === 404);
    check('cannot read another organisation users', !(await call('GET', '/users', null, T.adminB, B.br)).body.some(u => u.id === U.staff));
    check('role changes in one organisation leave the other untouched', (await call('GET', '/access/me', null, T.staffB, B.br)).body.permissions.includes('stock.receive'));

    // ── audit trail ──
    await new Promise(res => setTimeout(res, 900));
    const denied = await audits("action = 'DENIED'");
    check('refused attempts are logged with the permission', denied.length >= 10 && denied.some(d => /inventory.manage_items/.test(d.after_json)) && denied.some(d => /policy.configure/.test(d.after_json)), denied.length);
    const roleLog = await audits("entity = 'access_role'");
    check('role changes are audited', roleLog.some(d => d.action === 'CREATE') && roleLog.some(d => d.action === 'UPDATE') && roleLog.some(d => d.action === 'DELETE'), roleLog.length);
    const userLog = await audits("entity = 'user'");
    check('user and role assignments are audited', userLog.filter(d => d.action === 'UPDATE').length >= 3 && userLog.some(d => d.action === 'CREATE'), userLog.length);

    // ── the ledger is untouched by all of this ──
    r = await call('GET', '/inventory/reconciliation');
    check('ledger still reconciles', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 200));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of [org, B.org]) {
      for (const q of [
        'DELETE FROM transfer_events WHERE organization_id=@o', 'DELETE FROM location_access WHERE location_id IN (SELECT id FROM stock_locations WHERE organization_id=@o)',
        'DELETE FROM stock_count_items WHERE count_id IN (SELECT id FROM stock_counts WHERE organization_id=@o)', 'DELETE FROM stock_counts WHERE organization_id=@o',
        'DELETE FROM loss_actions WHERE organization_id=@o', 'DELETE FROM supplier_returns WHERE organization_id=@o', 'DELETE FROM quality_disposals WHERE organization_id=@o',
        'DELETE FROM valuation_adjustment_layers WHERE adjustment_id IN (SELECT id FROM valuation_adjustments WHERE organization_id=@o)', 'DELETE FROM valuation_adjustments WHERE organization_id=@o',
        'DELETE FROM batch_quality_events WHERE organization_id=@o', 'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o',
        'DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE organization_id=@o)', 'DELETE FROM stock_transfers WHERE organization_id=@o',
        'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
        'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
        'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sales WHERE organization_id=@o',
        'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
        'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o', 'DELETE FROM warehouses WHERE organization_id=@o',
        'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
        'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
        'DELETE FROM access_roles WHERE organization_id=@o', 'DELETE FROM users WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
        { try { await pool.request().input('o', sql.Int, o).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); } }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
