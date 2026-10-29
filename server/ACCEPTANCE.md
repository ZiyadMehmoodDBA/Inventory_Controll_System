# Product and Inventory Control: acceptance record

Status as of 2026-10-29. "Evidence" names the automated suite that proves a criterion; run them with `npm test`, `npm run test:integration` and the browser suites in `tests/e2e`. Anything not proven by a test is listed under **Open items**.

## Entity map (spec name -> existing ERP table)
| Spec entity | Table(s) |
|---|---|
| Products | `tires` (the ERP's product table; `products` is the service catalogue) |
| ProductCategories | `item_categories` |
| UnitsOfMeasure | `tires.unit`, `item_uom_conversions` |
| Warehouses / StorageLocations | `warehouses` / `stock_locations`, `location_access` |
| InventoryBalances | `tires.stock` (item total), `item_location_stock`, `batch_location_stock` |
| InventoryTransactions | `stock_movements` (append-only ledger), `stock_cost_layers` |
| InventoryReservations | `stock_reservations` |
| InventoryBatches | `stock_batches` (+ serials on purchase/sale lines) |
| StockCounts / Lines | `stock_counts` / `stock_count_items` |
| StockTransfers / Lines | `stock_transfers` / `stock_transfer_items`, `transfer_events` |
| ReorderPolicies | `tires.reorder_level/safety_stock/...`, `replenishment_requirements`, `replenishment_approvals`, org settings |
| InventoryAdjustments | `stock_adjustments`, `supplier_returns`, `loss_actions` |
| QualityInspections | `quality_profiles`, `batch_quality_events`, `product_recalls`, `hazard_inspections`, `quality_disposals` |
| AuditLogs | `audit_logs` (append-only) |
| Optional extensions | batch/expiry/serial per item (`tires.tracking`, `track_expiry`), hazmat (`hazard_*`), quality - all off unless an item or organisation turns them on |

## Acceptance criteria
| Criterion | Evidence |
|---|---|
| Authorized users maintain product and inventory records | smoke, smoke2 (categories, SKU), smoke7 (item master, import), smoke16 (permissions) |
| Receipts and issues update stock through auditable transactions | smoke, smoke4 (locations, approvals), smoke5 (batches), smoke17 (ledger cannot be edited or deleted) |
| Reservations and releases preserve integrity | smoke8 (position, reservations, availability) |
| Duplicate requests cannot create duplicate movements | smoke17 (same Idempotency-Key twice = one movement) |
| Concurrent operations cannot oversell | smoke17 (8 parallel write-offs, 6 parallel sales) |
| Rotation follows the configured picking policy | smoke5 (FEFO), smoke9 (policies, stock age), e2e_rotation |
| Expired, damaged, restricted stock cannot be used when prohibited | smoke8 (quarantined stock not sellable), smoke11 (holds, expiry, quality), smoke12 (hazmat), e2e_quality, e2e_hazmat |
| Reorder recommendations account for demand and incoming supply | smoke10 (reorder point, lead time, on order), e2e_replenish |
| Counts reconcile against the ledger | smoke8 (counts), smoke15 (reconciliation), smoke17 |
| Transfers preserve location-level accuracy | smoke4, smoke14 (in-transit, cancel, cost carried), e2e_warehouse |
| Valuation follows the configured accounting policy | smoke6 (methods, void at original cost), smoke9 (policy change), smoke15 (agrees with report) |
| Adjustments and write-offs are traceable | smoke13 (loss register: who, when, approver), smoke16 (audit and DENIED entries) |
| Reports reconcile with the transactions | smoke14, smoke15, e2e_insights |
| Unauthorized operations are rejected by the backend | smoke16 (about 130 checks), smoke17 (anonymous/forged/expired tokens) |
| Tests cover normal, exception, concurrency and failed-transaction cases | all suites; concurrency in smoke17; rejected writes that leave stock unchanged in smoke4, smoke8, smoke16 |
| Business performance measures with configurable targets | smoke18, e2e_scorecard (Inventory -> Dashboard -> Performance) |
| Migrations | smoke17 (ordered, checksummed, idempotent, concurrency-safe) |
| Backups and recovery | `node scripts/backup.js backup` and `drill` (see below); run on 2026-10-29: restore of a full backup into a scratch database, DBCC CHECKDB clean, ledger/balances/audit counts equal to live, 3 s |

## Business performance measures
`GET /api/inventory/insights/kpis?days=30|90|180|365` (Inventory -> Dashboard -> Performance). Each measure returns value, target, status, and a plain statement of how it was measured.
Inventory accuracy, stockout rate, inventory turnover, days on hand, excess and obsolete value, expiry and damage losses, replenishment lead time, supplier on-time delivery, order fulfillment accuracy, carrying cost, working capital.
- Targets are stored per organisation (`kpi_targets` setting, audited, `policy.configure`). None is preset; the screen suggests the organisation's own figure improved by 10%.
- Carrying cost needs the organisation's annual rate. It is not guessed.
- Money measures are withheld from users without the cost permission.

## Backup and recovery
Code: `utils/dbBackup.js`; CLI `node scripts/backup.js <backup|log|drill|pitr|prune|status>`; schedule `jobs/backupJob.js`; evidence in table `backup_runs`.
- **Schedule** (set `BACKUP_JOB=on` in `server/.env`): full backup 02:00, transaction-log backup every 30 min (recovery point objective 30 min), restore drill and point-in-time drill Sunday, prune 05:00 (`BACKUP_RETENTION_DAYS`, default 14). Jobs never overlap. Every run, success or failure, is a row in `backup_runs`; `node scripts/backup.js status` shows the last success per kind.
- **Off-host copy:** set `OFFSITE_BACKUP_DIR` to a UNC share on another machine that the SQL Server service account can write. SQL Server Standard has no `MIRROR TO`, so the full backup is taken a second time (`COPY_ONLY`, verified). Until this is set the run is recorded as "NO off-host copy configured". **The database host's own disk is not a recovery plan.**
- **Restore drill:** restores the newest full backup into a scratch database, runs DBCC CHECKDB, and fails if item balances, ledger and location balances disagree or the append-only triggers are missing. Comparison with the live database is informational only (live moves on after a backup).
- **Point-in-time recovery drill:** (1) a synthetic scratch database in FULL recovery gets a full backup, row A, a noted time, row B, a log backup; restoring full + log STOPAT that time must return A without B; (2) the production newest full backup plus the log backups after it are restored and verified like a drill.
- **Evidence (2026-10-29):** verified full and log backup; restore drill passed (CHECKDB clean, 0 mismatched items, 2 s); point-in-time drill passed (synthetic exact restore to the second, production full+log chain restored, CHECKDB clean).
- **Operations still required of the business:** set `BACKUP_JOB=on`, set `OFFSITE_BACKUP_DIR`, and monitor: alert when the last full is older than 26 h, the last log older than 90 min, or the latest drill failed.

## Data integrity housekeeping (2026-10-29)
- 195 orphan ledger rows (and 15 cost layers) from deleted test organisations were verified (organisation gone, no users or branches, timestamps match the test runs), exported to `scripts/purged/`, backed up first, and removed with `scripts/purge-orphan-movements.js --apply`. The script refuses rows whose organisation still exists.
- Migration 0004 adds `FK_stock_movements_tire` with NO ACTION: an item with history can no longer be deleted; retire it by status. 287 orphan audit rows from the same test organisations remain (append-only; harmless, not purged without a decision).

## Permission exceptions (formal)
- **Sales void and sales delete are administrator-only** (`requireRole('org_admin')`), deliberately outside the permission catalogue: they reverse revenue, stock and the customer ledger in one step and should not be delegable by configuration. Reversing a recorded sale payment needs manager or administrator; purchase payments need `purchases.manage`.
- Marking a sale's status (paid/partial/pending/overdue) and recording a sale payment stay open to any signed-in user of the organisation, because the cashier workflow needs it. Revisit if a separate cashier/finance split is required.

## Security fixes from the commit review (2026-10-29)
- `/auth/forgot-password` returned a password-reset token to anyone who knew an email address (account takeover). It now returns the same message for every address and no token; administrators reset passwords in Settings > Users. Self-service reset needs an email service first.
- `/auth/google` accepted a Google token issued to any application. It now requires `GOOGLE_CLIENT_ID` (fails closed with 503 when unset) and checks audience and issuer. **If you use Google sign-in, set `GOOGLE_CLIENT_ID` in `server/.env` to the same value as `VITE_GOOGLE_CLIENT_ID`.**
- A sale could reference another organisation's customer; the customer must now belong to the organisation.
- Payment reversals and purchase payments are permission-guarded (above). smoke19 covers these.

## Open items (not proven or not built)
- Supplier in-full delivery is not measurable: a purchase order is received as a whole, not per line. On-time delivery and lead time are.
- Order fulfillment accuracy is the share of orders not voided or returned. There is no pick/ship/back-order step to measure against.
- Turnover and carrying cost use an opening value rebuilt from the ledger and the current valuation method; they are management figures, not a ledger close.
- Remaining routes still validate by hand; only access, users and KPI routes use `utils/validate.js`.
- Data imports (Excel and catalog) are covered by smoke/smoke2 for good and bad rows; very large files are untested.
- Self-service password reset is disabled until an email service exists.
- Browser suites: `npm run test:e2e` (tests/run-e2e.cjs) warms Vite, runs each suite on a fresh API and retries a failed suite once; a pass-on-retry is reported as FLAKY, never as green.
- Known limitations kept as limitations: stock counts are not frozen during counting, the sale form has no location picker, serial-tracked cross-branch transfers are untested, valuation method changes are not retroactive, there is no transfer approval workflow, and very large imports are untested.
- Deferred by decision: supplier in-full delivery (needs per-line received quantities) and order fulfillment accuracy beyond void/return (needs pick/ship/back-order events).
- `db.js` still creates the baseline schema (migration version 0). New schema changes go in `migrations/` only.
