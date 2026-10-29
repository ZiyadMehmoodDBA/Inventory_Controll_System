// Warehouse & multi-location API: warehouses, per-location access, network stock view (organisation > branch > warehouse > location),
// the in-transit board, transfer history with its audit trail, and stock counts by location.
// Mounted on /api/inventory before routes/inventory.js; unmatched paths fall through.
const express = require('express');
const router  = express.Router();
const { getPool, sql }  = require('../db');
const { requireRole }   = require('../middleware/auth');
const P = require('../utils/permissions');
const { writeAudit }    = require('../utils/audit');
const { getContext }    = require('../context');
const { StockError, defaultLocationId } = require('../utils/stock');

const canManage = P.requirePermission('locations.manage');
const isAdmin = req => req.user.role === 'org_admin';
const int = v => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
const cleanName = v => String(v ?? '').trim().slice(0, 100);
const cleanCode = v => String(v ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30);
const isDupKey = e => e && (e.number === 2601 || e.number === 2627);

function fail(res, err) {
  if (err instanceof StockError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  console.error('[warehouse]', err.message);
  return res.status(500).json({ error: 'Warehouse operation failed' });
}

/** A branch gets its default location the first time it is used; make sure every visible branch has one so it shows up and can receive stock. */
async function ensureDefaults(orgId, only) {
  const pool = await getPool();
  const missing = (await pool.request().input('o', sql.Int, orgId).input('only', sql.Int, only)
    .query('SELECT b.id FROM branches b WHERE b.organization_id = @o AND b.is_active = 1 AND (@only IS NULL OR b.id = @only) AND NOT EXISTS (SELECT 1 FROM stock_locations l WHERE l.branch_id = b.id)')).recordset;
  for (const b of missing) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try { await defaultLocationId(tx, orgId, b.id); await tx.commit(); }
    catch (e) { try { await tx.rollback(); } catch { /* done */ } if (!isDupKey(e)) throw e; /* another request created it first */ }
  }
}

/** Branches this user may see: everything for the organisation admin, own branch for everyone else. */
const visibleBranch = req => (isAdmin(req) ? null : req.user.branchId);

// ── Warehouses ──────────────────────────────────────────────────────────────
router.get('/warehouses', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT w.id, w.name, w.code, w.address, w.is_active,
                     (SELECT COUNT(*) FROM stock_locations l WHERE l.warehouse_id = w.id) AS locations,
                     ISNULL((SELECT SUM(x.qty) FROM item_location_stock x JOIN stock_locations l ON l.id = x.location_id WHERE l.warehouse_id = w.id), 0) AS units
              FROM warehouses w WHERE w.organization_id = @o AND w.branch_id = @b ORDER BY w.is_active DESC, w.name`);
    res.json(r.recordset);
  } catch (err) { fail(res, err); }
});

router.post('/warehouses', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const name = cleanName(req.body?.name), code = cleanCode(req.body?.code || name);
    if (!name || !code) throw new StockError('INVALID_NAME', 'Name is required');
    const pool = await getPool();
    const r = await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('n', sql.NVarChar(100), name).input('c', sql.NVarChar(30), code)
      .input('a', sql.NVarChar(300), req.body?.address ? String(req.body.address).slice(0, 300) : null)
      .query('INSERT INTO warehouses (organization_id, branch_id, name, code, address) OUTPUT INSERTED.* VALUES (@o, @b, @n, @c, @a)');
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'CREATE', entity: 'warehouse', entityId: r.recordset[0].id, before: null, after: { name, code } });
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    if (isDupKey(err)) return res.status(409).json({ error: 'A warehouse with that code already exists in this branch', code: 'DUPLICATE_CODE' });
    fail(res, err);
  }
});

router.put('/warehouses/:id', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const id = int(req.params.id);
    const pool = await getPool();
    const cur = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query('SELECT * FROM warehouses WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
    if (!cur) throw new StockError('NOT_FOUND', 'Warehouse not found', 404);
    const name = req.body?.name !== undefined ? cleanName(req.body.name) : cur.name;
    if (!name) throw new StockError('INVALID_NAME', 'Name is required');
    const active = req.body?.is_active !== undefined ? !!req.body.is_active : !!cur.is_active;
    if (!active && cur.is_active) {
      const stock = (await pool.request().input('id', sql.Int, id).query(`SELECT ISNULL(SUM(x.qty), 0) AS n FROM item_location_stock x JOIN stock_locations l ON l.id = x.location_id WHERE l.warehouse_id = @id`)).recordset[0].n;
      if (stock !== 0) throw new StockError('WAREHOUSE_HAS_STOCK', `Cannot deactivate ${cur.name}: ${stock} unit(s) are still in its locations`, 409);
    }
    await pool.request().input('id', sql.Int, id).input('n', sql.NVarChar(100), name).input('a', sql.NVarChar(300), req.body?.address !== undefined ? (String(req.body.address || '').slice(0, 300) || null) : cur.address)
      .input('act', sql.Bit, active ? 1 : 0).query('UPDATE warehouses SET name = @n, address = @a, is_active = @act WHERE id = @id');
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'UPDATE', entity: 'warehouse', entityId: id, before: { name: cur.name, is_active: !!cur.is_active }, after: { name, is_active: active } });
    res.json({ id, name, is_active: active });
  } catch (err) { fail(res, err); }
});

// Put a location in a warehouse (or take it out with warehouse_id = null).
router.put('/locations/:id/warehouse', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const id = int(req.params.id);
    const wid = req.body?.warehouse_id == null || req.body.warehouse_id === '' ? null : int(req.body.warehouse_id);
    const pool = await getPool();
    const loc = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query('SELECT id, name, warehouse_id FROM stock_locations WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
    if (!loc) throw new StockError('NOT_FOUND', 'Location not found', 404);
    if (wid != null) {
      const w = (await pool.request().input('w', sql.Int, wid).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
        .query('SELECT id, is_active FROM warehouses WHERE id = @w AND organization_id = @o AND branch_id = @b')).recordset[0];
      if (!w) throw new StockError('NOT_FOUND', 'Warehouse not found in this branch', 404);
      if (!w.is_active) throw new StockError('INVALID_WAREHOUSE', 'That warehouse is inactive', 409);
    }
    await pool.request().input('id', sql.Int, id).input('w', sql.Int, wid).query('UPDATE stock_locations SET warehouse_id = @w WHERE id = @id');
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'UPDATE', entity: 'stock_location', entityId: id, before: { warehouse_id: loc.warehouse_id }, after: { warehouse_id: wid } });
    res.json({ id, warehouse_id: wid });
  } catch (err) { fail(res, err); }
});

// ── Location access ─────────────────────────────────────────────────────────
// A location with no rows is open to everyone in its branch. Add rows to limit issue / receive / count to named users.
router.get('/locations/:id/access', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const id = int(req.params.id);
    const pool = await getPool();
    const loc = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query('SELECT id, name, branch_id FROM stock_locations WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
    if (!loc) throw new StockError('NOT_FOUND', 'Location not found', 404);
    const rules = (await pool.request().input('id', sql.Int, id)
      .query('SELECT a.user_id, u.name, u.role, a.can_issue, a.can_receive, a.can_count FROM location_access a JOIN users u ON u.id = a.user_id WHERE a.location_id = @id ORDER BY u.name')).recordset;
    const users = (await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query("SELECT id, name, role FROM users WHERE organization_id = @o AND branch_id = @b AND is_active = 1 AND role IN ('staff') ORDER BY name")).recordset;
    res.json({ location: loc, restricted: rules.length > 0, rules, users });
  } catch (err) { fail(res, err); }
});

// Body: { users: [{ user_id, can_issue, can_receive, can_count }] }. An empty list removes the restriction.
router.put('/locations/:id/access', canManage, async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const id = int(req.params.id);
    const list = Array.isArray(req.body?.users) ? req.body.users : null;
    if (!list) throw new StockError('INVALID_BODY', 'users must be a list');
    const pool = await getPool();
    const loc = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query('SELECT id, name FROM stock_locations WHERE id = @id AND organization_id = @o AND branch_id = @b')).recordset[0];
    if (!loc) throw new StockError('NOT_FOUND', 'Location not found', 404);
    const ids = [...new Set(list.map(u => int(u.user_id)))];
    if (ids.some(n => !Number.isInteger(n))) throw new StockError('INVALID_USER', 'Invalid user');
    const valid = ids.length ? (await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT id FROM users WHERE organization_id = @o AND branch_id = @b AND id IN (${ids.join(',')})`)).recordset.map(r => r.id) : [];
    if (valid.length !== ids.length) throw new StockError('INVALID_USER', 'Every user must belong to this branch');
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx).input('id', sql.Int, id).query('DELETE FROM location_access WHERE location_id = @id');
      for (const u of list) {
        await new sql.Request(tx).input('l', sql.Int, id).input('u', sql.Int, int(u.user_id))
          .input('i', sql.Bit, u.can_issue === false ? 0 : 1).input('r', sql.Bit, u.can_receive === false ? 0 : 1).input('c', sql.Bit, u.can_count === false ? 0 : 1)
          .query('INSERT INTO location_access (location_id, user_id, can_issue, can_receive, can_count) VALUES (@l, @u, @i, @r, @c)');
      }
      await tx.commit();
    } catch (e) { try { await tx.rollback(); } catch { /* done */ } throw e; }
    writeAudit(pool, { orgId, branchId, userId: req.user.userId, action: 'UPDATE', entity: 'location_access', entityId: id, before: null, after: { users: ids } });
    res.json({ id, restricted: ids.length > 0, users: ids.length });
  } catch (err) { fail(res, err); }
});

// ── Network stock view ─────────────────────────────────────────────────────
// Organisation > branch > warehouse > location, with units, cost value and units on the way. ?q= limits to items matching a name / SKU.
router.get('/warehouse/network', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const only = visibleBranch(req);
    const q = String(req.query.q || '').trim().slice(0, 60);
    await ensureDefaults(orgId, only);
    const pool = await getPool();
    const rq = pool.request().input('o', sql.Int, orgId).input('only', sql.Int, only).input('q', sql.NVarChar(60), '%' + q + '%').input('hasq', sql.Bit, q ? 1 : 0);
    const rows = (await rq.query(`
      SELECT b.id AS branch_id, b.name AS branch_name, l.id AS location_id, l.name AS location_name, l.code AS location_code, l.kind, l.is_active, l.is_default,
             w.id AS warehouse_id, w.name AS warehouse_name,
             ISNULL(s.units, 0) AS units, ISNULL(s.items, 0) AS items, ISNULL(s.value, 0) AS value
      FROM branches b
      JOIN stock_locations l ON l.organization_id = b.organization_id AND l.branch_id = b.id
      LEFT JOIN warehouses w ON w.id = l.warehouse_id
      OUTER APPLY (SELECT SUM(x.qty) AS units, COUNT(CASE WHEN x.qty <> 0 THEN 1 END) AS items, SUM(x.qty * ISNULL(t.cost_price, 0)) AS value
                   FROM item_location_stock x JOIN tires t ON t.id = x.tire_id
                   WHERE x.location_id = l.id AND (@hasq = 0 OR t.brand + ' ' + t.model + ' ' + t.size LIKE @q OR t.sku LIKE @q)) s
      WHERE b.organization_id = @o AND (@only IS NULL OR b.id = @only) AND (l.is_active = 1 OR ISNULL(s.units, 0) <> 0)
      ORDER BY b.name, w.name, l.is_default DESC, l.name`)).recordset;
    const transit = (await pool.request().input('o', sql.Int, orgId).input('only', sql.Int, only).query(`
      SELECT tr.branch_id AS from_branch, ISNULL(tr.to_branch_id, tr.branch_id) AS to_branch, tr.from_location_id, SUM(i.qty) AS units
      FROM stock_transfers tr JOIN stock_transfer_items i ON i.transfer_id = tr.id
      WHERE tr.organization_id = @o AND tr.status = 'in_transit' AND (@only IS NULL OR tr.branch_id = @only OR ISNULL(tr.to_branch_id, tr.branch_id) = @only)
      GROUP BY tr.branch_id, ISNULL(tr.to_branch_id, tr.branch_id), tr.from_location_id`)).recordset;

    const branches = new Map();
    for (const r of rows) {
      if (!branches.has(r.branch_id)) branches.set(r.branch_id, { id: r.branch_id, name: r.branch_name, units: 0, items: 0, value: 0, in_transit_out: 0, in_transit_in: 0, warehouses: new Map() });
      const b = branches.get(r.branch_id);
      const wkey = r.warehouse_id ?? 0;
      if (!b.warehouses.has(wkey)) b.warehouses.set(wkey, { id: r.warehouse_id, name: r.warehouse_name || 'Unassigned locations', units: 0, value: 0, locations: [] });
      const w = b.warehouses.get(wkey);
      w.locations.push({ id: r.location_id, name: r.location_name, code: r.location_code, kind: r.kind, is_active: !!r.is_active, is_default: !!r.is_default, units: r.units, items: r.items, value: Number(r.value) });
      w.units += r.units; w.value += Number(r.value); b.units += r.units; b.value += Number(r.value); b.items += r.items;
    }
    for (const t of transit) {
      if (branches.has(t.from_branch)) branches.get(t.from_branch).in_transit_out += t.units;
      if (branches.has(t.to_branch)) branches.get(t.to_branch).in_transit_in += t.units;
    }
    const list = [...branches.values()].map(b => ({ ...b, warehouses: [...b.warehouses.values()] }));
    res.json({
      scope: only == null ? 'organisation' : 'branch',
      totals: { units: list.reduce((a, b) => a + b.units, 0), value: list.reduce((a, b) => a + b.value, 0), branches: list.length,
                locations: list.reduce((a, b) => a + b.warehouses.reduce((x, w) => x + w.locations.length, 0), 0),
                in_transit_units: transit.reduce((a, t) => a + (t.from_branch === t.to_branch ? t.units : t.units), 0) },
      branches: list,
    });
  } catch (err) { fail(res, err); }
});

// Stock of one location, item by item.
router.get('/warehouse/locations/:id/stock', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = int(req.params.id);
    const only = visibleBranch(req);
    const pool = await getPool();
    const loc = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, orgId)
      .query('SELECT id, name, branch_id FROM stock_locations WHERE id = @id AND organization_id = @o')).recordset[0];
    if (!loc || (only != null && loc.branch_id !== only)) throw new StockError('NOT_FOUND', 'Location not found', 404);
    const items = (await pool.request().input('id', sql.Int, id)
      .query(`SELECT t.id AS tire_id, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name, t.sku, x.qty, ISNULL(t.cost_price, 0) AS cost_price, x.qty * ISNULL(t.cost_price, 0) AS value
              FROM item_location_stock x JOIN tires t ON t.id = x.tire_id WHERE x.location_id = @id AND x.qty <> 0 ORDER BY item_name`)).recordset;
    res.json({ location: loc, items });
  } catch (err) { fail(res, err); }
});

// ── Transfers: destinations, in-transit board, history, detail ─────────────────
// Other branches of the organisation that stock can be sent to, with their active locations.
router.get('/warehouse/destinations', P.requirePermission('stock.transfer_branch'), async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    await ensureDefaults(orgId, null);
    const pool = await getPool();
    const r = (await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT b.id AS branch_id, b.name AS branch_name, l.id AS location_id, l.name AS location_name, l.kind, w.name AS warehouse_name
              FROM branches b JOIN stock_locations l ON l.organization_id = b.organization_id AND l.branch_id = b.id AND l.is_active = 1
              LEFT JOIN warehouses w ON w.id = l.warehouse_id
              WHERE b.organization_id = @o AND b.id <> @b AND b.is_active = 1 ORDER BY b.name, l.is_default DESC, l.name`)).recordset;
    const out = new Map();
    for (const x of r) {
      if (!out.has(x.branch_id)) out.set(x.branch_id, { id: x.branch_id, name: x.branch_name, locations: [] });
      out.get(x.branch_id).locations.push({ id: x.location_id, name: x.location_name, kind: x.kind, warehouse: x.warehouse_name });
    }
    res.json([...out.values()]);
  } catch (err) { fail(res, err); }
});

const TRANSFER_SELECT = `
  SELECT tr.id, tr.transfer_no, tr.status, tr.notes, tr.created_at, tr.received_at, tr.expected_at, tr.carrier, tr.reference, tr.has_discrepancy, tr.received_note,
         tr.branch_id AS from_branch_id, ISNULL(tr.to_branch_id, tr.branch_id) AS to_branch_id,
         fb.name AS from_branch, tb.name AS to_branch, fl.name AS from_name, tl.name AS to_name, tr.from_location_id, tr.to_location_id,
         cu.name AS created_by_name, ru.name AS received_by_name,
         CASE WHEN tr.to_branch_id IS NOT NULL AND tr.to_branch_id <> tr.branch_id THEN 1 ELSE 0 END AS cross_branch,
         CASE WHEN tr.status = 'in_transit' AND tr.expected_at IS NOT NULL AND tr.expected_at < CAST(GETDATE() AS DATE) THEN 1 ELSE 0 END AS overdue,
         DATEDIFF(DAY, tr.created_at, ISNULL(tr.received_at, GETDATE())) AS days_open,
         (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = tr.id) AS lines,
         (SELECT ISNULL(SUM(i.qty), 0) FROM stock_transfer_items i WHERE i.transfer_id = tr.id) AS units,
         (SELECT ISNULL(SUM(i.qty_short), 0) FROM stock_transfer_items i WHERE i.transfer_id = tr.id) AS units_short
  FROM stock_transfers tr
  JOIN branches fb ON fb.id = tr.branch_id JOIN branches tb ON tb.id = ISNULL(tr.to_branch_id, tr.branch_id)
  JOIN stock_locations fl ON fl.id = tr.from_location_id JOIN stock_locations tl ON tl.id = tr.to_location_id
  LEFT JOIN users cu ON cu.id = tr.created_by LEFT JOIN users ru ON ru.id = tr.received_by`;

const withDirection = (rows, branch) => rows.map(r => ({ ...r, direction: branch == null ? (r.cross_branch ? 'cross' : 'internal') : r.from_branch_id === branch && r.to_branch_id === branch ? 'internal' : r.from_branch_id === branch ? 'outgoing' : 'incoming' }));

// Everything not yet received, for the sending and the receiving branch. Overdue = past its expected date.
router.get('/warehouse/in-transit', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const only = visibleBranch(req);
    const pool = await getPool();
    const rows = (await pool.request().input('o', sql.Int, orgId).input('only', sql.Int, only)
      .query(`${TRANSFER_SELECT} WHERE tr.organization_id = @o AND tr.status = 'in_transit' AND (@only IS NULL OR tr.branch_id = @only OR tr.to_branch_id = @only)
              ORDER BY overdue DESC, tr.created_at`)).recordset;
    const list = withDirection(rows, only);
    res.json({ count: list.length, overdue: list.filter(r => r.overdue).length, units: list.reduce((a, r) => a + r.units, 0), transfers: list });
  } catch (err) { fail(res, err); }
});

// History: ?status= in_transit|received|completed|cancelled, ?discrepancy=1, ?direction= outgoing|incoming|internal.
router.get('/warehouse/transfers', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const only = visibleBranch(req);
    const status = ['in_transit', 'received', 'completed', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const pool = await getPool();
    const rows = (await pool.request().input('o', sql.Int, orgId).input('only', sql.Int, only).input('st', sql.NVarChar(12), status).input('d', sql.Bit, req.query.discrepancy ? 1 : 0)
      .query(`${TRANSFER_SELECT} WHERE tr.organization_id = @o AND (@only IS NULL OR tr.branch_id = @only OR tr.to_branch_id = @only)
              AND (@st IS NULL OR tr.status = @st) AND (@d = 0 OR tr.has_discrepancy = 1) ORDER BY tr.id DESC OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY`)).recordset;
    let list = withDirection(rows, only);
    if (['outgoing', 'incoming', 'internal'].includes(req.query.direction)) list = list.filter(r => r.direction === req.query.direction);
    res.json(list);
  } catch (err) { fail(res, err); }
});

// One transfer with its lines and the full dispatch / receipt trail.
router.get('/warehouse/transfers/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const only = visibleBranch(req);
    const pool = await getPool();
    const head = (await pool.request().input('o', sql.Int, orgId).input('id', sql.Int, int(req.params.id)).query(`${TRANSFER_SELECT} WHERE tr.organization_id = @o AND tr.id = @id`)).recordset[0];
    if (!head || (only != null && head.from_branch_id !== only && head.to_branch_id !== only)) throw new StockError('NOT_FOUND', 'Transfer not found', 404);
    const lines = (await pool.request().input('id', sql.Int, head.id)
      .query('SELECT tire_id, item_name, qty, qty_received, qty_short, dest_tire_id FROM stock_transfer_items WHERE transfer_id = @id ORDER BY id')).recordset;
    const events = (await pool.request().input('id', sql.Int, head.id).input('o', sql.Int, orgId)
      .query('SELECT e.id, e.event, e.note, e.details, e.created_at, u.name AS user_name FROM transfer_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.transfer_id = @id AND e.organization_id = @o ORDER BY e.id')).recordset
      .map(e => ({ ...e, details: e.details ? (() => { try { return JSON.parse(e.details); } catch { return null; } })() : null }));
    const canSettle = head.status === 'in_transit';
    res.json({ ...withDirection([head], only)[0], lines, events, can_receive: canSettle, can_cancel: canSettle });
  } catch (err) { fail(res, err); }
});

// ── Counts by location ─────────────────────────────────────────────────────
// For each location: last completed count, days since, open count and the variance it found.
router.get('/warehouse/counts', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const pool = await getPool();
    const r = (await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, branchId)
      .query(`SELECT l.id AS location_id, l.name AS location_name, l.kind, w.name AS warehouse_name,
                     ISNULL((SELECT SUM(x.qty) FROM item_location_stock x WHERE x.location_id = l.id), 0) AS units,
                     lc.id AS last_count_id, lc.count_no AS last_count_no, lc.completed_at AS last_counted_at,
                     DATEDIFF(DAY, lc.completed_at, GETDATE()) AS days_since,
                     oc.id AS open_count_id, oc.count_no AS open_count_no,
                     (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = lc.id AND i.counted_qty IS NOT NULL AND i.counted_qty <> i.system_qty) AS last_variances
              FROM stock_locations l LEFT JOIN warehouses w ON w.id = l.warehouse_id
              OUTER APPLY (SELECT TOP 1 c.id, c.count_no, c.completed_at FROM stock_counts c WHERE c.location_id = l.id AND c.status = 'completed' ORDER BY c.completed_at DESC) lc
              OUTER APPLY (SELECT TOP 1 c.id, c.count_no FROM stock_counts c WHERE c.location_id = l.id AND c.status = 'open' ORDER BY c.id DESC) oc
              WHERE l.organization_id = @o AND l.branch_id = @b AND l.is_active = 1 ORDER BY l.is_default DESC, l.name`)).recordset;
    res.json(r);
  } catch (err) { fail(res, err); }
});

module.exports = router;
