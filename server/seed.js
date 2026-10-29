/**
 * Dummy data seed for TuneGENDB.
 * Run: node server/seed.js
 * Safe to re-run — skips if data already exists.
 */
const { getPool, setupDatabase, sql } = require('./db');

// ─── Data definitions ────────────────────────────────────────────────────────

const CUSTOMERS = [
  { name: 'Ahmed Transport Co.',    phone: '+92-300-1234567', email: 'ahmed@atc.pk',       address: 'Lahore, Punjab' },
  { name: 'Hassan Autos',           phone: '+92-321-9876543', email: 'hassan@hassanautos.pk', address: 'Karachi, Sindh' },
  { name: 'Raza Motors',            phone: '+92-333-1112222', email: 'raza@razamotors.pk',  address: 'Islamabad' },
  { name: 'Khan Logistics',         phone: '+92-345-5556666', email: 'info@khanlogistics.pk', address: 'Faisalabad, Punjab' },
  { name: 'Malik Enterprises',      phone: '+92-312-7778888', email: 'malik@enterprise.pk', address: 'Multan, Punjab' },
  { name: 'Farooq Brothers',        phone: '+92-315-3334444', email: 'farooq@fbros.pk',     address: 'Rawalpindi, Punjab' },
];

const SUPPLIERS = [
  { name: 'Bridgestone Pakistan Ltd.', phone: '+92-21-34521234', email: 'supply@bridgestone.pk', address: 'Karachi, Sindh' },
  { name: 'Continental Trading Co.',   phone: '+92-42-35678901', email: 'orders@continental.pk', address: 'Lahore, Punjab' },
  { name: 'Dunlop Distributors',       phone: '+92-51-27891234', email: 'dunlop@dist.pk',         address: 'Islamabad' },
  { name: 'Yokohama Imports',          phone: '+92-21-38765432', email: 'yoko@imports.pk',         address: 'Karachi, Sindh' },
];

const TIRES = [
  { brand: 'Bridgestone', model: 'Ecopia EP150',       size: '195/65R15',  type: 'Passenger',   cost_price: 8500,  sale_price: 12000, stock: 30, reorder_level: 8  },
  { brand: 'Bridgestone', model: 'Turanza T005',        size: '205/55R16',  type: 'Passenger',   cost_price: 11000, sale_price: 15500, stock: 20, reorder_level: 6  },
  { brand: 'Bridgestone', model: 'Blizzak LM005',       size: '245/45R18',  type: 'Passenger',   cost_price: 22000, sale_price: 30000, stock: 10, reorder_level: 4  },
  { brand: 'Continental', model: 'ContiEcoContact 6',   size: '185/65R14',  type: 'Passenger',   cost_price: 7500,  sale_price: 11000, stock: 25, reorder_level: 8  },
  { brand: 'Continental', model: 'SportContact 6',      size: '225/45R17',  type: 'Performance', cost_price: 19000, sale_price: 27000, stock: 8,  reorder_level: 4  },
  { brand: 'Continental', model: 'Vancontact 200',      size: '225/75R16',  type: 'LT',          cost_price: 14000, sale_price: 19500, stock: 12, reorder_level: 5  },
  { brand: 'Dunlop',      model: 'SP Sport Maxx',       size: '235/45R17',  type: 'Performance', cost_price: 17000, sale_price: 23500, stock: 9,  reorder_level: 4  },
  { brand: 'Dunlop',      model: 'Grandtrek AT3',       size: '265/70R17',  type: '4x4',         cost_price: 20000, sale_price: 28000, stock: 7,  reorder_level: 4  },
  { brand: 'Yokohama',    model: 'BluEarth AE-01',      size: '195/60R15',  type: 'Passenger',   cost_price: 9000,  sale_price: 13000, stock: 18, reorder_level: 6  },
  { brand: 'Yokohama',    model: 'Geolandar A/T G015',  size: '255/65R17',  type: 'SUV',         cost_price: 21000, sale_price: 29500, stock: 6,  reorder_level: 4  },
];

const PRODUCTS = [
  { code: 'SVC-001', name: 'Wheel Alignment',    category: 'Service',     unit: 'job',  cost_price: 500,  sale_price: 1200  },
  { code: 'SVC-002', name: 'Tyre Balancing',     category: 'Service',     unit: 'job',  cost_price: 300,  sale_price: 800   },
  { code: 'ACC-001', name: 'Valve Stems Set',     category: 'Accessories', unit: 'set',  cost_price: 120,  sale_price: 350   },
  { code: 'ACC-002', name: 'Wheel Weights (Box)', category: 'Accessories', unit: 'box',  cost_price: 400,  sale_price: 900   },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

async function insertSale(pool, { invoice_no, customer_id, date, status, notes, items }) {
  const taxRate  = 15;
  const subtotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const tax      = parseFloat((subtotal * taxRate / 100).toFixed(2));
  const total    = parseFloat((subtotal + tax).toFixed(2));

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const sr = await new sql.Request(transaction)
      .input('invoice_no',  sql.NVarChar,    invoice_no)
      .input('customer_id', sql.Int,         customer_id)
      .input('date',        sql.Date,        date)
      .input('subtotal',    sql.Decimal(18,2), subtotal)
      .input('tax',         sql.Decimal(18,2), tax)
      .input('total',       sql.Decimal(18,2), total)
      .input('status',      sql.NVarChar,    status)
      .input('notes',       sql.NVarChar,    notes || '')
      .input('tax_rate',    sql.Decimal(5,2), taxRate)
      .query(`
        INSERT INTO sales (invoice_no,customer_id,date,subtotal,tax,total,status,notes,tax_rate)
        OUTPUT INSERTED.id
        VALUES (@invoice_no,@customer_id,@date,@subtotal,@tax,@total,@status,@notes,@tax_rate)
      `);
    const saleId = sr.recordset[0].id;

    for (const item of items) {
      const amount = parseFloat((item.qty * item.unit_price).toFixed(2));
      await new sql.Request(transaction)
        .input('sale_id',    sql.Int,           saleId)
        .input('tire_id',    sql.Int,           item.tire_id    || null)
        .input('product_id', sql.Int,           item.product_id || null)
        .input('tire_name',  sql.NVarChar,      item.name)
        .input('qty',        sql.Int,           item.qty)
        .input('unit_price', sql.Decimal(18,2), item.unit_price)
        .input('amount',     sql.Decimal(18,2), amount)
        .query(`INSERT INTO sale_items (sale_id,tire_id,product_id,tire_name,qty,unit_price,amount)
                VALUES (@sale_id,@tire_id,@product_id,@tire_name,@qty,@unit_price,@amount)`);
      if (item.tire_id && status === 'paid') {
        await new sql.Request(transaction)
          .input('tire_id', sql.Int, item.tire_id)
          .input('qty',     sql.Int, item.qty)
          .query('UPDATE tires SET stock = stock - @qty WHERE id = @tire_id');
      }
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

async function insertPurchase(pool, { po_no, supplier_id, date, status, notes, items }) {
  const subtotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const total    = parseFloat(subtotal.toFixed(2));

  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const pr = await new sql.Request(transaction)
      .input('po_no',       sql.NVarChar,    po_no)
      .input('supplier_id', sql.Int,         supplier_id)
      .input('date',        sql.Date,        date)
      .input('subtotal',    sql.Decimal(18,2), subtotal)
      .input('tax',         sql.Decimal(18,2), 0)
      .input('total',       sql.Decimal(18,2), total)
      .input('status',      sql.NVarChar,    status)
      .input('notes',       sql.NVarChar,    notes || '')
      .query(`
        INSERT INTO purchases (po_no,supplier_id,date,subtotal,tax,total,status,notes)
        OUTPUT INSERTED.id
        VALUES (@po_no,@supplier_id,@date,@subtotal,@tax,@total,@status,@notes)
      `);
    const purchaseId = pr.recordset[0].id;

    for (const item of items) {
      const amount = parseFloat((item.qty * item.unit_price).toFixed(2));
      await new sql.Request(transaction)
        .input('purchase_id', sql.Int,           purchaseId)
        .input('tire_id',     sql.Int,           item.tire_id    || null)
        .input('product_id',  sql.Int,           item.product_id || null)
        .input('tire_name',   sql.NVarChar,      item.name)
        .input('qty',         sql.Int,           item.qty)
        .input('unit_price',  sql.Decimal(18,2), item.unit_price)
        .input('amount',      sql.Decimal(18,2), amount)
        .query(`INSERT INTO purchase_items (purchase_id,tire_id,product_id,tire_name,qty,unit_price,amount)
                VALUES (@purchase_id,@tire_id,@product_id,@tire_name,@qty,@unit_price,@amount)`);
      if (status === 'received' && item.tire_id) {
        await new sql.Request(transaction)
          .input('tire_id', sql.Int, item.tire_id)
          .input('qty',     sql.Int, item.qty)
          .query('UPDATE tires SET stock = stock + @qty WHERE id = @tire_id');
      }
    }
    await transaction.commit();
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function seed() {
  console.log('Setting up database schema...');
  await setupDatabase();

  const pool = await getPool();

  // Check if already seeded
  const existingCustomers = await pool.request().query('SELECT COUNT(*) AS cnt FROM customers');
  if (existingCustomers.recordset[0].cnt > 0) {
    console.log(`\n⚠️  Customers table already has data (${existingCustomers.recordset[0].cnt} rows). Skipping seed.`);
    console.log('   To re-seed, delete all rows first or run against a fresh database.');
    process.exit(0);
  }

  console.log('\nInserting customers...');
  const customerIds = [];
  for (let i = 0; i < CUSTOMERS.length; i++) {
    const c    = CUSTOMERS[i];
    const code = `C${String(i + 1).padStart(3, '0')}`;
    const res  = await pool.request()
      .input('code',    sql.NVarChar, code)
      .input('name',    sql.NVarChar, c.name)
      .input('phone',   sql.NVarChar, c.phone)
      .input('email',   sql.NVarChar, c.email)
      .input('address', sql.NVarChar, c.address)
      .query('INSERT INTO customers (code,name,phone,email,address) OUTPUT INSERTED.id VALUES (@code,@name,@phone,@email,@address)');
    customerIds.push(res.recordset[0].id);
    console.log(`  ✓ ${c.name} (${code})`);
  }

  console.log('\nInserting suppliers...');
  const supplierIds = [];
  for (let i = 0; i < SUPPLIERS.length; i++) {
    const s    = SUPPLIERS[i];
    const code = `S${String(i + 1).padStart(3, '0')}`;
    const res  = await pool.request()
      .input('code',    sql.NVarChar, code)
      .input('name',    sql.NVarChar, s.name)
      .input('phone',   sql.NVarChar, s.phone)
      .input('email',   sql.NVarChar, s.email)
      .input('address', sql.NVarChar, s.address)
      .query('INSERT INTO suppliers (code,name,phone,email,address) OUTPUT INSERTED.id VALUES (@code,@name,@phone,@email,@address)');
    supplierIds.push(res.recordset[0].id);
    console.log(`  ✓ ${s.name} (${code})`);
  }

  console.log('\nInserting tire inventory...');
  const tireIds = [];
  for (const t of TIRES) {
    const res = await pool.request()
      .input('brand',         sql.NVarChar,    t.brand)
      .input('model',         sql.NVarChar,    t.model)
      .input('size',          sql.NVarChar,    t.size)
      .input('type',          sql.NVarChar,    t.type)
      .input('cost_price',    sql.Decimal(18,2), t.cost_price)
      .input('sale_price',    sql.Decimal(18,2), t.sale_price)
      .input('stock',         sql.Int,          t.stock)
      .input('reorder_level', sql.Int,          t.reorder_level)
      .query(`INSERT INTO tires (brand,model,size,type,cost_price,sale_price,stock,reorder_level)
              OUTPUT INSERTED.id VALUES (@brand,@model,@size,@type,@cost_price,@sale_price,@stock,@reorder_level)`);
    tireIds.push(res.recordset[0].id);
    console.log(`  ✓ ${t.brand} ${t.model} ${t.size} — stock: ${t.stock}`);
  }

  console.log('\nInserting products/services...');
  const productIds = [];
  for (const p of PRODUCTS) {
    const res = await pool.request()
      .input('code',       sql.NVarChar,    p.code)
      .input('name',       sql.NVarChar,    p.name)
      .input('category',   sql.NVarChar,    p.category)
      .input('unit',       sql.NVarChar,    p.unit)
      .input('cost_price', sql.Decimal(18,2), p.cost_price)
      .input('sale_price', sql.Decimal(18,2), p.sale_price)
      .query(`INSERT INTO products (code,name,category,unit,cost_price,sale_price,is_active)
              OUTPUT INSERTED.id VALUES (@code,@name,@category,@unit,@cost_price,@sale_price,1)`);
    productIds.push(res.recordset[0].id);
    console.log(`  ✓ ${p.name} (${p.code})`);
  }

  // Convenient shortcuts
  const [t1, t2, t3, t4, t5, t6, t7, t8, t9, t10] = tireIds;
  const [p1, p2, p3, p4] = productIds;
  const [c1, c2, c3, c4, c5, c6] = customerIds;
  const [s1, s2, s3, s4] = supplierIds;

  const tireName = (idx) => `${TIRES[idx].brand} ${TIRES[idx].model} ${TIRES[idx].size}`;

  console.log('\nInserting sales invoices...');

  const salesData = [
    {
      invoice_no: 'INV-2026-001', customer_id: c1, date: daysAgo(45), status: 'paid',
      notes: 'Bulk order — 4 passenger tyres',
      items: [
        { tire_id: t1, name: tireName(0), qty: 4, unit_price: TIRES[0].sale_price },
        { product_id: p1, name: PRODUCTS[0].name, qty: 1, unit_price: PRODUCTS[0].sale_price },
      ],
    },
    {
      invoice_no: 'INV-2026-002', customer_id: c2, date: daysAgo(38), status: 'paid',
      notes: 'Performance tyres + balancing',
      items: [
        { tire_id: t5, name: tireName(4), qty: 2, unit_price: TIRES[4].sale_price },
        { tire_id: t7, name: tireName(6), qty: 2, unit_price: TIRES[6].sale_price },
        { product_id: p2, name: PRODUCTS[1].name, qty: 4, unit_price: PRODUCTS[1].sale_price },
      ],
    },
    {
      invoice_no: 'INV-2026-003', customer_id: c3, date: daysAgo(28), status: 'paid',
      notes: 'SUV tyre replacement',
      items: [
        { tire_id: t10, name: tireName(9), qty: 4, unit_price: TIRES[9].sale_price },
        { product_id: p3, name: PRODUCTS[2].name, qty: 4, unit_price: PRODUCTS[2].sale_price },
      ],
    },
    {
      invoice_no: 'INV-2026-004', customer_id: c4, date: daysAgo(18), status: 'pending',
      notes: 'Fleet order — awaiting payment',
      items: [
        { tire_id: t6, name: tireName(5), qty: 6, unit_price: TIRES[5].sale_price },
        { product_id: p1, name: PRODUCTS[0].name, qty: 2, unit_price: PRODUCTS[0].sale_price },
      ],
    },
    {
      invoice_no: 'INV-2026-005', customer_id: c5, date: daysAgo(55), status: 'overdue',
      notes: 'Overdue — reminder sent',
      items: [
        { tire_id: t2, name: tireName(1), qty: 4, unit_price: TIRES[1].sale_price },
        { product_id: p4, name: PRODUCTS[3].name, qty: 2, unit_price: PRODUCTS[3].sale_price },
      ],
    },
    {
      invoice_no: 'INV-2026-006', customer_id: c6, date: daysAgo(10), status: 'pending',
      notes: '4x4 tyres for off-road fleet',
      items: [
        { tire_id: t8, name: tireName(7), qty: 4, unit_price: TIRES[7].sale_price },
        { product_id: p2, name: PRODUCTS[1].name, qty: 4, unit_price: PRODUCTS[1].sale_price },
      ],
    },
    {
      invoice_no: 'INV-2026-007', customer_id: c1, date: daysAgo(5), status: 'paid',
      notes: 'Repeat customer — premium tyres',
      items: [
        { tire_id: t3, name: tireName(2), qty: 4, unit_price: TIRES[2].sale_price },
        { product_id: p1, name: PRODUCTS[0].name, qty: 1, unit_price: PRODUCTS[0].sale_price },
        { product_id: p2, name: PRODUCTS[1].name, qty: 4, unit_price: PRODUCTS[1].sale_price },
      ],
    },
    {
      invoice_no: 'INV-2026-008', customer_id: c2, date: daysAgo(2), status: 'pending',
      notes: 'Workshop order',
      items: [
        { tire_id: t4, name: tireName(3), qty: 4, unit_price: TIRES[3].sale_price },
        { product_id: p3, name: PRODUCTS[2].name, qty: 4, unit_price: PRODUCTS[2].sale_price },
      ],
    },
  ];

  for (const sale of salesData) {
    await insertSale(pool, sale);
    console.log(`  ✓ ${sale.invoice_no} — ${sale.status} (${sale.items.length} items)`);
  }

  console.log('\nInserting purchase orders...');

  const purchasesData = [
    {
      po_no: 'PO-2026-001', supplier_id: s1, date: daysAgo(60), status: 'received',
      notes: 'Initial Bridgestone stock-up',
      items: [
        { tire_id: t1, name: tireName(0), qty: 20, unit_price: TIRES[0].cost_price },
        { tire_id: t2, name: tireName(1), qty: 15, unit_price: TIRES[1].cost_price },
      ],
    },
    {
      po_no: 'PO-2026-002', supplier_id: s2, date: daysAgo(50), status: 'received',
      notes: 'Continental passenger + LT range',
      items: [
        { tire_id: t4, name: tireName(3), qty: 18, unit_price: TIRES[3].cost_price },
        { tire_id: t5, name: tireName(4), qty: 10, unit_price: TIRES[4].cost_price },
        { tire_id: t6, name: tireName(5), qty: 12, unit_price: TIRES[5].cost_price },
      ],
    },
    {
      po_no: 'PO-2026-003', supplier_id: s3, date: daysAgo(40), status: 'received',
      notes: 'Dunlop performance + 4x4',
      items: [
        { tire_id: t7, name: tireName(6), qty: 10, unit_price: TIRES[6].cost_price },
        { tire_id: t8, name: tireName(7), qty: 8,  unit_price: TIRES[7].cost_price },
      ],
    },
    {
      po_no: 'PO-2026-004', supplier_id: s4, date: daysAgo(30), status: 'received',
      notes: 'Yokohama restocking',
      items: [
        { tire_id: t9,  name: tireName(8), qty: 15, unit_price: TIRES[8].cost_price },
        { tire_id: t10, name: tireName(9), qty: 8,  unit_price: TIRES[9].cost_price },
      ],
    },
    {
      po_no: 'PO-2026-005', supplier_id: s1, date: daysAgo(15), status: 'received',
      notes: 'Bridgestone premium restock',
      items: [
        { tire_id: t3, name: tireName(2), qty: 8,  unit_price: TIRES[2].cost_price },
        { tire_id: t1, name: tireName(0), qty: 12, unit_price: TIRES[0].cost_price },
      ],
    },
    {
      po_no: 'PO-2026-006', supplier_id: s2, date: daysAgo(5), status: 'pending',
      notes: 'Q2 bulk order — awaiting delivery',
      items: [
        { tire_id: t4, name: tireName(3), qty: 20, unit_price: TIRES[3].cost_price },
        { tire_id: t5, name: tireName(4), qty: 12, unit_price: TIRES[4].cost_price },
      ],
    },
  ];

  for (const po of purchasesData) {
    await insertPurchase(pool, po);
    console.log(`  ✓ ${po.po_no} — ${po.status} (${po.items.length} items)`);
  }

  console.log('\n✅ Seed complete!');
  console.log(`   ${CUSTOMERS.length} customers`);
  console.log(`   ${SUPPLIERS.length} suppliers`);
  console.log(`   ${TIRES.length} tire SKUs`);
  console.log(`   ${PRODUCTS.length} products/services`);
  console.log(`   ${salesData.length} sales invoices`);
  console.log(`   ${purchasesData.length} purchase orders`);
}

seed()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n❌ Seed failed:', err.message); process.exit(1); });
