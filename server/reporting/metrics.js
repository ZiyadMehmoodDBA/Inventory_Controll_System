// Approved metric definitions. Reports reference these by id; they are also synced to metric_definitions.
const METRICS = [
  { id: 'sales_invoiced', name: 'Invoiced sales', basis: 'sales activity',
    definition: 'Sum of invoice totals (net of invoice discounts, including tax) for non-voided invoices dated within the period. This is sales activity, not audited accounting revenue.' },
  { id: 'cash_received', name: 'Cash received', basis: 'recorded payments',
    definition: 'Sum of recorded customer payments (sale_payments) with payment date in the period.' },
  { id: 'account_balance', name: 'Account balance', basis: 'invoices less payments',
    definition: 'Customer: non-voided invoice totals minus recorded payments. Supplier: non-cancelled purchase totals minus recorded payments.' },
  { id: 'receivable_outstanding', name: 'Outstanding receivable', basis: 'invoice level',
    definition: 'Invoice total minus amount paid for non-voided, unpaid or part-paid invoices. Aged from invoice date (no due-date field exists).' },
  { id: 'estimated_gross_profit', name: 'Estimated gross profit', basis: 'estimate - current cost',
    definition: 'Sale item amount minus quantity x current item cost price. Uses current, not historical, cost; not a recognised accounting margin.' },
  { id: 'stock_on_hand', name: 'Stock on hand', basis: 'inventory records',
    definition: "Current recorded stock quantity per item for the user's branch scope. Reservations are not tracked." },
  { id: 'projected_depletion', name: 'Projected depletion', basis: 'estimate - trailing average',
    definition: 'Stock on hand divided by average daily units sold over the look-back window. Ignores seasonality, open purchase orders and reservations.' },
  { id: 'capital_in_stock', name: 'Capital tied in stock', basis: 'stock x cost price',
    definition: 'Stock on hand multiplied by current cost price.' },
  { id: 'purchases_total', name: 'Purchases', basis: 'purchase orders',
    definition: 'Sum of non-cancelled purchase order totals dated within the period.' },
  { id: 'payable_outstanding', name: 'Outstanding payable', basis: 'purchase level',
    definition: 'Purchase total minus amount paid for non-cancelled purchases with a remaining balance.' },
];

module.exports = { METRICS };
