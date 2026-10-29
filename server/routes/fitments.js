'use strict';
/**
 * Vehicle fitment routes — Pakistan-market OEM tyre lookup.
 * Mounted at: /api/fitments
 *
 * Cascade flow:  Category → Make → Model → Search
 * Results cross-reference tire_catalog by normalised size (space-insensitive).
 */

const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');

/** Strip spaces before R/C so "195/65 R15" matches "195/65R15" in both tables. */
const SIZE_NORM_SQL = `REPLACE(REPLACE(%COL%, ' R', 'R'), ' C', 'C')`;
function normCol(col) { return SIZE_NORM_SQL.replace('%COL%', col); }

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/fitments/categories
   Distinct categories in catalogue order.
───────────────────────────────────────────────────────────────────────────── */
router.get('/categories', async (req, res) => {
  try {
    const pool   = await getPool();
    // SQL Server requires ORDER BY columns to appear in SELECT when using DISTINCT.
    // Wrap in a subquery: inner selects category + sort_key, outer orders by sort_key.
    const result = await pool.request().query(`
      SELECT category FROM (
        SELECT DISTINCT category,
          CASE category
            WHEN 'Passenger Car Tyres'       THEN 1
            WHEN 'SUV/Crossovers Tyres'      THEN 2
            WHEN 'Light Truck Tyres'         THEN 3
            WHEN 'Truck & Bus/OTR Tyres'     THEN 4
            WHEN 'Tractor Tyres'             THEN 5
            WHEN 'Motorcycle/Rickshaw Tyres' THEN 6
            ELSE 7
          END AS sort_key
        FROM vehicle_fitments
      ) AS cats
      ORDER BY sort_key
    `);
    res.json(result.recordset.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/fitments/makes?category=Passenger+Car+Tyres
───────────────────────────────────────────────────────────────────────────── */
router.get('/makes', async (req, res) => {
  try {
    const pool = await getPool();
    const { category } = req.query;
    const r = pool.request();
    let where = '';
    if (category) {
      r.input('cat', sql.NVarChar(100), category);
      where = 'WHERE category = @cat';
    }
    const result = await r.query(
      `SELECT DISTINCT make FROM vehicle_fitments ${where} ORDER BY make`
    );
    res.json(result.recordset.map(row => row.make));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/fitments/models?make=Toyota&category=Passenger+Car+Tyres
───────────────────────────────────────────────────────────────────────────── */
router.get('/models', async (req, res) => {
  try {
    const pool = await getPool();
    const { make, category } = req.query;
    if (!make) return res.status(400).json({ error: 'make is required' });

    const r    = pool.request().input('make', sql.NVarChar(50), make);
    const cond = ['make = @make'];
    if (category) { r.input('cat', sql.NVarChar(100), category); cond.push('category = @cat'); }

    const result = await r.query(`
      SELECT DISTINCT model FROM vehicle_fitments
      WHERE ${cond.join(' AND ')}
      ORDER BY model
    `);
    res.json(result.recordset.map(row => row.model));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/fitments/search?make=Toyota&model=Corolla+XLi%2FGLi+%282014-2024%29&category=...
   Returns fitment rows + matching tire_catalog entries per normalised size.
───────────────────────────────────────────────────────────────────────────── */
router.get('/search', async (req, res) => {
  try {
    const pool = await getPool();
    const { make, model, category } = req.query;

    if (!make && !model) {
      return res.status(400).json({ error: 'At least make or model is required' });
    }

    const r    = pool.request();
    const cond = [];
    if (category) { r.input('cat',   sql.NVarChar(100), category); cond.push('vf.category = @cat'); }
    if (make)     { r.input('make',  sql.NVarChar(50),  make);     cond.push('vf.make = @make');     }
    if (model)    { r.input('model', sql.NVarChar(200), model);    cond.push('vf.model = @model');   }

    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';

    // 1. Fetch fitment rows
    const fitRes = await r.query(`
      SELECT id, category, make, model, year_from, year_to,
             tire_size, gtr_pattern, position
      FROM vehicle_fitments vf
      ${where}
      ORDER BY make, model, ISNULL(year_from, 0), ISNULL(position, 'Z')
    `);

    if (fitRes.recordset.length === 0) {
      return res.json({ fitments: [], catalogMatches: {} });
    }

    // 2. Distinct normalised sizes for batch catalogue lookup
    const sizes = [...new Set(fitRes.recordset.map(f => f.tire_size))];

    // 3. Lookup catalog entries for each unique size (normalise both sides)
    const catalogMatches = {};
    for (const size of sizes) {
      const normSize = size.replace(/ R(\d)/g, 'R$1').replace(/ C$/, 'C');
      const catReq = pool.request().input('size', sql.NVarChar(50), normSize);
      const catRes = await catReq.query(`
        SELECT id, brand, model AS tire_model, size,
               pattern, load_index, speed_index, tire_type
        FROM tire_catalog
        WHERE ${normCol('size')} = ${normCol('@size')}
        ORDER BY brand, model
      `);
      catalogMatches[size] = catRes.recordset;
    }

    res.json({ fitments: fitRes.recordset, catalogMatches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
