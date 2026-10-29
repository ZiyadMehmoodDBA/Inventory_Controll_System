# TuneGEN Billing and Inventory Control – architecture notes

The inventory module is part of the ERP (same login, organisations, branches, users, products = `tires`, suppliers, purchases, sales). It adds tables and a few columns; it does not run as a separate application.

| Requirement | Where it lives |
|---|---|
| Business rules in the backend | `utils/stock.js` (ledger, costing, approval rules), `utils/permissions.js`, `utils/insights.js`; routes only call them |
| Authentication and role-based authorization | `middleware/auth` (JWT) → `utils/permissions.js` `attachAccess` (live role/permissions from DB) → `requirePermission(...)` per route |
| Validated API contracts | `utils/validate.js` (`v.string/number/int/bool/enum/array`, `validate(body, schema)`); used by `/api/access`, `/api/users`. New endpoints should declare their contract the same way |
| Centralized error handling | `utils/errors.js`: `AppError`, `ValidationError`, `handleError`, `errorMiddleware` (registered last in `index.js`). Every error is `{ error, code, ...details }`; unexpected errors are logged and answered with a generic 500 |
| Transactions and concurrency | stock writes run in one SQL transaction with row locks (`UPDLOCK`/`HOLDLOCK`) in `utils/stock.js`; deadlock victims return `409 CONFLICT_RETRY`; `Idempotency-Key` header makes a repeated request apply once |
| Append-only history | migration `0001`/`0003`: triggers make `audit_logs` and `stock_movements` reject UPDATE/DELETE (only `stock_movements.unit_cost` may be filled in by costing, `location_id` only back-filled once). Corrections are new, opposing movements |
| Database constraints | migration `0002`: CHECK constraints (non-zero movements, balance = before + change, adjustment status, non-negative batch/location stock and approval limits) plus the NOT NULL/FK/unique rules in `db.js` |
| Versioned migrations | `migrations/NNNN_name.js` (`exports.description`, `exports.up(tx, sql)`); applied in order inside a transaction under an application lock, recorded with a checksum in `schema_migrations`; a changed, already-applied file is refused. Version 0 is the baseline created by `setupDatabase()` in `db.js` |
| Automated tests | `npm test` (unit: costing, reporting); `npm run test:integration` (17 HTTP suites in `tests/integration`: ledger integrity, concurrency, authorization, migrations, append-only); browser suites in `tests/e2e` |

## Adding a schema change
1. Create `migrations/000N_what_it_does.js` with `up(tx, sql)`; keep it idempotent where cheap.
2. Never edit a migration that has been applied anywhere; add a new one.
3. Restart the API (migrations run at start-up) and add a check to an integration suite.

## Purging test data
The append-only triggers refuse deletes unless the connection sets `sp_set_session_context N'allow_purge', 1`. Only test clean-up and an explicit administrator purge may do that.

## Running the tests
- `npm test` – unit tests (no server needed).
- `npm run test:integration [smoke16 smoke17 ...]` – starts a throwaway API on port 3055 per suite (the rate limiter would otherwise reject later suites). Each suite creates and removes its own organisation.
- Browser suites: start Vite (`npx vite --port 5199 --strictPort` in the project root) and an API on 3055, then
  `node tests/e2e/e2e.cjs <label> extra "$PWD/tests/e2e/e2e_roles.cjs"` (modules: rotation, sale, replenish, quality, hazmat, losses, warehouse, insights, roles, extra, master, control).
