const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const { getPool, sql } = require('../db');

const JWT_SECRET              = process.env.JWT_SECRET;
const JWT_EXPIRY              = '15m';
const REFRESH_EXPIRY_DEFAULT  = 1  * 24 * 60 * 60 * 1000;  // 1 day
const REFRESH_EXPIRY_REMEMBER = 30 * 24 * 60 * 60 * 1000;  // 30 days

// Auth rate limit — covers ALL /api/auth/* routes (login, register, refresh, etc.)
// 10/15min was too tight: a single user logging in + a couple refreshes can burn through it.
// 50/15min is still small enough to rate-limit credential-stuffing attacks while leaving
// room for legitimate refresh-token churn and dev/test runs.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(authLimiter);

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}
function sanitize(s, maxLen = 200) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, maxLen);
}

function issueAccessToken(user) {
  return jwt.sign(
    { userId: user.id, orgId: user.organization_id, branchId: user.branch_id, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

async function createRefreshToken(pool, userId, rememberMe) {
  const token     = crypto.randomBytes(48).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresMs = rememberMe ? REFRESH_EXPIRY_REMEMBER : REFRESH_EXPIRY_DEFAULT;
  const expiresAt = new Date(Date.now() + expiresMs);

  await pool.request()
    .input('user_id',    sql.Int,       userId)
    .input('token_hash', sql.NVarChar,  tokenHash)
    .input('expires_at', sql.DateTime2, expiresAt)
    .query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (@user_id, @token_hash, @expires_at)');

  return token;
}

// POST /api/auth/register
// Creates: organization → first branch (Main Branch) → org_admin user
router.post('/register', async (req, res) => {
  try {
    const {
      fullName, email, password, phone,
      org_name, org_type, org_address, org_phone, org_email,
      branch_name,
    } = req.body || {};

    const name        = sanitize(fullName, 100);
    const cleanEmail  = sanitize(email, 100).toLowerCase();
    const cleanPhone  = sanitize(phone, 50);
    const cleanOrgName = sanitize(org_name, 200);

    if (!name)                     return res.status(400).json({ error: 'Full name is required' });
    if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!cleanOrgName)             return res.status(400).json({ error: 'Organization name is required' });

    const pool = await getPool();

    // Check duplicate email
    const existing = await pool.request()
      .input('email', sql.NVarChar, cleanEmail)
      .query('SELECT id FROM users WHERE email = @email');
    if (existing.recordset.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Generate org code
    let orgCode = cleanOrgName.toUpperCase().replace(/[^A-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 20);
    const dupCode = await pool.request()
      .input('code', sql.NVarChar, orgCode)
      .query('SELECT id FROM organizations WHERE code = @code');
    if (dupCode.recordset.length > 0) orgCode = `${orgCode}-${Date.now().toString().slice(-4)}`;

    // 1. Create organization
    const orgRes = await pool.request()
      .input('name',    sql.NVarChar, cleanOrgName)
      .input('code',    sql.NVarChar, orgCode)
      .input('type',    sql.NVarChar, sanitize(org_type, 50) || 'retail')
      .input('address', sql.NVarChar, sanitize(org_address, 500))
      .input('phone',   sql.NVarChar, sanitize(org_phone, 50))
      .input('email',   sql.NVarChar, sanitize(org_email, 200))
      .query(`
        INSERT INTO organizations (name, code, type, address, phone, email)
        OUTPUT INSERTED.*
        VALUES (@name, @code, @type, @address, @phone, @email)
      `);
    const org = orgRes.recordset[0];

    // 2. Create first branch
    const firstBranch = sanitize(branch_name, 200) || 'Main Branch';
    const branchRes = await pool.request()
      .input('org_id',  sql.Int,      org.id)
      .input('name',    sql.NVarChar, firstBranch)
      .input('code',    sql.NVarChar, 'MAIN')
      .input('address', sql.NVarChar, sanitize(org_address, 500))
      .input('phone',   sql.NVarChar, sanitize(org_phone, 50))
      .query(`
        INSERT INTO branches (organization_id, name, code, address, phone)
        OUTPUT INSERTED.*
        VALUES (@org_id, @name, @code, @address, @phone)
      `);
    const branch = branchRes.recordset[0];

    // 3. Seed default settings for this org
    const defaults = [
      ['company_name',        cleanOrgName],
      ['company_tagline',     ''],
      ['company_address',     sanitize(org_address, 500)],
      ['company_phone',       sanitize(org_phone, 50)],
      ['company_email',       sanitize(org_email, 200)],
      ['invoice_prefix',      'INV'],
      ['po_prefix',           'PO'],
      ['default_tax_rate',    '15'],
      ['payment_due_days',    '30'],
      ['default_sale_status', 'pending'],
      ['currency',            'PKR'],
      ['announcement',        ''],
    ];
    for (const [key, value] of defaults) {
      await pool.request()
        .input('org_id', sql.Int,      org.id)
        .input('key',    sql.NVarChar, key)
        .input('value',  sql.NVarChar, value)
        .query(`INSERT INTO settings (organization_id, [key], value) VALUES (@org_id, @key, @value)`);
    }

    // 4. Create org_admin user (branch_id = NULL → sees all branches)
    const hash = await bcrypt.hash(password, 12);
    await pool.request()
      .input('name',            sql.NVarChar, name)
      .input('email',           sql.NVarChar, cleanEmail)
      .input('phone',           sql.NVarChar, cleanPhone)
      .input('password_hash',   sql.NVarChar, hash)
      .input('role',            sql.NVarChar, 'org_admin')
      .input('organization_id', sql.Int,      org.id)
      .query(`
        INSERT INTO users (name, email, phone, password_hash, role, organization_id)
        VALUES (@name, @email, @phone, @password_hash, @role, @organization_id)
      `);

    res.status(201).json({ success: true, organization_id: org.id, branch_id: branch.id });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body || {};
    const cleanEmail = sanitize(email, 100).toLowerCase();
    if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (!password)                 return res.status(400).json({ error: 'Password is required' });

    const pool = await getPool();
    const result = await pool.request()
      .input('email', sql.NVarChar, cleanEmail)
      .query(`
        SELECT u.id, u.name, u.email, u.role, u.password_hash, u.is_active,
               u.organization_id, u.branch_id,
               o.name AS org_name, o.code AS org_code, o.currency AS org_currency
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.email = @email
      `);

    const user = result.recordset[0];
    const dummyHash = '$2a$12$invaliddummyhashtopreventtimingattacks000000000000000000';
    const hashToCheck = user ? user.password_hash : dummyHash;
    const match = await bcrypt.compare(password, hashToCheck);

    if (!user || !match)  return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.is_active)  return res.status(403).json({ error: 'Your account has been deactivated' });

    // Fetch branches for this org
    const branchRes = await pool.request()
      .input('org_id', sql.Int, user.organization_id || 1)
      .query('SELECT id, name, code, address, phone FROM branches WHERE organization_id = @org_id AND is_active = 1 ORDER BY name');

    const accessToken  = issueAccessToken(user);
    const refreshToken = await createRefreshToken(pool, user.id, !!rememberMe);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id:              user.id,
        name:            user.name,
        email:           user.email,
        role:            user.role,
        organization_id: user.organization_id || 1,
        branch_id:       user.branch_id,
        organization: {
          name:     user.org_name,
          code:     user.org_code,
          currency: user.org_currency || 'PKR',
        },
        branches: branchRes.recordset,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

  try {
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const pool = await getPool();

    const result = await pool.request()
      .input('token_hash', sql.NVarChar, tokenHash)
      .query(`
        SELECT rt.user_id, u.role, u.organization_id, u.branch_id, u.is_active,
               u.name, u.email
        FROM refresh_tokens rt
        JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = @token_hash AND rt.expires_at > GETDATE()
      `);

    if (!result.recordset.length) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }
    const row = result.recordset[0];
    if (!row.is_active) return res.status(403).json({ error: 'Account deactivated' });

    const accessToken = jwt.sign(
      { userId: row.user_id, orgId: row.organization_id, branchId: row.branch_id, role: row.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    res.json({
      accessToken,
      user: {
        name:            row.name,
        email:           row.email,
        role:            row.role,
        organization_id: row.organization_id,
        branch_id:       row.branch_id,
      },
    });
  } catch (err) {
    console.error('Refresh error:', err.message);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// POST /api/auth/forgot-password
// There is no email service, so a reset token must NEVER be returned to the caller: anyone who knew an address could take over the account.
// The answer is identical whether or not the account exists (no user enumeration). An administrator resets the password from Settings -> Users.
router.post('/forgot-password', async (req, res) => {
  const cleanEmail = sanitize((req.body || {}).email, 100).toLowerCase();
  if (!isValidEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address' });
  console.warn(`[auth] password reset requested for an account; no self-service reset is available (administrator must reset it)`);
  res.json({ message: 'Self-service password reset is not available. Ask your administrator to reset your password from Settings > Users.' });
});

router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body || {};
    if (!resetToken) return res.status(400).json({ error: 'Reset token is required' });
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    let payload;
    try {
      payload = jwt.verify(resetToken, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Reset link has expired or is invalid. Please request a new one.' });
    }
    if (payload.type !== 'password-reset') {
      return res.status(401).json({ error: 'Invalid reset token' });
    }

    const pool = await getPool();
    const userRes = await pool.request()
      .input('id', sql.Int, payload.userId)
      .query('SELECT id, is_active FROM users WHERE id = @id');

    if (!userRes.recordset.length || !userRes.recordset[0].is_active) {
      return res.status(404).json({ error: 'Account not found or has been deactivated.' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.request()
      .input('id',   sql.Int,      payload.userId)
      .input('hash', sql.NVarChar, hash)
      .query('UPDATE users SET password_hash = @hash WHERE id = @id');

    // Invalidate all refresh tokens so every existing session is signed out
    await pool.request()
      .input('user_id', sql.Int, payload.userId)
      .query('DELETE FROM refresh_tokens WHERE user_id = @user_id');

    res.json({ success: true });
  } catch (err) {
    console.error('Reset-password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password. Please try again.' });
  }
});

// POST /api/auth/google
// Validates a Google ID token (via Google's tokeninfo endpoint) and issues our own JWTs.
// The user must already have an account — Google sign-in is an authentication method,
// not a self-registration path (organisation/branch context is required).
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body || {};
    if (!credential || typeof credential !== 'string') {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    // Fail closed: without the application's client id any Google-signed token (issued to any other app) would be accepted.
    if (!process.env.GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Google sign-in is not configured on the server.' });

    // Verify the ID token with Google — this checks signature + expiry server-side
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );
    if (!tokenRes.ok) {
      return res.status(401).json({ error: 'Invalid Google token. Please try again.' });
    }
    const tokenInfo = await tokenRes.json();

    if (tokenInfo.aud !== process.env.GOOGLE_CLIENT_ID || !['accounts.google.com', 'https://accounts.google.com'].includes(tokenInfo.iss)) {
      return res.status(401).json({ error: 'Invalid Google token. Please try again.' });
    }
    if (!tokenInfo.email_verified || tokenInfo.email_verified === 'false') {
      return res.status(401).json({ error: 'Google account email is not verified.' });
    }
    const email = (tokenInfo.email || '').toLowerCase().trim();
    if (!email) return res.status(401).json({ error: 'Could not retrieve email from Google.' });

    const pool = await getPool();

    const result = await pool.request()
      .input('email', sql.NVarChar, email)
      .query(`
        SELECT u.id, u.name, u.email, u.role, u.is_active,
               u.organization_id, u.branch_id,
               o.name AS org_name, o.code AS org_code, o.currency AS org_currency
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.email = @email
      `);

    if (!result.recordset.length) {
      return res.status(404).json({
        error: `No TuneGEN account found for ${email}. Ask your administrator to create one.`,
      });
    }

    const user = result.recordset[0];
    if (!user.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your administrator.' });
    }

    const branchRes = await pool.request()
      .input('org_id', sql.Int, user.organization_id || 1)
      .query('SELECT id, name, code, address, phone FROM branches WHERE organization_id = @org_id AND is_active = 1 ORDER BY name');

    const accessToken  = issueAccessToken(user);
    const refreshToken = await createRefreshToken(pool, user.id, false);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id:              user.id,
        name:            user.name,
        email:           user.email,
        role:            user.role,
        organization_id: user.organization_id || 1,
        branch_id:       user.branch_id,
        organization: {
          name:     user.org_name,
          code:     user.org_code,
          currency: user.org_currency || 'PKR',
        },
        branches: branchRes.recordset,
      },
    });
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.status(500).json({ error: 'Google authentication failed. Please try again.' });
  }
});

// POST /api/auth/demo
// One-click demo login — no credentials required.
// The demo user is pre-seeded by setupDatabase() (role = 'demo', org code = 'DEMO').
router.post('/demo', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('email', sql.NVarChar, 'demo@tunegen.app')
      .query(`
        SELECT u.id, u.name, u.email, u.role, u.is_active,
               u.organization_id, u.branch_id,
               o.name AS org_name, o.code AS org_code, o.currency AS org_currency
        FROM users u
        LEFT JOIN organizations o ON o.id = u.organization_id
        WHERE u.email = @email
      `);

    if (!result.recordset.length) {
      return res.status(503).json({ error: 'Demo mode is not configured on this server.' });
    }
    const user = result.recordset[0];
    if (!user.is_active) {
      return res.status(503).json({ error: 'Demo account is currently unavailable.' });
    }

    const branchRes = await pool.request()
      .input('org_id', sql.Int, user.organization_id)
      .query('SELECT id, name, code FROM branches WHERE organization_id = @org_id AND is_active = 1 ORDER BY name');

    const accessToken  = issueAccessToken(user);
    const refreshToken = await createRefreshToken(pool, user.id, false);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id:              user.id,
        name:            user.name,
        email:           user.email,
        role:            user.role,
        organization_id: user.organization_id,
        branch_id:       user.branch_id,
        organization: {
          name:     user.org_name,
          code:     user.org_code,
          currency: user.org_currency || 'PKR',
        },
        branches: branchRes.recordset,
      },
    });
  } catch (err) {
    console.error('Demo auth error:', err.message);
    res.status(500).json({ error: 'Failed to start demo session. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    try {
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const pool = await getPool();
      await pool.request()
        .input('token_hash', sql.NVarChar, tokenHash)
        .query('DELETE FROM refresh_tokens WHERE token_hash = @token_hash');
    } catch (err) {
      console.error('Logout cleanup error:', err.message);
    }
  }
  res.json({ success: true });
});

module.exports = router;
