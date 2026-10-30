// Walk-in (no customer) sales now keep their payments like every other sale, so cash collected at the counter is traceable per payment and
// per method. sale_payments.customer_id becomes optional; there is still no receivable and no customer ledger entry for a walk-in.
exports.description = 'sale_payments.customer_id nullable; backfill payments of past walk-in sales';

exports.up = async (tx, sql) => {
  const run = s => new sql.Request(tx).batch(s);
  await run(`ALTER TABLE sale_payments ALTER COLUMN customer_id INT NULL`);

  // Past walk-in sales have an amount paid but no payment rows. One row per sale carries it (a split cash/card tender was never stored
  // separately, so it is recorded under the method the sale used). Voided sales are left alone.
  await run(`
    INSERT INTO sale_payments (sale_id, customer_id, organization_id, branch_id, amount, payment_date, payment_method, reference_no, notes)
    SELECT s.id, NULL, s.organization_id, s.branch_id, s.amount_paid, s.date, ISNULL(NULLIF(s.payment_method, ''), 'cash'), '', 'Recorded from the sale (walk-in, before payments were kept)'
    FROM sales s
    WHERE s.customer_id IS NULL AND s.status <> 'voided' AND ISNULL(s.amount_paid, 0) > 0
      AND NOT EXISTS (SELECT 1 FROM sale_payments p WHERE p.sale_id = s.id)`);
};
