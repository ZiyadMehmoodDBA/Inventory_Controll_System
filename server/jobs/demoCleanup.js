/**
 * Demo cleanup job — runs every 30 minutes.
 *
 * Resets transactional data (sales, purchases, payments, ledger) for the demo
 * organisation and re-seeds it so the demo always looks fresh.
 * Customers, suppliers, and inventory are left intact (static demo master data).
 */

const cron = require('node-cron');
const { getPool, sql } = require('../db');

// Cached after first lookup so we don't hit the DB every 30 min just for this
let _demoOrgId   = null;
let _demoBranchId = null;

async function getDemoContext() {
  if (_demoOrgId && _demoBranchId) return { orgId: _demoOrgId, branchId: _demoBranchId };
  const pool = await getPool();

  const orgRes = await pool.request()
    .input('code', sql.NVarChar, 'DEMO')
    .query('SELECT id FROM organizations WHERE code = @code');
  _demoOrgId = orgRes.recordset[0]?.id ?? null;
  if (!_demoOrgId) return null;

  const branchRes = await pool.request()
    .input('org_id', sql.Int, _demoOrgId)
    .query('SELECT TOP 1 id FROM branches WHERE organization_id = @org_id ORDER BY id');
  _demoBranchId = branchRes.recordset[0]?.id ?? null;

  return _demoOrgId && _demoBranchId ? { orgId: _demoOrgId, branchId: _demoBranchId } : null;
}

async function deleteTransactions(pool, orgId) {
  // Delete in FK-safe order
  await pool.request().input('org_id', sql.Int, orgId).query(`
    DELETE sp FROM sale_payments sp
    INNER JOIN sales s ON s.id = sp.sale_id
    WHERE s.organization_id = @org_id
  `);
  await pool.request().input('org_id', sql.Int, orgId).query(`
    DELETE pp FROM purchase_payments pp
    INNER JOIN purchases p ON p.id = pp.purchase_id
    WHERE p.organization_id = @org_id
  `);
  await pool.request().input('org_id', sql.Int, orgId).query(`
    DELETE si FROM sale_items si
    INNER JOIN sales s ON s.id = si.sale_id
    WHERE s.organization_id = @org_id
  `);
  await pool.request().input('org_id', sql.Int, orgId).query(`
    DELETE pi FROM purchase_items pi
    INNER JOIN purchases p ON p.id = pi.purchase_id
    WHERE p.organization_id = @org_id
  `);
  await pool.request().input('org_id', sql.Int, orgId).query(
    'DELETE FROM sales     WHERE organization_id = @org_id'
  );
  await pool.request().input('org_id', sql.Int, orgId).query(
    'DELETE FROM purchases WHERE organization_id = @org_id'
  );
  await pool.request().input('org_id', sql.Int, orgId).query(
    'DELETE FROM ledger_entries WHERE organization_id = @org_id'
  );
  // Revert customer/supplier balances to 0 (they drifted from demo activity)
  await pool.request().input('org_id', sql.Int, orgId).query(
    'UPDATE customers SET balance = 0 WHERE organization_id = @org_id'
  );
  await pool.request().input('org_id', sql.Int, orgId).query(
    'UPDATE suppliers SET balance = 0 WHERE organization_id = @org_id'
  );
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function seedDemoTransactions(pool, orgId, branchId) {
  // Fetch demo customers and tires
  const custRows = await pool.request()
    .input('org_id', sql.Int, orgId)
    .query('SELECT id FROM customers WHERE organization_id = @org_id ORDER BY id');
  const customers = custRows.recordset.map(r => r.id);

  const tireRows = await pool.request()
    .input('org_id', sql.Int, orgId)
    .query('SELECT id, sale_price FROM tires WHERE organization_id = @org_id ORDER BY id');
  const tires = tireRows.recordset;

  const supplierRows = await pool.request()
    .input('org_id', sql.Int, orgId)
    .query('SELECT id FROM suppliers WHERE organization_id = @org_id ORDER BY id');
  const suppliers = supplierRows.recordset.map(r => r.id);

  if (!customers.length || !tires.length) return;

  // ── 6 demo sales ──────────────────────────────────────────────────────────
  const salesSpec = [
    { custIdx: 0, days: 0,  inv: 'DEMO-INV-001', status: 'pending',  paidPct: 0,   tireIdxs: [0, 2] },
    { custIdx: 1, days: 3,  inv: 'DEMO-INV-002', status: 'paid',     paidPct: 1,   tireIdxs: [3] },
    { custIdx: 2, days: 6,  inv: 'DEMO-INV-003', status: 'partial',  paidPct: 0.5, tireIdxs: [1, 4] },
    { custIdx: 3, days: 12, inv: 'DEMO-INV-004', status: 'overdue',  paidPct: 0,   tireIdxs: [0] },
    { custIdx: 0, days: 18, inv: 'DEMO-INV-005', status: 'paid',     paidPct: 1,   tireIdxs: [2, 3, 1] },
    { custIdx: 4, days: 25, inv: 'DEMO-INV-006', status: 'voided',   paidPct: 0,   tireIdxs: [4] },
  ];

  for (const s of salesSpec) {
    const lineItems = s.tireIdxs.map(i => tires[i % tires.length]);
    const subtotal  = lineItems.reduce((acc, t) => acc + Number(t.sale_price), 0);
    const tax       = Math.round(subtotal * 0.15 * 100) / 100;
    const total     = subtotal + tax;
    const amtPaid   = Math.round(total * s.paidPct * 100) / 100;

    const saleRes = await pool.request()
      .input('invoice_no',    sql.NVarChar,      s.inv)
      .input('customer_id',   sql.Int,           customers[s.custIdx % customers.length])
      .input('date',          sql.NVarChar,      daysAgo(s.days))
      .input('subtotal',      sql.Decimal(18,2), subtotal)
      .input('tax',           sql.Decimal(18,2), tax)
      .input('total',         sql.Decimal(18,2), total)
      .input('amount_paid',   sql.Decimal(18,2), amtPaid)
      .input('status',        sql.NVarChar,      s.status)
      .input('org_id',        sql.Int,           orgId)
      .input('branch_id',     sql.Int,           branchId)
      .query(`
        INSERT INTO sales
          (invoice_no, customer_id, date, subtotal, tax, total, amount_paid, status, organization_id, branch_id)
        OUTPUT INSERTED.id
        VALUES
          (@invoice_no, @customer_id, @date, @subtotal, @tax, @total, @amount_paid, @status, @org_id, @branch_id)
      `);
    const saleId = saleRes.recordset[0].id;

    for (const tire of lineItems) {
      await pool.request()
        .input('sale_id',    sql.Int,           saleId)
        .input('tire_id',    sql.Int,           tire.id)
        .input('tire_name',  sql.NVarChar,      'Demo Tire')
        .input('qty',        sql.Int,           1)
        .input('unit_price', sql.Decimal(18,2), tire.sale_price)
        .input('amount',     sql.Decimal(18,2), tire.sale_price)
        .query(`
          INSERT INTO sale_items (sale_id, tire_id, tire_name, qty, unit_price, amount)
          VALUES (@sale_id, @tire_id, @tire_name, @qty, @unit_price, @amount)
        `);
    }
  }

  // ── 3 demo purchases ──────────────────────────────────────────────────────
  if (!suppliers.length) return;

  const purchasesSpec = [
    { suppIdx: 0, days: 2,  po: 'DEMO-PO-001', status: 'received', paidPct: 1,   tireIdxs: [0, 1, 2] },
    { suppIdx: 1, days: 8,  po: 'DEMO-PO-002', status: 'pending',  paidPct: 0,   tireIdxs: [3, 4] },
    { suppIdx: 2, days: 20, po: 'DEMO-PO-003', status: 'partial',  paidPct: 0.4, tireIdxs: [1, 3] },
  ];

  for (const p of purchasesSpec) {
    const lineItems = p.tireIdxs.map(i => tires[i % tires.length]);
    const subtotal  = lineItems.reduce((acc, t) => acc + Number(t.sale_price) * 0.75, 0); // cost ~75% of sale
    const tax       = Math.round(subtotal * 0.15 * 100) / 100;
    const total     = subtotal + tax;
    const amtPaid   = Math.round(total * p.paidPct * 100) / 100;

    const poRes = await pool.request()
      .input('po_no',       sql.NVarChar,      p.po)
      .input('supplier_id', sql.Int,           suppliers[p.suppIdx % suppliers.length])
      .input('date',        sql.NVarChar,      daysAgo(p.days))
      .input('subtotal',    sql.Decimal(18,2), subtotal)
      .input('tax',         sql.Decimal(18,2), tax)
      .input('total',       sql.Decimal(18,2), total)
      .input('amount_paid', sql.Decimal(18,2), amtPaid)
      .input('status',      sql.NVarChar,      p.status)
      .input('org_id',      sql.Int,           orgId)
      .input('branch_id',   sql.Int,           branchId)
      .query(`
        INSERT INTO purchases
          (po_no, supplier_id, date, subtotal, tax, total, amount_paid, status, organization_id, branch_id)
        OUTPUT INSERTED.id
        VALUES
          (@po_no, @supplier_id, @date, @subtotal, @tax, @total, @amount_paid, @status, @org_id, @branch_id)
      `);
    const poId = poRes.recordset[0].id;

    for (const tire of lineItems) {
      const cost = Number(tire.sale_price) * 0.75;
      await pool.request()
        .input('purchase_id', sql.Int,           poId)
        .input('tire_id',     sql.Int,           tire.id)
        .input('tire_name',   sql.NVarChar,      'Demo Tire')
        .input('qty',         sql.Int,           2)
        .input('unit_price',  sql.Decimal(18,2), cost)
        .input('amount',      sql.Decimal(18,2), cost * 2)
        .query(`
          INSERT INTO purchase_items (purchase_id, tire_id, tire_name, qty, unit_price, amount)
          VALUES (@purchase_id, @tire_id, @tire_name, @qty, @unit_price, @amount)
        `);
    }
  }
}

async function resetDemoData() {
  const ctx = await getDemoContext();
  if (!ctx) {
    console.log('[DemoCleanup] Demo org not found — skipping reset.');
    return;
  }
  const pool = await getPool();
  await deleteTransactions(pool, ctx.orgId);
  await seedDemoTransactions(pool, ctx.orgId, ctx.branchId);
  console.log('[DemoCleanup] Demo transactions reset for org', ctx.orgId);
}

function initDemoCleanupJob() {
  // Every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    resetDemoData().catch(err => console.error('[DemoCleanup] Error:', err.message));
  });
  console.log('✅ Demo cleanup job scheduled (every 30 min)');
}

module.exports = { initDemoCleanupJob, resetDemoData, seedDemoTransactions };
