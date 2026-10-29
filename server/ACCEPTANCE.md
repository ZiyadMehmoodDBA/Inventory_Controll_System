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
- `node scripts/backup.js backup [--log]`: compressed, checksummed full backup, verified with `RESTORE VERIFYONLY`; `--log` adds a verified log backup.
- `node scripts/backup.js drill`: restores the newest backup into a scratch database, runs `DBCC CHECKDB`, compares ledger rows, ledger net quantity, item and location balances, adjustments, audit rows and migrations with the live database, confirms the append-only triggers came back, then drops the scratch copy. Exit code 1 on any failure.
- `node scripts/backup.js prune [days]`.
- The database is in FULL recovery model with no scheduled backups. **Schedule** `backup` daily and `backup --log` every 15-60 minutes (SQL Agent or Windows Task Scheduler) and `drill` weekly, and copy `BACKUP_DIR` off the database host.

## Open items (not proven or not built)
- Supplier in-full delivery is not measurable: a purchase order is received as a whole, not per line. On-time delivery and lead time are.
- Order fulfillment accuracy is the share of orders not voided or returned. There is no pick/ship/back-order step to measure against.
- Turnover and carrying cost use an opening value rebuilt from the ledger and the current valuation method; they are management figures, not a ledger close.
- Backups are not scheduled by the application; the schedule above is an operations task.
- Point-in-time restore from log backups is supported by the files but not exercised by the drill.
- Remaining routes still validate by hand; only access, users and KPI routes use `utils/validate.js`.
- Data imports (Excel and catalog) are covered by smoke/smoke2 for good and bad rows; very large files are untested.
