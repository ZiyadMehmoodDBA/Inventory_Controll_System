const { sql } = require('../db');

/**
 * Write an immutable audit log entry.
 * Fire-and-forget: never throws — audit failures are logged but do NOT
 * propagate to the caller so the main operation always completes.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {{ orgId, branchId, userId, action, entity, entityId, before, after }} params
 *   action  : 'CREATE' | 'UPDATE' | 'DELETE'
 *   entity  : 'sales' | 'inventory' | 'products'
 *   before/after: plain objects or null
 */
async function writeAudit(pool, { orgId, branchId, userId, action, entity, entityId, before, after }) {
  try {
    // Look up user's display name — non-fatal if it fails
    let userName = 'System';
    if (userId) {
      try {
        const u = await pool.request()
          .input('uid', sql.Int, userId)
          .query('SELECT name FROM users WHERE id = @uid');
        userName = u.recordset[0]?.name ?? 'Unknown';
      } catch { /* ignore */ }
    }

    await pool.request()
      .input('orgId',    sql.Int,             orgId    || 1)
      .input('branchId', sql.Int,             branchId || 1)
      .input('userId',   sql.Int,             userId   || null)
      .input('userName', sql.NVarChar(100),   userName)
      .input('action',   sql.NVarChar(20),    action)
      .input('entity',   sql.NVarChar(50),    entity)
      .input('entityId', sql.Int,             entityId || null)
      .input('before',   sql.NVarChar(sql.MAX), before ? JSON.stringify(before) : null)
      .input('after',    sql.NVarChar(sql.MAX), after  ? JSON.stringify(after)  : null)
      .query(`
        INSERT INTO audit_logs
          (organization_id, branch_id, user_id, user_name, action, entity, entity_id, before_json, after_json)
        VALUES
          (@orgId, @branchId, @userId, @userName, @action, @entity, @entityId, @before, @after)
      `);
  } catch (err) {
    console.error('[Audit] write failed:', err.message);
  }
}

module.exports = { writeAudit };
