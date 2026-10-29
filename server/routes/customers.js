const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db');
const { getContext }   = require('../context');
const { nextEntityCode } = require('../utils/docNumber');

// Returns the existing customer that owns this phone number within the org,
// or null if the phone is free.  Pass excludeId on updates to ignore self.
async function findPhoneDuplicate(pool, orgId, phone, excludeId = null) {
  const cleaned = (phone || '').trim();
  if (!cleaned) return null;
  const req = pool.request()
    .input('orgId', sql.Int,      orgId)
    .input('phone', sql.NVarChar, cleaned);
  let q = 'SELECT id, name FROM customers WHERE organization_id = @orgId AND phone = @phone';
  if (excludeId != null) {
    req.input('excludeId', sql.Int, excludeId);
    q += ' AND id != @excludeId';
  }
  const res = await req.query(q);
  return res.recordset[0] ?? null;
}

router.get('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const result = await pool.request()
      .input('orgId', sql.Int, orgId)
      .query(`
        SELECT
          c.*,
          ISNULL((SELECT SUM(s.total)   FROM sales s         WHERE s.customer_id  = c.id AND s.organization_id = @orgId), 0) AS total_invoiced,
          ISNULL((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.customer_id = c.id AND sp.organization_id = @orgId), 0) AS total_paid,
          ISNULL((SELECT SUM(s.total)   FROM sales s         WHERE s.customer_id  = c.id AND s.organization_id = @orgId), 0) -
          ISNULL((SELECT SUM(sp.amount) FROM sale_payments sp WHERE sp.customer_id = c.id AND sp.organization_id = @orgId), 0) AS balance_due,
          ISNULL((SELECT COUNT(*)       FROM sales s         WHERE s.customer_id  = c.id AND s.organization_id = @orgId), 0) AS invoice_count,
          ISNULL((SELECT COUNT(*)       FROM sales s         WHERE s.customer_id  = c.id AND s.organization_id = @orgId
                                          AND s.status IN ('pending','overdue','partial')), 0) AS unpaid_count
        FROM customers c
        WHERE c.organization_id = @orgId
        ORDER BY balance_due DESC, c.name ASC
      `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const result = await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT * FROM customers WHERE id = @id AND organization_id = @orgId');
    if (!result.recordset.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const {
      name, phone, email, address,
      vehicle_plate, vehicle_make, vehicle_model, vehicle_year,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const pool = await getPool();

    // Unique phone check
    const dup = await findPhoneDuplicate(pool, orgId, phone);
    if (dup) {
      return res.status(409).json({
        error: `Phone number already registered to "${dup.name}". Each customer must have a unique phone.`,
      });
    }

    const code = await nextEntityCode(pool.request(), 'customers');

    const result = await pool.request()
      .input('orgId',         sql.Int,      orgId)
      .input('code',          sql.NVarChar, code)
      .input('name',          sql.NVarChar, name.trim())
      .input('phone',         sql.NVarChar, (phone   || '').trim())
      .input('email',         sql.NVarChar, (email   || '').trim())
      .input('address',       sql.NVarChar, (address || '').trim())
      .input('vehicle_plate', sql.NVarChar, (vehicle_plate || '').trim().toUpperCase() || null)
      .input('vehicle_make',  sql.NVarChar, (vehicle_make  || '').trim() || null)
      .input('vehicle_model', sql.NVarChar, (vehicle_model || '').trim() || null)
      .input('vehicle_year',  sql.SmallInt, vehicle_year ? Number(vehicle_year) : null)
      .query(`
        INSERT INTO customers
          (organization_id, code, name, phone, email, address,
           vehicle_plate, vehicle_make, vehicle_model, vehicle_year)
        OUTPUT INSERTED.*
        VALUES
          (@orgId, @code, @name, @phone, @email, @address,
           @vehicle_plate, @vehicle_make, @vehicle_model, @vehicle_year)
      `);
    res.status(201).json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const {
      name, phone, email, address, balance,
      vehicle_plate, vehicle_make, vehicle_model, vehicle_year,
    } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const pool = await getPool();

    // Unique phone check (exclude self)
    const dup = await findPhoneDuplicate(pool, orgId, phone, Number(req.params.id));
    if (dup) {
      return res.status(409).json({
        error: `Phone number already registered to "${dup.name}". Each customer must have a unique phone.`,
      });
    }

    const result = await pool.request()
      .input('id',            sql.Int,           req.params.id)
      .input('orgId',         sql.Int,           orgId)
      .input('name',          sql.NVarChar,      name.trim())
      .input('phone',         sql.NVarChar,      (phone   || '').trim())
      .input('email',         sql.NVarChar,      (email   || '').trim())
      .input('address',       sql.NVarChar,      (address || '').trim())
      .input('balance',       sql.Decimal(18,2), balance || 0)
      .input('vehicle_plate', sql.NVarChar,      (vehicle_plate || '').trim().toUpperCase() || null)
      .input('vehicle_make',  sql.NVarChar,      (vehicle_make  || '').trim() || null)
      .input('vehicle_model', sql.NVarChar,      (vehicle_model || '').trim() || null)
      .input('vehicle_year',  sql.SmallInt,      vehicle_year ? Number(vehicle_year) : null)
      .query(`
        UPDATE customers SET
          name=@name, phone=@phone, email=@email, address=@address, balance=@balance,
          vehicle_plate=@vehicle_plate, vehicle_make=@vehicle_make,
          vehicle_model=@vehicle_model, vehicle_year=@vehicle_year
        OUTPUT INSERTED.*
        WHERE id = @id AND organization_id = @orgId
      `);
    if (!result.recordset.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const pool = await getPool();
    const check = await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('SELECT COUNT(*) AS cnt FROM sales WHERE customer_id = @id AND organization_id = @orgId');
    if (check.recordset[0].cnt > 0) {
      return res.status(400).json({ error: 'Cannot delete customer with existing sales records.' });
    }
    await pool.request()
      .input('id',    sql.Int, req.params.id)
      .input('orgId', sql.Int, orgId)
      .query('DELETE FROM customers WHERE id = @id AND organization_id = @orgId');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bulk', async (req, res) => {
  const { orgId } = getContext(req);
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows provided' });
  }
  const pool = await getPool();
  let inserted = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const name = String(row.name || '').trim();
      if (!name) { errors.push({ row: i + 2, message: 'Name is required' }); continue; }

      const phone = String(row.phone || '').trim();
      if (phone) {
        const dup = await findPhoneDuplicate(pool, orgId, phone);
        if (dup) {
          errors.push({ row: i + 2, message: `Phone ${phone} already used by "${dup.name}"` });
          continue;
        }
      }

      const code = await nextEntityCode(pool.request(), 'customers');

      const yr = row.vehicle_year ? Number(row.vehicle_year) : null;
      await pool.request()
        .input('orgId',         sql.Int,      orgId)
        .input('code',          sql.NVarChar, code)
        .input('name',          sql.NVarChar, name)
        .input('phone',         sql.NVarChar, phone)
        .input('email',         sql.NVarChar, String(row.email   || '').trim())
        .input('address',       sql.NVarChar, String(row.address || '').trim())
        .input('vehicle_plate', sql.NVarChar, String(row.vehicle_plate || '').trim().toUpperCase() || null)
        .input('vehicle_make',  sql.NVarChar, String(row.vehicle_make  || '').trim() || null)
        .input('vehicle_model', sql.NVarChar, String(row.vehicle_model || '').trim() || null)
        .input('vehicle_year',  sql.SmallInt, yr)
        .query(`
          INSERT INTO customers
            (organization_id, code, name, phone, email, address,
             vehicle_plate, vehicle_make, vehicle_model, vehicle_year)
          VALUES
            (@orgId, @code, @name, @phone, @email, @address,
             @vehicle_plate, @vehicle_make, @vehicle_model, @vehicle_year)
        `);
      inserted++;
    } catch (err) {
      errors.push({ row: i + 2, message: err.message });
    }
  }
  res.json({ inserted, errors });
});

module.exports = router;
