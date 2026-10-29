// Hazardous materials & special handling rules, enforced by the stock ledger.
//   Opt-in per item: an item is "special" only if it has a hazard class, a storage temperature range or a safety hold.
//   Every other item skips all of this (no extra queries, no restrictions), so businesses without such stock are unaffected.
// Rules:
//   storage   hazard class must be permitted at the location (and within its cap), the location's inspection must be current and not failed,
//             no open blocking incident there, no incompatible class stored there, and a temperature-sensitive item needs a location
//             whose declared range sits inside the item's tolerance. Restricted-kind locations (quarantine, damaged) are exempt from the
//             permit and temperature rules so unsafe stock can always be contained, but segregation still applies.
//   dispatch  (sales, transfers out) blocked by a safety hold, a missing SDS or transport details when the class requires them, or an
//             open blocking incident on the item or its location. Moving stock into a restricted location (containment) is always allowed.
//   Adjustments out, write-offs, disposals and corrections (voids, cancelled receipts) are never blocked.
// Standalone: the stock ledger imports this file, so StockError is required lazily.
const { sql } = require('../db');
const err = (code, message, status = 409, details = {}) => { const { StockError } = require('./stock'); return new StockError(code, message, status, details); };

const HZ_COLUMNS = 't.hazard_class_id, t.storage_temp_min_c, t.storage_temp_max_c, t.un_number, t.sds_ref, t.hazard_hold';
const isSpecial = i => i.hazard_class_id != null || i.storage_temp_min_c != null || i.storage_temp_max_c != null || !!i.hazard_hold;
const INTAKE = new Set(['grn_received', 'transfer_in', 'opening_stock', 'adjustment']);
const DISPATCH = new Set(['sale', 'transfer_out']);
const DEFAULT_SDS_MAX_AGE = 1095, DEFAULT_DUE_SOON = 7;
const INCIDENT_TYPES = { spill: 'Spill', leak: 'Leak', fire: 'Fire / explosion', exposure: 'Exposure / injury', temperature_excursion: 'Temperature excursion', damage: 'Damaged packaging', near_miss: 'Near miss', other: 'Other' };
const SEVERITIES = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
const PACKING_GROUPS = ['I', 'II', 'III'];

const todayStr = () => new Date().toISOString().slice(0, 10);
const dayOf = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
const addDays = (d, n) => { const x = new Date(dayOf(d) + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function companyNumber(conn, orgId, key, fallback = null) {
  const r = await new sql.Request(conn).input('o', sql.Int, orgId).input('k', sql.NVarChar(100), key).query('SELECT TOP 1 value FROM settings WHERE organization_id = @o AND [key] = @k');
  const n = Number(r.recordset[0]?.value);
  return r.recordset.length && Number.isFinite(n) ? n : fallback;
}

/** Latest inspection of a location and what it means for new hazardous stock arriving there. */
async function locationInspection(conn, orgId, loc) {
  const last = (await new sql.Request(conn).input('o', sql.Int, orgId).input('l', sql.Int, loc.id)
    .query("SELECT TOP 1 result, inspected_at, next_due FROM hazard_inspections WHERE organization_id = @o AND subject_type = 'location' AND location_id = @l ORDER BY id DESC")).recordset[0] ?? null;
  const interval = loc.inspection_interval_days ?? await companyNumber(conn, orgId, 'hz_location_inspection_days', null);
  const due = last ? (last.next_due ? dayOf(last.next_due) : interval > 0 ? addDays(last.inspected_at, interval) : null) : null;
  const overdue = interval > 0 && (!last || (due != null && due < todayStr()));
  return { last, interval: interval > 0 ? interval : null, due, failed: last?.result === 'fail', overdue, never: interval > 0 && !last };
}

async function getClass(conn, orgId, id) {
  return (await new sql.Request(conn).input('o', sql.Int, orgId).input('id', sql.Int, id)
    .query('SELECT id, code, name, kind, requires_sds, requires_transport_info, is_active FROM hazard_classes WHERE id = @id AND organization_id = @o')).recordset[0] ?? null;
}

/** Throws if `qty` more units of this item may not be put in this location. */
async function assertStorable(conn, orgId, item, loc, qty) {
  if (!isSpecial(item)) return;
  const name = item.item_name ?? `item ${item.id}`;
  const normal = (loc.kind ?? 'normal') === 'normal';
  if (item.hazard_class_id != null) {
    const cls = await getClass(conn, orgId, item.hazard_class_id);
    const label = cls ? `${cls.name} (${cls.code})` : 'its hazard class';
    if (normal) {
      const permit = (await new sql.Request(conn).input('l', sql.Int, loc.id).input('c', sql.Int, item.hazard_class_id)
        .query('SELECT max_qty FROM location_hazard_permits WHERE location_id = @l AND hazard_class_id = @c')).recordset[0];
      if (!permit) throw err('HAZMAT_LOCATION_NOT_PERMITTED', `${name} is ${label} and ${loc.name} is not approved to store it. Permit the class on that location under Hazmat > Locations, or choose an approved location.`, 409, { tireId: item.id, locationId: loc.id });
      if (permit.max_qty != null) {
        const cur = (await new sql.Request(conn).input('l', sql.Int, loc.id).input('c', sql.Int, item.hazard_class_id)
          .query('SELECT ISNULL(SUM(x.qty), 0) AS n FROM item_location_stock x JOIN tires t ON t.id = x.tire_id WHERE x.location_id = @l AND t.hazard_class_id = @c AND x.qty > 0')).recordset[0].n;
        if (cur + qty > permit.max_qty) throw err('HAZMAT_LOCATION_CAPACITY', `${loc.name} may hold at most ${permit.max_qty} unit(s) of ${label}; it has ${cur}, adding ${qty} would exceed the limit`, 409, { limit: permit.max_qty, current: cur });
      }
      const insp = await locationInspection(conn, orgId, loc);
      if (insp.failed) throw err('HAZMAT_LOCATION_FAILED_INSPECTION', `${loc.name} failed its last safety inspection. Hazardous stock cannot be added until it passes a new inspection.`, 409, { locationId: loc.id });
      if (insp.overdue) throw err('HAZMAT_LOCATION_INSPECTION_OVERDUE', `${loc.name} is overdue for its safety inspection${insp.due ? ` (was due ${insp.due})` : ' (never inspected)'}. Record an inspection before adding hazardous stock.`, 409, { locationId: loc.id });
    }
    const open = (await new sql.Request(conn).input('o', sql.Int, orgId).input('l', sql.Int, loc.id)
      .query("SELECT TOP 1 incident_no FROM hazard_incidents WHERE organization_id = @o AND location_id = @l AND status = 'open' AND blocks_dispatch = 1")).recordset[0];
    if (open) throw err('HAZMAT_INCIDENT_OPEN', `${loc.name} has an open incident (${open.incident_no}) that blocks hazardous stock. Close it first.`, 409, { incident: open.incident_no });
    const clash = (await new sql.Request(conn).input('l', sql.Int, loc.id).input('c', sql.Int, item.hazard_class_id).input('t', sql.Int, item.id)
      .query(`SELECT TOP 1 c.code, c.name, i.reason, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name
              FROM item_location_stock x JOIN tires t ON t.id = x.tire_id JOIN hazard_classes c ON c.id = t.hazard_class_id
              JOIN hazard_incompatibilities i ON (i.class_a = @c AND i.class_b = c.id) OR (i.class_b = @c AND i.class_a = c.id)
              WHERE x.location_id = @l AND x.qty > 0 AND t.id <> @t`)).recordset[0];
    if (clash) throw err('HAZMAT_INCOMPATIBLE_STORAGE', `${name} (${label}) must be segregated from ${clash.item_name} (${clash.name}) and cannot share ${loc.name}${clash.reason ? `: ${clash.reason}` : ''}`, 409, { locationId: loc.id });
  }
  if (normal && (item.storage_temp_min_c != null || item.storage_temp_max_c != null)) {
    const lo = loc.temp_min_c != null ? Number(loc.temp_min_c) : null, hi = loc.temp_max_c != null ? Number(loc.temp_max_c) : null;
    const imin = item.storage_temp_min_c != null ? Number(item.storage_temp_min_c) : null, imax = item.storage_temp_max_c != null ? Number(item.storage_temp_max_c) : null;
    const range = `${imin ?? '…'} to ${imax ?? '…'} °C`;
    if ((imin != null && (lo == null || lo < imin)) || (imax != null && (hi == null || hi > imax))) {
      throw err('HAZMAT_TEMPERATURE', `${name} must be stored at ${range}, but ${loc.name} ${lo == null && hi == null ? 'has no declared temperature range' : `is rated ${lo ?? '…'} to ${hi ?? '…'} °C`}. Set the location's range under Hazmat > Locations or use a suitable location.`, 409, { locationId: loc.id });
    }
  }
}

/** Throws if units of this item may not leave this location by sale or transfer. */
async function assertDispatchable(conn, orgId, item, loc, o = {}) {
  if (!isSpecial(item) || o.containment) return;
  const name = item.item_name ?? `item ${item.id}`;
  if (item.hazard_hold) throw err('HAZMAT_HOLD', `${name} is on a safety hold and cannot be dispatched${item.hazard_hold_reason ? `: ${item.hazard_hold_reason}` : ''}`, 409, { tireId: item.id });
  if (item.hazard_class_id != null) {
    const cls = await getClass(conn, orgId, item.hazard_class_id);
    if (cls?.requires_sds && !item.sds_ref) throw err('HAZMAT_SDS_MISSING', `${name} needs a Safety Data Sheet on file before it can be dispatched (${cls.name} requires one)`, 409, { tireId: item.id });
    if (cls?.requires_transport_info && !item.un_number) throw err('HAZMAT_TRANSPORT_INFO_MISSING', `${name} needs its UN number recorded before it can be dispatched (${cls.name} requires transport details)`, 409, { tireId: item.id });
  }
  const open = (await new sql.Request(conn).input('o', sql.Int, orgId).input('t', sql.Int, item.id).input('l', sql.Int, loc.id).input('h', sql.Bit, item.hazard_class_id != null ? 1 : 0)
    .query("SELECT TOP 1 incident_no FROM hazard_incidents WHERE organization_id = @o AND status = 'open' AND blocks_dispatch = 1 AND (tire_id = @t OR (@h = 1 AND location_id = @l)) ORDER BY id")).recordset[0];
  if (open) throw err('HAZMAT_INCIDENT_OPEN', `${name} is blocked by open incident ${open.incident_no}. Close the incident before dispatching.`, 409, { incident: open.incident_no });
}

/** Incompatible classes may not travel or be sold together. ids: item ids of one shipment. */
async function assertCompatibleLoad(conn, orgId, ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isInteger))];
  if (list.length < 2) return;
  const r = await new sql.Request(conn).input('o', sql.Int, orgId).query(
    `SELECT TOP 1 LTRIM(RTRIM(a.brand + ' ' + a.model + ' ' + a.size)) AS a_name, ca.name AS a_class, LTRIM(RTRIM(b.brand + ' ' + b.model + ' ' + b.size)) AS b_name, cb.name AS b_class, i.reason
     FROM tires a JOIN tires b ON a.id < b.id
     JOIN hazard_classes ca ON ca.id = a.hazard_class_id JOIN hazard_classes cb ON cb.id = b.hazard_class_id
     JOIN hazard_incompatibilities i ON (i.class_a = a.hazard_class_id AND i.class_b = b.hazard_class_id) OR (i.class_a = b.hazard_class_id AND i.class_b = a.hazard_class_id)
     WHERE a.organization_id = @o AND b.organization_id = @o AND a.id IN (${list.join(',')}) AND b.id IN (${list.join(',')})`);
  const x = r.recordset[0];
  if (x) throw err('HAZMAT_INCOMPATIBLE_LOAD', `${x.a_name} (${x.a_class}) and ${x.b_name} (${x.b_class}) are incompatible and cannot be dispatched together${x.reason ? `: ${x.reason}` : ''}`);
}

/** Called by the ledger for every movement line. */
async function guardMovement(conn, { item, loc }, o) {
  if (!isSpecial(item)) return;
  if (o.qtyChange > 0 && INTAKE.has(o.reason)) await assertStorable(conn, o.orgId, item, loc, o.qtyChange);
  else if (o.qtyChange < 0 && DISPATCH.has(o.reason)) await assertDispatchable(conn, o.orgId, item, loc, o);
}

/** Transfer: load compatibility plus destination suitability for every special line, before anything moves. */
async function assertTransferAllowed(conn, orgId, items, to) {
  const ids = items.map(i => i.tireId);
  await assertCompatibleLoad(conn, orgId, ids);
  const rows = (await new sql.Request(conn).input('o', sql.Int, orgId)
    .query(`SELECT t.id, ${HZ_COLUMNS}, LTRIM(RTRIM(t.brand + ' ' + t.model + ' ' + t.size)) AS item_name FROM tires t WHERE t.organization_id = @o AND t.id IN (${ids.map(Number).filter(Number.isInteger).join(',') || '0'})`)).recordset;
  for (const row of rows) {
    if (!isSpecial(row)) continue;
    await assertStorable(conn, orgId, row, to, items.find(i => i.tireId === row.id)?.qty ?? 0);
  }
}

module.exports = { HZ_COLUMNS, isSpecial, INCIDENT_TYPES, SEVERITIES, PACKING_GROUPS, DEFAULT_SDS_MAX_AGE, DEFAULT_DUE_SOON, companyNumber, locationInspection, getClass,
  assertStorable, assertDispatchable, assertCompatibleLoad, assertTransferAllowed, guardMovement, todayStr, dayOf, addDays };
