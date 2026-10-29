-- ============================================================
-- TuneGEN Database Schema
-- Microsoft SQL Server (T-SQL)
--
-- Run this script in SSMS or sqlcmd against your SQL Server.
-- The application's server/db.js applies these automatically
-- on first start, so you only need this file for manual setup.
-- ============================================================

-- 1. Create database (skip if already exists)
IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'TuneGENDB')
    CREATE DATABASE TuneGENDB;
GO

USE TuneGENDB;
GO

-- ── Core lookup tables ───────────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tire_types' AND xtype='U')
CREATE TABLE tire_types (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    name       NVARCHAR(100) NOT NULL,
    sort_order INT DEFAULT 0
);
GO

-- ── Multi-org / multi-branch ─────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='organizations' AND xtype='U')
CREATE TABLE organizations (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    name       NVARCHAR(200) NOT NULL,
    code       NVARCHAR(50)  NOT NULL,
    type       NVARCHAR(50)  DEFAULT 'retail',
    address    NVARCHAR(500),
    phone      NVARCHAR(50),
    email      NVARCHAR(200),
    currency   NVARCHAR(10)  DEFAULT 'PKR',
    logo_url   NVARCHAR(500),
    is_active  BIT           DEFAULT 1,
    created_at DATETIME2     DEFAULT GETDATE(),
    CONSTRAINT UQ_org_code UNIQUE (code)
);
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='branches' AND xtype='U')
CREATE TABLE branches (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT NOT NULL,
    name            NVARCHAR(200) NOT NULL,
    code            NVARCHAR(50)  NOT NULL,
    address         NVARCHAR(500),
    phone           NVARCHAR(50),
    email           NVARCHAR(200),
    is_active       BIT       DEFAULT 1,
    created_at      DATETIME2 DEFAULT GETDATE()
);
GO

-- ── Users & auth ─────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='users' AND xtype='U')
CREATE TABLE users (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    name            NVARCHAR(100) NOT NULL,
    email           NVARCHAR(100) NOT NULL,
    phone           NVARCHAR(50),
    company         NVARCHAR(100),
    city            NVARCHAR(100),
    password_hash   NVARCHAR(255) NOT NULL,
    role            NVARCHAR(50)  DEFAULT 'staff',
    organization_id INT           NOT NULL DEFAULT 1,
    branch_id       INT           NULL,
    is_active       BIT           DEFAULT 1,
    created_at      DATETIME      DEFAULT GETDATE(),
    CONSTRAINT UQ_users_email UNIQUE (email)
);
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='refresh_tokens' AND xtype='U')
CREATE TABLE refresh_tokens (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash NVARCHAR(255) NOT NULL,
    expires_at DATETIME2     NOT NULL,
    created_at DATETIME2     DEFAULT GETDATE(),
    CONSTRAINT UQ_refresh_token UNIQUE (token_hash)
);
GO

-- ── Settings (per-org key-value store) ───────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='settings' AND xtype='U')
CREATE TABLE settings (
    organization_id INT           NOT NULL DEFAULT 1,
    [key]           NVARCHAR(100) NOT NULL,
    value           NVARCHAR(1000),
    updated_at      DATETIME DEFAULT GETDATE(),
    CONSTRAINT PK_settings PRIMARY KEY (organization_id, [key])
);
GO

-- ── Customers & suppliers ────────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='customers' AND xtype='U')
CREATE TABLE customers (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT           NOT NULL DEFAULT 1,
    code            NVARCHAR(20)  UNIQUE NOT NULL,
    name            NVARCHAR(100) NOT NULL,
    phone           NVARCHAR(50),
    email           NVARCHAR(100),
    address         NVARCHAR(200),
    balance         DECIMAL(18,2) DEFAULT 0,
    vehicle_plate   NVARCHAR(20)  NULL,
    vehicle_make    NVARCHAR(50)  NULL,
    vehicle_model   NVARCHAR(50)  NULL,
    vehicle_year    SMALLINT      NULL,
    created_at      DATETIME DEFAULT GETDATE()
);
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='suppliers' AND xtype='U')
CREATE TABLE suppliers (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT           NOT NULL DEFAULT 1,
    code            NVARCHAR(20)  UNIQUE NOT NULL,
    name            NVARCHAR(100) NOT NULL,
    phone           NVARCHAR(50),
    email           NVARCHAR(100),
    address         NVARCHAR(200),
    balance         DECIMAL(18,2) DEFAULT 0,
    created_at      DATETIME DEFAULT GETDATE()
);
GO

-- ── Inventory ────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='tires' AND xtype='U')
CREATE TABLE tires (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT           NOT NULL DEFAULT 1,
    branch_id       INT           NOT NULL DEFAULT 1,
    brand           NVARCHAR(100) NOT NULL,
    model           NVARCHAR(100) NOT NULL,
    size            NVARCHAR(50)  NOT NULL,
    type            NVARCHAR(50),
    pattern         NVARCHAR(100) NULL,
    load_index      NVARCHAR(10)  NULL,
    speed_index     NVARCHAR(5)   NULL,
    dot             NVARCHAR(20)  NULL,
    stock           INT           DEFAULT 0,
    cost_price      DECIMAL(18,2) NOT NULL DEFAULT 0,
    sale_price      DECIMAL(18,2) NOT NULL DEFAULT 0,
    reorder_level   INT           DEFAULT 10,
    created_at      DATETIME      DEFAULT GETDATE()
);
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='stock_movements' AND xtype='U')
CREATE TABLE stock_movements (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    tire_id         INT NOT NULL REFERENCES tires(id),
    organization_id INT NOT NULL DEFAULT 1,
    branch_id       INT NOT NULL DEFAULT 1,
    qty_change      INT NOT NULL,
    reason          NVARCHAR(50)  NOT NULL,
    reference       NVARCHAR(100) NULL,
    ref_id          INT           NULL,
    notes           NVARCHAR(500) NULL,
    created_at      DATETIME2 DEFAULT GETDATE()
);
GO

-- ── Products catalog (services, accessories, non-tire items) ─────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='products' AND xtype='U')
CREATE TABLE products (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT           NOT NULL DEFAULT 1,
    code            NVARCHAR(50),
    name            NVARCHAR(200) NOT NULL,
    description     NVARCHAR(500),
    category        NVARCHAR(100),
    unit            NVARCHAR(50)  DEFAULT 'pcs',
    cost_price      DECIMAL(18,2) DEFAULT 0,
    sale_price      DECIMAL(18,2) DEFAULT 0,
    is_active       BIT           DEFAULT 1,
    created_at      DATETIME      DEFAULT GETDATE()
);
GO

-- ── Sales ────────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sales' AND xtype='U')
CREATE TABLE sales (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT           NOT NULL DEFAULT 1,
    branch_id       INT           NOT NULL DEFAULT 1,
    invoice_no      NVARCHAR(50)  UNIQUE NOT NULL,
    customer_id     INT           REFERENCES customers(id),
    date            DATE          NOT NULL,
    subtotal        DECIMAL(18,2) NOT NULL DEFAULT 0,
    discount        DECIMAL(18,2) NOT NULL DEFAULT 0,
    tax_rate        DECIMAL(5,2)  DEFAULT 0,
    tax             DECIMAL(18,2) NOT NULL DEFAULT 0,
    total           DECIMAL(18,2) NOT NULL DEFAULT 0,
    amount_paid     DECIMAL(18,2) DEFAULT 0,
    status          NVARCHAR(20)  DEFAULT 'pending',
    payment_method  NVARCHAR(20)  NULL,
    cash_given      DECIMAL(18,2) NULL,
    notes           NVARCHAR(500),
    created_at      DATETIME      DEFAULT GETDATE()
);
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sale_items' AND xtype='U')
CREATE TABLE sale_items (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    sale_id    INT REFERENCES sales(id) ON DELETE CASCADE,
    tire_id    INT REFERENCES tires(id),
    product_id INT REFERENCES products(id),
    tire_name  NVARCHAR(200),
    qty        INT           NOT NULL DEFAULT 1,
    unit_price DECIMAL(18,2) NOT NULL DEFAULT 0,
    discount   DECIMAL(5,2)  NOT NULL DEFAULT 0,
    amount     DECIMAL(18,2) NOT NULL DEFAULT 0
);
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='sale_payments' AND xtype='U')
CREATE TABLE sale_payments (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    sale_id        INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    customer_id    INT NOT NULL REFERENCES customers(id),
    amount         DECIMAL(18,2) NOT NULL,
    payment_date   DATE          NOT NULL,
    payment_method NVARCHAR(50)  DEFAULT 'cash',
    reference_no   NVARCHAR(100) DEFAULT '',
    notes          NVARCHAR(500) DEFAULT '',
    created_at     DATETIME      DEFAULT GETDATE()
);
GO

-- ── Purchases ────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='purchases' AND xtype='U')
CREATE TABLE purchases (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT           NOT NULL DEFAULT 1,
    branch_id       INT           NOT NULL DEFAULT 1,
    po_no           NVARCHAR(50)  UNIQUE NOT NULL,
    supplier_id     INT           REFERENCES suppliers(id),
    date            DATE          NOT NULL,
    subtotal        DECIMAL(18,2) NOT NULL DEFAULT 0,
    tax_rate        DECIMAL(5,2)  NOT NULL DEFAULT 0,
    tax             DECIMAL(18,2) NOT NULL DEFAULT 0,
    total           DECIMAL(18,2) NOT NULL DEFAULT 0,
    amount_paid     DECIMAL(18,2) DEFAULT 0,
    status          NVARCHAR(20)  DEFAULT 'pending',
    reference_no    NVARCHAR(100) NULL,
    notes           NVARCHAR(500),
    created_at      DATETIME      DEFAULT GETDATE()
);
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='purchase_items' AND xtype='U')
CREATE TABLE purchase_items (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    purchase_id INT REFERENCES purchases(id) ON DELETE CASCADE,
    tire_id     INT REFERENCES tires(id),
    product_id  INT REFERENCES products(id),
    tire_name   NVARCHAR(200),
    qty         INT           NOT NULL DEFAULT 1,
    unit_price  DECIMAL(18,2) NOT NULL DEFAULT 0,
    amount      DECIMAL(18,2) NOT NULL DEFAULT 0
);
GO

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='purchase_payments' AND xtype='U')
CREATE TABLE purchase_payments (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    purchase_id    INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    supplier_id    INT NOT NULL REFERENCES suppliers(id),
    amount         DECIMAL(18,2) NOT NULL,
    payment_date   DATE          NOT NULL,
    payment_method NVARCHAR(50)  DEFAULT 'cash',
    reference_no   NVARCHAR(100) DEFAULT '',
    notes          NVARCHAR(500) DEFAULT '',
    created_at     DATETIME      DEFAULT GETDATE()
);
GO

-- ── Financial ledger ─────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ledger_entries' AND xtype='U')
CREATE TABLE ledger_entries (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT           NOT NULL DEFAULT 1,
    branch_id       INT           NOT NULL DEFAULT 1,
    entry_date      DATE          NOT NULL,
    entity_type     NVARCHAR(20)  NOT NULL,
    entity_id       INT           NOT NULL,
    entry_type      NVARCHAR(30)  NOT NULL,
    debit           DECIMAL(18,2) DEFAULT 0,
    credit          DECIMAL(18,2) DEFAULT 0,
    description     NVARCHAR(500) DEFAULT '',
    reference_no    NVARCHAR(100) DEFAULT '',
    sale_id         INT REFERENCES sales(id),
    purchase_id     INT REFERENCES purchases(id),
    created_at      DATETIME      DEFAULT GETDATE()
);
GO

-- ── Audit log ────────────────────────────────────────────────────────────────

IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='audit_logs' AND xtype='U')
CREATE TABLE audit_logs (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    organization_id INT           NOT NULL DEFAULT 1,
    branch_id       INT           NOT NULL DEFAULT 1,
    user_id         INT           NULL,
    user_name       NVARCHAR(100) NOT NULL DEFAULT 'System',
    action          NVARCHAR(20)  NOT NULL,    -- CREATE | UPDATE | DELETE
    entity          NVARCHAR(50)  NOT NULL,    -- sales | inventory | products
    entity_id       INT           NULL,
    before_json     NVARCHAR(MAX) NULL,
    after_json      NVARCHAR(MAX) NULL,
    created_at      DATETIME2     DEFAULT GETDATE()
);
GO

CREATE INDEX IX_audit_logs_org_created ON audit_logs (organization_id, created_at DESC);
GO

-- ── Indexes for common queries ────────────────────────────────────────────────

CREATE INDEX IX_sales_org_branch_date   ON sales    (organization_id, branch_id, date DESC);
CREATE INDEX IX_purchases_org_branch    ON purchases (organization_id, branch_id, date DESC);
CREATE INDEX IX_tires_org_branch        ON tires     (organization_id, branch_id);
CREATE INDEX IX_customers_org           ON customers (organization_id);
CREATE INDEX IX_suppliers_org           ON suppliers (organization_id);
GO
