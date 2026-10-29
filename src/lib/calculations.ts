/** Summarise a sales array (excludes voided entries for totals). */
export function calcSaleSummary(sales: any[]) {
  const active = sales.filter(s => s.status !== 'voided');
  const total     = active.reduce((sum, s) => sum + Number(s.total), 0);
  const collected = active.reduce((sum, s) => sum + Number(s.amount_paid || 0), 0);
  const pending   = active.reduce((sum, s) => sum + Math.max(0, Number(s.total) - Number(s.amount_paid || 0)), 0);
  return { total, collected, pending, count: active.length };
}

/** Summarise a purchases array. */
export function calcPurchaseSummary(purchases: any[]) {
  const totalPurchased   = purchases.reduce((s, p) => s + Number(p.total), 0);
  const totalPaid        = purchases.reduce((s, p) => s + Number(p.amount_paid || 0), 0);
  const totalOutstanding = parseFloat((totalPurchased - totalPaid).toFixed(2));
  const pendingDelivery  = purchases
    .filter(p => p.status === 'pending')
    .reduce((s, p) => s + Number(p.total), 0);
  return { totalPurchased, totalPaid, totalOutstanding, pendingDelivery };
}

/** Summarise customers or suppliers (all share the same financial fields). */
export function calcContactSummary(contacts: any[]) {
  const totalInvoiced = contacts.reduce((s, c) => s + Number(c.total_invoiced || 0), 0);
  const totalPaid     = contacts.reduce((s, c) => s + Number(c.total_paid     || 0), 0);
  const totalBalance  = contacts.reduce((s, c) => s + Number(c.balance_due    || 0), 0);
  return { totalInvoiced, totalPaid, totalBalance };
}

/** Payment progress percentage (0–100), safe for invoiced=0. */
export function calcPaymentPct(invoiced: number, paid: number): number {
  return invoiced > 0 ? Math.min(100, Math.round((paid / invoiced) * 100)) : 100;
}
