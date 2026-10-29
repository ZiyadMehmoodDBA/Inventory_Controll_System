'use strict';
/**
 * Pakistan-market vehicle → OEM tyre fitment seed.
 * Data source: files/vehicle-fitment.json (built from GTR Master Catalogue + Pakistan auto market).
 *
 * Categories match GTR's own structure:
 *   Passenger Car Tyres | SUV/Crossovers Tyres | Light Truck Tyres
 *   Truck & Bus/OTR Tyres | Tractor Tyres | Motorcycle/Rickshaw Tyres
 *
 * Strategy: TRUNCATE + bulk INSERT on every restart so reference data stays
 * current without MERGE complexity.
 */

const path = require('path');
const FITMENT_DATA = require(path.join(__dirname, '../../files/vehicle-fitment.json'));

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Extract year_from / year_to from model strings like "(2014-2024)" or "(2021+)". */
function parseYears(str) {
  let m = str.match(/\((\d{4})[-–](\d{4})\)/);
  if (m) return { year_from: +m[1], year_to: +m[2] };
  m = str.match(/\((\d{4})\+\)/);
  if (m) return { year_from: +m[1], year_to: null };
  return { year_from: null, year_to: null };
}

/**
 * Normalise a tyre size string to a compact form without spaces before R/C.
 * "195/65 R15" → "195/65R15", "7.50 R16 C" → "7.50R16C"
 */
function normaliseSize(size) {
  return size
    .replace(/\s+R(\d)/g, 'R$1')
    .replace(/\s+C(\b|$)/g, 'C')
    .trim();
}

/** Detect Front / Rear from motorcycle / tractor model strings. */
function parsePosition(str) {
  if (/\bFront$/i.test(str.trim())) return 'Front';
  if (/\bRear$/i.test(str.trim()))  return 'Rear';
  return null;
}

/** Strip " Front" / " Rear" suffix from the display label. */
function stripPosition(str) {
  return str.replace(/\s+(Front|Rear)$/i, '').trim();
}

/* ── Build rows ───────────────────────────────────────────────────────────── */
function buildRows() {
  const rows = [];
  for (const [category, makesObj] of Object.entries(FITMENT_DATA)) {
    for (const [make, entries] of Object.entries(makesObj)) {
      for (const entry of entries) {
        const position          = parsePosition(entry.model);
        const model             = stripPosition(entry.model);
        const { year_from, year_to } = parseYears(model);
        const tire_size         = normaliseSize(entry.size);

        rows.push({
          category,
          make,
          model,
          year_from,   // null if not stated
          year_to,
          tire_size,
          gtr_pattern: entry.gtr ?? null,
          position,    // 'Front' | 'Rear' | null
        });
      }
    }
  }
  return rows;
}

/* ── Seed function ────────────────────────────────────────────────────────── */
async function seedVehicleFitments(dbPool, sql) {
  // Always rebuild — this is read-only reference data, not user data.
  await dbPool.request().query('TRUNCATE TABLE vehicle_fitments');

  const rows = buildRows();
  for (const r of rows) {
    await dbPool.request()
      .input('category',    sql.NVarChar(100), r.category)
      .input('make',        sql.NVarChar(50),  r.make)
      .input('model',       sql.NVarChar(200), r.model)
      .input('year_from',   sql.SmallInt,      r.year_from)
      .input('year_to',     sql.SmallInt,      r.year_to)
      .input('tire_size',   sql.NVarChar(50),  r.tire_size)
      .input('gtr_pattern', sql.NVarChar(100), r.gtr_pattern)
      .input('position',    sql.NVarChar(10),  r.position)
      .query(`
        INSERT INTO vehicle_fitments
          (category, make, model, year_from, year_to, tire_size, gtr_pattern, position)
        VALUES
          (@category, @make, @model, @year_from, @year_to, @tire_size, @gtr_pattern, @position)
      `);
  }

  console.log(`✅ Vehicle fitments seeded: ${rows.length} rows across ${Object.keys(FITMENT_DATA).length} categories`);
}

module.exports = { seedVehicleFitments };
