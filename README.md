# TuneGEN Billing and Inventory Control System

A full-stack billing, inventory and business-intelligence ERP built with React 19 + TypeScript on the frontend and Node.js/Express on the backend, backed by Microsoft SQL Server.

---

## Features

| Module | Description |
|---|---|
| **Dashboard** | Today/month revenue, units sold, top-5 SKUs, low-stock alerts |
| **Sales (POS)** | Invoice creation, multi-item cart, discount, payment methods |
| **Purchases (GRN)** | Purchase orders, goods receipt, supplier payments |
| **Invoices** | Printable PDF invoices with company branding |
| **AI Reports** | Natural-language business questions answered from approved, permission-scoped reports (see below) |
| **Inventory** | Product/SKU catalog, stock levels, reorder alerts, movements log |
| **Services** | Fitting, balancing, alignment — service price list |
| **Customers** | CRM with vehicle info, balance tracking, ledger |
| **Suppliers** | Supplier accounts, balance, purchase history |
| **Financial Ledger** | Double-entry journal, AR/AP, payment history |
| **Reports** | P&L, Sales Report, Stock Report, Low-Stock export (PDF + Excel) |
| **Settings** | Company profile, invoice defaults, services price list, user management |
| **Audit Log** | Immutable before/after log for every create/update/delete |
| **Organizations** | Multi-org, multi-branch architecture (admin only) |

---

## Tech Stack

**Frontend**
- React 19 + TypeScript + Vite
- Tailwind CSS v4
- Recharts (charts), jsPDF + autoTable (PDF export), SheetJS XLSX (Excel export)
- Lucide React (icons)

**Backend**
- Node.js + Express 4
- Microsoft SQL Server (via `mssql`)
- JWT authentication (access + refresh tokens, bcrypt password hashing)
- Helmet, CORS, express-rate-limit

---

## AI Reporting and Business Intelligence

Open **AI Reports** in the sidebar and ask, for example: *"What is this month's revenue?"*, *"What is Ahmad's account statement?"*, *"Which products are below their reorder points?"*.

How it works (the model never touches data or SQL):

1. The question goes to a **provider adapter** (`server/reporting/provider.js`) which returns a structured spec: a report id plus parameters, or a clarification.
2. The spec is **validated** against the approved **report registry** (`registry.js`) and re-authorised by role and data classification (`policy.js`). Org, branch and role come only from the JWT.
3. A fixed **parameterised SQL template** runs with a row limit, timeout and (optionally) a read-only DB login. Rows are projected to the report's declared columns.
4. The response carries the interpretation, KPIs, evidence table, calculation definition, caveats and follow-ups. Forecasts and gross profit are labelled estimates. Unsupported questions (expenses, net profit, expiry, lead times, ...) are refused rather than guessed.
5. Every run is written to `report_execution_history` and `report_access_audit` (no result rows are stored).

Endpoints: `POST /api/reports/ask`, `GET /api/reports/definitions`, `GET /api/reports/:id`, `GET /api/reports/history`, `GET|POST /api/reports/saved`, `POST /api/reports/saved/:id/run`, `POST /api/reports/:id/export` (CSV). Saved reports and exports are re-authorised on every run.

Configuration (optional, in `server/.env`):

| Variable | Description |
|---|---|
| `AI_PROVIDER` | `mock` (default, rule-based, no external calls). Add real adapters in `provider.js`. |
| `REPORT_DB_USER` / `REPORT_DB_PASSWORD` | Read-only SQL login used only for reports. Strongly recommended in production. |

Per-organisation limits and AI-provider approval live in `reporting_policy_configuration`. Run the guardrail tests with `node --test server/reporting/reporting.test.js`.

## Prerequisites

- **Node.js** 18+
- **Microsoft SQL Server** 2016 or later (Express edition works)
- **npm** 9+

---

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/ZiyadMehmoodDBA/tire-pro.git
cd tire-pro   # repository folder name may differ
```

### 2. Configure the backend environment

```bash
cp server/.env.example server/.env
```

Edit `server/.env` with your SQL Server credentials and secrets:

```env
DB_SERVER=localhost          # SQL Server host (IP or hostname\instance)
DB_USER=sa                   # SQL Server login
DB_PASSWORD=your-password    # SQL Server password
DB_NAME=TuneGENDB            # Database name (auto-created on first run)
PORT=3001                    # API port
ADMIN_PASSWORD=YourSecurePassword123   # First-run admin account password
JWT_SECRET=<64-char random hex>        # See below for how to generate
```

Generate a JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Install dependencies

```bash
# Frontend dependencies
npm install

# Backend dependencies
cd server && npm install && cd ..
```

### 4. Start the application

```bash
# Starts both frontend (port 5173) and backend (port 3001) concurrently
npm start
```

On first run the server will:
- Create the `TuneGENDB` database automatically
- Create all tables and apply migrations
- Seed default organization, branch, settings, tire types and services
- Create the admin user account (email: `zmehmood@tunegen.com`, password: value of `ADMIN_PASSWORD` in `.env`)

### 5. Open the app

Navigate to [http://localhost:5173](http://localhost:5173)

Login with:
- **Email:** `zmehmood@tunegen.com`
- **Password:** *(value you set in `ADMIN_PASSWORD`)*

---

## Database Setup (Manual / SSMS)

If you prefer to set up the database manually instead of relying on the auto-migration, a pure T-SQL script is provided:

```
database/schema.sql   — all CREATE TABLE statements + indexes
database/seed.sql     — default lookup data (tire types, services, settings)
```

Run `schema.sql` first, then `seed.sql` in SQL Server Management Studio or `sqlcmd`.

To load sample/demo data (customers, suppliers, tires, sales):
```bash
node server/seed.js
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DB_SERVER` | Yes | SQL Server hostname or IP (e.g. `localhost`, `10.0.0.5`) |
| `DB_USER` | Yes | SQL Server login username |
| `DB_PASSWORD` | Yes | SQL Server login password |
| `DB_NAME` | Yes | Database name (default: `TuneGENDB`) |
| `PORT` | No | API server port (default: `3001`) |
| `ADMIN_PASSWORD` | Yes | Password set for the initial admin account on first run |
| `JWT_SECRET` | Yes | 64-char hex secret for signing JWTs — keep this private |

---

## Project Structure

```
tunegen-bics/
├── src/                    # React frontend
│   ├── api/                # API client (typed wrappers)
│   ├── components/         # Shared UI components
│   ├── lib/                # Utilities (auth, formatters, PDF/Excel export)
│   └── pages/              # Page components (one per route)
├── server/                 # Node.js/Express backend
│   ├── routes/             # Express route handlers
│   ├── middleware/         # Auth middleware
│   ├── reporting/          # AI reporting: registry, validator, provider adapter, engine, audit
│   ├── utils/              # Helpers (audit logger, context)
│   ├── db.js               # Database setup + migrations (auto-runs on start)
│   ├── seed.js             # Demo data seeder (run manually)
│   └── index.js            # Entry point
├── database/               # Plain SQL scripts for manual DB setup
│   ├── schema.sql          # All CREATE TABLE statements
│   └── seed.sql            # Default lookup data
└── public/                 # Static assets
```

---

## User Roles

| Role | Access |
|---|---|
| `org_admin` | Full access — settings, user management, audit log, organizations, all branches |
| `branch_manager` | All operations for assigned branch |
| `staff` | Sales, purchases, inventory (read/write) for assigned branch |

---

## License

Private — internal use only.
