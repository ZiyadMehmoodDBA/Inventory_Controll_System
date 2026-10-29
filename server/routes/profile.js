const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { getPool, sql } = require('../db');

const REFRESH_EXPIRY = 30 * 24 * 60 * 60 * 1000; // 30 days — same as rememberMe

// GET /api/profile — fetch own full profile
router.get('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const pool   = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, userId)
      .query(`
        SELECT
          u.id, u.name, u.email, u.phone, u.role, u.is_active, u.created_at,
          u.first_name, u.last_name, u.address, u.job_title, u.department, u.date_of_birth,
          u.emergency_contact_name, u.emergency_contact_phone, u.emergency_contact_relation,
          u.branch_id,
          o.name  AS organization_name,
          o.code  AS organization_code,
          b.name  AS branch_name
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
        LEFT JOIN branches      b ON b.id = u.branch_id
        WHERE u.id = @id
      `);
    if (!result.recordset.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/profile — update own profile (no role/org changes allowed)
router.put('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      name, first_name, last_name, phone, address, job_title, department, date_of_birth,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relation,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Display name is required' });

    const pool   = await getPool();
    const result = await pool.request()
      .input('id',                         sql.Int,      userId)
      .input('name',                       sql.NVarChar, name.trim().slice(0, 100))
      .input('first_name',                 sql.NVarChar, first_name?.trim().slice(0, 100) || null)
      .input('last_name',                  sql.NVarChar, last_name?.trim().slice(0, 100)  || null)
      .input('phone',                      sql.NVarChar, phone?.trim().slice(0, 50)        || '')
      .input('address',                    sql.NVarChar, address?.trim().slice(0, 500)     || null)
      .input('job_title',                  sql.NVarChar, job_title?.trim().slice(0, 100)   || null)
      .input('department',                 sql.NVarChar, department?.trim().slice(0, 100)  || null)
      .input('date_of_birth',              sql.Date,     date_of_birth || null)
      .input('ec_name',                    sql.NVarChar, emergency_contact_name?.trim().slice(0, 100)    || null)
      .input('ec_phone',                   sql.NVarChar, emergency_contact_phone?.trim().slice(0, 50)   || null)
      .input('ec_relation',                sql.NVarChar, emergency_contact_relation?.trim().slice(0, 50) || null)
      .query(`
        UPDATE users SET
          name                       = @name,
          first_name                 = @first_name,
          last_name                  = @last_name,
          phone                      = @phone,
          address                    = @address,
          job_title                  = @job_title,
          department                 = @department,
          date_of_birth              = @date_of_birth,
          emergency_contact_name     = @ec_name,
          emergency_contact_phone    = @ec_phone,
          emergency_contact_relation = @ec_relation
        OUTPUT
          INSERTED.id, INSERTED.name, INSERTED.email, INSERTED.phone, INSERTED.role,
          INSERTED.first_name, INSERTED.last_name, INSERTED.address,
          INSERTED.job_title, INSERTED.department, INSERTED.date_of_birth,
          INSERTED.emergency_contact_name, INSERTED.emergency_contact_phone,
          INSERTED.emergency_contact_relation, INSERTED.created_at
        WHERE id = @id
      `);
    if (!result.recordset.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/profile/change-password
// Verifies current password → updates hash → invalidates all sessions → issues new refresh token
// The current session stays alive; all other devices are signed out.
router.post('/change-password', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
    if (!newPassword || newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const pool    = await getPool();
    const userRes = await pool.request()
      .input('id', sql.Int, userId)
      .query('SELECT id, password_hash FROM users WHERE id = @id AND is_active = 1');

    if (!userRes.recordset.length) return res.status(404).json({ error: 'User not found' });
    const user = userRes.recordset[0];

    const currentMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!currentMatch) return res.status(401).json({ error: 'Current password is incorrect' });

    const samePassword = await bcrypt.compare(newPassword, user.password_hash);
    if (samePassword)
      return res.status(400).json({ error: 'New password must be different from your current password' });

    const newHash = await bcrypt.hash(newPassword, 12);

    // Update password and invalidate all existing sessions atomically
    await pool.request()
      .input('id',   sql.Int,      userId)
      .input('hash', sql.NVarChar, newHash)
      .query('UPDATE users SET password_hash = @hash WHERE id = @id');

    await pool.request()
      .input('user_id', sql.Int, userId)
      .query('DELETE FROM refresh_tokens WHERE user_id = @user_id');

    // Issue a fresh refresh token for the current session so the user stays logged in
    const rawToken  = crypto.randomBytes(48).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRY);

    await pool.request()
      .input('user_id',    sql.Int,       userId)
      .input('token_hash', sql.NVarChar,  tokenHash)
      .input('expires_at', sql.DateTime2, expiresAt)
      .query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (@user_id, @token_hash, @expires_at)');

    res.json({ success: true, refreshToken: rawToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
