const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { requireRole }  = require('../middleware/auth');
const P = require('../utils/permissions');

// All audit endpoints are org_admin only
router.use(P.requirePermission('reports.audit'));

// GET /api/audit?entity=&action=&from=&to=&page=1&limit=50
router.get('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { entity, action, from, to } = req.query;
    const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const pool = await getPool();

    const rows = await pool.request()
      .input('orgId',    sql.Int,      orgId)
      .input('entity',   sql.NVarChar, entity || null)
      .input('action',   sql.NVarChar, action || null)
      .input('from',     sql.Date,     from   || null)
      .input('to',       sql.Date,     to     || null)
      .input('offset',   sql.Int,      offset)
      .input('limit',    sql.Int,      limit)
      .query(`
        SELECT
          id, organization_id, branch_id, user_id, user_name,
          action, entity, entity_id, before_json, after_json, created_at
        FROM audit_logs
        WHERE organization_id = @orgId
          AND (@entity IS NULL OR entity   = @entity)
          AND (@action IS NULL OR action   = @action)
          AND (@from   IS NULL OR CAST(created_at AS DATE) >= @from)
          AND (@to     IS NULL OR CAST(created_at AS DATE) <= @to)
        ORDER BY created_at DESC
        OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
      `);

    const countRes = await pool.request()
      .input('orgId',  sql.Int,      orgId)
      .input('entity', sql.NVarChar, entity || null)
      .input('action', sql.NVarChar, action || null)
      .input('from',   sql.Date,     from   || null)
      .input('to',     sql.Date,     to     || null)
      .query(`
        SELECT COUNT(*) AS total FROM audit_logs
        WHERE organization_id = @orgId
          AND (@entity IS NULL OR entity = @entity)
          AND (@action IS NULL OR action = @action)
          AND (@from   IS NULL OR CAST(created_at AS DATE) >= @from)
          AND (@to     IS NULL OR CAST(created_at AS DATE) <= @to)
      `);

    res.json({
      logs:  rows.recordset,
      total: countRes.recordset[0].total,
      page,
      limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
