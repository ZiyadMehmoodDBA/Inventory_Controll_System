// Backup configuration: stored in platform_settings (editable in the console), with the environment variables as the fallback so an
// installation that has only a .env keeps working. Paths are on the SQL SERVER host and end up inside BACKUP DATABASE ... TO DISK, so they are
// validated strictly here before they are ever saved.
const { getPool, sql } = require('../db');

const KEYS = ['backup_enabled', 'backup_dir', 'offsite_dir', 'retention_days'];
let cache = null, cachedAt = 0;

// A drive path (C:\folder\sub) or a UNC share (\\server\share\folder). No wildcards, no quotes, no .. segments, no control characters.
const BAD = /[*?"<>|\u0000-\u001f]/;
function checkPath(value) {
  const p = String(value ?? '').trim();
  if (!p) return null;
  if (p.length > 400) throw new Error('The folder path is too long');
  if (BAD.test(p) || p.includes("'")) throw new Error('The folder path contains characters that are not allowed');
  if (p.split(/[\\/]+/).includes('..')) throw new Error('The folder path may not contain ".."');
  if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\/:]+[\\/][^\\/:]+)/.test(p)) throw new Error('Use a full path on the database server, such as D:\\Backups or \\\\fileserver\\sqlbackups');
  return p.replace(/\//g, '\\').replace(/\\+$/, '');
}
const isUnc = p => !!p && p.startsWith('\\\\');

async function load(force = false) {
  if (!force && cache && Date.now() - cachedAt < 15000) return cache;
  const pool = await getPool();
  const rows = (await pool.request().query(`SELECT key_name, value FROM platform_settings WHERE key_name IN (${KEYS.map(k => `'${k}'`).join(',')})`)).recordset;
  const db = Object.fromEntries(rows.map(r => [r.key_name, r.value]));
  const env = process.env;
  const pick = (key, envName, fallback) => (db[key] != null && db[key] !== '' ? { value: db[key], source: 'console' } : env[envName] ? { value: env[envName], source: 'environment' } : { value: fallback, source: 'default' });
  const enabled = db.backup_enabled != null ? db.backup_enabled === 'on' : String(env.BACKUP_JOB || '').toLowerCase() === 'on';
  cache = {
    enabled,
    backup_dir: pick('backup_dir', 'BACKUP_DIR', null),
    offsite_dir: pick('offsite_dir', 'OFFSITE_BACKUP_DIR', null),
    retention_days: (() => { const r = pick('retention_days', 'BACKUP_RETENTION_DAYS', '14'); return { value: Math.max(1, Number(r.value) || 14), source: r.source }; })(),
  };
  cachedAt = Date.now();
  return cache;
}

/** Save a validated change. `change` holds any of: enabled (bool), backup_dir, offsite_dir, retention_days. An empty path clears the console value. */
async function save(change, userId) {
  const pool = await getPool();
  const set = async (key, value) => pool.request().input('k', sql.NVarChar(60), key).input('v', sql.NVarChar(1000), value).input('u', sql.Int, userId ?? null).query(`
    MERGE platform_settings AS t USING (SELECT @k AS key_name) AS s ON t.key_name = s.key_name
    WHEN MATCHED THEN UPDATE SET value = @v, updated_at = SYSUTCDATETIME(), updated_by = @u
    WHEN NOT MATCHED THEN INSERT (key_name, value, updated_by) VALUES (@k, @v, @u);`);
  if (change.enabled !== undefined) await set('backup_enabled', change.enabled ? 'on' : 'off');
  if (change.backup_dir !== undefined) await set('backup_dir', checkPath(change.backup_dir) ?? '');
  if (change.offsite_dir !== undefined) await set('offsite_dir', checkPath(change.offsite_dir) ?? '');
  if (change.retention_days !== undefined) await set('retention_days', String(change.retention_days));
  cache = null;
  return load(true);
}

module.exports = { load, save, checkPath, isUnc };
