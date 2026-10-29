'use strict';
/**
 * validateBranchContext — Option A security middleware.
 *
 * For org_admin users (whose JWT has branchId: null), they supply a target
 * branch via the X-Branch-ID header.  This middleware verifies that the
 * requested branch actually belongs to the admin's own organisation before
 * the request reaches any route handler.
 *
 * Branch-scoped users already have their branchId baked into the JWT (issued
 * at login), so they bypass this check entirely.
 *
 * Cache: TTL-based in-memory Map — avoids a DB round-trip on every request
 * while remaining consistent within ~5 minutes of a branch being deleted.
 * Call invalidateBranchCache() in branch-delete routes for tighter consistency.
 */

const { getPool, sql } = require('../db');

const _cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

async function _isBranchValid(orgId, branchId) {
  const key = `${orgId}:${branchId}`;
  const cached = _cache.get(key);
  if (cached && Date.now() < cached.expires) return cached.valid;

  const pool = await getPool();
  const res  = await pool.request()
    .input('id',     sql.Int, branchId)
    .input('org_id', sql.Int, orgId)
    .query('SELECT 1 AS ok FROM branches WHERE id = @id AND organization_id = @org_id');

  const valid = res.recordset.length > 0;
  _cache.set(key, { valid, expires: Date.now() + TTL_MS });
  return valid;
}

/** Call this when a branch is deleted so the cache doesn't serve stale "valid" entries. */
function invalidateBranchCache(orgId, branchId) {
  _cache.delete(`${orgId}:${branchId}`);
}

async function validateBranchContext(req, res, next) {
  // Only org_admins have branchId === null in their JWT.
  // Branch-scoped users are fine — their branch is already verified at login.
  if (!req.user || req.user.branchId != null) return next();

  const headerVal = req.headers['x-branch-id'];
  if (!headerVal) return next(); // no header → context.js will default to branch 1

  const branchId = parseInt(headerVal, 10);
  if (!branchId || branchId < 1) return next(); // malformed → let context.js handle default

  const orgId = req.user.orgId;

  try {
    const valid = await _isBranchValid(orgId, branchId);
    if (!valid) {
      return res.status(403).json({
        error: 'Branch does not belong to your organisation',
        code:  'INVALID_BRANCH',
      });
    }
    next();
  } catch (err) {
    // Fail open: org_id column filter in every SQL query still prevents cross-org data leaks.
    console.error('[validateBranchContext] DB error:', err.message);
    next();
  }
}

module.exports = { validateBranchContext, invalidateBranchCache };
