// Product / material master data rules shared by the inventory routes: allowed values, validation of the
// optional master attributes, per-item unit conversions, and the change history of important attributes.
const { sql } = require('../db');
const { StockError, ROTATION_POLICIES } = require('./stock');
const { parseSeasonality } = require('./replenishment');

const UOMS = ['pcs', 'set', 'pair', 'dozen', 'box', 'carton', 'pack', 'pallet', 'roll', 'bag', 'bottle', 'can', 'drum', 'sheet', 'kit',
              'kg', 'g', 'lb', 'oz', 'l', 'ml', 'gal', 'm', 'cm', 'mm', 'ft', 'in', 'sqm', 'sqft', 'cbm', 'hour', 'unit'];
const ITEM_TYPES = {
  finished_good: 'Finished goods', raw_material: 'Raw material', consumable: 'Consumable', packaging: 'Packaging material',
  component: 'Component', spare_part: 'Spare part', other: 'Other',
};
const STATUSES = ['active', 'inactive', 'discontinued'];
const TAX_CLASSES = ['standard', 'reduced', 'zero', 'exempt'];

const bad = (code, message) => new StockError(code, message, 400);

const isBlank = v => v === undefined || v === null || v === '';
const text = (v, max) => { const t = String(v ?? '').trim().slice(0, max); return t || null; };

function num(v, label, { min = 0, max = Infinity, int = false, positive = false } = {}) {
  if (isBlank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw bad('INVALID_NUMBER', `${label} must be a number`);
  if (int && !Number.isInteger(n)) throw bad('INVALID_NUMBER', `${label} must be a whole number`);
  if (positive ? n <= 0 : n < min) throw bad('INVALID_NUMBER', `${label} must be ${positive ? 'greater than zero' : `${min} or more`}`);
  if (n > max) throw bad('INVALID_NUMBER', `${label} must be ${max} or less`);
  return n;
}

function uomOf(v, label) {
  if (isBlank(v)) return null;
  const u = String(v).trim().toLowerCase();
  if (!UOMS.includes(u)) throw bad('INVALID_UOM', `${label} "${String(v).trim()}" is not valid. Use one of: ${UOMS.join(', ')}`);
  return u;
}

// Column name -> [SQL type, parser(body value) -> clean value]. Only keys present in the request are touched.
const EXTRA = {
  item_type:             [sql.NVarChar(20),   v => { const t = String(v).trim().toLowerCase(); if (!ITEM_TYPES[t]) throw bad('INVALID_ITEM_TYPE', `Item type must be one of: ${Object.keys(ITEM_TYPES).join(', ')}`); return t; }],
  manufacturer:          [sql.NVarChar(100),  v => text(v, 100)],
  supplier_id:           [sql.Int,            v => (isBlank(v) ? null : num(v, 'Supplier', { int: true, positive: true }))],
  purchase_uom:          [sql.NVarChar(20),   v => uomOf(v, 'Purchase unit')],
  sales_uom:             [sql.NVarChar(20),   v => uomOf(v, 'Sales unit')],
  pack_size:             [sql.Decimal(18, 4), v => num(v, 'Pack size', { positive: true })],
  length_cm:             [sql.Decimal(18, 3), v => num(v, 'Length')],
  width_cm:              [sql.Decimal(18, 3), v => num(v, 'Width')],
  height_cm:             [sql.Decimal(18, 3), v => num(v, 'Height')],
  weight_kg:             [sql.Decimal(18, 3), v => num(v, 'Weight')],
  volume_l:              [sql.Decimal(18, 3), v => num(v, 'Volume')],
  tax_class:             [sql.NVarChar(20),   v => { if (isBlank(v)) return null; const t = String(v).trim().toLowerCase(); if (!TAX_CLASSES.includes(t)) throw bad('INVALID_TAX_CLASS', `Tax classification must be one of: ${TAX_CLASSES.join(', ')}`); return t; }],
  tax_rate:              [sql.Decimal(5, 2),  v => num(v, 'Tax rate', { max: 100 })],
  min_stock:             [sql.Int,            v => num(v, 'Minimum stock', { int: true })],
  max_stock:             [sql.Int,            v => num(v, 'Maximum stock', { int: true })],
  reorder_qty:           [sql.Int,            v => num(v, 'Preferred replenishment quantity', { int: true, positive: true })],
  storage_requirements:  [sql.NVarChar(500),  v => text(v, 500)],
  handling_instructions: [sql.NVarChar(500),  v => text(v, 500)],
  safety_requirements:   [sql.NVarChar(500),  v => text(v, 500)],
  shelf_life_days:       [sql.Int,            v => num(v, 'Shelf life', { int: true, positive: true })],
  storage_conditions:    [sql.NVarChar(200),  v => text(v, 200)],
  rotation_policy:       [sql.NVarChar(15),   v => { if (isBlank(v)) return null; const t = String(v).trim().toLowerCase(); if (!ROTATION_POLICIES[t]) throw bad('INVALID_ROTATION', `Rotation policy must be one of: ${Object.keys(ROTATION_POLICIES).join(', ')}`); return t; }],
  inspection_interval_days: [sql.Int,         v => num(v, 'Inspection interval', { int: true, max: 3650 })],
  near_expiry_days:      [sql.Int,            v => num(v, 'Near-expiry window', { int: true, max: 3650 })],
  min_remaining_days:    [sql.Int,            v => num(v, 'Minimum remaining shelf life', { int: true, max: 3650 })],
  require_mfg_date:      [sql.Bit,            v => { if (isBlank(v) || v === 'inherit') return null; if (v === true || v === 1 || v === '1' || v === 'yes' || v === 'true') return true; if (v === false || v === 0 || v === '0' || v === 'no' || v === 'false') return false; throw bad('INVALID_MFG_RULE', 'Manufacturing date rule must be yes, no or inherit'); }],
  quality_profile_id:    [sql.Int,            v => (isBlank(v) ? null : num(v, 'Quality profile', { int: true, positive: true }))],
  hazard_class_id:       [sql.Int,            v => (isBlank(v) ? null : num(v, 'Hazard class', { int: true, positive: true }))],
  un_number:             [sql.NVarChar(10),   v => { if (isBlank(v)) return null; const m = /^(?:UN|NA)?\s*(\d{4})$/i.exec(String(v).trim()); if (!m) throw bad('INVALID_UN_NUMBER', 'UN number must be four digits, e.g. UN1203'); return 'UN' + m[1]; }],
  packing_group:         [sql.NVarChar(3),    v => { if (isBlank(v)) return null; const t = String(v).trim().toUpperCase(); if (!['I', 'II', 'III'].includes(t)) throw bad('INVALID_PACKING_GROUP', 'Packing group must be I, II or III'); return t; }],
  flash_point_c:         [sql.Decimal(6, 1),  v => num(v, 'Flash point', { min: -273, max: 2000 })],
  sds_ref:               [sql.NVarChar(300),  v => text(v, 300)],
  sds_date:              [sql.Date,           v => { if (isBlank(v)) return null; const t = String(v).slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t))) throw bad('INVALID_DATE', 'SDS date must be a valid date'); if (t > new Date().toISOString().slice(0, 10)) throw bad('INVALID_DATE', 'SDS date cannot be in the future'); return t; }],
  ppe:                   [sql.NVarChar(300),  v => text(v, 300)],
  emergency_info:        [sql.NVarChar(500),  v => text(v, 500)],
  storage_temp_min_c:    [sql.Decimal(6, 1),  v => num(v, 'Minimum storage temperature', { min: -273, max: 2000 })],
  storage_temp_max_c:    [sql.Decimal(6, 1),  v => num(v, 'Maximum storage temperature', { min: -273, max: 2000 })],
  hazard_inspection_days: [sql.Int,           v => num(v, 'Hazard inspection interval', { int: true, positive: true, max: 3650 })],
  reorder_mode:          [sql.NVarChar(10),   v => { if (isBlank(v)) return null; const t = String(v).trim().toLowerCase(); if (!['auto', 'manual'].includes(t)) throw bad('INVALID_REORDER_MODE', 'Reorder mode must be auto or manual'); return t; }],
  safety_stock:          [sql.Int,            v => num(v, 'Safety stock', { int: true })],
  lead_time_days:        [sql.Int,            v => num(v, 'Lead time', { int: true, max: 365 })],
  moq:                   [sql.Int,            v => num(v, 'Minimum order quantity', { int: true, positive: true })],
  order_multiple:        [sql.Int,            v => num(v, 'Order multiple', { int: true, positive: true })],
  capacity_units:        [sql.Int,            v => num(v, 'Storage capacity', { int: true, positive: true })],
  seasonality:           [sql.NVarChar(200),  v => parseSeasonality(v)],
  status:                [sql.NVarChar(15),   v => { const t = String(v).trim().toLowerCase(); if (!STATUSES.includes(t)) throw bad('INVALID_STATUS', `Status must be one of: ${STATUSES.join(', ')}`); return t; }],
};

/**
 * Validate the optional master attributes in a request body. Returns only the keys that were supplied, cleaned.
 * `is_active` is accepted as a legacy way to set the status. Throws a 400 StockError on the first problem.
 */
function parseExtra(body, current = {}) {
  const out = {};
  for (const [key, [, parse]] of Object.entries(EXTRA)) {
    if (body[key] === undefined) continue;
    if ((key === 'item_type' || key === 'status') && isBlank(body[key])) continue;
    out[key] = parse(body[key]);
  }
  if (out.status === undefined && body.is_active !== undefined) {
    const off = body.is_active === false || body.is_active === 0 || body.is_active === '0';
    if (off && current.status !== 'discontinued' && current.status !== 'inactive') out.status = 'inactive';
    else if (!off && current.status && current.status !== 'active') out.status = 'active';
  }
  const min = out.min_stock !== undefined ? out.min_stock : current.min_stock;
  const max = out.max_stock !== undefined ? out.max_stock : current.max_stock;
  if (min != null && max != null && Number(min) > Number(max)) throw bad('INVALID_STOCK_LEVELS', 'Minimum stock cannot be greater than maximum stock');
  const cap = out.capacity_units !== undefined ? out.capacity_units : current.capacity_units;
  if (cap != null && max != null && Number(max) > Number(cap)) throw bad('INVALID_STOCK_LEVELS', 'Maximum stock cannot be greater than the storage capacity');
  const tmin = out.storage_temp_min_c !== undefined ? out.storage_temp_min_c : current.storage_temp_min_c;
  const tmax = out.storage_temp_max_c !== undefined ? out.storage_temp_max_c : current.storage_temp_max_c;
  if (tmin != null && tmax != null && Number(tmin) > Number(tmax)) throw bad('INVALID_TEMPERATURE', 'Minimum storage temperature cannot be above the maximum');
  return out;
}

/** Alternative units: [{ uom, factor }] where 1 uom = factor base units. */
function parseConversions(list, baseUom) {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw bad('INVALID_CONVERSIONS', 'Unit conversions must be a list');
  const seen = new Set(), out = [];
  for (const c of list) {
    if (isBlank(c?.uom) && isBlank(c?.factor)) continue;
    const uom = uomOf(c.uom, 'Conversion unit');
    const factor = num(c.factor, `Conversion factor for ${uom}`, { positive: true });
    if (!uom || factor == null) throw bad('INVALID_CONVERSIONS', 'Each unit conversion needs a unit and a factor');
    if (uom === baseUom) throw bad('INVALID_CONVERSIONS', `"${uom}" is the item's base unit; it does not need a conversion`);
    if (seen.has(uom)) throw bad('INVALID_CONVERSIONS', `Unit "${uom}" appears twice in the conversions`);
    seen.add(uom); out.push({ uom, factor });
  }
  return out;
}

async function loadConversions(request, tireId) {
  const r = await request.input('cvt', sql.Int, tireId).query('SELECT uom, factor FROM item_uom_conversions WHERE tire_id = @cvt ORDER BY uom');
  return r.recordset.map(c => ({ uom: c.uom, factor: Number(c.factor) }));
}

async function saveConversions(tx, tireId, list) {
  await new sql.Request(tx).input('t', sql.Int, tireId).query('DELETE FROM item_uom_conversions WHERE tire_id = @t');
  for (const c of list) {
    await new sql.Request(tx).input('t', sql.Int, tireId).input('u', sql.NVarChar(20), c.uom).input('f', sql.Decimal(18, 6), c.factor)
      .query('INSERT INTO item_uom_conversions (tire_id, uom, factor) VALUES (@t, @u, @f)');
  }
}

/** Write the validated extras to the item; also keeps legacy is_active in step with status. */
async function applyExtra(tx, tireId, values) {
  const keys = Object.keys(values);
  if (!keys.length) return;
  // a class or profile must belong to the item's own organisation
  for (const [col, table] of [['hazard_class_id', 'hazard_classes'], ['quality_profile_id', 'quality_profiles']]) {
    if (values[col] == null) continue;
    const ok = await new sql.Request(tx).input('id', sql.Int, tireId).input('c', sql.Int, values[col])
      .query(`SELECT 1 AS x FROM ${table} c JOIN tires t ON t.organization_id = c.organization_id WHERE c.id = @c AND t.id = @id`);
    if (!ok.recordset.length) throw bad('NOT_FOUND', col === 'hazard_class_id' ? 'Hazard class not found' : 'Quality profile not found');
  }
  const rq = new sql.Request(tx).input('id', sql.Int, tireId);
  const sets = keys.map(k => { rq.input(k, EXTRA[k][0], values[k]); return `${k} = @${k}`; });
  if (values.status !== undefined) sets.push(`is_active = ${values.status === 'active' ? 1 : 0}`);
  await rq.query(`UPDATE tires SET ${sets.join(', ')} WHERE id = @id`);
}

// Important attributes whose changes are kept in product_history.
const TRACKED = ['sku', 'barcode', 'brand', 'model', 'size', 'description', 'category_id', 'uom', 'purchase_uom', 'sales_uom', 'item_type', 'manufacturer',
  'supplier_id', 'cost_price', 'sale_price', 'tax_class', 'tax_rate', 'min_stock', 'max_stock', 'reorder_level', 'reorder_qty', 'tracking', 'track_expiry',
  'status', 'shelf_life_days', 'pack_size', 'weight_kg', 'volume_l', 'length_cm', 'width_cm', 'height_cm', 'storage_requirements', 'handling_instructions',
  'safety_requirements', 'storage_conditions', 'rotation_policy', 'reorder_mode', 'safety_stock', 'lead_time_days', 'moq', 'order_multiple', 'capacity_units', 'seasonality', 'hazard_class_id', 'un_number', 'packing_group', 'flash_point_c', 'sds_ref', 'sds_date', 'ppe', 'emergency_info', 'storage_temp_min_c', 'storage_temp_max_c', 'hazard_inspection_days', 'inspection_interval_days', 'near_expiry_days', 'min_remaining_days', 'require_mfg_date', 'quality_profile_id', 'conversions'];

const norm = v => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const n = Number(v);
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(n) && String(n) === v.trim()) ? String(n) : String(v).trim();
};
const convText = list => (list && list.length ? list.map(c => `${c.uom}=${Number(c.factor)}`).join('; ') : null);

/** Record each tracked attribute that differs between two snapshots of an item. Returns the number of changes logged. */
async function logChanges(tx, { orgId, tireId, userId, before, after }) {
  let n = 0;
  for (const f of TRACKED) {
    const a = f === 'conversions' ? convText(before?.conversions) : norm(before?.[f]);
    const b = f === 'conversions' ? convText(after?.conversions) : norm(after?.[f]);
    if (a === b) continue;
    await new sql.Request(tx).input('o', sql.Int, orgId).input('t', sql.Int, tireId).input('f', sql.NVarChar(40), f)
      .input('a', sql.NVarChar(500), a === null ? null : a.slice(0, 500)).input('b', sql.NVarChar(500), b === null ? null : b.slice(0, 500)).input('u', sql.Int, userId ?? null)
      .query('INSERT INTO product_history (organization_id, tire_id, field, old_value, new_value, user_id) VALUES (@o, @t, @f, @a, @b, @u)');
    n++;
  }
  return n;
}

async function logCreated(tx, { orgId, tireId, userId, name }) {
  await new sql.Request(tx).input('o', sql.Int, orgId).input('t', sql.Int, tireId).input('n', sql.NVarChar(500), String(name).slice(0, 500)).input('u', sql.Int, userId ?? null)
    .query("INSERT INTO product_history (organization_id, tire_id, field, old_value, new_value, user_id) VALUES (@o, @t, '(created)', NULL, @n, @u)");
}

/** Inactive items cannot be sold or bought; discontinued items can still be sold (to clear stock) but not bought. */
async function assertTransactable(tx, orgId, tireIds, kind) {
  const ids = [...new Set(tireIds.filter(Boolean).map(Number))];
  if (!ids.length) return;
  const rq = new sql.Request(tx).input('o', sql.Int, orgId);
  const list = ids.map((id, i) => { rq.input('i' + i, sql.Int, id); return '@i' + i; }).join(',');
  const r = await rq.query(`SELECT LTRIM(RTRIM(brand + ' ' + model + ' ' + size)) AS name, status FROM tires WHERE organization_id = @o AND id IN (${list}) AND status <> 'active'`);
  for (const t of r.recordset) {
    if (t.status === 'inactive' || kind === 'purchase') {
      throw new StockError('ITEM_INACTIVE', `${t.name} is ${t.status} and cannot be ${kind === 'sale' ? 'sold' : 'purchased'}. Reactivate it in Inventory first.`, 409);
    }
  }
}

module.exports = { UOMS, ITEM_TYPES, STATUSES, TAX_CLASSES, EXTRA, parseExtra, parseConversions, loadConversions, saveConversions, applyExtra,
  uomOf, logChanges, logCreated, assertTransactable, TRACKED };
