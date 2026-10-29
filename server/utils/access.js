// Who may use which storage location.
//   org_admin            every location of the organisation
//   branch_manager       every location of their own branch
//   staff / others       locations of their own branch; and, once a location lists users in location_access, only those users
//                        (per action: issue = sales / dispatch / write-offs, receive = goods in / transfer receipt, count = stock counts)
// A location with no access rows is open to its branch, so nothing changes until someone opts a location in.
const { sql } = require('../db');

const ACTIONS = { issue: 'can_issue', receive: 'can_receive', count: 'can_count' };
const LABEL = { issue: 'issue stock from', receive: 'receive stock into', count: 'count' };

// StockError is required lazily: stock.js requires this file.
const deny = (message, status = 403, code = 'LOCATION_FORBIDDEN') => { const { StockError } = require('./stock'); return new StockError(code, message, status); };
const DENIALS = new Set(['LOCATION_FORBIDDEN', 'INVALID_LOCATION']);

/** Throws a StockError (403 LOCATION_FORBIDDEN) when `user` ({ userId, role, branchId }) may not perform `action` at the location. Returns the location row. */
async function assertLocationAccess(conn, orgId, user, locationId, action) {
  const col = ACTIONS[action];
  if (!col) throw new Error(`Unknown location action ${action}`);
  const rq = conn.request ? conn.request() : new sql.Request(conn);
  const r = await rq.input('o', sql.Int, orgId).input('l', sql.Int, locationId).input('u', sql.Int, user.userId ?? null)
    .query(`SELECT l.id, l.branch_id, l.name, l.is_active, l.kind, l.warehouse_id,
                   (SELECT COUNT(*) FROM location_access a WHERE a.location_id = l.id) AS rules,
                   (SELECT ${col} FROM location_access a WHERE a.location_id = l.id AND a.user_id = @u) AS allowed
            FROM stock_locations l WHERE l.id = @l AND l.organization_id = @o`);
  const loc = r.recordset[0];
  if (!loc) throw deny('Stock location not found', 404, 'INVALID_LOCATION');
  if (user.role === 'org_admin') return loc;
  if (user.branchId != null && loc.branch_id !== user.branchId) throw deny(`You cannot ${LABEL[action]} ${loc.name}: it belongs to another branch`);
  if (user.role === 'branch_manager') return loc;
  if (loc.rules > 0 && !loc.allowed) throw deny(`You are not authorised to ${LABEL[action]} ${loc.name}`);
  return loc;
}

/** Same check without throwing: true / false. */
async function canAccessLocation(conn, orgId, user, locationId, action) {
  try { await assertLocationAccess(conn, orgId, user, locationId, action); return true; } catch (e) { if (DENIALS.has(e.code)) return false; throw e; }
}

module.exports = { assertLocationAccess, canAccessLocation };
