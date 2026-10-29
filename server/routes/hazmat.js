// Hazardous materials & special handling: hazard classes, segregation, permitted locations, inspections, incidents, safety holds and a
// compliance board. The rules themselves live in utils/hazmat.js and are enforced by the stock ledger; this file manages the data.
// Opt-in: nothing here affects an item until it has a hazard class or a storage temperature range.
// Mounted on /api/inventory before routes/inventory.js; unmatched paths fall through.
const express = require('express');
const router  = express.Router();
const { getPool, sql }  = require('../db');
const { requireRole }   = require('../middleware/auth');
const P = require('../utils/permissions');
const { writeAudit }    = require('../utils/audit');
const { getContext }    = require('../context');
const { nextDocNumber } = require('../utils/docNumber');
const { StockError, defaultLocationId } = require('../utils/stock');
const H = require('../utils/hazmat');

const canManage = P.requirePermission('hazmat.manage');
const isManager = req => P.has(req.user, 'hazmat.manage');
const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const text = (v, max) => { const t = String(v ?? '').trim().slice(0, max); return t || null; };
const bool = (v, dflt) => (v === undefined || v === null || v === '' ? dflt : v === true || v === 1 || v === '1' || v === 'true' || v === 'yes');
const num = (v, label, lo, hi) => { if (v === undefined || v === null || v === '') return null; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new StockError('INVALID_NUMBER', `${label} must be a number from ${lo} to ${hi}`, 400); return n; };
const wholeOrNull = (v, label, lo, hi) => { const n = num(v, label, lo, hi); if (n != null && !Number.isInteger(n)) throw new StockError('INVALID_NUMBER', `${label} must be a whole number`, 400); return n; };
const reasonOf = (v, label = 'A reason') => { const r = text(v, 500); if (!r || r.length < 3) throw new StockError('REASON_REQUIRED', `${label} is required`, 400); return r; };

function fail(res, err) {
  if (err instanceof StockError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  console.error('[hazmat]', err.message);
  return res.status(500).json({ error: 'Operation failed' });
}
async function inTransaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try { const out = await fn(tx); await tx.commit(); return out; }
  catch (e) { try { await tx.rollback(); } catch { /* already rolled back */ } throw e; }
}
const audit = async (req, ctx, action, entity, entityId, after) => {
  try { writeAudit(await getPool(), { orgId: ctx.orgId, branchId: ctx.branchId, userId: req.user.userId, action, entity, entityId: entityId || 0, before: null, after }); } catch { /* best effort */ }
};

router.use('/hazmat', (req, res, next) => (req.method !== 'GET' && req.user?.role === 'demo' ? res.status(403).json({ error: 'Not available in demo mode', code: 'DEMO' }) : next()));

const ITEM_NAME = "LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size))";
const dup = e => e && (e.number === 2601 || e.number === 2627);

// ── Meta & settings ─────────────────────────────────────────────────────────
async function settings(conn, orgId) {
  return { sds_max_age_days: await H.companyNumber(conn, orgId, 'hz_sds_max_age_days', H.DEFAULT_SDS_MAX_AGE), location_inspection_days: await H.companyNumber(conn, orgId, 'hz_location_inspection_days', null) };
}
router.get('/hazmat/meta', async (req, res) => {
  try {
    const ctx = getContext(req);
    res.json({ incident_types: Object.entries(H.INCIDENT_TYPES).map(([value, label]) => ({ value, label })), severities: Object.entries(H.SEVERITIES).map(([value, label]) => ({ value, label })),
               packing_groups: H.PACKING_GROUPS, settings: await settings(await getPool(), ctx.orgId) });
  } catch (err) { fail(res, err); }
});
router.put('/hazmat/settings', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const pool = await getPool();
    const set = async (key, v) => {
      if (v === null) await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(100), key).query('DELETE FROM settings WHERE organization_id = @o AND [key] = @k');
      else await pool.request().input('o', sql.Int, ctx.orgId).input('k', sql.NVarChar(100), key).input('v', sql.NVarChar(1000), String(v))
        .query(`IF EXISTS (SELECT 1 FROM settings WHERE organization_id = @o AND [key] = @k) UPDATE settings SET value = @v WHERE organization_id = @o AND [key] = @k
                ELSE INSERT INTO settings (organization_id, [key], value) VALUES (@o, @k, @v)`);
    };
    if (b.sds_max_age_days !== undefined) { const n = wholeOrNull(b.sds_max_age_days, 'SDS maximum age', 30, 3650); await set('hz_sds_max_age_days', n); }
    if (b.location_inspection_days !== undefined) { const n = wholeOrNull(b.location_inspection_days, 'Location inspection interval', 1, 3650); await set('hz_location_inspection_days', n); }
    await audit(req, ctx, 'UPDATE', 'hazmat_settings', 0, b);
    res.json(await settings(pool, ctx.orgId));
  } catch (err) { fail(res, err); }
});

// ── Hazard classes & segregation ───────────────────────────────────────────
const STANDARD = [
  ['2.1', 'Flammable gas', 'UN class 2.1'], ['2.2', 'Non-flammable gas', 'UN class 2.2'], ['2.3', 'Toxic gas', 'UN class 2.3'], ['3', 'Flammable liquid', 'UN class 3'],
  ['4.1', 'Flammable solid', 'UN class 4.1'], ['5.1', 'Oxidiser', 'UN class 5.1'], ['6.1', 'Toxic substance', 'UN class 6.1'], ['8', 'Corrosive', 'UN class 8'],
  ['9', 'Miscellaneous dangerous goods', 'UN class 9'],
];
const STANDARD_PAIRS = [
  ['3', '5.1', 'Flammable liquids must be kept apart from oxidisers'], ['2.1', '5.1', 'Flammable gas must be kept apart from oxidisers'], ['4.1', '5.1', 'Flammable solids must be kept apart from oxidisers'],
  ['2.1', '2.3', 'Flammable and toxic gases are segregated'], ['5.1', '8', 'Oxidisers and corrosives are segregated'], ['3', '8', 'Flammable liquids and corrosives are segregated'],
  ['6.1', '5.1', 'Toxic substances and oxidisers are segregated'],
];

function classBody(b) {
  const code = text(b.code, 20), name = text(b.name, 100);
  if (!code || !name) throw new StockError('NAME_REQUIRED', 'A code and a name are required', 400);
  const kind = b.kind === 'special' ? 'special' : 'hazard';
  return { code, name, kind, regulation: text(b.regulation, 200), description: text(b.description, 500), sds: bool(b.requires_sds, true), tr: bool(b.requires_transport_info, false), active: bool(b.is_active, true) };
}
const classReq = (rq, c) => rq.input('c', sql.NVarChar(20), c.code).input('n', sql.NVarChar(100), c.name).input('k', sql.NVarChar(10), c.kind).input('rg', sql.NVarChar(200), c.regulation)
  .input('d', sql.NVarChar(500), c.description).input('s', sql.Bit, c.sds ? 1 : 0).input('t', sql.Bit, c.tr ? 1 : 0).input('a', sql.Bit, c.active ? 1 : 0);

router.get('/hazmat/classes', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const classes = (await pool.request().input('o', sql.Int, ctx.orgId).query(`
      SELECT c.id, c.code, c.name, c.kind, c.regulation, c.description, c.requires_sds, c.requires_transport_info, c.is_active,
             (SELECT COUNT(*) FROM tires t WHERE t.hazard_class_id = c.id) AS item_count,
             (SELECT COUNT(*) FROM location_hazard_permits p WHERE p.hazard_class_id = c.id) AS permit_count
      FROM hazard_classes c WHERE c.organization_id = @o ORDER BY c.code`)).recordset;
    const pairs = (await pool.request().input('o', sql.Int, ctx.orgId).query('SELECT class_a, class_b, reason FROM hazard_incompatibilities WHERE organization_id = @o')).recordset;
    res.json({ classes, incompatibilities: pairs });
  } catch (err) { fail(res, err); }
});

router.post('/hazmat/classes', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const c = classBody(req.body || {});
    try {
      const r = await classReq((await getPool()).request().input('o', sql.Int, ctx.orgId), c)
        .query('INSERT INTO hazard_classes (organization_id, code, name, kind, regulation, description, requires_sds, requires_transport_info, is_active) OUTPUT INSERTED.id VALUES (@o, @c, @n, @k, @rg, @d, @s, @t, @a)');
      await audit(req, ctx, 'CREATE', 'hazard_class', r.recordset[0].id, c);
      res.status(201).json({ id: r.recordset[0].id });
    } catch (e) { if (dup(e)) throw new StockError('DUPLICATE_CODE', 'A class with this code already exists', 409); throw e; }
  } catch (err) { fail(res, err); }
});

router.put('/hazmat/classes/:id', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const c = classBody(req.body || {});
    try {
      const r = await classReq((await getPool()).request().input('o', sql.Int, ctx.orgId).input('id', sql.Int, int(req.params.id)), c)
        .query('UPDATE hazard_classes SET code = @c, name = @n, kind = @k, regulation = @rg, description = @d, requires_sds = @s, requires_transport_info = @t, is_active = @a WHERE id = @id AND organization_id = @o');
      if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Class not found', 404);
    } catch (e) { if (dup(e)) throw new StockError('DUPLICATE_CODE', 'A class with this code already exists', 409); throw e; }
    await audit(req, ctx, 'UPDATE', 'hazard_class', int(req.params.id), c);
    res.json({ id: int(req.params.id) });
  } catch (err) { fail(res, err); }
});

router.delete('/hazmat/classes/:id', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const id = int(req.params.id);
    await inTransaction(async tx => {
      const use = (await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, ctx.orgId)
        .query('SELECT (SELECT COUNT(*) FROM tires WHERE hazard_class_id = @id AND organization_id = @o) AS n')).recordset[0].n;
      if (use > 0) throw new StockError('CLASS_IN_USE', `${use} item(s) use this class. Reassign them, or mark the class inactive instead.`, 409);
      const r = await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).query('DELETE FROM hazard_classes WHERE id = @id AND organization_id = @o');
      if (!r.rowsAffected[0]) throw new StockError('NOT_FOUND', 'Class not found', 404);
      await new sql.Request(tx).input('id', sql.Int, id).query('DELETE FROM location_hazard_permits WHERE hazard_class_id = @id; DELETE FROM hazard_incompatibilities WHERE class_a = @id OR class_b = @id');
    });
    await audit(req, ctx, 'DELETE', 'hazard_class', id, {});
    res.json({ id });
  } catch (err) { fail(res, err); }
});

// Starting point only: review the list and the pairs against the regulations that apply to you.
router.post('/hazmat/classes/seed-standard', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const out = await inTransaction(async tx => {
      let classes = 0, pairs = 0;
      for (const [code, name, reg] of STANDARD) {
        const r = await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('c', sql.NVarChar(20), code).input('n', sql.NVarChar(100), name).input('rg', sql.NVarChar(200), reg)
          .query("IF NOT EXISTS (SELECT 1 FROM hazard_classes WHERE organization_id = @o AND code = @c) INSERT INTO hazard_classes (organization_id, code, name, kind, regulation, requires_sds) VALUES (@o, @c, @n, 'hazard', @rg, 1)");
        classes += r.rowsAffected[0] ? 1 : 0;
      }
      const ids = Object.fromEntries((await new sql.Request(tx).input('o', sql.Int, ctx.orgId).query('SELECT id, code FROM hazard_classes WHERE organization_id = @o')).recordset.map(x => [x.code, x.id]));
      for (const [a, b, reason] of STANDARD_PAIRS) {
        if (!ids[a] || !ids[b]) continue;
        const lo = Math.min(ids[a], ids[b]), hi = Math.max(ids[a], ids[b]);
        const r = await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('a', sql.Int, lo).input('b', sql.Int, hi).input('r', sql.NVarChar(200), reason)
          .query('IF NOT EXISTS (SELECT 1 FROM hazard_incompatibilities WHERE class_a = @a AND class_b = @b) INSERT INTO hazard_incompatibilities (organization_id, class_a, class_b, reason) VALUES (@o, @a, @b, @r)');
        pairs += r.rowsAffected[0] ? 1 : 0;
      }
      return { classes_added: classes, pairs_added: pairs };
    });
    await audit(req, ctx, 'CREATE', 'hazard_classes_seed', 0, out);
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

router.put('/hazmat/incompatibilities', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const ctx = getContext(req);
    const a = int(req.body?.class_a), b = int(req.body?.class_b);
    if (!(a > 0) || !(b > 0)) throw new StockError('INVALID_CLASS', 'Choose two classes', 400);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    await inTransaction(async tx => {
      const ok = (await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('a', sql.Int, lo).input('b', sql.Int, hi).query('SELECT COUNT(DISTINCT id) AS n FROM hazard_classes WHERE organization_id = @o AND id IN (@a, @b)')).recordset[0].n;
      if (ok !== (lo === hi ? 1 : 2)) throw new StockError('NOT_FOUND', 'Class not found', 404);
      const rq = () => new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('a', sql.Int, lo).input('b', sql.Int, hi).input('r', sql.NVarChar(200), text(req.body?.reason, 200));
      if (bool(req.body?.incompatible, true)) await rq().query('IF NOT EXISTS (SELECT 1 FROM hazard_incompatibilities WHERE class_a = @a AND class_b = @b) INSERT INTO hazard_incompatibilities (organization_id, class_a, class_b, reason) VALUES (@o, @a, @b, @r) ELSE UPDATE hazard_incompatibilities SET reason = @r WHERE class_a = @a AND class_b = @b');
      else await rq().query('DELETE FROM hazard_incompatibilities WHERE class_a = @a AND class_b = @b');
    });
    await audit(req, ctx, 'UPDATE', 'hazard_incompatibility', lo, req.body);
    res.json({ class_a: lo, class_b: hi, incompatible: bool(req.body?.incompatible, true) });
  } catch (err) { fail(res, err); }
});

// ── Locations: permitted classes, temperature rating, inspection interval ──
async function locationRows(pool, ctx) {
  await inTransaction(tx => defaultLocationId(tx, ctx.orgId, ctx.branchId));
  const locs = (await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).query(`
    SELECT l.id, l.name, l.code, l.kind, l.is_default, l.is_active, l.temp_min_c, l.temp_max_c, l.inspection_interval_days, l.hazard_notes,
           ISNULL((SELECT SUM(x.qty) FROM item_location_stock x WHERE x.location_id = l.id), 0) AS units,
           ISNULL((SELECT SUM(x.qty) FROM item_location_stock x JOIN tires t ON t.id = x.tire_id WHERE x.location_id = l.id AND t.hazard_class_id IS NOT NULL AND x.qty > 0), 0) AS hazard_units
    FROM stock_locations l WHERE l.organization_id = @o AND l.branch_id = @b ORDER BY l.is_default DESC, l.name`)).recordset;
  const permits = (await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
    .query('SELECT p.location_id, p.hazard_class_id, p.max_qty FROM location_hazard_permits p JOIN stock_locations l ON l.id = p.location_id WHERE l.organization_id = @o AND l.branch_id = @b')).recordset;
  const out = [];
  for (const l of locs) {
    const insp = await H.locationInspection(pool, ctx.orgId, l);
    out.push({ ...l, permits: permits.filter(p => p.location_id === l.id).map(p => ({ hazard_class_id: p.hazard_class_id, max_qty: p.max_qty })),
               inspection: { interval_days: insp.interval, last_result: insp.last?.result ?? null, last_at: insp.last?.inspected_at ?? null, due: insp.due, overdue: insp.overdue, never: insp.never, failed: insp.failed } });
  }
  return out;
}
router.get('/hazmat/locations', async (req, res) => {
  try { res.json(await locationRows(await getPool(), getContext(req))); } catch (err) { fail(res, err); }
});

router.put('/hazmat/locations/:id', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const id = int(req.params.id);
    const tmin = num(b.temp_min_c, 'Minimum temperature', -273, 2000), tmax = num(b.temp_max_c, 'Maximum temperature', -273, 2000);
    if (tmin != null && tmax != null && tmin > tmax) throw new StockError('INVALID_TEMPERATURE', 'Minimum temperature cannot be above the maximum', 400);
    const interval = wholeOrNull(b.inspection_interval_days, 'Inspection interval', 1, 3650);
    const out = await inTransaction(async tx => {
      const loc = (await new sql.Request(tx).input('id', sql.Int, id).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
        .query('SELECT id FROM stock_locations WHERE id = @id AND organization_id = @o AND (@b IS NULL OR branch_id = @b)')).recordset[0];
      if (!loc) throw new StockError('NOT_FOUND', 'Location not found', 404);
      await new sql.Request(tx).input('id', sql.Int, id).input('a', sql.Decimal(6, 1), tmin).input('c', sql.Decimal(6, 1), tmax).input('i', sql.Int, interval).input('n', sql.NVarChar(500), text(b.hazard_notes, 500))
        .query('UPDATE stock_locations SET temp_min_c = @a, temp_max_c = @c, inspection_interval_days = @i, hazard_notes = @n WHERE id = @id');
      if (Array.isArray(b.permits)) {
        const seen = new Set();
        await new sql.Request(tx).input('id', sql.Int, id).query('DELETE FROM location_hazard_permits WHERE location_id = @id');
        for (const p of b.permits) {
          const cid = int(p.hazard_class_id);
          if (!(cid > 0) || seen.has(cid)) continue;
          seen.add(cid);
          const ok = (await new sql.Request(tx).input('c', sql.Int, cid).input('o', sql.Int, ctx.orgId).query('SELECT 1 AS x FROM hazard_classes WHERE id = @c AND organization_id = @o')).recordset.length;
          if (!ok) throw new StockError('NOT_FOUND', 'Hazard class not found', 404);
          await new sql.Request(tx).input('l', sql.Int, id).input('c', sql.Int, cid).input('m', sql.Int, wholeOrNull(p.max_qty, 'Maximum quantity', 1, 100000000))
            .query('INSERT INTO location_hazard_permits (location_id, hazard_class_id, max_qty) VALUES (@l, @c, @m)');
        }
      }
      return (await new sql.Request(tx).input('l', sql.Int, id).query(`SELECT COUNT(*) AS n FROM item_location_stock x JOIN tires t ON t.id = x.tire_id JOIN stock_locations l ON l.id = x.location_id
        WHERE x.location_id = @l AND x.qty > 0 AND l.kind = 'normal' AND t.hazard_class_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM location_hazard_permits p WHERE p.location_id = @l AND p.hazard_class_id = t.hazard_class_id)`)).recordset[0].n;
    });
    await audit(req, ctx, 'UPDATE', 'hazmat_location', id, b);
    res.json({ id, items_without_permit: out });
  } catch (err) { fail(res, err); }
});

// ── Items: register, safety hold, dry-run check ────────────────────────────
router.get('/hazmat/items', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const rows = (await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).query(`
      SELECT t.id, ${ITEM_NAME} AS name, t.sku, t.stock AS on_hand, t.hazard_class_id, c.code AS class_code, c.name AS class_name, c.requires_sds, c.requires_transport_info, c.is_active AS class_active,
             t.un_number, t.packing_group, t.flash_point_c, t.sds_ref, t.sds_date, t.ppe, t.emergency_info, t.storage_conditions, t.storage_requirements, t.handling_instructions, t.safety_requirements,
             t.storage_temp_min_c, t.storage_temp_max_c, t.hazard_inspection_days, t.hazard_hold, t.hazard_hold_reason, t.hazard_hold_at
      FROM tires t LEFT JOIN hazard_classes c ON c.id = t.hazard_class_id
      WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND (t.hazard_class_id IS NOT NULL OR t.storage_temp_min_c IS NOT NULL OR t.storage_temp_max_c IS NOT NULL OR t.hazard_hold = 1)
      ORDER BY c.code, name`)).recordset;
    const where = (await pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).query(`
      SELECT x.tire_id, l.id AS location_id, l.name, x.qty FROM item_location_stock x JOIN tires t ON t.id = x.tire_id JOIN stock_locations l ON l.id = x.location_id
      WHERE t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b) AND x.qty > 0 AND (t.hazard_class_id IS NOT NULL OR t.storage_temp_min_c IS NOT NULL OR t.storage_temp_max_c IS NOT NULL)`)).recordset;
    res.json(rows.map(r => ({ ...r, locations: where.filter(w => w.tire_id === r.id).map(w => ({ location_id: w.location_id, name: w.name, qty: w.qty })) })));
  } catch (err) { fail(res, err); }
});

// Anyone may put a precautionary safety hold on an item; lifting it takes a manager.
router.put('/hazmat/items/:id/hold', async (req, res) => {
  try {
    const ctx = getContext(req);
    const hold = bool(req.body?.hold, true);
    const reason = reasonOf(req.body?.reason, hold ? 'A reason for the hold' : 'A reason for lifting the hold');
    if (!hold && !isManager(req)) throw new StockError('FORBIDDEN', 'Only a manager or administrator can lift a safety hold', 403);
    const r = await (await getPool()).request().input('id', sql.Int, int(req.params.id)).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).input('h', sql.Bit, hold ? 1 : 0)
      .input('r', sql.NVarChar(500), hold ? reason : null).input('u', sql.Int, req.user.userId ?? null)
      .query(`UPDATE tires SET hazard_hold = @h, hazard_hold_reason = @r, hazard_hold_at = ${hold ? 'GETDATE()' : 'NULL'}, hazard_hold_by = @u
              OUTPUT INSERTED.id WHERE id = @id AND organization_id = @o AND (@b IS NULL OR branch_id = @b) AND hazard_hold <> @h`);
    if (!r.recordset.length) throw new StockError('NO_CHANGE', hold ? 'Item not found or already on hold' : 'Item not found or not on hold', 409);
    await audit(req, ctx, 'UPDATE', 'hazard_hold', int(req.params.id), { hold, reason });
    res.json({ id: int(req.params.id), hold });
  } catch (err) { fail(res, err); }
});

// "Could this move happen?" without moving anything. Used by the UI and handy for planning.
router.post('/hazmat/check', async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    const action = b.action === 'dispatch' ? 'dispatch' : 'store';
    const result = await inTransaction(async tx => {
      const item = (await new sql.Request(tx).input('id', sql.Int, int(b.tire_id)).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
        .query(`SELECT t.id, ${H.HZ_COLUMNS}, t.hazard_hold_reason, ${ITEM_NAME} AS item_name FROM tires t WHERE t.id = @id AND t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b)`)).recordset[0];
      if (!item) throw new StockError('NOT_FOUND', 'Item not found', 404);
      const lid = b.location_id ? int(b.location_id) : await defaultLocationId(tx, ctx.orgId, ctx.branchId);
      const loc = (await new sql.Request(tx).input('l', sql.Int, lid).input('o', sql.Int, ctx.orgId)
        .query('SELECT id, name, kind, temp_min_c, temp_max_c, inspection_interval_days FROM stock_locations WHERE id = @l AND organization_id = @o')).recordset[0];
      if (!loc) throw new StockError('NOT_FOUND', 'Location not found', 404);
      try {
        if (action === 'store') await H.assertStorable(tx, ctx.orgId, item, loc, int(b.qty) > 0 ? int(b.qty) : 1);
        else await H.assertDispatchable(tx, ctx.orgId, item, loc, {});
        return { allowed: true, special: H.isSpecial(item) };
      } catch (e) { if (e instanceof StockError) return { allowed: false, code: e.code, message: e.message, special: true }; throw e; }
    });
    res.json(result);
  } catch (err) { fail(res, err); }
});

// ── Inspections ────────────────────────────────────────────────────────────
router.get('/hazmat/inspections', async (req, res) => {
  try {
    const ctx = getContext(req);
    const r = await (await getPool()).request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
      .input('st', sql.NVarChar(10), ['location', 'item'].includes(req.query.subject) ? req.query.subject : null)
      .query(`SELECT TOP 300 i.id, i.subject_type, i.location_id, l.name AS location_name, i.tire_id, ${ITEM_NAME} AS item_name, i.result, i.findings, i.next_due, i.inspected_at, u.name AS user_name
              FROM hazard_inspections i LEFT JOIN stock_locations l ON l.id = i.location_id LEFT JOIN tires t ON t.id = i.tire_id LEFT JOIN users u ON u.id = i.inspected_by
              WHERE i.organization_id = @o AND (@b IS NULL OR i.branch_id = @b) AND (@st IS NULL OR i.subject_type = @st) ORDER BY i.id DESC`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.post('/hazmat/inspections', async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    if (!['location', 'item'].includes(b.subject_type)) throw new StockError('INVALID_SUBJECT', 'Inspect a location or an item', 400);
    if (!['pass', 'fail'].includes(b.result)) throw new StockError('INVALID_RESULT', 'Result must be pass or fail', 400);
    const findings = b.result === 'fail' ? reasonOf(b.findings, 'Findings describing the failure') : text(b.findings, 1000);
    const out = await inTransaction(async tx => {
      let branch = ctx.branchId, interval = null, subjectName = '';
      let locId = null, tireId = null;
      if (b.subject_type === 'location') {
        const l = (await new sql.Request(tx).input('id', sql.Int, int(b.location_id)).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
          .query('SELECT id, name, branch_id, inspection_interval_days FROM stock_locations WHERE id = @id AND organization_id = @o AND (@b IS NULL OR branch_id = @b)')).recordset[0];
        if (!l) throw new StockError('NOT_FOUND', 'Location not found', 404);
        locId = l.id; branch = l.branch_id; subjectName = l.name;
        interval = l.inspection_interval_days ?? await H.companyNumber(tx, ctx.orgId, 'hz_location_inspection_days', null);
      } else {
        const t = (await new sql.Request(tx).input('id', sql.Int, int(b.tire_id)).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId)
          .query(`SELECT t.id, t.branch_id, t.hazard_inspection_days, ${ITEM_NAME} AS name FROM tires t WITH (UPDLOCK) WHERE t.id = @id AND t.organization_id = @o AND (@b IS NULL OR t.branch_id = @b)`)).recordset[0];
        if (!t) throw new StockError('NOT_FOUND', 'Item not found', 404);
        tireId = t.id; branch = t.branch_id; subjectName = t.name; interval = t.hazard_inspection_days;
      }
      const next = b.next_due ? H.dayOf(b.next_due) : interval > 0 ? H.addDays(H.todayStr(), interval) : null;
      if (b.next_due && (!next || next < H.todayStr())) throw new StockError('INVALID_DATE', 'The next inspection date must be today or later', 400);
      const ins = await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, branch).input('st', sql.NVarChar(10), b.subject_type).input('l', sql.Int, locId).input('t', sql.Int, tireId)
        .input('r', sql.NVarChar(10), b.result).input('f', sql.NVarChar(1000), findings).input('n', sql.Date, next).input('u', sql.Int, req.user.userId ?? null)
        .query('INSERT INTO hazard_inspections (organization_id, branch_id, subject_type, location_id, tire_id, result, findings, next_due, inspected_by) OUTPUT INSERTED.id VALUES (@o, @b, @st, @l, @t, @r, @f, @n, @u)');
      let held = false;
      if (b.subject_type === 'item' && b.result === 'fail') {
        await new sql.Request(tx).input('id', sql.Int, tireId).input('r', sql.NVarChar(500), `Failed inspection: ${findings}`.slice(0, 500)).input('u', sql.Int, req.user.userId ?? null)
          .query('UPDATE tires SET hazard_hold = 1, hazard_hold_reason = @r, hazard_hold_at = GETDATE(), hazard_hold_by = @u WHERE id = @id AND hazard_hold = 0');
        held = true;
      }
      return { id: ins.recordset[0].id, subject: subjectName, result: b.result, next_due: next, item_placed_on_hold: held };
    });
    await audit(req, ctx, 'CREATE', 'hazard_inspection', out.id, out);
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

// ── Incidents ──────────────────────────────────────────────────────────────
router.get('/hazmat/incidents', async (req, res) => {
  try {
    const ctx = getContext(req);
    const st = ['open', 'closed'].includes(req.query.status) ? req.query.status : null;
    const r = await (await getPool()).request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).input('st', sql.NVarChar(10), st)
      .query(`SELECT TOP 300 i.id, i.incident_no, i.incident_type, i.severity, i.tire_id, ${ITEM_NAME} AS item_name, i.batch_id, sb.batch_no, i.location_id, l.name AS location_name, i.qty_affected, i.description,
                     i.actions_taken, i.blocks_dispatch, i.status, i.reported_at, u.name AS reported_by_name, i.closed_at, i.resolution
              FROM hazard_incidents i LEFT JOIN tires t ON t.id = i.tire_id LEFT JOIN stock_locations l ON l.id = i.location_id LEFT JOIN stock_batches sb ON sb.id = i.batch_id LEFT JOIN users u ON u.id = i.reported_by
              WHERE i.organization_id = @o AND (@b IS NULL OR i.branch_id = @b) AND (@st IS NULL OR i.status = @st) ORDER BY i.id DESC`);
    res.json(r.recordset.map(x => ({ ...x, type_label: H.INCIDENT_TYPES[x.incident_type] ?? x.incident_type, severity_label: H.SEVERITIES[x.severity] ?? x.severity })));
  } catch (err) { fail(res, err); }
});

router.post('/hazmat/incidents', async (req, res) => {
  try {
    const ctx = getContext(req);
    const b = req.body || {};
    if (!H.INCIDENT_TYPES[b.incident_type]) throw new StockError('INVALID_TYPE', 'Choose an incident type', 400);
    const severity = b.severity || 'medium';
    if (!H.SEVERITIES[severity]) throw new StockError('INVALID_SEVERITY', 'Severity must be low, medium, high or critical', 400);
    const description = reasonOf(b.description, 'A description of what happened');
    const tireId = b.tire_id ? int(b.tire_id) : null, locId = b.location_id ? int(b.location_id) : null, batchId = b.batch_id ? int(b.batch_id) : null;
    if (!tireId && !locId) throw new StockError('SUBJECT_REQUIRED', 'Say which item or location was involved', 400);
    const blocks = bool(b.blocks_dispatch, severity === 'high' || severity === 'critical');
    const out = await inTransaction(async tx => {
      let branch = ctx.branchId;
      if (tireId) {
        const t = (await new sql.Request(tx).input('id', sql.Int, tireId).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).query('SELECT id, branch_id FROM tires WHERE id = @id AND organization_id = @o AND (@b IS NULL OR branch_id = @b)')).recordset[0];
        if (!t) throw new StockError('NOT_FOUND', 'Item not found', 404);
        branch = t.branch_id;
      }
      if (locId) {
        const l = (await new sql.Request(tx).input('id', sql.Int, locId).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).query('SELECT id, branch_id FROM stock_locations WHERE id = @id AND organization_id = @o AND (@b IS NULL OR branch_id = @b)')).recordset[0];
        if (!l) throw new StockError('NOT_FOUND', 'Location not found', 404);
        branch = l.branch_id;
      }
      if (batchId) {
        const bt = (await new sql.Request(tx).input('id', sql.Int, batchId).input('o', sql.Int, ctx.orgId).input('t', sql.Int, tireId).query('SELECT id FROM stock_batches WHERE id = @id AND organization_id = @o AND (@t IS NULL OR tire_id = @t)')).recordset[0];
        if (!bt) throw new StockError('NOT_FOUND', 'Batch not found for this item', 404);
      }
      const no = await nextDocNumber(new sql.Request(tx), 'hazard_incidents', 'HZI');
      const ins = await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, branch ?? 0).input('no', sql.NVarChar(30), no).input('ty', sql.NVarChar(24), b.incident_type).input('sv', sql.NVarChar(10), severity)
        .input('t', sql.Int, tireId).input('bt', sql.Int, batchId).input('l', sql.Int, locId).input('q', sql.Int, wholeOrNull(b.qty_affected, 'Quantity affected', 0, 100000000))
        .input('d', sql.NVarChar(1000), description).input('a', sql.NVarChar(1000), text(b.actions_taken, 1000)).input('bl', sql.Bit, blocks ? 1 : 0).input('u', sql.Int, req.user.userId ?? null)
        .query(`INSERT INTO hazard_incidents (organization_id, branch_id, incident_no, incident_type, severity, tire_id, batch_id, location_id, qty_affected, description, actions_taken, blocks_dispatch, reported_by)
                OUTPUT INSERTED.id VALUES (@o, @b, @no, @ty, @sv, @t, @bt, @l, @q, @d, @a, @bl, @u)`);
      const id = ins.recordset[0].id;
      let heldItem = false, heldBatch = false;
      if (tireId && bool(b.hold_item, false)) {
        const r = await new sql.Request(tx).input('id', sql.Int, tireId).input('r', sql.NVarChar(500), `Incident ${no}: ${description}`.slice(0, 500)).input('u', sql.Int, req.user.userId ?? null)
          .query('UPDATE tires SET hazard_hold = 1, hazard_hold_reason = @r, hazard_hold_at = GETDATE(), hazard_hold_by = @u WHERE id = @id AND hazard_hold = 0');
        heldItem = r.rowsAffected[0] > 0;
      }
      if (batchId && bool(b.hold_batch, false)) {
        const why = `Hazard incident ${no}: ${description}`.slice(0, 500);
        const r = await new sql.Request(tx).input('id', sql.Int, batchId).input('r', sql.NVarChar(500), why).input('u', sql.Int, req.user.userId ?? null)
          .query("UPDATE stock_batches SET quality_status = 'on_hold', status_reason = @r, status_changed_at = GETDATE(), status_changed_by = @u OUTPUT INSERTED.tire_id WHERE id = @id AND quality_status = 'released'");
        if (r.recordset.length) {
          heldBatch = true;
          await new sql.Request(tx).input('o', sql.Int, ctx.orgId).input('b', sql.Int, branch ?? 0).input('id', sql.Int, batchId).input('t', sql.Int, r.recordset[0].tire_id).input('r', sql.NVarChar(500), why).input('u', sql.Int, req.user.userId ?? null)
            .query("INSERT INTO batch_quality_events (organization_id, branch_id, batch_id, tire_id, event_type, from_status, to_status, reason, user_id) VALUES (@o, @b, @id, @t, 'hold', 'released', 'on_hold', @r, @u)");
        }
      }
      return { id, incident_no: no, severity, blocks_dispatch: blocks, item_placed_on_hold: heldItem, batch_placed_on_hold: heldBatch };
    });
    await audit(req, ctx, 'CREATE', 'hazard_incident', out.id, out);
    res.status(201).json(out);
  } catch (err) { fail(res, err); }
});

router.post('/hazmat/incidents/:id/close', canManage, async (req, res) => {
  try {
    const ctx = getContext(req);
    const resolution = reasonOf(req.body?.resolution, 'A resolution');
    const r = await (await getPool()).request().input('id', sql.Int, int(req.params.id)).input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId).input('r', sql.NVarChar(1000), resolution).input('u', sql.Int, req.user.userId ?? null)
      .query("UPDATE hazard_incidents SET status = 'closed', closed_at = GETDATE(), closed_by = @u, resolution = @r OUTPUT INSERTED.id WHERE id = @id AND organization_id = @o AND (@b IS NULL OR branch_id = @b) AND status = 'open'");
    if (!r.recordset.length) throw new StockError('NOT_FOUND', 'Open incident not found', 404);
    await audit(req, ctx, 'UPDATE', 'hazard_incident', int(req.params.id), { resolution });
    res.json({ id: int(req.params.id), status: 'closed' });
  } catch (err) { fail(res, err); }
});

// ── Compliance board ───────────────────────────────────────────────────────
router.get('/hazmat/compliance', async (req, res) => {
  try {
    const ctx = getContext(req);
    const pool = await getPool();
    const st = await settings(pool, ctx.orgId);
    const q = (query, inputs = {}) => { const rq = pool.request().input('o', sql.Int, ctx.orgId).input('b', sql.Int, ctx.branchId); for (const [k, [t, v]] of Object.entries(inputs)) rq.input(k, t, v); return rq.query(query).then(r => r.recordset); };
    const scope = 't.organization_id = @o AND (@b IS NULL OR t.branch_id = @b)';
    const stocked = 'x.qty > 0 AND l.kind = \'normal\'';

    const misplaced = await q(`SELECT t.id AS tire_id, ${ITEM_NAME} AS item_name, c.name AS class_name, l.id AS location_id, l.name AS location_name, x.qty
      FROM item_location_stock x JOIN tires t ON t.id = x.tire_id JOIN stock_locations l ON l.id = x.location_id JOIN hazard_classes c ON c.id = t.hazard_class_id
      WHERE ${scope} AND ${stocked} AND NOT EXISTS (SELECT 1 FROM location_hazard_permits p WHERE p.location_id = l.id AND p.hazard_class_id = t.hazard_class_id)`);
    const overCap = await q(`SELECT l.id AS location_id, l.name AS location_name, c.name AS class_name, p.max_qty, SUM(x.qty) AS qty
      FROM location_hazard_permits p JOIN stock_locations l ON l.id = p.location_id JOIN hazard_classes c ON c.id = p.hazard_class_id
      JOIN tires t ON t.hazard_class_id = p.hazard_class_id JOIN item_location_stock x ON x.tire_id = t.id AND x.location_id = l.id
      WHERE ${scope} AND l.organization_id = @o AND p.max_qty IS NOT NULL AND x.qty > 0 GROUP BY l.id, l.name, c.name, p.max_qty HAVING SUM(x.qty) > p.max_qty`);
    const temp = await q(`SELECT t.id AS tire_id, ${ITEM_NAME} AS item_name, t.storage_temp_min_c, t.storage_temp_max_c, l.id AS location_id, l.name AS location_name, l.temp_min_c, l.temp_max_c, x.qty
      FROM item_location_stock x JOIN tires t ON t.id = x.tire_id JOIN stock_locations l ON l.id = x.location_id
      WHERE ${scope} AND ${stocked} AND (t.storage_temp_min_c IS NOT NULL OR t.storage_temp_max_c IS NOT NULL)
        AND ((t.storage_temp_min_c IS NOT NULL AND (l.temp_min_c IS NULL OR l.temp_min_c < t.storage_temp_min_c)) OR (t.storage_temp_max_c IS NOT NULL AND (l.temp_max_c IS NULL OR l.temp_max_c > t.storage_temp_max_c)))`);
    const conflicts = await q(`SELECT l.id AS location_id, l.name AS location_name, ${ITEM_NAME.replace(/\bt\./g, 'a.')} AS a_name, ca.name AS a_class, ${ITEM_NAME.replace(/\bt\./g, 'b.')} AS b_name, cb.name AS b_class, i.reason
      FROM item_location_stock xa JOIN item_location_stock xb ON xb.location_id = xa.location_id AND xa.tire_id < xb.tire_id
      JOIN tires a ON a.id = xa.tire_id JOIN tires b ON b.id = xb.tire_id JOIN stock_locations l ON l.id = xa.location_id
      JOIN hazard_classes ca ON ca.id = a.hazard_class_id JOIN hazard_classes cb ON cb.id = b.hazard_class_id
      JOIN hazard_incompatibilities i ON (i.class_a = a.hazard_class_id AND i.class_b = b.hazard_class_id) OR (i.class_a = b.hazard_class_id AND i.class_b = a.hazard_class_id)
      WHERE a.organization_id = @o AND (@b IS NULL OR a.branch_id = @b) AND xa.qty > 0 AND xb.qty > 0`);
    const items = await q(`SELECT t.id AS tire_id, ${ITEM_NAME} AS item_name, t.stock AS on_hand, c.name AS class_name, c.requires_sds, c.requires_transport_info, c.is_active, t.sds_ref, t.sds_date, t.un_number, t.hazard_hold, t.hazard_hold_reason, t.hazard_inspection_days
      FROM tires t JOIN hazard_classes c ON c.id = t.hazard_class_id WHERE ${scope} AND t.is_active = 1`);
    const held = await q(`SELECT t.id AS tire_id, ${ITEM_NAME} AS item_name, t.hazard_hold_reason, t.hazard_hold_at, t.stock AS on_hand FROM tires t WHERE ${scope} AND t.hazard_hold = 1`);
    const lastItemInsp = await q('SELECT i.tire_id, i.result, i.inspected_at, i.next_due FROM hazard_inspections i WHERE i.organization_id = @o AND i.subject_type = \'item\' AND i.id = (SELECT MAX(id) FROM hazard_inspections WHERE tire_id = i.tire_id AND subject_type = \'item\')');
    const incidents = await q(`SELECT i.id, i.incident_no, i.incident_type, i.severity, i.blocks_dispatch, i.description, i.reported_at, ${ITEM_NAME} AS item_name, l.name AS location_name
      FROM hazard_incidents i LEFT JOIN tires t ON t.id = i.tire_id LEFT JOIN stock_locations l ON l.id = i.location_id WHERE i.organization_id = @o AND (@b IS NULL OR i.branch_id = @b) AND i.status = 'open' ORDER BY i.id DESC`);

    const today = H.todayStr();
    const sdsMissing = items.filter(i => i.requires_sds && !i.sds_ref);
    const sdsOld = items.filter(i => i.sds_ref && st.sds_max_age_days && (!i.sds_date || H.addDays(i.sds_date, st.sds_max_age_days) < today))
      .map(i => ({ ...i, reason: i.sds_date ? `SDS dated ${H.dayOf(i.sds_date)}, older than ${st.sds_max_age_days} days` : 'SDS has no date recorded' }));
    const transportMissing = items.filter(i => i.requires_transport_info && !i.un_number);
    const inactiveClass = items.filter(i => !i.is_active && i.on_hand > 0);
    const itemInspection = [];
    for (const i of (await q(`SELECT t.id AS tire_id, ${ITEM_NAME} AS item_name, t.hazard_inspection_days AS interval_days FROM tires t WHERE ${scope} AND t.hazard_inspection_days IS NOT NULL AND t.is_active = 1`))) {
      const last = lastItemInsp.find(x => x.tire_id === i.tire_id);
      const due = last ? (last.next_due ? H.dayOf(last.next_due) : H.addDays(last.inspected_at, i.interval_days)) : null;
      if (!last) itemInspection.push({ ...i, due: null, never: true, failed: false });
      else if (last.result === 'fail') itemInspection.push({ ...i, due, never: false, failed: true });
      else if (due && due < today) itemInspection.push({ ...i, due, never: false, failed: false, days_overdue: Math.floor((new Date(today) - new Date(due)) / 86400000) });
    }
    const locs = await locationRows(pool, ctx);
    const locationInspection = locs.filter(l => l.kind === 'normal' && (l.inspection.overdue || l.inspection.failed) && (l.permits.length || l.hazard_units > 0 || l.inspection.interval_days))
      .map(l => ({ location_id: l.id, location_name: l.name, due: l.inspection.due, never: l.inspection.never, failed: l.inspection.failed, hazard_units: l.hazard_units }));

    const n = a => a.length;
    const summary = { incompatible: n(conflicts), misplaced: n(misplaced) + n(overCap), temperature: n(temp), sds: n(sdsMissing) + n(sdsOld) + n(transportMissing), inspections: n(itemInspection) + n(locationInspection),
                      incidents: n(incidents), holds: n(held), inactive_class: n(inactiveClass) };
    res.json({ summary, needs_attention: Object.values(summary).reduce((a, b) => a + b, 0), settings: st,
               incompatible: conflicts, misplaced, over_capacity: overCap, temperature: temp, sds_missing: sdsMissing, sds_old: sdsOld, transport_missing: transportMissing,
               item_inspections: itemInspection, location_inspections: locationInspection, open_incidents: incidents, holds: held, inactive_class: inactiveClass });
  } catch (err) { fail(res, err); }
});

module.exports = router;
