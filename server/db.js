const sql    = require('mssql');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { seedTireCatalog }      = require('./seeds/tireCatalog');
const { seedVehicleFitments }  = require('./seeds/vehicleFitments');

const baseConfig = {
  server:   process.env.DB_SERVER || 'localhost',
  user:     process.env.DB_USER   || 'sa',
  password: process.env.DB_PASSWORD || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true,
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
  connectionTimeout: 15000,
  requestTimeout:    30000,
};

let pool = null;

async function getPool() {
  // Reconnect if the pool was closed or errored
  if (!pool || !pool.connected) {
    if (pool) { try { await pool.close(); } catch (_) {} }
    pool = new sql.ConnectionPool({ ...baseConfig, database: process.env.DB_NAME || 'TuneGENDB' });
    pool.on('error', err => {
      console.error('SQL pool error:', err.message);
      pool = null; // force reconnect on next call
    });
    await pool.connect();
  }
  return pool;
}

async function getSetting(key, defaultValue = '', orgId = 1) {
  try {
    const p = await getPool();
    const result = await p.request()
      .input('key',    sql.NVarChar, key)
      .input('org_id', sql.Int,      orgId)
      .query('SELECT value FROM settings WHERE [key] = @key AND organization_id = @org_id');
    return result.recordset[0]?.value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

async function setupDatabase() {
  const masterPool = new sql.ConnectionPool({ ...baseConfig, database: 'master' });
  await masterPool.connect();
  await masterPool.request().query(`
    IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'TuneGENDB')
    BEGIN
      CREATE DATABASE TuneGENDB;
    END
  `);
  await masterPool.close();

  const dbPool = new sql.ConnectionPool({ ...baseConfig, database: 'TuneGENDB' });
  await dbPool.connect();
  const r = dbPool.request();

  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='customers' AND xtype='U')
    CREATE TABLE customers (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      code        NVARCHAR(20)  UNIQUE NOT NULL,
      name        NVARCHAR(100) NOT NULL,
      phone       NVARCHAR(50),
      email       NVARCHAR(100),
      address     NVARCHAR(200),
      balance     DECIMAL(18,2) DEFAULT 0,
      created_at  DATETIME DEFAULT GETDATE()
    )
  `);

  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='suppliers' AND xtype='U')
    CREATE TABLE suppliers (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      code        NVARCHAR(20)  UNIQUE NOT NULL,
      name        NVARCHAR(100) NOT NULL,
      phone       NVARCHAR(50),
      email       NVARCHAR(100),
      address     NVARCHAR(200),
      balance     DECIMAL(18,2) DEFAULT 0,
      created_at  DATETIME DEFAULT GETDATE()
    )
  `);

  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tires' AND xtype='U')
    CREATE TABLE tires (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      brand         NVARCHAR(100) NOT NULL,
      model         NVARCHAR(100) NOT NULL,
      size          NVARCHAR(50)  NOT NULL,
      type          NVARCHAR(50),
      stock         INT DEFAULT 0,
      cost_price    DECIMAL(18,2) NOT NULL DEFAULT 0,
      sale_price    DECIMAL(18,2) NOT NULL DEFAULT 0,
      reorder_level INT DEFAULT 10,
      created_at    DATETIME DEFAULT GETDATE()
    )
  `);

  // Products / goods catalog (services, accessories, non-tire items)
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='products' AND xtype='U')
    CREATE TABLE products (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      code        NVARCHAR(50),
      name        NVARCHAR(200) NOT NULL,
      description NVARCHAR(500),
      category    NVARCHAR(100),
      unit        NVARCHAR(50) DEFAULT 'pcs',
      cost_price  DECIMAL(18,2) DEFAULT 0,
      sale_price  DECIMAL(18,2) DEFAULT 0,
      is_active   BIT DEFAULT 1,
      created_at  DATETIME DEFAULT GETDATE()
    )
  `);

  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sales' AND xtype='U')
    CREATE TABLE sales (
      id           INT IDENTITY(1,1) PRIMARY KEY,
      invoice_no   NVARCHAR(50)  UNIQUE NOT NULL,
      customer_id  INT REFERENCES customers(id),
      date         DATE NOT NULL,
      subtotal     DECIMAL(18,2) NOT NULL DEFAULT 0,
      tax          DECIMAL(18,2) NOT NULL DEFAULT 0,
      total        DECIMAL(18,2) NOT NULL DEFAULT 0,
      status       NVARCHAR(20)  DEFAULT 'pending',
      notes        NVARCHAR(500),
      created_at   DATETIME DEFAULT GETDATE()
    )
  `);

  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sale_items' AND xtype='U')
    CREATE TABLE sale_items (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      sale_id     INT REFERENCES sales(id) ON DELETE CASCADE,
      tire_id     INT REFERENCES tires(id),
      product_id  INT REFERENCES products(id),
      tire_name   NVARCHAR(200),
      qty         INT NOT NULL DEFAULT 1,
      unit_price  DECIMAL(18,2) NOT NULL DEFAULT 0,
      amount      DECIMAL(18,2) NOT NULL DEFAULT 0
    )
  `);

  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='purchases' AND xtype='U')
    CREATE TABLE purchases (
      id           INT IDENTITY(1,1) PRIMARY KEY,
      po_no        NVARCHAR(50)  UNIQUE NOT NULL,
      supplier_id  INT REFERENCES suppliers(id),
      date         DATE NOT NULL,
      subtotal     DECIMAL(18,2) NOT NULL DEFAULT 0,
      tax          DECIMAL(18,2) NOT NULL DEFAULT 0,
      total        DECIMAL(18,2) NOT NULL DEFAULT 0,
      status       NVARCHAR(20)  DEFAULT 'pending',
      notes        NVARCHAR(500),
      created_at   DATETIME DEFAULT GETDATE()
    )
  `);

  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='purchase_items' AND xtype='U')
    CREATE TABLE purchase_items (
      id           INT IDENTITY(1,1) PRIMARY KEY,
      purchase_id  INT REFERENCES purchases(id) ON DELETE CASCADE,
      tire_id      INT REFERENCES tires(id),
      product_id   INT REFERENCES products(id),
      tire_name    NVARCHAR(200),
      qty          INT NOT NULL DEFAULT 1,
      unit_price   DECIMAL(18,2) NOT NULL DEFAULT 0,
      amount       DECIMAL(18,2) NOT NULL DEFAULT 0
    )
  `);

  // Settings key-value store
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='settings' AND xtype='U')
    CREATE TABLE settings (
      [key]      NVARCHAR(100) PRIMARY KEY,
      value      NVARCHAR(1000),
      updated_at DATETIME DEFAULT GETDATE()
    )
  `);

  // Payments against sales invoices (for partial/full payment tracking)
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sale_payments' AND xtype='U')
    CREATE TABLE sale_payments (
      id             INT IDENTITY(1,1) PRIMARY KEY,
      sale_id        INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      customer_id    INT NOT NULL REFERENCES customers(id),
      amount         DECIMAL(18,2) NOT NULL,
      payment_date   DATE NOT NULL,
      payment_method NVARCHAR(50) DEFAULT 'cash',
      reference_no   NVARCHAR(100) DEFAULT '',
      notes          NVARCHAR(500) DEFAULT '',
      created_at     DATETIME DEFAULT GETDATE()
    )
  `);

  // Payments to suppliers against purchase orders
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='purchase_payments' AND xtype='U')
    CREATE TABLE purchase_payments (
      id             INT IDENTITY(1,1) PRIMARY KEY,
      purchase_id    INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      supplier_id    INT NOT NULL REFERENCES suppliers(id),
      amount         DECIMAL(18,2) NOT NULL,
      payment_date   DATE NOT NULL,
      payment_method NVARCHAR(50) DEFAULT 'cash',
      reference_no   NVARCHAR(100) DEFAULT '',
      notes          NVARCHAR(500) DEFAULT '',
      created_at     DATETIME DEFAULT GETDATE()
    )
  `);

  // Financial ledger — immutable journal entries (banking-style)
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ledger_entries' AND xtype='U')
    CREATE TABLE ledger_entries (
      id           INT IDENTITY(1,1) PRIMARY KEY,
      entry_date   DATE NOT NULL,
      entity_type  NVARCHAR(20) NOT NULL,
      entity_id    INT NOT NULL,
      entry_type   NVARCHAR(30) NOT NULL,
      debit        DECIMAL(18,2) DEFAULT 0,
      credit       DECIMAL(18,2) DEFAULT 0,
      description  NVARCHAR(500) DEFAULT '',
      reference_no NVARCHAR(100) DEFAULT '',
      sale_id      INT REFERENCES sales(id),
      purchase_id  INT REFERENCES purchases(id),
      created_at   DATETIME DEFAULT GETDATE()
    )
  `);

  // Tire type lookups
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tire_types' AND xtype='U')
    CREATE TABLE tire_types (
      id         INT IDENTITY(1,1) PRIMARY KEY,
      name       NVARCHAR(100) NOT NULL,
      sort_order INT DEFAULT 0
    )
  `);

  // Global tire catalog — brand/model/size reference data (no org scope)
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tire_catalog' AND xtype='U')
    CREATE TABLE tire_catalog (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      brand       NVARCHAR(100) NOT NULL,
      model       NVARCHAR(100) NOT NULL,
      size        NVARCHAR(50)  NOT NULL,
      pattern     NVARCHAR(100) NULL,
      load_index  NVARCHAR(10)  NULL,
      speed_index NVARCHAR(5)   NULL,
      tire_type   NVARCHAR(50)  NULL,
      CONSTRAINT UQ_tire_catalog_bms UNIQUE (brand, model, size)
    )
  `);

  // ── Multi-org / multi-branch ───────────────────────────────────────────────
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='organizations' AND xtype='U')
    CREATE TABLE organizations (
      id           INT IDENTITY(1,1) PRIMARY KEY,
      name         NVARCHAR(200) NOT NULL,
      code         NVARCHAR(50)  NOT NULL,
      type         NVARCHAR(50)  DEFAULT 'retail',
      address      NVARCHAR(500),
      phone        NVARCHAR(50),
      email        NVARCHAR(200),
      currency     NVARCHAR(10)  DEFAULT 'PKR',
      logo_url     NVARCHAR(500),
      is_active    BIT           DEFAULT 1,
      created_at   DATETIME2     DEFAULT GETDATE(),
      CONSTRAINT UQ_org_code UNIQUE (code)
    )
  `);

  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='branches' AND xtype='U')
    CREATE TABLE branches (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT NOT NULL,
      name            NVARCHAR(200) NOT NULL,
      code            NVARCHAR(50)  NOT NULL,
      address         NVARCHAR(500),
      phone           NVARCHAR(50),
      email           NVARCHAR(200),
      is_active       BIT           DEFAULT 1,
      created_at      DATETIME2     DEFAULT GETDATE()
    )
  `);

  // Users table — password_hash stores bcrypt hash (never plaintext)
  await r.query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')
    CREATE TABLE users (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      name          NVARCHAR(100) NOT NULL,
      email         NVARCHAR(100) NOT NULL,
      phone         NVARCHAR(50),
      company       NVARCHAR(100),
      city          NVARCHAR(100),
      password_hash NVARCHAR(255) NOT NULL,
      role          NVARCHAR(50)  DEFAULT 'Administrator',
      is_active     BIT           DEFAULT 1,
      created_at    DATETIME      DEFAULT GETDATE(),
      CONSTRAINT UQ_users_email UNIQUE (email)
    )
  `);

  // Migrations — add columns to existing tables if they don't have them yet
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('sale_items') AND name = 'product_id')
      ALTER TABLE sale_items ADD product_id INT REFERENCES products(id);
  `);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('purchase_items') AND name = 'product_id')
      ALTER TABLE purchase_items ADD product_id INT REFERENCES products(id);
  `);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('sales') AND name = 'tax_rate')
      ALTER TABLE sales ADD tax_rate DECIMAL(5,2) DEFAULT 0;
  `);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('sales') AND name = 'amount_paid')
      ALTER TABLE sales ADD amount_paid DECIMAL(18,2) DEFAULT 0;
  `);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('purchases') AND name = 'amount_paid')
      ALTER TABLE purchases ADD amount_paid DECIMAL(18,2) DEFAULT 0;
  `);

  // ── Multi-org column migrations ────────────────────────────────────────────
  // Org-scoped tables (no branch_id — entity is shared across all branches of an org)
  for (const tbl of ['customers', 'suppliers', 'products', 'tire_types']) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${tbl}') AND name = 'organization_id')
        ALTER TABLE ${tbl} ADD organization_id INT NOT NULL DEFAULT 1
    `);
  }
  // Branch-scoped tables
  for (const tbl of ['tires', 'sales', 'purchases', 'sale_payments', 'purchase_payments', 'ledger_entries']) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${tbl}') AND name = 'organization_id')
        ALTER TABLE ${tbl} ADD organization_id INT NOT NULL DEFAULT 1
    `);
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${tbl}') AND name = 'branch_id')
        ALTER TABLE ${tbl} ADD branch_id INT NOT NULL DEFAULT 1
    `);
  }
  // Vehicle info columns for customers
  for (const col of [
    { name: 'vehicle_plate', def: 'NVARCHAR(20) NULL' },
    { name: 'vehicle_make',  def: 'NVARCHAR(50) NULL' },
    { name: 'vehicle_model', def: 'NVARCHAR(50) NULL' },
    { name: 'vehicle_year',  def: 'SMALLINT NULL' },
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('customers') AND name = '${col.name}')
        ALTER TABLE customers ADD ${col.name} ${col.def}
    `);
  }

  // Tire SKU spec columns — pattern, load/speed index, DOT
  for (const col of [
    { name: 'pattern',     def: 'NVARCHAR(100) NULL' },
    { name: 'load_index',  def: 'NVARCHAR(10)  NULL' },
    { name: 'speed_index', def: 'NVARCHAR(5)   NULL' },
    { name: 'dot',         def: 'NVARCHAR(20)  NULL' },
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('tires') AND name = '${col.name}')
        ALTER TABLE tires ADD ${col.name} ${col.def}
    `);
  }

  // ── Item master (phase 2): categories + identity fields on every stock item ──
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='item_categories' AND xtype='U')
    CREATE TABLE item_categories (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT NOT NULL,
      name            NVARCHAR(100) NOT NULL,
      parent_id       INT NULL,
      created_at      DATETIME DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_item_categories_name')
      CREATE UNIQUE INDEX UX_item_categories_name ON item_categories (organization_id, name)`);
  for (const col of [
    { name: 'sku',         def: 'NVARCHAR(60)  NULL' },
    { name: 'barcode',     def: 'NVARCHAR(60)  NULL' },
    { name: 'category_id', def: 'INT           NULL' },
    { name: 'uom',         def: "NVARCHAR(20)  NOT NULL CONSTRAINT DF_tires_uom DEFAULT 'pcs'" },
    { name: 'description', def: 'NVARCHAR(500) NULL' },
    { name: 'is_active',   def: 'BIT           NOT NULL CONSTRAINT DF_tires_active DEFAULT 1' },
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('tires') AND name = '${col.name}')
        ALTER TABLE tires ADD ${col.name} ${col.def}
    `);
  }
  // Backfill a stable SKU for existing items, then enforce uniqueness per org + branch.
  await dbPool.request().query(`
    UPDATE tires SET sku = 'SKU-' + RIGHT('000000' + CAST(id AS NVARCHAR(10)), 6) WHERE sku IS NULL`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_tires_sku')
      CREATE UNIQUE INDEX UX_tires_sku ON tires (organization_id, branch_id, sku) WHERE sku IS NOT NULL`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_tires_barcode')
      CREATE UNIQUE INDEX UX_tires_barcode ON tires (organization_id, branch_id, barcode) WHERE barcode IS NOT NULL`);

  // Users: organization_id (required) + branch_id (null = org admin sees all branches)
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('users') AND name = 'organization_id')
      ALTER TABLE users ADD organization_id INT NOT NULL DEFAULT 1
  `);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('users') AND name = 'branch_id')
      ALTER TABLE users ADD branch_id INT NULL
  `);

  // Users: extended profile columns
  for (const [col, def] of [
    ['first_name',                 'NVARCHAR(100)  NULL'],
    ['last_name',                  'NVARCHAR(100)  NULL'],
    ['address',                    'NVARCHAR(500)  NULL'],
    ['job_title',                  'NVARCHAR(100)  NULL'],
    ['department',                 'NVARCHAR(100)  NULL'],
    ['date_of_birth',              'DATE           NULL'],
    ['emergency_contact_name',     'NVARCHAR(100)  NULL'],
    ['emergency_contact_phone',    'NVARCHAR(50)   NULL'],
    ['emergency_contact_relation', 'NVARCHAR(50)   NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('users') AND name = '${col}')
        ALTER TABLE users ADD ${col} ${def}
    `);
  }

  // ── POS / GRN additions ───────────────────────────────────────────────────
  // Stock audit trail: every stock change is logged here
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_movements' AND xtype='U')
    CREATE TABLE stock_movements (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      tire_id         INT NOT NULL REFERENCES tires(id),
      organization_id INT NOT NULL DEFAULT 1,
      branch_id       INT NOT NULL DEFAULT 1,
      qty_change      INT NOT NULL,
      reason          NVARCHAR(50)  NOT NULL,
      reference       NVARCHAR(100) NULL,
      ref_id          INT NULL,
      notes           NVARCHAR(500) NULL,
      created_at      DATETIME2 DEFAULT GETDATE()
    )
  `);
  // Stock ledger upgrade (phase 1): richer movements, adjustment documents, idempotency keys
  for (const [col, ddl] of [
    ['qty_before',      'INT NULL'],
    ['qty_after',       'INT NULL'],
    ['unit_cost',       'DECIMAL(18,2) NULL'],
    ['user_id',         'INT NULL'],
    ['idempotency_key', 'NVARCHAR(100) NULL'],
    ['item_name',       'NVARCHAR(200) NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('stock_movements') AND name = '${col}')
        ALTER TABLE stock_movements ADD ${col} ${ddl}`);
  }
  // Movements must outlive the item they describe, so drop the item foreign key.
  await dbPool.request().query(`
    DECLARE @fk NVARCHAR(200) = (
      SELECT TOP 1 fk.name FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      WHERE fk.parent_object_id = OBJECT_ID('stock_movements') AND fk.referenced_object_id = OBJECT_ID('tires')
        AND COL_NAME(fkc.parent_object_id, fkc.parent_column_id) = 'tire_id');
    IF @fk IS NOT NULL EXEC('ALTER TABLE stock_movements DROP CONSTRAINT [' + @fk + ']')`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_stock_movements_idem')
      CREATE UNIQUE INDEX UX_stock_movements_idem ON stock_movements (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_stock_movements_item')
      CREATE INDEX IX_stock_movements_item ON stock_movements (organization_id, tire_id, id DESC)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_adjustments' AND xtype='U')
    CREATE TABLE stock_adjustments (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      tire_id         INT           NOT NULL,
      item_name       NVARCHAR(200) NULL,
      qty_change      INT           NOT NULL,
      reason_code     NVARCHAR(30)  NOT NULL,
      notes           NVARCHAR(500) NULL,
      status          NVARCHAR(20)  NOT NULL DEFAULT 'pending',
      requested_by    INT           NOT NULL,
      requested_at    DATETIME2     NOT NULL DEFAULT GETDATE(),
      decided_by      INT           NULL,
      decided_at      DATETIME2     NULL,
      decision_note   NVARCHAR(300) NULL,
      movement_id     INT           NULL
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_stock_adjustments_org')
      CREATE INDEX IX_stock_adjustments_org ON stock_adjustments (organization_id, status, requested_at DESC)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='idempotency_keys' AND xtype='U')
    CREATE TABLE idempotency_keys (
      organization_id INT           NOT NULL,
      [key]           NVARCHAR(100) NOT NULL,
      route           NVARCHAR(100) NOT NULL,
      status_code     INT           NULL,
      response_json   NVARCHAR(MAX) NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE(),
      CONSTRAINT PK_idempotency_keys PRIMARY KEY (organization_id, [key])
    )`);

  // Line-level discount % on sale items
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('sale_items') AND name = 'discount')
      ALTER TABLE sale_items ADD discount DECIMAL(5,2) NOT NULL DEFAULT 0
  `);
  // Order-level discount amount on sales
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('sales') AND name = 'discount')
      ALTER TABLE sales ADD discount DECIMAL(18,2) NOT NULL DEFAULT 0
  `);
  // Payment method captured at POS checkout
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('sales') AND name = 'payment_method')
      ALTER TABLE sales ADD payment_method NVARCHAR(20) NULL
  `);
  // Cash tendered (for printing change due on receipt)
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('sales') AND name = 'cash_given')
      ALTER TABLE sales ADD cash_given DECIMAL(18,2) NULL
  `);
  // tax_rate column on purchases (mirrors sales)
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('purchases') AND name = 'tax_rate')
      ALTER TABLE purchases ADD tax_rate DECIMAL(5,2) NOT NULL DEFAULT 0
  `);
  // Reference number on purchases (GRN number / delivery note)
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('purchases') AND name = 'reference_no')
      ALTER TABLE purchases ADD reference_no NVARCHAR(100) NULL
  `);

  // Audit log — immutable record of every create/update/delete
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='audit_logs' AND xtype='U')
    CREATE TABLE audit_logs (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL DEFAULT 1,
      branch_id       INT           NOT NULL DEFAULT 1,
      user_id         INT           NULL,
      user_name       NVARCHAR(100) NOT NULL DEFAULT 'System',
      action          NVARCHAR(20)  NOT NULL,
      entity          NVARCHAR(50)  NOT NULL,
      entity_id       INT           NULL,
      before_json     NVARCHAR(MAX) NULL,
      after_json      NVARCHAR(MAX) NULL,
      created_at      DATETIME2     DEFAULT GETDATE()
    )
  `);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name='IX_audit_logs_org_created')
      CREATE INDEX IX_audit_logs_org_created ON audit_logs (organization_id, created_at DESC)
  `);

  // AI reporting support tables (definitions, saved reports, history, access audit, policy)
  await require('./reporting/store').initReportingTables(dbPool);

  // Refresh tokens for JWT session management
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='refresh_tokens' AND xtype='U')
    CREATE TABLE refresh_tokens (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash  NVARCHAR(255) NOT NULL,
      expires_at  DATETIME2 NOT NULL,
      created_at  DATETIME2 DEFAULT GETDATE(),
      CONSTRAINT UQ_refresh_token UNIQUE (token_hash)
    )
  `);
  // Clean up expired refresh tokens on startup
  await dbPool.request().query(`DELETE FROM refresh_tokens WHERE expires_at < GETDATE()`);

  // Settings: migrate to per-org key-value (change PK from (key) to (organization_id, key))
  const settingsOrgExists = await dbPool.request().query(
    `SELECT COUNT(*) AS cnt FROM sys.columns WHERE object_id = OBJECT_ID('settings') AND name = 'organization_id'`
  );
  if (settingsOrgExists.recordset[0].cnt === 0) {
    await dbPool.request().query(`ALTER TABLE settings ADD organization_id INT NOT NULL DEFAULT 1`);
    // Drop old single-column PK
    const pkRow = await dbPool.request().query(`
      SELECT kc.name AS pk_name
      FROM sys.key_constraints kc
      JOIN sys.tables t ON t.object_id = kc.parent_object_id
      WHERE t.name = 'settings' AND kc.type = 'PK'
    `);
    const pkName = pkRow.recordset[0]?.pk_name;
    if (pkName) {
      await dbPool.request().query(`ALTER TABLE settings DROP CONSTRAINT [${pkName}]`);
    }
    await dbPool.request().query(
      `ALTER TABLE settings ADD CONSTRAINT PK_settings PRIMARY KEY (organization_id, [key])`
    );
  }

  // Seed default organization + branch (only if none exist)
  const orgCount = await dbPool.request().query('SELECT COUNT(*) AS cnt FROM organizations');
  if (orgCount.recordset[0].cnt === 0) {
    const orgRes = await dbPool.request()
      .input('name', sql.NVarChar, 'TuneGEN')
      .input('code', sql.NVarChar, 'TUNEGEN')
      .input('type', sql.NVarChar, 'retail')
      .query(`INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@name, @code, @type)`);
    const defaultOrgId = orgRes.recordset[0].id;
    await dbPool.request()
      .input('org_id', sql.Int,      defaultOrgId)
      .input('name',   sql.NVarChar, 'Main Branch')
      .input('code',   sql.NVarChar, 'MAIN')
      .query(`INSERT INTO branches (organization_id, name, code) VALUES (@org_id, @name, @code)`);
    console.log('✅ Default organization and branch seeded');
  }

  // Seed default settings for org 1 (only if table is empty)
  const settingsCount = await dbPool.request()
    .query(`SELECT COUNT(*) AS cnt FROM settings WHERE organization_id = 1`);
  if (settingsCount.recordset[0].cnt === 0) {
    const defaults = [
      ['company_name',        'TuneGEN'],
      ['company_tagline',     'Tyre & Wheel Solutions'],
      ['business_type',       'tyre_shop'],
      ['company_address',     '123 Industrial Zone, Lahore, Pakistan'],
      ['company_phone',       '+92-42-1234567'],
      ['company_email',       'info@tunegen.pk'],
      ['invoice_prefix',      'INV'],
      ['po_prefix',           'PO'],
      ['default_tax_rate',    '15'],
      ['payment_due_days',    '30'],
      ['default_sale_status', 'pending'],
      ['currency',            'PKR'],
      ['announcement',        ''],
      ['refresh_interval',    '60'],
    ];
    for (const [key, value] of defaults) {
      await dbPool.request()
        .input('org_id', sql.Int,      1)
        .input('key',    sql.NVarChar, key)
        .input('value',  sql.NVarChar, value)
        .query(`INSERT INTO settings (organization_id, [key], value) VALUES (@org_id, @key, @value)`);
    }
  }

  // Seed default tire types (only if empty)
  const typesCount = await dbPool.request()
    .query('SELECT COUNT(*) AS cnt FROM tire_types');
  if (typesCount.recordset[0].cnt === 0) {
    const types = ['Passenger', 'SUV', '4x4', 'LT', 'Performance', 'Motorcycle'];
    for (let i = 0; i < types.length; i++) {
      await dbPool.request()
        .input('name',       sql.NVarChar, types[i])
        .input('sort_order', sql.Int,      i)
        .query(`INSERT INTO tire_types (name, sort_order) VALUES (@name, @sort_order)`);
    }
  }

  // Seed default services for org 1 (only if no services exist yet)
  const servicesCount = await dbPool.request().query(
    `SELECT COUNT(*) AS cnt FROM products WHERE organization_id = 1 AND category = 'Service'`
  );
  if (servicesCount.recordset[0].cnt === 0) {
    const defaultServices = [
      { name: 'Tire Fitting',      sale: 300,   cost: 100, desc: 'Mount and fit tyre to wheel rim' },
      { name: 'Wheel Balancing',   sale: 250,   cost: 80,  desc: 'Dynamic wheel balancing with weights' },
      { name: 'Wheel Alignment',   sale: 1500,  cost: 500, desc: '4-wheel laser alignment' },
      { name: 'Puncture Repair',   sale: 200,   cost: 50,  desc: 'Tubeless puncture plug and patch repair' },
      { name: 'Valve Replacement', sale: 100,   cost: 30,  desc: 'Replace tyre valve stem' },
    ];
    for (const svc of defaultServices) {
      await dbPool.request()
        .input('name', sql.NVarChar,     svc.name)
        .input('desc', sql.NVarChar,     svc.desc)
        .input('sale', sql.Decimal(18,2), svc.sale)
        .input('cost', sql.Decimal(18,2), svc.cost)
        .query(`
          INSERT INTO products (organization_id, name, description, category, unit, sale_price, cost_price, is_active)
          VALUES (1, @name, @desc, 'Service', 'job', @sale, @cost, 1)
        `);
    }
    console.log('✅ Default services seeded');
  }

  // Ensure announcement key exists for org 1 on existing databases
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM settings WHERE organization_id = 1 AND [key] = 'announcement')
      INSERT INTO settings (organization_id, [key], value) VALUES (1, 'announcement', '')
  `);

  // Ensure refresh_interval key exists for org 1 on existing databases
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT 1 FROM settings WHERE organization_id = 1 AND [key] = 'refresh_interval')
      INSERT INTO settings (organization_id, [key], value) VALUES (1, 'refresh_interval', '60')
  `);

  // One-time rebrand of data carried over from a database created before the TuneGEN rename.
  // Idempotent; skips an email swap if the new address is already taken.
  const legacy = 'tire' + 'pro';
  for (const [oldEmail, newEmail] of [[`zmehmood@${legacy}.com`, 'zmehmood@tunegen.com'], [`demo@${legacy}.app`, 'demo@tunegen.app']]) {
    await dbPool.request().input('o', sql.NVarChar, oldEmail).input('n', sql.NVarChar, newEmail)
      .query('UPDATE users SET email = @n WHERE email = @o AND NOT EXISTS (SELECT 1 FROM users WHERE email = @n)');
  }
  await dbPool.request().input('l', sql.NVarChar, `%${legacy}%`).query(`
    UPDATE settings SET value = REPLACE(REPLACE(REPLACE(REPLACE(value, 'TirePro', 'TuneGEN'), 'tirepro.pk', 'tunegen.pk'), 'tirepro.app', 'tunegen.app'), 'tirepro.com', 'tunegen.com')
    WHERE value LIKE @l;
    UPDATE organizations SET code = 'TUNEGEN' WHERE code = 'TIREPRO' AND NOT EXISTS (SELECT 1 FROM organizations WHERE code = 'TUNEGEN');
    UPDATE organizations SET name = REPLACE(name, 'TirePro', 'TuneGEN') WHERE name LIKE @l;
    UPDATE users SET company = REPLACE(company, 'TirePro', 'TuneGEN') WHERE company LIKE @l;
  `);

  // Seed admin user — only inserts once; safe to run on every restart
  const adminEmail = 'zmehmood@tunegen.com';
  const adminCheck = await dbPool.request()
    .input('email', sql.NVarChar, adminEmail)
    .query('SELECT id FROM users WHERE email = @email');
  if (adminCheck.recordset.length === 0) {
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) throw new Error('Set ADMIN_PASSWORD in server/.env before first run');
    const hash = await bcrypt.hash(adminPassword, 12);
    await dbPool.request()
      .input('name',            sql.NVarChar, 'Ziyad Mehmood')
      .input('email',           sql.NVarChar, adminEmail)
      .input('password_hash',   sql.NVarChar, hash)
      .input('company',         sql.NVarChar, 'TuneGEN')
      .input('role',            sql.NVarChar, 'org_admin')
      .input('organization_id', sql.Int,      1)
      .query(`
        INSERT INTO users (name, email, password_hash, company, role, organization_id)
        VALUES (@name, @email, @password_hash, @company, @role, @organization_id)
      `);
    console.log('✅ Admin user seeded:', adminEmail);
  } else {
    // Backfill existing admin with org context
    await dbPool.request()
      .input('email',           sql.NVarChar, adminEmail)
      .input('organization_id', sql.Int,      1)
      .query(`
        UPDATE users SET organization_id = @organization_id
        WHERE email = @email AND organization_id = 0
      `);
  }

  // Vehicle fitments — Pakistan-market OEM tyre size reference (global, no org scope)
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='vehicle_fitments' AND xtype='U')
    CREATE TABLE vehicle_fitments (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      category    NVARCHAR(100) NOT NULL,
      make        NVARCHAR(50)  NOT NULL,
      model       NVARCHAR(200) NOT NULL,
      year_from   SMALLINT      NULL,
      year_to     SMALLINT      NULL,
      tire_size   NVARCHAR(50)  NOT NULL,
      gtr_pattern NVARCHAR(100) NULL,
      position    NVARCHAR(10)  NULL
    )
  `);
  // Migrate existing installs: add gtr_pattern, position columns + fix old schema
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('vehicle_fitments') AND name = 'gtr_pattern')
      ALTER TABLE vehicle_fitments ADD gtr_pattern NVARCHAR(100) NULL
  `);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('vehicle_fitments') AND name = 'position')
      ALTER TABLE vehicle_fitments ADD position NVARCHAR(10) NULL
  `);
  // Make year_from nullable (was NOT NULL in first version)
  await dbPool.request().query(`
    IF EXISTS (
      SELECT * FROM sys.columns
      WHERE object_id = OBJECT_ID('vehicle_fitments') AND name = 'year_from' AND is_nullable = 0
    )
      ALTER TABLE vehicle_fitments ALTER COLUMN year_from SMALLINT NULL
  `);

  // Catalog scraper run logs
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='catalog_scraper_logs' AND xtype='U')
    CREATE TABLE catalog_scraper_logs (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      source        NVARCHAR(100) NOT NULL,
      status        NVARCHAR(20)  NOT NULL DEFAULT 'running',
      started_at    DATETIME2 DEFAULT GETDATE(),
      finished_at   DATETIME2 NULL,
      items_found   INT DEFAULT 0,
      items_added   INT DEFAULT 0,
      items_updated INT DEFAULT 0,
      error_msg     NVARCHAR(500) NULL,
      triggered_by  NVARCHAR(50)  DEFAULT 'schedule'
    )
  `);
  // Migrate: add items_updated column if missing (for existing installs)
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('catalog_scraper_logs') AND name = 'items_updated')
      ALTER TABLE catalog_scraper_logs ADD items_updated INT DEFAULT 0
  `);

  // ── Demo organisation ─────────────────────────────────────────────────────
  // Seed a read-only demo org + branch + user if they don't exist yet.
  // Demo data (customers / suppliers / tires) is also seeded here once.
  // Transactional data (sales / purchases) is seeded by the demoCleanup job.
  await seedDemoOrg(dbPool, sql);

  // Stock ledger baseline. Items with no movements get an opening_balance equal to their stock.
  // Once only, items whose stock differs from their movements get a one-off opening_balance for the
  // difference so the ledger reconciles from here on. Later drift stays visible in /inventory/reconciliation.
  await dbPool.request().query(`
    INSERT INTO stock_movements (tire_id, organization_id, branch_id, qty_change, reason, reference, notes, qty_before, qty_after, unit_cost, item_name, idempotency_key)
    SELECT t.id, t.organization_id, t.branch_id, t.stock, 'opening_balance', 'OPENING', 'Opening balance recorded when the stock ledger was enabled',
           0, t.stock, t.cost_price, t.brand + ' ' + t.model + ' ' + t.size, 'baseline:' + CAST(t.id AS NVARCHAR(20))
    FROM tires t
    WHERE t.stock <> 0 AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.tire_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.organization_id = t.organization_id AND m.idempotency_key = 'baseline:' + CAST(t.id AS NVARCHAR(20)))`);
  const baselined = await dbPool.request().query("SELECT 1 FROM settings WHERE organization_id = 1 AND [key] = 'stock_ledger_baselined'");
  if (!baselined.recordset.length) {
    await dbPool.request().query(`
      INSERT INTO stock_movements (tire_id, organization_id, branch_id, qty_change, reason, reference, notes, qty_before, qty_after, unit_cost, item_name, idempotency_key)
      SELECT t.id, t.organization_id, t.branch_id, t.stock - d.total, 'opening_balance', 'OPENING', 'Difference between recorded stock and earlier movements at ledger baseline',
             d.total, t.stock, t.cost_price, t.brand + ' ' + t.model + ' ' + t.size, 'baseline-diff:' + CAST(t.id AS NVARCHAR(20))
      FROM tires t CROSS APPLY (SELECT ISNULL(SUM(m.qty_change), 0) AS total FROM stock_movements m WHERE m.tire_id = t.id) d
      WHERE t.stock <> d.total;
      INSERT INTO settings (organization_id, [key], value) VALUES (1, 'stock_ledger_baselined', '1');`);
  }

  // ── Stock locations (phase 3): several stock locations per branch, balances per item per location ──
  // tires.stock stays the item's total and must equal SUM(item_location_stock.qty).
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_locations' AND xtype='U')
    CREATE TABLE stock_locations (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      name            NVARCHAR(100) NOT NULL,
      code            NVARCHAR(30)  NOT NULL,
      is_default      BIT           NOT NULL DEFAULT 0,
      is_active       BIT           NOT NULL DEFAULT 1,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_stock_locations_code')
      CREATE UNIQUE INDEX UX_stock_locations_code ON stock_locations (organization_id, branch_id, code)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_stock_locations_default')
      CREATE UNIQUE INDEX UX_stock_locations_default ON stock_locations (organization_id, branch_id) WHERE is_default = 1`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='item_location_stock' AND xtype='U')
    CREATE TABLE item_location_stock (
      tire_id     INT NOT NULL,
      location_id INT NOT NULL,
      qty         INT NOT NULL DEFAULT 0,
      CONSTRAINT PK_item_location_stock PRIMARY KEY (tire_id, location_id)
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_item_location_stock_loc')
      CREATE INDEX IX_item_location_stock_loc ON item_location_stock (location_id) INCLUDE (tire_id, qty)`);
  for (const [table, col] of [['stock_movements', 'location_id'], ['stock_adjustments', 'location_id']]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${col}')
        ALTER TABLE ${table} ADD ${col} INT NULL`);
  }
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_transfers' AND xtype='U')
    CREATE TABLE stock_transfers (
      id               INT IDENTITY(1,1) PRIMARY KEY,
      organization_id  INT           NOT NULL,
      branch_id        INT           NOT NULL,
      transfer_no      NVARCHAR(30)  NOT NULL,
      from_location_id INT           NOT NULL,
      to_location_id   INT           NOT NULL,
      notes            NVARCHAR(500) NULL,
      created_by       INT           NULL,
      created_at       DATETIME2     NOT NULL DEFAULT GETDATE()
    );
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_transfer_items' AND xtype='U')
    CREATE TABLE stock_transfer_items (
      id          INT IDENTITY(1,1) PRIMARY KEY,
      transfer_id INT NOT NULL,
      tire_id     INT NOT NULL,
      item_name   NVARCHAR(200) NULL,
      qty         INT NOT NULL
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_stock_transfers_no')
      CREATE UNIQUE INDEX UX_stock_transfers_no ON stock_transfers (transfer_no)`);
  // Every existing branch gets a default location; existing stock and history are placed there.
  await dbPool.request().query(`
    INSERT INTO stock_locations (organization_id, branch_id, name, code, is_default)
    SELECT b.organization_id, b.id, 'Main Store', 'MAIN', 1 FROM branches b
    WHERE NOT EXISTS (SELECT 1 FROM stock_locations l WHERE l.organization_id = b.organization_id AND l.branch_id = b.id)`);
  await dbPool.request().query(`
    INSERT INTO item_location_stock (tire_id, location_id, qty)
    SELECT t.id, l.id, t.stock FROM tires t
    JOIN stock_locations l ON l.organization_id = t.organization_id AND l.branch_id = t.branch_id AND l.is_default = 1
    WHERE t.stock <> 0 AND NOT EXISTS (SELECT 1 FROM item_location_stock x WHERE x.tire_id = t.id)`);
  await dbPool.request().query(`
    UPDATE m SET location_id = l.id FROM stock_movements m
    JOIN stock_locations l ON l.organization_id = m.organization_id AND l.branch_id = m.branch_id AND l.is_default = 1
    WHERE m.location_id IS NULL`);

  // ── Batch / lot / serial tracking and expiry (phase 4) ──
  // A serial number is a batch that holds at most one unit. For tracked items the batch balances of a location
  // always add up to item_location_stock.
  for (const [col, ddl] of [
    ['tracking',     "NVARCHAR(10) NOT NULL CONSTRAINT DF_tires_tracking DEFAULT 'none'"],
    ['track_expiry', 'BIT NOT NULL CONSTRAINT DF_tires_track_expiry DEFAULT 0'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('tires') AND name = '${col}')
        ALTER TABLE tires ADD ${col} ${ddl}`);
  }
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_batches' AND xtype='U')
    CREATE TABLE stock_batches (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      tire_id         INT           NOT NULL,
      batch_no        NVARCHAR(60)  NOT NULL,
      expiry_date     DATE          NULL,
      unit_cost       DECIMAL(18,2) NULL,
      is_legacy       BIT           NOT NULL DEFAULT 0,
      notes           NVARCHAR(300) NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_stock_batches_item_no')
      CREATE UNIQUE INDEX UX_stock_batches_item_no ON stock_batches (tire_id, batch_no)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_stock_batches_expiry')
      CREATE INDEX IX_stock_batches_expiry ON stock_batches (organization_id, expiry_date)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='batch_location_stock' AND xtype='U')
    CREATE TABLE batch_location_stock (
      batch_id    INT NOT NULL,
      location_id INT NOT NULL,
      qty         INT NOT NULL DEFAULT 0,
      CONSTRAINT PK_batch_location_stock PRIMARY KEY (batch_id, location_id)
    )`);
  for (const [table, col, ddl] of [
    ['stock_movements',   'batch_id',    'INT NULL'],
    ['stock_adjustments', 'batch_id',    'INT NULL'],
    ['purchase_items',    'batch_no',    'NVARCHAR(60) NULL'],
    ['purchase_items',    'expiry_date', 'DATE NULL'],
    ['purchase_items',    'serials',     'NVARCHAR(MAX) NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${col}')
        ALTER TABLE ${table} ADD ${col} ${ddl}`);
  }

  // ── Cost layers for FIFO / average valuation (phase 5) ──
  // Every stock-in (except transfers) adds a layer; every stock-out consumes the oldest layers first.
  // Layers are kept for every item regardless of the organisation's valuation method, so the method can be switched later.
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_cost_layers' AND xtype='U')
    CREATE TABLE stock_cost_layers (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      tire_id       INT           NOT NULL,
      qty_received  INT           NOT NULL,
      qty_remaining INT           NOT NULL,
      unit_cost     DECIMAL(18,4) NOT NULL,
      movement_id   INT           NULL,
      created_at    DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_cost_layers_item')
      CREATE INDEX IX_cost_layers_item ON stock_cost_layers (tire_id, qty_remaining, created_at)`);
  // Items that already hold stock start with one layer at their current cost price.
  await dbPool.request().query(`
    INSERT INTO stock_cost_layers (tire_id, qty_received, qty_remaining, unit_cost)
    SELECT t.id, t.stock, t.stock, ISNULL(t.cost_price, 0) FROM tires t
    WHERE t.stock > 0 AND NOT EXISTS (SELECT 1 FROM stock_cost_layers l WHERE l.tire_id = t.id)`);

  // Blended FIFO costs need more than 2 decimals or margins drift by cents.
  await dbPool.request().query(`
    IF EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('stock_movements') AND name = 'unit_cost' AND scale < 4)
      ALTER TABLE stock_movements ALTER COLUMN unit_cost DECIMAL(18,4) NULL`);

  // ── Product & material master data (phase 6) ──
  for (const [col, ddl] of [
    ['item_type',             "NVARCHAR(20) NOT NULL CONSTRAINT DF_tires_item_type DEFAULT 'finished_good'"],
    ['manufacturer',          'NVARCHAR(100) NULL'],
    ['supplier_id',           'INT NULL'],
    ['purchase_uom',          'NVARCHAR(20) NULL'],
    ['sales_uom',             'NVARCHAR(20) NULL'],
    ['pack_size',             'DECIMAL(18,4) NULL'],
    ['length_cm',             'DECIMAL(18,3) NULL'],
    ['width_cm',              'DECIMAL(18,3) NULL'],
    ['height_cm',             'DECIMAL(18,3) NULL'],
    ['weight_kg',             'DECIMAL(18,3) NULL'],
    ['volume_l',              'DECIMAL(18,3) NULL'],
    ['tax_class',             'NVARCHAR(20) NULL'],
    ['tax_rate',              'DECIMAL(5,2) NULL'],
    ['min_stock',             'INT NULL'],
    ['max_stock',             'INT NULL'],
    ['reorder_qty',           'INT NULL'],
    ['storage_requirements',  'NVARCHAR(500) NULL'],
    ['handling_instructions', 'NVARCHAR(500) NULL'],
    ['safety_requirements',   'NVARCHAR(500) NULL'],
    ['shelf_life_days',       'INT NULL'],
    ['storage_conditions',    'NVARCHAR(200) NULL'],
    ['status',                "NVARCHAR(15) NOT NULL CONSTRAINT DF_tires_status DEFAULT 'active'"],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('tires') AND name = '${col}')
        ALTER TABLE tires ADD ${col} ${ddl}`);
  }
  // Items that were switched off before statuses existed are 'inactive'.
  await dbPool.request().query("UPDATE tires SET status = 'inactive' WHERE is_active = 0 AND status = 'active'");
  // Alternative units of measure for an item: 1 <uom> = <factor> of the item's base unit.
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='item_uom_conversions' AND xtype='U')
    CREATE TABLE item_uom_conversions (
      tire_id INT          NOT NULL,
      uom     NVARCHAR(20) NOT NULL,
      factor  DECIMAL(18,6) NOT NULL,
      CONSTRAINT PK_item_uom_conversions PRIMARY KEY (tire_id, uom)
    )`);
  // Who changed which important product attribute, and when.
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='product_history' AND xtype='U')
    CREATE TABLE product_history (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      tire_id         INT           NOT NULL,
      field           NVARCHAR(40)  NOT NULL,
      old_value       NVARCHAR(500) NULL,
      new_value       NVARCHAR(500) NULL,
      user_id         INT           NULL,
      changed_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_product_history_item')
      CREATE INDEX IX_product_history_item ON product_history (tire_id, id DESC)`);

  // ── Stock control (phase 7): reservations, restricted locations, in-transit transfers, physical counts ──
  // Location kind: 'normal' stock is available; 'quarantine' / 'damaged' stock is on hand but never available.
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('stock_locations') AND name = 'kind')
      ALTER TABLE stock_locations ADD kind NVARCHAR(12) NOT NULL CONSTRAINT DF_stock_locations_kind DEFAULT 'normal'`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_reservations' AND xtype='U')
    CREATE TABLE stock_reservations (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      tire_id         INT           NOT NULL,
      location_id     INT           NOT NULL,
      qty             INT           NOT NULL CHECK (qty > 0),
      status          NVARCHAR(12)  NOT NULL DEFAULT 'active',
      reference       NVARCHAR(100) NULL,
      notes           NVARCHAR(500) NULL,
      expires_at      DATE          NULL,
      sale_id         INT           NULL,
      created_by      INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE(),
      closed_at       DATETIME2     NULL,
      closed_by       INT           NULL
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_stock_reservations_item')
      CREATE INDEX IX_stock_reservations_item ON stock_reservations (tire_id, location_id, status) INCLUDE (qty, expires_at)`);
  for (const [col, ddl] of [['status', "NVARCHAR(12) NOT NULL CONSTRAINT DF_stock_transfers_status DEFAULT 'completed'"], ['received_at', 'DATETIME2 NULL'], ['received_by', 'INT NULL']]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('stock_transfers') AND name = '${col}')
        ALTER TABLE stock_transfers ADD ${col} ${ddl}`);
  }
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_counts' AND xtype='U')
    CREATE TABLE stock_counts (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      count_no        NVARCHAR(30)  NOT NULL,
      location_id     INT           NOT NULL,
      status          NVARCHAR(12)  NOT NULL DEFAULT 'open',
      notes           NVARCHAR(500) NULL,
      created_by      INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE(),
      completed_at    DATETIME2     NULL,
      completed_by    INT           NULL
    );
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_count_items' AND xtype='U')
    CREATE TABLE stock_count_items (
      id            INT IDENTITY(1,1) PRIMARY KEY,
      count_id      INT           NOT NULL,
      tire_id       INT           NOT NULL,
      batch_id      INT           NULL,
      item_name     NVARCHAR(200) NULL,
      batch_no      NVARCHAR(60)  NULL,
      system_qty    INT           NOT NULL,
      counted_qty   INT           NULL,
      variance      INT           NULL,
      adjustment_id INT           NULL
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_stock_counts_no')
      CREATE UNIQUE INDEX UX_stock_counts_no ON stock_counts (count_no)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_stock_count_items_count')
      CREATE INDEX IX_stock_count_items_count ON stock_count_items (count_id)`);

  // ── Rotation & valuation (phase 8) ──
  // Rotation = which physical units leave first (item > category > company default). Valuation = which cost is booked. They are independent.
  for (const [table, col, ddl] of [
    ['tires',           'rotation_policy', 'NVARCHAR(15) NULL'],
    ['item_categories', 'rotation_policy', 'NVARCHAR(15) NULL'],
    ['stock_batches',   'received_date',   'DATE NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${col}')
        ALTER TABLE ${table} ADD ${col} ${ddl}`);
  }
  await dbPool.request().query("UPDATE stock_batches SET received_date = CAST(created_at AS DATE) WHERE received_date IS NULL");
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='valuation_policy_history' AND xtype='U')
    CREATE TABLE valuation_policy_history (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      old_method      NVARCHAR(20)  NULL,
      new_method      NVARCHAR(20)  NOT NULL,
      note            NVARCHAR(500) NULL,
      user_id         INT           NULL,
      changed_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='valuation_adjustments' AND xtype='U')
    CREATE TABLE valuation_adjustments (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      tire_id         INT           NOT NULL,
      item_name       NVARCHAR(200) NULL,
      qty             INT           NOT NULL,
      old_unit_cost   DECIMAL(18,4) NOT NULL,
      new_unit_cost   DECIMAL(18,4) NOT NULL,
      old_value       DECIMAL(18,2) NOT NULL,
      new_value       DECIMAL(18,2) NOT NULL,
      reason          NVARCHAR(500) NOT NULL,
      method          NVARCHAR(20)  NULL,
      user_id         INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    );
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='valuation_adjustment_layers' AND xtype='U')
    CREATE TABLE valuation_adjustment_layers (
      adjustment_id INT           NOT NULL,
      layer_id      INT           NOT NULL,
      qty           INT           NOT NULL,
      old_cost      DECIMAL(18,4) NOT NULL,
      new_cost      DECIMAL(18,4) NOT NULL,
      CONSTRAINT PK_valuation_adjustment_layers PRIMARY KEY (adjustment_id, layer_id)
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_valuation_adjustments_item')
      CREATE INDEX IX_valuation_adjustments_item ON valuation_adjustments (organization_id, tire_id, id DESC)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='valuation_snapshots' AND xtype='U')
    CREATE TABLE valuation_snapshots (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NULL,
      method          NVARCHAR(20)  NOT NULL,
      total_units     INT           NOT NULL,
      total_value     DECIMAL(18,2) NOT NULL,
      note            NVARCHAR(500) NULL,
      user_id         INT           NULL,
      taken_at        DATETIME2     NOT NULL DEFAULT GETDATE()
    );
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='valuation_snapshot_items' AND xtype='U')
    CREATE TABLE valuation_snapshot_items (
      snapshot_id INT           NOT NULL,
      tire_id     INT           NOT NULL,
      item_name   NVARCHAR(200) NULL,
      category    NVARCHAR(100) NULL,
      qty         INT           NOT NULL,
      unit_cost   DECIMAL(18,4) NOT NULL,
      value       DECIMAL(18,2) NOT NULL
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_valuation_snapshot_items')
      CREATE INDEX IX_valuation_snapshot_items ON valuation_snapshot_items (snapshot_id)`);

  // ── Replenishment & stockout prevention (phase 9) ──
  for (const [table, col, ddl] of [
    ['tires',           'reorder_mode',     'NVARCHAR(10) NULL'],
    ['tires',           'safety_stock',     'INT NULL'],
    ['tires',           'lead_time_days',   'INT NULL'],
    ['tires',           'moq',              'INT NULL'],
    ['tires',           'order_multiple',   'INT NULL'],
    ['tires',           'capacity_units',   'INT NULL'],
    ['tires',           'seasonality',      'NVARCHAR(200) NULL'],
    ['item_categories', 'seasonality',      'NVARCHAR(200) NULL'],
    ['suppliers',       'lead_time_days',   'INT NULL'],
    ['suppliers',       'min_order_value',  'DECIMAL(18,2) NULL'],
    ['purchases',       'received_at',      'DATETIME2 NULL'],
    ['purchases',       'expected_date',    'DATE NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${col}')
        ALTER TABLE ${table} ADD ${col} ${ddl}`);
  }
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='replenishment_requirements' AND xtype='U')
    CREATE TABLE replenishment_requirements (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      tire_id         INT           NOT NULL,
      qty             INT           NOT NULL,
      needed_by       DATE          NOT NULL,
      note            NVARCHAR(300) NULL,
      status          NVARCHAR(10)  NOT NULL DEFAULT 'open',
      created_by      INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE(),
      closed_at       DATETIME2     NULL
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='replenishment_approvals' AND xtype='U')
    CREATE TABLE replenishment_approvals (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      purchase_id     INT           NOT NULL,
      tire_id         INT           NOT NULL,
      item_name       NVARCHAR(200) NULL,
      suggested_qty   INT           NOT NULL,
      ordered_qty     INT           NOT NULL,
      unit_cost       DECIMAL(18,2) NOT NULL,
      reason          NVARCHAR(500) NULL,
      basis           NVARCHAR(1000) NULL,
      approved_by     INT           NULL,
      approved_at     DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_replenishment_approvals_po')
      CREATE INDEX IX_replenishment_approvals_po ON replenishment_approvals (organization_id, purchase_id)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_replenishment_requirements_item')
      CREATE INDEX IX_replenishment_requirements_item ON replenishment_requirements (organization_id, tire_id, status)`);

  // ── Expiry, shelf life & product quality (phase 10) ──
  for (const [table, col, ddl] of [
    ['stock_batches',   'mfg_date',              'DATE NULL'],
    ['stock_batches',   'quality_status',        "NVARCHAR(12) NOT NULL CONSTRAINT DF_stock_batches_quality DEFAULT 'released'"],
    ['stock_batches',   'status_reason',         'NVARCHAR(500) NULL'],
    ['stock_batches',   'status_changed_at',     'DATETIME2 NULL'],
    ['stock_batches',   'status_changed_by',     'INT NULL'],
    ['stock_batches',   'last_inspected_at',     'DATETIME2 NULL'],
    ['tires',           'inspection_interval_days', 'INT NULL'],
    ['tires',           'near_expiry_days',      'INT NULL'],
    ['tires',           'min_remaining_days',    'INT NULL'],
    ['tires',           'require_mfg_date',      'BIT NULL'],
    ['tires',           'quality_profile_id',    'INT NULL'],
    ['item_categories', 'quality_profile_id',    'INT NULL'],
    ['purchase_items',  'mfg_date',              'DATE NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${col}')
        ALTER TABLE ${table} ADD ${col} ${ddl}`);
  }
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='quality_profiles' AND xtype='U')
    CREATE TABLE quality_profiles (
      id                       INT IDENTITY(1,1) PRIMARY KEY,
      organization_id          INT           NOT NULL,
      name                     NVARCHAR(100) NOT NULL,
      regulation               NVARCHAR(200) NULL,
      near_expiry_days         INT           NULL,
      inspection_interval_days INT           NULL,
      min_remaining_days       INT           NULL,
      require_mfg_date         BIT           NULL,
      release_approval         NVARCHAR(10)  NULL,
      notes                    NVARCHAR(500) NULL,
      created_at               DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_quality_profiles_name')
      CREATE UNIQUE INDEX UX_quality_profiles_name ON quality_profiles (organization_id, name)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='batch_quality_events' AND xtype='U')
    CREATE TABLE batch_quality_events (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      batch_id        INT           NOT NULL,
      tire_id         INT           NOT NULL,
      event_type      NVARCHAR(20)  NOT NULL,
      from_status     NVARCHAR(12)  NULL,
      to_status       NVARCHAR(12)  NULL,
      result          NVARCHAR(12)  NULL,
      qty             INT           NULL,
      reason          NVARCHAR(500) NULL,
      reference       NVARCHAR(100) NULL,
      recall_id       INT           NULL,
      user_id         INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_batch_quality_events_batch')
      CREATE INDEX IX_batch_quality_events_batch ON batch_quality_events (batch_id, id)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='product_recalls' AND xtype='U')
    CREATE TABLE product_recalls (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      recall_no       NVARCHAR(30)  NOT NULL,
      title           NVARCHAR(200) NOT NULL,
      reason          NVARCHAR(1000) NOT NULL,
      severity        NVARCHAR(10)  NOT NULL DEFAULT 'class2',
      source          NVARCHAR(200) NULL,
      status          NVARCHAR(10)  NOT NULL DEFAULT 'open',
      created_by      INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE(),
      closed_by       INT           NULL,
      closed_at       DATETIME2     NULL,
      closure_note    NVARCHAR(1000) NULL
    );
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='product_recall_batches' AND xtype='U')
    CREATE TABLE product_recall_batches (
      recall_id        INT           NOT NULL,
      batch_id         INT           NOT NULL,
      tire_id          INT           NOT NULL,
      item_name        NVARCHAR(200) NULL,
      batch_no         NVARCHAR(60)  NULL,
      qty_on_hand      INT           NOT NULL DEFAULT 0,
      qty_sold         INT           NOT NULL DEFAULT 0,
      prior_status     NVARCHAR(12)  NULL,
      disposition      NVARCHAR(10)  NULL,
      CONSTRAINT PK_product_recall_batches PRIMARY KEY (recall_id, batch_id)
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_product_recalls_no')
      CREATE UNIQUE INDEX UX_product_recalls_no ON product_recalls (organization_id, recall_no)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='quality_disposals' AND xtype='U')
    CREATE TABLE quality_disposals (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      disposal_no     NVARCHAR(30)  NOT NULL,
      batch_id        INT           NOT NULL,
      tire_id         INT           NOT NULL,
      item_name       NVARCHAR(200) NULL,
      batch_no        NVARCHAR(60)  NULL,
      qty             INT           NOT NULL,
      method          NVARCHAR(20)  NOT NULL,
      reason          NVARCHAR(500) NOT NULL,
      reference       NVARCHAR(100) NULL,
      supplier_id     INT           NULL,
      unit_cost       DECIMAL(18,4) NOT NULL DEFAULT 0,
      value           DECIMAL(18,2) NOT NULL DEFAULT 0,
      recall_id       INT           NULL,
      user_id         INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_quality_disposals_no')
      CREATE UNIQUE INDEX UX_quality_disposals_no ON quality_disposals (organization_id, disposal_no)`);

  // ── Hazardous materials & special handling (phase 11) ──
  // Opt-in per item: nothing below changes behaviour until an item gets a hazard class or a storage temperature range.
  for (const [table, col, ddl] of [
    ['tires', 'hazard_class_id',        'INT NULL'],
    ['tires', 'un_number',              'NVARCHAR(10) NULL'],
    ['tires', 'packing_group',          'NVARCHAR(3) NULL'],
    ['tires', 'flash_point_c',          'DECIMAL(6,1) NULL'],
    ['tires', 'sds_ref',                'NVARCHAR(300) NULL'],
    ['tires', 'sds_date',               'DATE NULL'],
    ['tires', 'ppe',                    'NVARCHAR(300) NULL'],
    ['tires', 'emergency_info',         'NVARCHAR(500) NULL'],
    ['tires', 'storage_temp_min_c',     'DECIMAL(6,1) NULL'],
    ['tires', 'storage_temp_max_c',     'DECIMAL(6,1) NULL'],
    ['tires', 'hazard_inspection_days', 'INT NULL'],
    ['tires', 'hazard_hold',            'BIT NOT NULL CONSTRAINT DF_tires_hazard_hold DEFAULT 0'],
    ['tires', 'hazard_hold_reason',     'NVARCHAR(500) NULL'],
    ['tires', 'hazard_hold_at',         'DATETIME2 NULL'],
    ['tires', 'hazard_hold_by',         'INT NULL'],
    ['stock_locations', 'temp_min_c',               'DECIMAL(6,1) NULL'],
    ['stock_locations', 'temp_max_c',               'DECIMAL(6,1) NULL'],
    ['stock_locations', 'inspection_interval_days', 'INT NULL'],
    ['stock_locations', 'hazard_notes',             'NVARCHAR(500) NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${col}')
        ALTER TABLE ${table} ADD ${col} ${ddl}`);
  }
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='hazard_classes' AND xtype='U')
    CREATE TABLE hazard_classes (
      id                      INT IDENTITY(1,1) PRIMARY KEY,
      organization_id         INT           NOT NULL,
      code                    NVARCHAR(20)  NOT NULL,
      name                    NVARCHAR(100) NOT NULL,
      kind                    NVARCHAR(10)  NOT NULL DEFAULT 'hazard',
      regulation              NVARCHAR(200) NULL,
      description             NVARCHAR(500) NULL,
      requires_sds            BIT           NOT NULL DEFAULT 1,
      requires_transport_info BIT           NOT NULL DEFAULT 0,
      is_active               BIT           NOT NULL DEFAULT 1,
      created_at              DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_hazard_classes_code')
      CREATE UNIQUE INDEX UX_hazard_classes_code ON hazard_classes (organization_id, code)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='hazard_incompatibilities' AND xtype='U')
    CREATE TABLE hazard_incompatibilities (
      organization_id INT           NOT NULL,
      class_a         INT           NOT NULL,
      class_b         INT           NOT NULL,
      reason          NVARCHAR(200) NULL,
      CONSTRAINT PK_hazard_incompatibilities PRIMARY KEY (class_a, class_b)
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='location_hazard_permits' AND xtype='U')
    CREATE TABLE location_hazard_permits (
      location_id     INT NOT NULL,
      hazard_class_id INT NOT NULL,
      max_qty         INT NULL,
      CONSTRAINT PK_location_hazard_permits PRIMARY KEY (location_id, hazard_class_id)
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='hazard_inspections' AND xtype='U')
    CREATE TABLE hazard_inspections (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT            NOT NULL,
      branch_id       INT            NOT NULL,
      subject_type    NVARCHAR(10)   NOT NULL,
      location_id     INT            NULL,
      tire_id         INT            NULL,
      result          NVARCHAR(10)   NOT NULL,
      findings        NVARCHAR(1000) NULL,
      next_due        DATE           NULL,
      inspected_by    INT            NULL,
      inspected_at    DATETIME2      NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_hazard_inspections_subject')
      CREATE INDEX IX_hazard_inspections_subject ON hazard_inspections (organization_id, subject_type, location_id, tire_id, id)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='hazard_incidents' AND xtype='U')
    CREATE TABLE hazard_incidents (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT            NOT NULL,
      branch_id       INT            NOT NULL,
      incident_no     NVARCHAR(30)   NOT NULL,
      incident_type   NVARCHAR(24)   NOT NULL,
      severity        NVARCHAR(10)   NOT NULL DEFAULT 'medium',
      tire_id         INT            NULL,
      batch_id        INT            NULL,
      location_id     INT            NULL,
      qty_affected    INT            NULL,
      description     NVARCHAR(1000) NOT NULL,
      actions_taken   NVARCHAR(1000) NULL,
      blocks_dispatch BIT            NOT NULL DEFAULT 0,
      status          NVARCHAR(10)   NOT NULL DEFAULT 'open',
      reported_by     INT            NULL,
      reported_at     DATETIME2      NOT NULL DEFAULT GETDATE(),
      closed_by       INT            NULL,
      closed_at       DATETIME2      NULL,
      resolution      NVARCHAR(1000) NULL
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_hazard_incidents_no')
      CREATE UNIQUE INDEX UX_hazard_incidents_no ON hazard_incidents (organization_id, incident_no)`);

  // ── Waste, damage & obsolete inventory (phase 12) ──
  // Physical losses are the existing stock-out adjustments and disposals (read through utils/losses.js); nothing here changes how stock moves.
  for (const [table, col, ddl] of [
    ['tires',             'lifecycle_status', 'NVARCHAR(12) NULL'],
    ['tires',             'lifecycle_note',   'NVARCHAR(300) NULL'],
    ['tires',             'lifecycle_set_at', 'DATETIME2 NULL'],
    ['tires',             'lifecycle_set_by', 'INT NULL'],
    ['quality_disposals', 'loss_cause',       'NVARCHAR(20) NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${col}')
        ALTER TABLE ${table} ADD ${col} ${ddl}`);
  }
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='supplier_returns' AND xtype='U')
    CREATE TABLE supplier_returns (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      return_no       NVARCHAR(30)  NOT NULL,
      supplier_id     INT           NOT NULL,
      tire_id         INT           NOT NULL,
      item_name       NVARCHAR(200) NULL,
      batch_id        INT           NULL,
      location_id     INT           NULL,
      qty             INT           NOT NULL,
      reason          NVARCHAR(500) NOT NULL,
      reference       NVARCHAR(100) NULL,
      adjustment_id   INT           NOT NULL,
      credit_amount   DECIMAL(18,2) NOT NULL DEFAULT 0,
      credit_ref      NVARCHAR(100) NULL,
      credit_at       DATETIME2     NULL,
      closed_at       DATETIME2     NULL,
      closed_by       INT           NULL,
      created_by      INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_supplier_returns_no')
      CREATE UNIQUE INDEX UX_supplier_returns_no ON supplier_returns (organization_id, return_no)`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='loss_actions' AND xtype='U')
    CREATE TABLE loss_actions (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      pattern_key     NVARCHAR(120) NULL,
      title           NVARCHAR(200) NOT NULL,
      detail          NVARCHAR(1000) NULL,
      owner_name      NVARCHAR(100) NULL,
      due_date        DATE          NULL,
      status          NVARCHAR(12)  NOT NULL DEFAULT 'open',
      resolution      NVARCHAR(500) NULL,
      created_by      INT           NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE(),
      closed_by       INT           NULL,
      closed_at       DATETIME2     NULL
    )`);

  // ── Warehouses & multi-location (phase 13) ──
  // Warehouses group locations inside a branch. Cross-branch transfers are in_transit until the destination confirms receipt; every step is logged.
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='warehouses' AND xtype='U')
    CREATE TABLE warehouses (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      branch_id       INT           NOT NULL,
      name            NVARCHAR(100) NOT NULL,
      code            NVARCHAR(30)  NOT NULL,
      address         NVARCHAR(300) NULL,
      is_active       BIT           NOT NULL DEFAULT 1,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_warehouses_code')
      CREATE UNIQUE INDEX UX_warehouses_code ON warehouses (organization_id, branch_id, code)`);
  for (const [table, col, ddl] of [
    ['stock_locations',      'warehouse_id',   'INT NULL'],
    ['stock_transfers',      'to_branch_id',   'INT NULL'],
    ['stock_transfers',      'expected_at',    'DATE NULL'],
    ['stock_transfers',      'carrier',        'NVARCHAR(100) NULL'],
    ['stock_transfers',      'reference',      'NVARCHAR(100) NULL'],
    ['stock_transfers',      'received_note',  'NVARCHAR(500) NULL'],
    ['stock_transfers',      'has_discrepancy', 'BIT NOT NULL CONSTRAINT DF_stock_transfers_disc DEFAULT 0'],
    ['stock_transfer_items', 'qty_received',   'INT NULL'],
    ['stock_transfer_items', 'qty_short',      'INT NULL'],
    ['stock_transfer_items', 'dest_tire_id',   'INT NULL'],
    ['purchases',            'location_id',    'INT NULL'],
  ]) {
    await dbPool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${col}')
        ALTER TABLE ${table} ADD ${col} ${ddl}`);
  }
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='transfer_events' AND xtype='U')
    CREATE TABLE transfer_events (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT           NOT NULL,
      transfer_id     INT           NOT NULL,
      event           NVARCHAR(24)  NOT NULL,
      user_id         INT           NULL,
      note            NVARCHAR(500) NULL,
      details         NVARCHAR(1000) NULL,
      created_at      DATETIME2     NOT NULL DEFAULT GETDATE()
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_transfer_events_transfer')
      CREATE INDEX IX_transfer_events_transfer ON transfer_events (transfer_id)`);
  // Opt-in restriction: once a location has any row here, only the listed users (plus admins and the branch manager) may use it for that action.
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='location_access' AND xtype='U')
    CREATE TABLE location_access (
      location_id INT NOT NULL,
      user_id     INT NOT NULL,
      can_issue   BIT NOT NULL DEFAULT 1,
      can_receive BIT NOT NULL DEFAULT 1,
      can_count   BIT NOT NULL DEFAULT 1,
      CONSTRAINT PK_location_access PRIMARY KEY (location_id, user_id)
    )`);

  // ── Roles and permissions (phase 15) ──
  // access_roles: per-organisation roles (one built-in row per base role, plus custom roles). permissions is a JSON array of permission codes.
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='access_roles' AND xtype='U')
    CREATE TABLE access_roles (
      id              INT IDENTITY(1,1) PRIMARY KEY,
      organization_id INT NOT NULL,
      name            NVARCHAR(80)  NOT NULL,
      base_role       NVARCHAR(30)  NOT NULL,
      description     NVARCHAR(300) NULL,
      permissions     NVARCHAR(MAX) NOT NULL DEFAULT '[]',
      approval_limit  DECIMAL(14,2) NULL,
      is_builtin      BIT NOT NULL DEFAULT 0,
      created_at      DATETIME NOT NULL DEFAULT GETDATE(),
      updated_at      DATETIME NULL
    )`);
  await dbPool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_access_roles_builtin' AND object_id = OBJECT_ID('access_roles'))
      CREATE UNIQUE INDEX UX_access_roles_builtin ON access_roles (organization_id, base_role) WHERE is_builtin = 1;
    IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'UX_access_roles_name' AND object_id = OBJECT_ID('access_roles'))
      CREATE UNIQUE INDEX UX_access_roles_name ON access_roles (organization_id, name);
    IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('users') AND name = 'access_role_id')
      ALTER TABLE users ADD access_role_id INT NULL;`);

  // One-time: organisations that existed before business types keep their tyre modules.
  // New organisations get no value and resolve to General Store.
  const migrated = await dbPool.request().query("SELECT 1 FROM settings WHERE organization_id = 1 AND [key] = 'business_type_migrated'");
  if (!migrated.recordset.length) {
    await dbPool.request().query(`
      INSERT INTO settings (organization_id, [key], value)
      SELECT o.id, 'business_type', 'tyre_shop' FROM organizations o
      WHERE NOT EXISTS (SELECT 1 FROM settings s WHERE s.organization_id = o.id AND s.[key] = 'business_type');
      INSERT INTO settings (organization_id, [key], value) VALUES (1, 'business_type_migrated', '1');
    `);
  }

  // Seed global tire catalog (merges new brands/models on every restart)
  await seedTireCatalog(dbPool, sql);

  // Seed Pakistan-market vehicle fitment reference data
  await seedVehicleFitments(dbPool, sql);

  await dbPool.close();

  pool = new sql.ConnectionPool({ ...baseConfig, database: 'TuneGENDB' });
  await pool.connect();
  // Versioned migrations (folder migrations/) run after the idempotent baseline above.
  await require('./migrations').run(pool);
  console.log('✅ Database TuneGENDB and all tables ready.');
}

// ── Demo org seeder ───────────────────────────────────────────────────────────
async function seedDemoOrg(pool, sqlLib) {
  // Idempotent — only runs if the demo org doesn't exist yet
  const existing = await pool.request()
    .input('code', sqlLib.NVarChar, 'DEMO')
    .query('SELECT id FROM organizations WHERE code = @code');
  if (existing.recordset.length > 0) return;

  // 1. Create demo organisation
  const orgRes = await pool.request()
    .input('name', sqlLib.NVarChar, 'TuneGEN Demo')
    .input('code', sqlLib.NVarChar, 'DEMO')
    .input('type', sqlLib.NVarChar, 'retail')
    .query(`
      INSERT INTO organizations (name, code, type)
      OUTPUT INSERTED.id
      VALUES (@name, @code, @type)
    `);
  const demoOrgId = orgRes.recordset[0].id;

  // 2. Create demo branch
  const branchRes = await pool.request()
    .input('org_id', sqlLib.Int,      demoOrgId)
    .input('name',   sqlLib.NVarChar, 'Demo Branch')
    .input('code',   sqlLib.NVarChar, 'DEMO-BR')
    .query(`
      INSERT INTO branches (organization_id, name, code)
      OUTPUT INSERTED.id
      VALUES (@org_id, @name, @code)
    `);
  const demoBranchId = branchRes.recordset[0].id;

  // 3. Seed demo settings
  const demoSettings = [
    ['company_name',        'TuneGEN Demo'],
    ['company_tagline',     'Demo Tyre Shop — Explore Freely'],
    ['business_type',       'tyre_shop'],
    ['company_address',     '1 Demo Street, Lahore, Pakistan'],
    ['company_phone',       '+92-42-0000000'],
    ['company_email',       'demo@tunegen.app'],
    ['invoice_prefix',      'DEMO'],
    ['po_prefix',           'DEMO-PO'],
    ['default_tax_rate',    '15'],
    ['payment_due_days',    '30'],
    ['default_sale_status', 'pending'],
    ['currency',            'PKR'],
    ['announcement',        'You are in Demo Mode — data resets every 30 minutes'],
    ['refresh_interval',    '60'],
  ];
  for (const [key, value] of demoSettings) {
    await pool.request()
      .input('org_id', sqlLib.Int,      demoOrgId)
      .input('key',    sqlLib.NVarChar, key)
      .input('value',  sqlLib.NVarChar, value)
      .query(`INSERT INTO settings (organization_id, [key], value) VALUES (@org_id, @key, @value)`);
  }

  // 4. Create demo user (role = 'demo')
  const demoHash = await require('bcryptjs').hash('demo1234', 10);
  await pool.request()
    .input('name',            sqlLib.NVarChar, 'Demo User')
    .input('email',           sqlLib.NVarChar, 'demo@tunegen.app')
    .input('password_hash',   sqlLib.NVarChar, demoHash)
    .input('role',            sqlLib.NVarChar, 'demo')
    .input('organization_id', sqlLib.Int,      demoOrgId)
    .query(`
      INSERT INTO users (name, email, password_hash, role, organization_id)
      VALUES (@name, @email, @password_hash, @role, @organization_id)
    `);

  // 5. Seed demo customers
  const demoCustomers = [
    { code: 'C-DEMO-001', name: 'Ahmed Motors',         phone: '0300-1111111', email: 'ahmed@demo.pk' },
    { code: 'C-DEMO-002', name: 'Bilal Auto Works',     phone: '0301-2222222', email: 'bilal@demo.pk' },
    { code: 'C-DEMO-003', name: 'Karachi Wheel House',  phone: '0302-3333333', email: 'kwh@demo.pk'   },
    { code: 'C-DEMO-004', name: 'Raza Tyre Center',     phone: '0303-4444444', email: 'raza@demo.pk'  },
    { code: 'C-DEMO-005', name: 'Star Auto Garage',     phone: '0304-5555555', email: 'star@demo.pk'  },
  ];
  for (const c of demoCustomers) {
    await pool.request()
      .input('code',    sqlLib.NVarChar, c.code)
      .input('name',    sqlLib.NVarChar, c.name)
      .input('phone',   sqlLib.NVarChar, c.phone)
      .input('email',   sqlLib.NVarChar, c.email)
      .input('org_id',  sqlLib.Int,      demoOrgId)
      .query(`
        INSERT INTO customers (code, name, phone, email, organization_id)
        VALUES (@code, @name, @phone, @email, @org_id)
      `);
  }

  // 6. Seed demo suppliers
  const demoSuppliers = [
    { code: 'S-DEMO-001', name: 'Bridgestone Pakistan',   phone: '0311-1111111', email: 'bs@demo.pk'  },
    { code: 'S-DEMO-002', name: 'GTR Tyres Ltd',          phone: '0312-2222222', email: 'gtr@demo.pk' },
    { code: 'S-DEMO-003', name: 'Hankook Distributors',   phone: '0313-3333333', email: 'hk@demo.pk'  },
  ];
  for (const s of demoSuppliers) {
    await pool.request()
      .input('code',   sqlLib.NVarChar, s.code)
      .input('name',   sqlLib.NVarChar, s.name)
      .input('phone',  sqlLib.NVarChar, s.phone)
      .input('email',  sqlLib.NVarChar, s.email)
      .input('org_id', sqlLib.Int,      demoOrgId)
      .query(`
        INSERT INTO suppliers (code, name, phone, email, organization_id)
        VALUES (@code, @name, @phone, @email, @org_id)
      `);
  }

  // 7. Seed demo tire inventory
  const demoTires = [
    { brand: 'Bridgestone', model: 'Turanza T005',       size: '205/55R16', type: 'Passenger',    stock: 24, cost: 12500, sale: 15000 },
    { brand: 'Michelin',    model: 'Pilot Sport 4',      size: '225/45R17', type: 'Performance',  stock: 18, cost: 18000, sale: 22000 },
    { brand: 'Continental', model: 'PremiumContact 6',   size: '195/65R15', type: 'Passenger',    stock: 30, cost: 10500, sale: 13000 },
    { brand: 'Yokohama',    model: 'BluEarth GT AE51',   size: '215/60R16', type: 'Passenger',    stock: 12, cost: 11000, sale: 14000 },
    { brand: 'Hankook',     model: 'Ventus Prime 4',     size: '205/60R16', type: 'Passenger',    stock: 20, cost: 9500,  sale: 12000 },
    { brand: 'Goodyear',    model: 'EfficientGrip 2',    size: '185/65R15', type: 'Passenger',    stock: 35, cost: 8800,  sale: 11000 },
    { brand: 'GTR',         model: 'HP10',               size: '195/55R15', type: 'Passenger',    stock: 50, cost: 4500,  sale:  6000 },
    { brand: 'GTR',         model: 'HP10',               size: '215/60R16', type: 'SUV',          stock: 40, cost: 5200,  sale:  7000 },
    { brand: 'Dunlop',      model: 'SportMaxx RT2',      size: '225/50R17', type: 'Performance',  stock: 15, cost: 15000, sale: 18500 },
    { brand: 'Falken',      model: 'ZIEX ZE914',         size: '205/55R16', type: 'Passenger',    stock: 22, cost: 7500,  sale:  9500 },
  ];
  for (const t of demoTires) {
    await pool.request()
      .input('brand',      sqlLib.NVarChar,      t.brand)
      .input('model',      sqlLib.NVarChar,      t.model)
      .input('size',       sqlLib.NVarChar,      t.size)
      .input('type',       sqlLib.NVarChar,      t.type)
      .input('stock',      sqlLib.Int,           t.stock)
      .input('cost_price', sqlLib.Decimal(18,2), t.cost)
      .input('sale_price', sqlLib.Decimal(18,2), t.sale)
      .input('org_id',     sqlLib.Int,           demoOrgId)
      .input('branch_id',  sqlLib.Int,           demoBranchId)
      .query(`
        INSERT INTO tires (brand, model, size, type, stock, cost_price, sale_price, organization_id, branch_id)
        VALUES (@brand, @model, @size, @type, @stock, @cost_price, @sale_price, @org_id, @branch_id)
      `);
  }

  // 8. Seed demo services
  const demoServices = [
    { name: 'Tire Fitting',      sale: 300,  cost: 100, desc: 'Mount and fit tyre to wheel rim' },
    { name: 'Wheel Balancing',   sale: 250,  cost: 80,  desc: 'Dynamic wheel balancing with weights' },
    { name: 'Wheel Alignment',   sale: 1500, cost: 500, desc: '4-wheel laser alignment' },
    { name: 'Puncture Repair',   sale: 200,  cost: 50,  desc: 'Tubeless puncture plug and patch repair' },
  ];
  for (const svc of demoServices) {
    await pool.request()
      .input('name',   sqlLib.NVarChar,      svc.name)
      .input('desc',   sqlLib.NVarChar,      svc.desc)
      .input('sale',   sqlLib.Decimal(18,2), svc.sale)
      .input('cost',   sqlLib.Decimal(18,2), svc.cost)
      .input('org_id', sqlLib.Int,           demoOrgId)
      .query(`
        INSERT INTO products (organization_id, name, description, category, unit, sale_price, cost_price, is_active)
        VALUES (@org_id, @name, @desc, 'Service', 'job', @sale, @cost, 1)
      `);
  }

  console.log('✅ Demo org, branch, user and master data seeded (org_id =', demoOrgId, ')');

  // Seed initial demo transactions immediately (the cleanup cron will refresh them every 30 min)
  try {
    const { seedDemoTransactions } = require('./jobs/demoCleanup');
    await seedDemoTransactions(pool, demoOrgId, demoBranchId);
    console.log('✅ Demo transactions seeded for org_id =', demoOrgId);
  } catch (err) {
    // Non-fatal — the cleanup cron will seed on its next run
    console.warn('⚠ Could not seed demo transactions:', err.message);
  }
}

module.exports = { getPool, setupDatabase, getSetting, sql };
