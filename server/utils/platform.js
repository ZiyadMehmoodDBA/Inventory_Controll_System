// Platform operators: the few users who may run and configure things that affect the whole database (every organisation's data), such as backups.
// An organisation administrator is NOT automatically one. The flag lives on users.is_platform_admin, is read live on every request, and is
// changed only by scripts/grant-platform-admin.js, never through the API.
const { getPool, sql } = require('../db');
const { AppError } = require('./errors');

async function isPlatformAdmin(user) {
  if (!user?.userId || user.role !== 'org_admin') return false;
  const r = await (await getPool()).request().input('id', sql.Int, user.userId)
    .query('SELECT is_platform_admin FROM users WHERE id = @id AND is_active = 1');
  return !!r.recordset[0]?.is_platform_admin;
}

/** Route guard, after authentication. */
async function requirePlatformAdmin(req, res, next) {
  try {
    if (await isPlatformAdmin(req.user)) return next();
    next(new AppError('Only platform administrators can do this', 403, 'PLATFORM_ONLY'));
  } catch (e) { next(e); }
}

module.exports = { isPlatformAdmin, requirePlatformAdmin };
