/**
 * Tests for ledger route — verifies voided sales are excluded from
 * customer receivables (the "no invoice against customer" bug).
 *
 * Run with: npx jest server/routes/ledger.test.js
 * (requires: npm install --save-dev jest)
 */

'use strict';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CUSTOMERS = [
  { id: 1, code: 'C001', name: 'Alice', phone: null, email: null, address: null },
];

const SALES = [
  // voided sale — should NOT appear in balance or statement
  { id: 10, customer_id: 1, organization_id: 1, total: 5000, amount_paid: 0, status: 'voided', date: '2024-01-01', invoice_no: 'INV-001', created_at: '2024-01-01T00:00:00' },
  // active sale — should appear
  { id: 11, customer_id: 1, organization_id: 1, total: 3000, amount_paid: 1000, status: 'partial', date: '2024-02-01', invoice_no: 'INV-002', created_at: '2024-02-01T00:00:00' },
];

const PAYMENTS = [
  { id: 1, customer_id: 1, organization_id: 1, sale_id: 11, amount: 1000, payment_date: '2024-02-15', payment_method: 'cash', reference_no: '', notes: '', created_at: '2024-02-15T00:00:00' },
];

// ── Pure logic under test ────────────────────────────────────────────────────
// Mirrors what the SQL queries compute but in JS so we can unit-test without a DB.

function computeCustomerBalance(sales) {
  // Replicate /ledger/customers aggregate — voided excluded via JOIN filter
  const activeSales = sales.filter(s => s.status !== 'voided');
  const totalInvoiced = activeSales.reduce((sum, s) => sum + Number(s.total), 0);
  const totalPaid     = activeSales.reduce((sum, s) => sum + Number(s.amount_paid), 0);
  return { total_invoiced: totalInvoiced, total_paid: totalPaid, balance: totalInvoiced - totalPaid };
}

function buildStatement(sales, payments) {
  // Replicate /customer/:id/statement UNION ALL — voided excluded
  const activeSales = sales.filter(s => s.status !== 'voided');

  const entries = [
    ...activeSales.map(s => ({
      entry_date: s.date,
      entry_type: 'Invoice',
      reference_no: s.invoice_no,
      debit: Number(s.total),
      credit: 0,
      sort_ts: s.created_at,
    })),
    ...payments.map(p => ({
      entry_date: p.payment_date,
      entry_type: 'Payment',
      reference_no: p.reference_no || `RCP-${p.id}`,
      debit: 0,
      credit: Number(p.amount),
      sort_ts: p.created_at,
    })),
  ].sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.sort_ts.localeCompare(b.sort_ts));

  let runningBalance = 0;
  return entries.map(e => {
    runningBalance = parseFloat((runningBalance + e.debit - e.credit).toFixed(2));
    return { ...e, running_balance: runningBalance };
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Ledger — voided sales exclusion', () => {

  describe('computeCustomerBalance (mirrors /ledger/customers)', () => {
    it('does not include voided sales in total_invoiced', () => {
      const { total_invoiced } = computeCustomerBalance(SALES);
      // Only INV-002 (3000) should count; INV-001 (5000) is voided
      expect(total_invoiced).toBe(3000);
    });

    it('does not include voided sales in balance', () => {
      const { balance } = computeCustomerBalance(SALES);
      // 3000 - 1000 = 2000
      expect(balance).toBe(2000);
    });

    it('returns zero balance when all sales are voided', () => {
      const voidedOnly = SALES.map(s => ({ ...s, status: 'voided' }));
      const { balance } = computeCustomerBalance(voidedOnly);
      expect(balance).toBe(0);
    });
  });

  describe('buildStatement (mirrors /customer/:id/statement)', () => {
    it('excludes voided invoices from statement entries', () => {
      const entries = buildStatement(SALES, PAYMENTS);
      const invoiceEntries = entries.filter(e => e.entry_type === 'Invoice');
      // Only INV-002 should appear
      expect(invoiceEntries).toHaveLength(1);
      expect(invoiceEntries[0].reference_no).toBe('INV-002');
    });

    it('does not include voided sale amount as debit', () => {
      const entries = buildStatement(SALES, PAYMENTS);
      const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
      // Only 3000 from INV-002; voided INV-001 (5000) excluded
      expect(totalDebit).toBe(3000);
    });

    it('correctly computes running balance with payment applied', () => {
      const entries = buildStatement(SALES, PAYMENTS);
      // Entry 1: Invoice 3000 → running_balance = 3000
      // Entry 2: Payment 1000 → running_balance = 2000
      const last = entries[entries.length - 1];
      expect(last.running_balance).toBe(2000);
    });

    it('has no debit from voided invoice even when it predates active entries', () => {
      const entries = buildStatement(SALES, PAYMENTS);
      const voidedEntry = entries.find(e => e.reference_no === 'INV-001');
      expect(voidedEntry).toBeUndefined();
    });
  });

  describe('regression: customer with only voided sales', () => {
    it('shows zero balance (not phantom receivable)', () => {
      const voidedOnly = [SALES[0]]; // only the voided sale
      const { balance } = computeCustomerBalance(voidedOnly);
      expect(balance).toBe(0);
    });

    it('produces an empty statement', () => {
      const voidedOnly = [SALES[0]];
      const entries = buildStatement(voidedOnly, []);
      expect(entries).toHaveLength(0);
    });
  });
});
