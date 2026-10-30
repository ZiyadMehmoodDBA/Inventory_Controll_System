// Grant or revoke platform-administrator rights (backup console and other database-wide controls).
//   node scripts/grant-platform-admin.js list
//   node scripts/grant-platform-admin.js grant  <email>
//   node scripts/grant-platform-admin.js revoke <email>
// Deliberately a script and not an API: an organisation administrator must not be able to promote themselves. Only organisation
// administrators can hold the flag. Changes are written to the audit log.
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { getPool, sql } = require('../db');
const { writeAudit } = require('../utils/audit');

(async () => {
  const [cmd, email] = process.argv.slice(2);
  const pool = await getPool();
  let code = 0;
  try {
    if (cmd === 'list') {
      console.table((await pool.request().query("SELECT u.id, u.name, u.email, o.name AS organisation FROM users u JOIN organizations o ON o.id = u.organization_id WHERE u.is_platform_admin = 1 AND u.is_active = 1 ORDER BY u.id")).recordset);
    } else if ((cmd === 'grant' || cmd === 'revoke') && email) {
      const u = (await pool.request().input('e', sql.NVarChar(200), email).query('SELECT id, name, role, organization_id, is_active FROM users WHERE LOWER(email) = LOWER(@e)')).recordset;
      if (u.length !== 1) throw new Error(u.length ? 'More than one user has that email' : 'No user with that email');
      const user = u[0];
      if (cmd === 'grant' && (user.role !== 'org_admin' || !user.is_active)) throw new Error('Only an active organisation administrator can be a platform administrator');
      await pool.request().input('i', sql.Int, user.id).input('f', sql.Bit, cmd === 'grant').query('UPDATE users SET is_platform_admin = @f WHERE id = @i');
      await writeAudit(pool, { orgId: user.organization_id, branchId: 1, userId: null, action: 'UPDATE', entity: 'platform_admin', entityId: user.id, before: null, after: { email, platform_admin: cmd === 'grant' } });
      console.log(`${cmd === 'grant' ? 'granted to' : 'revoked from'} ${user.name} <${email}>`);
    } else { console.log('usage: node scripts/grant-platform-admin.js list | grant <email> | revoke <email>'); code = 2; }
  } catch (e) { console.error('FAILED:', e.message); code = 1; }
  process.exit(code);
})();
