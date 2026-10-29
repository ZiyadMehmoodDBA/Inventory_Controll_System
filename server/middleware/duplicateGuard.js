// Stops the same transaction being posted twice.
//  1. Idempotency-Key header (preferred): the first response is stored and replayed for retries;
//     a retry that arrives while the first is still running gets 409.
//  2. No header: an identical POST (same user, URL and body) repeated within a few seconds is rejected,
//     which covers double-clicks and impatient retries without any client change.
const crypto = require('crypto');
const { getPool, sql } = require('../db');

const WINDOW_MS = 5000;
const recent = new Map();   // fingerprint -> timestamp

setInterval(() => { const now = Date.now(); for (const [k, t] of recent) if (now - t > WINDOW_MS) recent.delete(k); }, 30000).unref();

const KEY_RE = /^[A-Za-z0-9._:-]{8,100}$/;

function duplicateGuard(allowedPaths = /^\/(bulk)?$/) {
  return async (req, res, next) => {
    if (req.method !== 'POST' || !allowedPaths.test(req.path) || !req.user) return next();

    const header = req.get('Idempotency-Key');
    if (header) {
      if (!KEY_RE.test(header)) return res.status(400).json({ error: 'Invalid Idempotency-Key' });
      try {
        const pool = await getPool();
        const route = `${req.baseUrl}${req.path}`.slice(0, 100);
        try {
          await pool.request().input('o', sql.Int, req.user.orgId).input('k', sql.NVarChar(100), header).input('r', sql.NVarChar(100), route)
            .query('INSERT INTO idempotency_keys (organization_id, [key], route) VALUES (@o, @k, @r)');
        } catch (e) {
          if (e.number !== 2627 && e.number !== 2601) throw e;   // not a duplicate-key error
          const ex = await pool.request().input('o', sql.Int, req.user.orgId).input('k', sql.NVarChar(100), header)
            .query('SELECT route, status_code, response_json FROM idempotency_keys WHERE organization_id = @o AND [key] = @k');
          const row = ex.recordset[0];
          if (row?.route === route && row.status_code) {
            res.set('Idempotent-Replay', 'true');
            return res.status(row.status_code).json(JSON.parse(row.response_json));
          }
          return res.status(409).json({ error: 'A request with this Idempotency-Key is already being processed.', code: 'DUPLICATE_REQUEST' });
        }
        // Store the outcome when the handler responds; failures free the key so the client can retry.
        const json = res.json.bind(res);
        res.json = body => {
          const store = res.statusCode < 500
            ? pool.request().input('o', sql.Int, req.user.orgId).input('k', sql.NVarChar(100), header).input('s', sql.Int, res.statusCode)
                .input('b', sql.NVarChar(sql.MAX), JSON.stringify(body)).query('UPDATE idempotency_keys SET status_code = @s, response_json = @b WHERE organization_id = @o AND [key] = @k')
            : pool.request().input('o', sql.Int, req.user.orgId).input('k', sql.NVarChar(100), header)
                .query('DELETE FROM idempotency_keys WHERE organization_id = @o AND [key] = @k');
          store.catch(err => console.error('[idempotency] store failed:', err.message));
          return json(body);
        };
        return next();
      } catch (err) {
        console.error('[idempotency]', err.message);
        return res.status(500).json({ error: 'Could not verify request uniqueness' });
      }
    }

    const fp = crypto.createHash('sha256').update(`${req.user.userId}|${req.baseUrl}${req.path}|${JSON.stringify(req.body ?? {})}`).digest('hex');
    const last = recent.get(fp);
    if (last && Date.now() - last < WINDOW_MS) {
      return res.status(409).json({ error: 'This looks like a duplicate submission and was ignored. Wait a few seconds if you really meant to repeat it.', code: 'DUPLICATE_REQUEST' });
    }
    recent.set(fp, Date.now());
    // A failed attempt must not block a corrected retry.
    res.on('finish', () => { if (res.statusCode >= 400) recent.delete(fp); });
    next();
  };
}

module.exports = { duplicateGuard };
