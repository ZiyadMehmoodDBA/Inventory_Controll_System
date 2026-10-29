// Business types and the optional modules each one enables. Keep the ids in step with
// src/lib/businessTypes.ts. The server enforces modules; the UI only mirrors them.
const { getPool, sql } = require('../db');

const BUSINESS_TYPES = [
  'general_store', 'tyre_shop', 'auto_parts', 'auto_workshop', 'grocery', 'pharmacy',
  'perfumes_cosmetics', 'clothing', 'electronics', 'hardware', 'restaurant',
  'stationery', 'wholesale', 'manufacturing', 'other',
];
const DEFAULT_TYPE = 'general_store';

// Optional modules by business type. Everything not listed here is core and always on.
const MODULES_BY_TYPE = {
  tyre_shop: ['tyreFitment', 'tyreCatalog'],
};

const modulesFor = type => MODULES_BY_TYPE[type] || [];

async function getBusinessType(orgId) {
  const pool = await getPool();
  const r = await pool.request().input('o', sql.Int, orgId)
    .query("SELECT value FROM settings WHERE organization_id = @o AND [key] = 'business_type'");
  const v = r.recordset[0]?.value;
  return BUSINESS_TYPES.includes(v) ? v : DEFAULT_TYPE;
}

async function isModuleEnabled(orgId, module) {
  return modulesFor(await getBusinessType(orgId)).includes(module);
}

// Route guard: 403 when the caller's organisation has not enabled the module.
function requireModule(module) {
  return async (req, res, next) => {
    try {
      if (!(await isModuleEnabled(req.user.orgId, module))) {
        return res.status(403).json({ error: 'This module is not enabled for your business type.', code: 'MODULE_DISABLED' });
      }
      next();
    } catch (err) {
      console.error('[modules]', err.message);
      res.status(500).json({ error: 'Could not verify module access' });
    }
  };
}

module.exports = { BUSINESS_TYPES, DEFAULT_TYPE, modulesFor, getBusinessType, isModuleEnabled, requireModule };
