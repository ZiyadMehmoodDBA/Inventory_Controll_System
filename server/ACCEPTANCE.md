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
Code: `utils/dbBackup.js`, `utils/backupConfig.js`, `jobs/backupJob.js`, `routes/backups.js`; console in **Settings > Backups**; CLI `node scripts/backup.js <backup|log|drill|pitr|prune|status|check>`; evidence in table `backup_runs` (job, trigger and outcome of every run).
- **Console (Settings > Backups, since 2026-10-30):** health banner, latest full / log / drill / point-in-time results, database size and recovery model, the master switch for scheduled backups, the backup / off-host folders and retention, the job list (add, edit, enable or disable, run now, delete; schedules built from plain choices or a cron expression, next run shown) and a filterable run history. Changes apply at once, no restart, and are audited (entities `backup_config`, `backup_job`, `backup_job_run`).
- **Who may use it:** backups hold every organisation's data and the folders are written by the database server, so the console and `/api/backups` are limited to **platform administrators** (`users.is_platform_admin`, organisation administrators only), not to every organisation admin. The flag is granted once to the first organisation's administrators by migration 0006 and afterwards only with `npm run platform-admin -- grant|revoke|list <email>`; it cannot be set through the API. Evidence: smoke21, e2e_backups.
- **Where settings live:** the database (`platform_settings`, `backup_jobs`). The old environment variables `BACKUP_JOB`, `BACKUP_DIR`, `OFFSITE_BACKUP_DIR`, `BACKUP_RETENTION_DAYS` still work as the fallback until the console saves a value (`BACKUP_JOB` seeded the master switch when migration 0006 ran). `BACKUP_SCHEDULER=off` stops one process from scheduling anything (used by the test servers; also for a second instance).
- **Folder rules:** a full path (`D:\Backups` or `\\server\share\folder`); no wildcards, quotes, `..` or control characters; the off-host folder must differ from the backup folder. Schedules: five numeric fields; a log job may run at most every 5 minutes, any other job every 15; at most 30 jobs; one job runs at a time.
- **Default schedule** (migration 0006 seeds these jobs; edit freely): full backup 02:00, transaction-log backup every 30 min (recovery point objective 30 min), restore drill 03:30 and point-in-time drill 04:00 on Sunday, prune 05:00 (retention default 14 days). Jobs never overlap.
- **Off-host copy:** set the off-host folder to a share on another machine that the SQL Server service account can write. SQL Server Standard has no `MIRROR TO`, so the full backup is taken a second time (`COPY_ONLY`, verified). Until it is set the run says so and the health banner reports it. **The database host's own disk is not a recovery plan.**
- **Restore drill:** restores the newest full backup into a scratch database, runs DBCC CHECKDB, and fails if item balances, ledger and location balances disagree or the append-only triggers are missing. Comparison with the live database is informational only (live moves on after a backup).
- **Point-in-time recovery drill:** (1) a synthetic scratch database in FULL recovery gets a full backup, row A, a noted time, row B, a log backup; restoring full + log STOPAT that time must return A without B; (2) the production newest full backup plus the log backups after it are restored and verified like a drill.
- **Evidence (2026-10-29):** verified full and log backup; restore drill passed (CHECKDB clean, 0 mismatched items, 2 s); point-in-time drill passed (synthetic exact restore to the second, production full+log chain restored, CHECKDB clean).
- **Health check:** the console banner and `npm run backup:check` (exit 1 and a list) report: last full backup older than 26 h, last log backup older than 1.5 h, a drill older than 8 days, the latest run of any kind failed, scheduled backups switched off, or no off-host copy. Run `backup:check` hourly from Windows Task Scheduler (or any monitor that alerts on a non-zero exit) so someone is told without opening the console.
- **Operations still required of the business:** set the off-host folder in the console and schedule `npm run backup:check`.

## Business-aware catalogue scraper (2026-10-30)
Code: `catalogue/` (`profiles.js`, `netguard.js`, `extract.js`, `normalize.js`, `service.js`), `routes/catalogue.js`, UI **Settings > Catalogue Scraper**; tables `catalogue_profiles`, `catalogue_jobs`, `catalogue_raw`, `catalogue_records` (migration 0007). Evidence: `catalogue/catalogue.test.js`, smoke22 (87 checks), e2e_catalogue (43).
- **One engine, a profile per business type.** All 15 business types have a profile (`catalogue/profiles.js`): the attributes to extract (required / optional), default search keywords, categories with the words that file a product in each, and the identity used for duplicates. The engine has no industry knowledge: auto parts add OEM number and vehicle fitment, tyres add width / aspect ratio / rim / load / speed / season / run-flat, electronics add storage / warranty / colour, grocery adds barcode / pack size / ingredients, and so on. An organisation can change keywords, categories, required attributes and pages per scrape for any type (`PUT /catalogue/profile/:type`, audited), and reset to the defaults.
- **Workflow:** choose business type, give a source name and URL (a listing page or a product page), optional keywords and category; the scrape reads up to 10 pages (default 3, next-page links followed, same site only) and opens each product page for the specification; records are normalised (name and brand tidied, price and currency parsed, GTIN check digit verified, pack size and unit, attributes from structured data, spec tables and patterns in the text, category from the profile), checked against existing products and against each other, then shown for review with status Pending (a required attribute is missing), Validated, Duplicate, Ignored or Imported. A user can preview (with the raw extraction), edit, ignore / restore, approve and import, and export CSV or Excel. Limits per scrape: 200 products, 60 requests; one scrape per organisation at a time, two on the server.
- **Extraction order:** JSON-LD (Product, ItemList, BreadcrumbList), schema.org microdata, Open Graph product meta, then HTML (specification tables and lists, product cards, optional CSS selectors per source under Advanced). Raw extraction is stored separately (`catalogue_raw`) from normalised records; every record keeps its source URL and extraction time.
- **Duplicates and overwriting:** a record is a duplicate when its SKU or barcode matches a product, its OEM number matches a product imported earlier, its brand + name + size match a product (word order and unit spacing ignored), or it repeats another record of the same scrape. A duplicate is never imported; **an existing product is never overwritten** (checked again at the moment of import). Editing a record re-runs the check. The import creates a new product with zero stock (stock comes in through receipts, as everywhere else), the listed price as selling price or, by choice, as cost, a category created if missing, and an audit entry and product history line. Tyre shops need brand, model and size (an incomplete tyre is refused with the reason); other businesses need a name.
- **Safe fetching (users supply the URLs):** only http / https on ports 80, 443, 8080, 8443, no credentials in the URL; every connection and redirect is checked at connect time against private, loopback, link-local, carrier-grade NAT and cloud-metadata ranges (also defeats DNS rebinding); robots.txt is read and obeyed (the most specific rule wins); requests to one site are at least 1.2 s apart; failures retry with backoff; pages over 2 MB or not web content are refused; a login, paywall, 401 / 402 / 403 or human-verification page ends that page with the reason, never a workaround. The scraper identifies itself as `TuneGENCatalogueBot`. **Operator duty:** respect each site's terms and copyright; scraped text and images are the site's.
- **Safe output:** scraped text is rendered as text, image and source links only when http(s) (opened with `noopener nofollow`); exports prefix any value starting with `=`, `+`, `-`, `@` so a spreadsheet cannot run it as a formula.
- **Permission:** `inventory.manage_items` (administrators and managers by default; the Settings tab is shown to administrators). Demo users are blocked. Everything is organisation-scoped (another organisation gets 404).
- **Environment:** `CATALOGUE_ALLOW_LOOPBACK=on` opens 127.0.0.0/8 and any port, for the test servers that scrape a fixture shop. **Never set it in production.** `CATALOGUE_MIN_GAP_MS` overrides the 1200 ms spacing (tests use 0).
- **Not built:** AI classification (the normaliser's rules-based category and attribute mapping is the extension point), JavaScript-rendered pages (only server-delivered HTML is read), updating an existing product from a scrape, scheduled / recurring scrapes, downloading product images (only the image address is stored).

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
- Contracts declared with `utils/validate.js`: access, users, KPI, and (2026-10-30) the money routes: sales, purchases, payments and their Excel imports (`utils/schemas.js`, evidence smoke20). Still validated by hand: inventory, customers, suppliers, services, ledger, organisations, settings. Next in line: inventory adjustments and transfers.
- Money-route rules enforced beyond shape: quantities are whole numbers from 1, prices and amounts are 0 to 1e9, a sale cannot be created voided, an order discount cannot exceed the order, a till payment cannot exceed the total, a payment cannot exceed the balance due (409 OVERPAYMENT), voided sales and cancelled purchases take no payment, a purchase supplier must belong to the organisation, and payments lock the document row so two at once cannot both pass.
- Data imports (Excel and catalog) are covered by smoke/smoke2 for good and bad rows; very large files are untested.
- Self-service password reset is disabled until an email service exists.
- Browser suites: `npm run test:e2e` (tests/run-e2e.cjs) warms Vite, runs each suite on a fresh API and retries a failed suite once; a pass-on-retry is reported as FLAKY, never as green.
- Known limitations kept as limitations: stock counts are not frozen during counting, the sale form has no location picker, serial-tracked cross-branch transfers are untested, valuation method changes are not retroactive, there is no transfer approval workflow, and very large imports are untested.
- Deferred by decision: supplier in-full delivery (needs per-line received quantities) and order fulfillment accuracy beyond void/return (needs pick/ship/back-order events).
- `db.js` still creates the baseline schema (migration version 0). New schema changes go in `migrations/` only.
