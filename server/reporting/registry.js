// Registry of approved reports. The AI may only select a report id and validated parameters;
// every query below is a fixed, parameterised template scoped by organisation (and branch).
const { sql } = require('../db');
const { PERIODS, previousPeriod } = require('./periods');

const ORG   = 's.organization_id = @orgId';
const money = v => Number(v || 0);
const sum   = (rows, k) => rows.reduce((a, r) => a + money(r[k]), 0);
const fmtN  = n => n.toLocaleString('en-PK', { maximumFractionDigits: 2 });

const col = (key, label, type = 'text') => ({ key, label, type });
const P_PERIOD = def => ({ type: 'period', default: def });
const P_LIMIT  = (def, max = 500) => ({ type: 'int', default: def, min: 1, max });

// Inputs every template receives. rowLimit is limit+1 so the engine can detect truncation.
function base(scope, p) {
  return [
    ['orgId', sql.Int, scope.orgId],
    ['branchId', sql.Int, scope.branchId],
    ['rowLimit', sql.Int, p.limit + 1],
    ...(p.period ? [['from', sql.VarChar(10), p.period.from], ['to', sql.VarChar(10), p.period.to]] : []),
  ];
}
const BR = '(@branchId IS NULL OR s.branch_id = @branchId)';
const DATE_RANGE = 's.date BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)';
const ITEM = "COALESCE(t.brand + ' ' + t.model + ' ' + t.size, pr.name, si.tire_name, 'Unknown item')";

const REPORTS = {
  // ── Sales & revenue ─────────────────────────────────────────────────────────
  revenue_summary: {
    title: 'Sales revenue summary', domain: 'sales', classification: 'confidential_financial', metric: 'sales_invoiced',
    description: 'Daily invoiced sales for a period.',
    params: { period: P_PERIOD('this_month'), limit: P_LIMIT(366) },
    columns: [col('sale_date', 'Date', 'date'), col('invoices', 'Invoices', 'number'), col('sales_total', 'Invoiced sales', 'currency'), col('discounts', 'Discounts', 'currency'), col('tax', 'Tax', 'currency')],
    chart: { type: 'line', x: 'sale_date', y: 'sales_total' },
    caveats: ['Shows sales activity (invoiced), not audited accounting revenue.', 'Voided invoices excluded; refunds/credit notes are not modelled separately.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) CONVERT(VARCHAR(10), s.date, 23) AS sale_date, COUNT(*) AS invoices,
                   SUM(s.total) AS sales_total, SUM(s.discount) AS discounts, SUM(s.tax) AS tax
            FROM sales s WHERE ${ORG} AND ${BR} AND s.status != 'voided' AND ${DATE_RANGE}
            GROUP BY CONVERT(VARCHAR(10), s.date, 23) ORDER BY sale_date`,
      inputs: base(scope, p),
    }),
    summarize: rows => {
      const total = sum(rows, 'sales_total'), n = sum(rows, 'invoices');
      return {
        kpis: [{ label: 'Invoiced sales', value: total, type: 'currency' }, { label: 'Invoices', value: n, type: 'number' }, { label: 'Average invoice', value: n ? total / n : 0, type: 'currency' }],
        headline: `Invoiced sales were ${fmtN(total)} across ${n} invoice(s).`,
      };
    },
  },

  revenue_compare: {
    title: 'Sales comparison', domain: 'sales', classification: 'confidential_financial', metric: 'sales_invoiced',
    description: 'Invoiced sales for a period versus the preceding period.',
    params: { period: P_PERIOD('this_month') },
    columns: [col('period_label', 'Period'), col('from_date', 'From', 'date'), col('to_date', 'To', 'date'), col('invoices', 'Invoices', 'number'), col('sales_total', 'Invoiced sales', 'currency')],
    chart: { type: 'bar', x: 'period_label', y: 'sales_total' },
    caveats: ['Compares sales activity, not accounting revenue.', 'A partly elapsed current period will naturally be lower than a complete previous period.'],
    build: (scope, p) => {
      const prev = previousPeriod(p.period);
      return {
        sql: `SELECT 'Current' AS period_label, @from AS from_date, @to AS to_date, COUNT(*) AS invoices, ISNULL(SUM(s.total),0) AS sales_total
              FROM sales s WHERE ${ORG} AND ${BR} AND s.status != 'voided' AND ${DATE_RANGE}
              UNION ALL
              SELECT 'Previous', @pfrom, @pto, COUNT(*), ISNULL(SUM(s.total),0)
              FROM sales s WHERE ${ORG} AND ${BR} AND s.status != 'voided' AND s.date BETWEEN CAST(@pfrom AS DATE) AND CAST(@pto AS DATE)`,
        inputs: [...base(scope, p), ['pfrom', sql.VarChar(10), prev.from], ['pto', sql.VarChar(10), prev.to]],
      };
    },
    summarize: rows => {
      const cur = money(rows[0]?.sales_total), prev = money(rows[1]?.sales_total), diff = cur - prev;
      const pct = prev ? (diff / prev) * 100 : null;
      return {
        kpis: [{ label: 'Current', value: cur, type: 'currency' }, { label: 'Previous', value: prev, type: 'currency' }, { label: 'Change', value: diff, type: 'currency' },
               ...(pct !== null ? [{ label: 'Change %', value: pct, type: 'percent' }] : [])],
        headline: pct === null
          ? `Current sales ${fmtN(cur)}; the previous period had no sales so no % change is shown.`
          : `Sales ${diff >= 0 ? 'rose' : 'fell'} ${fmtN(Math.abs(diff))} (${pct.toFixed(1)}%) versus the previous period.`,
      };
    },
  },

  top_products: {
    title: 'Top items by revenue', domain: 'sales', classification: 'confidential_financial', metric: 'sales_invoiced',
    description: 'Items ranked by invoiced line amount.',
    params: { period: P_PERIOD('this_month'), limit: P_LIMIT(10, 100) },
    columns: [col('item', 'Item'), col('units', 'Units', 'number'), col('revenue', 'Line revenue', 'currency')],
    chart: { type: 'bar', x: 'item', y: 'revenue' },
    caveats: ['Line amounts before invoice-level discount and tax.', 'Voided invoices excluded.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) ${ITEM} AS item, SUM(si.qty) AS units, SUM(si.amount) AS revenue
            FROM sale_items si JOIN sales s ON s.id = si.sale_id
            LEFT JOIN tires t ON t.id = si.tire_id AND t.organization_id = @orgId
            LEFT JOIN products pr ON pr.id = si.product_id AND pr.organization_id = @orgId
            WHERE ${ORG} AND ${BR} AND s.status != 'voided' AND ${DATE_RANGE}
            GROUP BY ${ITEM} ORDER BY revenue DESC`,
      inputs: base(scope, p),
    }),
    summarize: rows => ({
      kpis: [{ label: 'Items listed', value: rows.length, type: 'number' }, { label: 'Revenue (listed)', value: sum(rows, 'revenue'), type: 'currency' }],
      headline: rows.length ? `Top item: ${rows[0].item} with ${fmtN(money(rows[0].revenue))}.` : 'No sales in this period.',
    }),
  },

  sales_by_branch: {
    title: 'Sales by branch', domain: 'sales', classification: 'confidential_financial', metric: 'sales_invoiced',
    description: 'Invoiced sales per branch.',
    params: { period: P_PERIOD('this_quarter'), limit: P_LIMIT(100) },
    columns: [col('branch', 'Branch'), col('invoices', 'Invoices', 'number'), col('sales_total', 'Invoiced sales', 'currency')],
    chart: { type: 'bar', x: 'branch', y: 'sales_total' },
    caveats: ['Branch users only see their own branch.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) b.name AS branch, COUNT(*) AS invoices, SUM(s.total) AS sales_total
            FROM sales s JOIN branches b ON b.id = s.branch_id AND b.organization_id = @orgId
            WHERE ${ORG} AND ${BR} AND s.status != 'voided' AND ${DATE_RANGE}
            GROUP BY b.name ORDER BY sales_total DESC`,
      inputs: base(scope, p),
    }),
    summarize: rows => ({
      kpis: [{ label: 'Branches', value: rows.length, type: 'number' }, { label: 'Invoiced sales', value: sum(rows, 'sales_total'), type: 'currency' }],
      headline: rows.length ? `${rows[0].branch} leads with ${fmtN(money(rows[0].sales_total))}.` : 'No sales in this period.',
    }),
  },

  gross_profit_by_product: {
    title: 'Estimated gross profit by item', domain: 'sales', classification: 'confidential_financial', metric: 'estimated_gross_profit',
    description: 'Line revenue less quantity x current cost price, per item.',
    params: { period: P_PERIOD('this_month'), limit: P_LIMIT(25, 200) },
    columns: [col('item', 'Item'), col('units', 'Units', 'number'), col('revenue', 'Revenue', 'currency'), col('est_cost', 'Est. cost', 'currency'), col('est_gross_profit', 'Est. gross profit', 'currency'), col('margin_pct', 'Margin %', 'percent')],
    chart: { type: 'bar', x: 'item', y: 'est_gross_profit' },
    caveats: ['ESTIMATE: uses current cost price, not the cost at time of sale.', 'Excludes operating expenses; this is not net profit.', 'Items without a cost price are costed at zero, which overstates profit.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) item, units, revenue, est_cost, revenue - est_cost AS est_gross_profit,
                   CASE WHEN revenue = 0 THEN NULL ELSE (revenue - est_cost) * 100.0 / revenue END AS margin_pct
            FROM (
              SELECT ${ITEM} AS item, SUM(si.qty) AS units, SUM(si.amount) AS revenue,
                     SUM(si.qty * ISNULL(COALESCE(t.cost_price, pr.cost_price), 0)) AS est_cost
              FROM sale_items si JOIN sales s ON s.id = si.sale_id
              LEFT JOIN tires t ON t.id = si.tire_id AND t.organization_id = @orgId
              LEFT JOIN products pr ON pr.id = si.product_id AND pr.organization_id = @orgId
              WHERE ${ORG} AND ${BR} AND s.status != 'voided' AND ${DATE_RANGE}
              GROUP BY ${ITEM}
            ) x ORDER BY est_gross_profit DESC`,
      inputs: base(scope, p),
    }),
    summarize: rows => {
      const rev = sum(rows, 'revenue'), gp = sum(rows, 'est_gross_profit');
      return {
        kpis: [{ label: 'Revenue', value: rev, type: 'currency' }, { label: 'Est. gross profit', value: gp, type: 'currency' },
               ...(rev ? [{ label: 'Est. margin', value: (gp * 100) / rev, type: 'percent' }] : [])],
        headline: `Estimated gross profit ${fmtN(gp)} on ${fmtN(rev)} revenue (estimate; see caveats).`,
      };
    },
  },

  // ── Accounts ────────────────────────────────────────────────────────────────
  customer_statement: {
    title: 'Customer account statement', domain: 'receivables', classification: 'confidential_financial', metric: 'account_balance',
    description: 'Opening balance, invoices, payments and running balance for one customer.',
    params: { period: P_PERIOD('last_90_days'), entity: { type: 'entity', kind: 'customer', required: true }, limit: P_LIMIT(500) },
    columns: [col('entry_date', 'Date', 'date'), col('entry_type', 'Type'), col('reference_no', 'Reference'), col('description', 'Description'), col('debit', 'Debit', 'currency'), col('credit', 'Credit', 'currency'), col('running_balance', 'Balance', 'currency')],
    chart: null, statement: { debitIncreases: true },
    caveats: ['Debit = invoice (customer owes); credit = payment received.', 'Matches the Ledger page statement logic: non-voided invoices and recorded payments.'],
    build: (scope, p) => ({
      sql: `WITH tx AS (
              SELECT s.date AS entry_date, 'Invoice' AS entry_type, s.invoice_no AS reference_no, 'Sales invoice' AS description,
                     s.total AS debit, CAST(0 AS DECIMAL(18,2)) AS credit, s.created_at AS sort_ts
              FROM sales s WHERE s.customer_id = @entityId AND ${ORG} AND ${BR} AND s.status != 'voided'
              UNION ALL
              SELECT sp.payment_date, 'Payment', CASE WHEN ISNULL(sp.reference_no,'') != '' THEN sp.reference_no ELSE 'RCP-' + CAST(sp.id AS NVARCHAR) END,
                     'Payment received (' + sp.payment_method + ')', CAST(0 AS DECIMAL(18,2)), sp.amount, sp.created_at
              FROM sale_payments sp WHERE sp.customer_id = @entityId AND sp.organization_id = @orgId
            )
            SELECT TOP (@rowLimit) CONVERT(VARCHAR(10), entry_date, 23) AS entry_date, entry_type, reference_no, description, debit, credit
            FROM (
              SELECT CAST(@from AS DATE) AS entry_date, 'Opening balance' AS entry_type, '' AS reference_no, 'Balance brought forward' AS description,
                     ISNULL(SUM(debit),0) AS debit, ISNULL(SUM(credit),0) AS credit, CAST('1900-01-01' AS DATETIME) AS sort_ts, 0 AS ord
              FROM tx WHERE entry_date < CAST(@from AS DATE)
              UNION ALL
              SELECT entry_date, entry_type, reference_no, description, debit, credit, sort_ts, 1 FROM tx
              WHERE entry_date BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)
            ) u ORDER BY ord, entry_date, sort_ts`,
      inputs: [...base(scope, p), ['entityId', sql.Int, p.entityId]],
    }),
  },

  supplier_statement: {
    title: 'Supplier account statement', domain: 'payables', classification: 'confidential_financial', metric: 'account_balance',
    description: 'Opening balance, purchases, payments and running balance for one supplier.',
    params: { period: P_PERIOD('last_90_days'), entity: { type: 'entity', kind: 'supplier', required: true }, limit: P_LIMIT(500) },
    columns: [col('entry_date', 'Date', 'date'), col('entry_type', 'Type'), col('reference_no', 'Reference'), col('description', 'Description'), col('debit', 'Debit', 'currency'), col('credit', 'Credit', 'currency'), col('running_balance', 'Balance', 'currency')],
    chart: null, statement: { debitIncreases: false },
    caveats: ['Credit = purchase (we owe supplier); debit = payment made.'],
    build: (scope, p) => ({
      sql: `WITH tx AS (
              SELECT pu.date AS entry_date, 'Purchase' AS entry_type, pu.po_no AS reference_no, 'Purchase order' AS description,
                     CAST(0 AS DECIMAL(18,2)) AS debit, pu.total AS credit, pu.created_at AS sort_ts
              FROM purchases pu WHERE pu.supplier_id = @entityId AND pu.organization_id = @orgId AND (@branchId IS NULL OR pu.branch_id = @branchId) AND pu.status != 'cancelled'
              UNION ALL
              SELECT pp.payment_date, 'Payment', CASE WHEN ISNULL(pp.reference_no,'') != '' THEN pp.reference_no ELSE 'PAY-' + CAST(pp.id AS NVARCHAR) END,
                     'Payment to supplier (' + pp.payment_method + ')', pp.amount, CAST(0 AS DECIMAL(18,2)), pp.created_at
              FROM purchase_payments pp WHERE pp.supplier_id = @entityId AND pp.organization_id = @orgId
            )
            SELECT TOP (@rowLimit) CONVERT(VARCHAR(10), entry_date, 23) AS entry_date, entry_type, reference_no, description, debit, credit
            FROM (
              SELECT CAST(@from AS DATE) AS entry_date, 'Opening balance' AS entry_type, '' AS reference_no, 'Balance brought forward' AS description,
                     ISNULL(SUM(debit),0) AS debit, ISNULL(SUM(credit),0) AS credit, CAST('1900-01-01' AS DATETIME) AS sort_ts, 0 AS ord
              FROM tx WHERE entry_date < CAST(@from AS DATE)
              UNION ALL
              SELECT entry_date, entry_type, reference_no, description, debit, credit, sort_ts, 1 FROM tx
              WHERE entry_date BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)
            ) u ORDER BY ord, entry_date, sort_ts`,
      inputs: [...base(scope, p), ['entityId', sql.Int, p.entityId]],
    }),
  },

  account_balance: {
    title: 'Account balance', domain: 'receivables', classification: 'confidential_financial', metric: 'account_balance',
    description: 'Current balance for one customer or supplier.',
    params: { entity: { type: 'entity', kind: 'any', required: true } },
    columns: [col('name', 'Account'), col('kind', 'Type'), col('invoiced', 'Invoiced / purchased', 'currency'), col('paid', 'Paid', 'currency'), col('balance', 'Balance', 'currency')],
    chart: null,
    caveats: ['Customer balance = invoices less payments (positive: they owe us). Supplier balance = purchases less payments (positive: we owe them).'],
    build: (scope, p) => {
      const inputs = [['orgId', sql.Int, scope.orgId], ['branchId', sql.Int, scope.branchId], ['entityId', sql.Int, p.entityId]];
      if (p.entityKind === 'supplier') {
        return {
          sql: `SELECT su.name AS name, 'Supplier' AS kind,
                       ISNULL((SELECT SUM(total) FROM purchases pu WHERE pu.supplier_id = su.id AND pu.organization_id = @orgId AND pu.status != 'cancelled' AND (@branchId IS NULL OR pu.branch_id = @branchId)),0) AS invoiced,
                       ISNULL((SELECT SUM(amount) FROM purchase_payments pp WHERE pp.supplier_id = su.id AND pp.organization_id = @orgId),0) AS paid
                FROM suppliers su WHERE su.id = @entityId AND su.organization_id = @orgId`,
          inputs,
        };
      }
      return {
        sql: `SELECT c.name AS name, 'Customer' AS kind,
                     ISNULL((SELECT SUM(total) FROM sales s WHERE s.customer_id = c.id AND s.organization_id = @orgId AND s.status != 'voided' AND ${BR}),0) AS invoiced,
                     ISNULL((SELECT SUM(amount) FROM sale_payments sp WHERE sp.customer_id = c.id AND sp.organization_id = @orgId),0) AS paid
              FROM customers c WHERE c.id = @entityId AND c.organization_id = @orgId`,
        inputs,
      };
    },
    postProcess: rows => rows.map(r => ({ ...r, balance: money(r.invoiced) - money(r.paid) })),
    summarize: rows => {
      const r = rows[0];
      if (!r) return { kpis: [], headline: 'Account not found in your scope.' };
      const owes = r.kind === 'Customer' ? 'owes us' : 'is owed by us';
      return { kpis: [{ label: 'Balance', value: r.balance, type: 'currency' }], headline: `${r.name} ${r.balance >= 0 ? owes : 'is in credit'}: ${fmtN(Math.abs(r.balance))}.` };
    },
  },

  payments_received: {
    title: 'Payments received', domain: 'receivables', classification: 'confidential_financial', metric: 'cash_received',
    description: 'Recorded customer payments, optionally for one customer.',
    params: { period: P_PERIOD('this_month'), entity: { type: 'entity', kind: 'customer', required: false }, limit: P_LIMIT(200) },
    columns: [col('payment_date', 'Date', 'date'), col('customer', 'Customer'), col('reference_no', 'Reference'), col('payment_method', 'Method'), col('amount', 'Amount', 'currency')],
    chart: null,
    caveats: ['Recorded payments only; reversals/refunds are not modelled as separate entries.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) CONVERT(VARCHAR(10), sp.payment_date, 23) AS payment_date, c.name AS customer,
                   sp.reference_no, sp.payment_method, sp.amount
            FROM sale_payments sp JOIN customers c ON c.id = sp.customer_id AND c.organization_id = @orgId
            JOIN sales s ON s.id = sp.sale_id
            WHERE sp.organization_id = @orgId AND ${BR} AND (@entityId IS NULL OR sp.customer_id = @entityId)
              AND sp.payment_date BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)
            ORDER BY sp.payment_date DESC, sp.id DESC`,
      inputs: [...base(scope, p), ['entityId', sql.Int, p.entityId ?? null]],
    }),
    summarize: rows => ({
      kpis: [{ label: 'Cash received', value: sum(rows, 'amount'), type: 'currency' }, { label: 'Payments', value: rows.length, type: 'number' }],
      headline: `${rows.length} payment(s) totalling ${fmtN(sum(rows, 'amount'))}.`,
    }),
  },

  receivables_aging: {
    title: 'Outstanding receivables and aging', domain: 'receivables', classification: 'confidential_financial', metric: 'receivable_outstanding',
    description: 'Unpaid invoice balances per customer, aged from invoice date.',
    params: { limit: P_LIMIT(200) },
    columns: [col('customer', 'Customer'), col('outstanding', 'Outstanding', 'currency'), col('age_0_30', '0-30 days', 'currency'), col('age_31_60', '31-60', 'currency'), col('age_61_90', '61-90', 'currency'), col('age_90_plus', '90+', 'currency'), col('flagged_overdue', 'Marked overdue', 'currency')],
    chart: { type: 'bar', x: 'customer', y: 'outstanding' },
    caveats: ['No due-date field exists; aging counts days since invoice date.', 'Uses invoice-level amount paid.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) c.name AS customer, SUM(o) AS outstanding,
                   SUM(CASE WHEN age <= 30 THEN o ELSE 0 END) AS age_0_30,
                   SUM(CASE WHEN age BETWEEN 31 AND 60 THEN o ELSE 0 END) AS age_31_60,
                   SUM(CASE WHEN age BETWEEN 61 AND 90 THEN o ELSE 0 END) AS age_61_90,
                   SUM(CASE WHEN age > 90 THEN o ELSE 0 END) AS age_90_plus,
                   SUM(CASE WHEN st = 'overdue' THEN o ELSE 0 END) AS flagged_overdue
            FROM (SELECT s.customer_id, s.total - ISNULL(s.amount_paid,0) AS o, DATEDIFF(DAY, s.date, GETDATE()) AS age, s.status AS st
                  FROM sales s WHERE ${ORG} AND ${BR} AND s.status NOT IN ('paid','voided') AND s.total - ISNULL(s.amount_paid,0) > 0) x
            JOIN customers c ON c.id = x.customer_id AND c.organization_id = @orgId
            GROUP BY c.name ORDER BY outstanding DESC`,
      inputs: base(scope, p),
    }),
    summarize: rows => ({
      kpis: [{ label: 'Outstanding receivables', value: sum(rows, 'outstanding'), type: 'currency' }, { label: 'Over 90 days', value: sum(rows, 'age_90_plus'), type: 'currency' }, { label: 'Customers', value: rows.length, type: 'number' }],
      headline: `${fmtN(sum(rows, 'outstanding'))} outstanding across ${rows.length} customer(s).`,
    }),
  },

  // ── Purchasing ──────────────────────────────────────────────────────────────
  purchases_by_supplier: {
    title: 'Purchases by supplier', domain: 'purchasing', classification: 'confidential_financial', metric: 'purchases_total',
    description: 'Purchase order totals per supplier.',
    params: { period: P_PERIOD('this_month'), limit: P_LIMIT(100) },
    columns: [col('supplier', 'Supplier'), col('orders', 'Orders', 'number'), col('purchased', 'Purchased', 'currency'), col('paid', 'Paid', 'currency'), col('outstanding', 'Outstanding', 'currency')],
    chart: { type: 'bar', x: 'supplier', y: 'purchased' },
    caveats: ['Cancelled purchase orders excluded.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) su.name AS supplier, COUNT(*) AS orders, SUM(pu.total) AS purchased, SUM(ISNULL(pu.amount_paid,0)) AS paid,
                   SUM(pu.total - ISNULL(pu.amount_paid,0)) AS outstanding
            FROM purchases pu JOIN suppliers su ON su.id = pu.supplier_id AND su.organization_id = @orgId
            WHERE pu.organization_id = @orgId AND (@branchId IS NULL OR pu.branch_id = @branchId) AND pu.status != 'cancelled'
              AND pu.date BETWEEN CAST(@from AS DATE) AND CAST(@to AS DATE)
            GROUP BY su.name ORDER BY purchased DESC`,
      inputs: base(scope, p),
    }),
    summarize: rows => ({
      kpis: [{ label: 'Purchased', value: sum(rows, 'purchased'), type: 'currency' }, { label: 'Outstanding', value: sum(rows, 'outstanding'), type: 'currency' }, { label: 'Suppliers', value: rows.length, type: 'number' }],
      headline: `Purchased ${fmtN(sum(rows, 'purchased'))} from ${rows.length} supplier(s).`,
    }),
  },

  supplier_unpaid: {
    title: 'Unpaid supplier invoices', domain: 'payables', classification: 'confidential_financial', metric: 'payable_outstanding',
    description: 'Purchase orders with a remaining balance.',
    params: { limit: P_LIMIT(200) },
    columns: [col('supplier', 'Supplier'), col('po_no', 'PO'), col('po_date', 'Date', 'date'), col('total', 'Total', 'currency'), col('paid', 'Paid', 'currency'), col('outstanding', 'Outstanding', 'currency'), col('age_days', 'Age (days)', 'number')],
    chart: null,
    caveats: ['Cancelled purchases excluded. Supplier payment terms are not stored, so overdue status cannot be derived.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) su.name AS supplier, pu.po_no, CONVERT(VARCHAR(10), pu.date, 23) AS po_date, pu.total,
                   ISNULL(pu.amount_paid,0) AS paid, pu.total - ISNULL(pu.amount_paid,0) AS outstanding, DATEDIFF(DAY, pu.date, GETDATE()) AS age_days
            FROM purchases pu JOIN suppliers su ON su.id = pu.supplier_id AND su.organization_id = @orgId
            WHERE pu.organization_id = @orgId AND (@branchId IS NULL OR pu.branch_id = @branchId) AND pu.status != 'cancelled'
              AND pu.total - ISNULL(pu.amount_paid,0) > 0
            ORDER BY pu.date`,
      inputs: base(scope, p),
    }),
    summarize: rows => ({
      kpis: [{ label: 'Outstanding payables', value: sum(rows, 'outstanding'), type: 'currency' }, { label: 'Open purchases', value: rows.length, type: 'number' }],
      headline: `${fmtN(sum(rows, 'outstanding'))} unpaid across ${rows.length} purchase order(s).`,
    }),
  },

  // ── Inventory ───────────────────────────────────────────────────────────────
  low_stock: {
    title: 'Items at or below reorder level', domain: 'inventory', classification: 'internal', metric: 'stock_on_hand',
    description: 'Inventory items whose stock is at or below their reorder level.',
    params: { limit: P_LIMIT(200) },
    columns: [col('item', 'Item'), col('stock', 'On hand', 'number'), col('reorder_level', 'Reorder level', 'number'), col('shortfall', 'Shortfall', 'number')],
    chart: null,
    caveats: ['Reorder levels are as configured per item; reservations and incoming orders are not netted.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) t.brand + ' ' + t.model + ' ' + t.size AS item, t.stock, t.reorder_level, t.reorder_level - t.stock AS shortfall
            FROM tires t WHERE t.organization_id = @orgId AND (@branchId IS NULL OR t.branch_id = @branchId) AND t.stock <= t.reorder_level
            ORDER BY (t.reorder_level - t.stock) DESC`,
      inputs: base(scope, p),
    }),
    summarize: rows => ({
      kpis: [{ label: 'Items to reorder', value: rows.length, type: 'number' }],
      headline: rows.length ? `${rows.length} item(s) are at or below reorder level.` : 'No items are at or below reorder level.',
    }),
  },

  slow_moving: {
    title: 'Slow-moving stock', domain: 'inventory', classification: 'confidential_financial', metric: 'capital_in_stock',
    description: 'In-stock items with no sales in the look-back window, and capital tied up.',
    params: { days: { type: 'int', default: 60, min: 7, max: 365 }, limit: P_LIMIT(200) },
    columns: [col('item', 'Item'), col('stock', 'On hand', 'number'), col('last_sale', 'Last sale', 'date'), col('capital_tied', 'Capital tied', 'currency')],
    chart: null,
    caveats: ['Capital = stock x current cost price.', 'Items never sold show no last-sale date.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) t.brand + ' ' + t.model + ' ' + t.size AS item, t.stock,
                   (SELECT CONVERT(VARCHAR(10), MAX(s.date), 23) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.tire_id = t.id AND s.status != 'voided' AND s.organization_id = @orgId) AS last_sale,
                   t.stock * t.cost_price AS capital_tied
            FROM tires t
            WHERE t.organization_id = @orgId AND (@branchId IS NULL OR t.branch_id = @branchId) AND t.stock > 0
              AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                              WHERE si.tire_id = t.id AND s.organization_id = @orgId AND s.status != 'voided' AND s.date >= DATEADD(DAY, -@days, CAST(GETDATE() AS DATE)))
            ORDER BY capital_tied DESC`,
      inputs: [...base(scope, p), ['days', sql.Int, p.days]],
    }),
    summarize: rows => ({
      kpis: [{ label: 'Items', value: rows.length, type: 'number' }, { label: 'Capital tied', value: sum(rows, 'capital_tied'), type: 'currency' }],
      headline: `${rows.length} item(s) with no sales in the window hold ${fmtN(sum(rows, 'capital_tied'))} of stock at cost.`,
    }),
  },

  stock_depletion: {
    title: 'Projected stock depletion (estimate)', domain: 'inventory', classification: 'internal', metric: 'projected_depletion',
    description: 'Items projected to run out before the end of the month, from trailing sales.',
    params: { days: { type: 'int', default: 30, min: 14, max: 180 }, limit: P_LIMIT(200) },
    columns: [col('item', 'Item'), col('stock', 'On hand', 'number'), col('daily_demand', 'Avg daily units', 'number'), col('est_demand_to_month_end', 'Est. demand to month end', 'number'), col('est_stockout_date', 'Est. stockout', 'date'), col('confidence', 'Confidence')],
    chart: null,
    caveats: ['ESTIMATE from trailing average daily sales; not a confirmed stockout date.', 'Open purchase orders, reservations and seasonality are not included.', 'Confidence is low when few sales lines support the average.'],
    build: (scope, p) => ({
      sql: `SELECT TOP (@rowLimit) item, stock, daily_demand,
                   daily_demand * rem_days AS est_demand_to_month_end,
                   CONVERT(VARCHAR(10), DATEADD(DAY, CAST(stock / daily_demand AS INT), CAST(GETDATE() AS DATE)), 23) AS est_stockout_date,
                   CASE WHEN sale_lines >= 10 THEN 'medium' WHEN sale_lines >= 3 THEN 'low' ELSE 'very low' END AS confidence
            FROM (
              SELECT t.brand + ' ' + t.model + ' ' + t.size AS item, t.stock,
                     CAST(SUM(si.qty) AS DECIMAL(18,4)) / @days AS daily_demand, COUNT(*) AS sale_lines,
                     DATEDIFF(DAY, CAST(GETDATE() AS DATE), EOMONTH(GETDATE())) + 1 AS rem_days
              FROM tires t JOIN sale_items si ON si.tire_id = t.id JOIN sales s ON s.id = si.sale_id AND s.organization_id = @orgId
              WHERE t.organization_id = @orgId AND (@branchId IS NULL OR t.branch_id = @branchId) AND s.status != 'voided'
                AND s.date >= DATEADD(DAY, -@days, CAST(GETDATE() AS DATE))
              GROUP BY t.id, t.brand, t.model, t.size, t.stock
            ) d
            WHERE daily_demand > 0 AND stock / daily_demand <= rem_days
            ORDER BY stock / daily_demand`,
      inputs: [...base(scope, p), ['days', sql.Int, p.days]],
    }),
    summarize: rows => ({
      kpis: [{ label: 'Items at risk', value: rows.length, type: 'number' }],
      headline: rows.length
        ? `${rows.length} item(s) are projected to run out before month end (estimate).`
        : 'No items are projected to run out before month end based on recent sales.',
    }),
  },
};

// Questions the engine recognises but cannot answer because the data is not modelled.
const UNSUPPORTED = [
  { match: /expir|best[- ]before|shelf life/i, reason: 'Expiry dates are not tracked in the current data model.' },
  { match: /lead time|replenishment time/i, reason: 'Supplier lead times are not recorded (no order-to-receipt timestamps).' },
  { match: /fulfil|dispatch|awaiting delivery/i, reason: 'Order dispatch and fulfilment stages are not tracked.' },
  { match: /discrepanc|shrink|damaged/i, reason: 'Stock count discrepancies and damages are not recorded.' },
  { match: /return rate|returns?\b/i, reason: 'Sales returns are not modelled separately.' },
  { match: /cash position|bank balance/i, reason: 'No bank/cash accounts are recorded, so cash position cannot be calculated.' },
  { match: /net profit|operating expense|expenses?\b/i, reason: 'Expenses are not recorded, so net profit and expense trends cannot be calculated. Gross profit by item is available as an estimate.' },
];

module.exports = { REPORTS, UNSUPPORTED, PERIODS };
