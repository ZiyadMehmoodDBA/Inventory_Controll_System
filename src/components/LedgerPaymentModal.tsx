import { useState, useEffect } from 'react';
import { X, CreditCard, CheckCircle2, Loader2, DollarSign, ChevronDown } from 'lucide-react';
import { api } from '../api/client';
import ErrorBanner from './ErrorBanner';
import { formatCurrency, formatDate } from '../lib/utils';
import { usePaymentForm, PAYMENT_METHODS } from '../lib/usePaymentForm';

interface LedgerPaymentModalProps {
  entity: { id: number; name: string; code: string };
  type: 'customer' | 'supplier';
  onClose: () => void;
  onPaymentRecorded: () => void; // caller reloads the statement
}

interface UnpaidDoc {
  id: number;
  ref_no: string;
  date: string;
  total: number;
  amount_paid: number;
  balance_due: number;
  status: string;
}

export default function LedgerPaymentModal({ entity, type, onClose, onPaymentRecorded }: LedgerPaymentModalProps) {
  const isCustomer = type === 'customer';

  const [docs,        setDocs]        = useState<UnpaidDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError,   setDocsError]   = useState('');

  const [selectedId,  setSelectedId]  = useState<number | ''>('');
  const { amount, setAmount, paymentDate, setPaymentDate, method, setMethod, referenceNo, setReferenceNo, notes, setNotes, loading, setLoading, error, setError, success, setSuccess } = usePaymentForm('');

  useEffect(() => {
    (async () => {
      setDocsLoading(true); setDocsError('');
      try {
        const data = isCustomer
          ? await api.ledger.unpaidInvoices(entity.id)
          : await api.ledger.unpaidPOs(entity.id);
        setDocs(data);
        // Auto-select first if only one
        if (data.length === 1) {
          setSelectedId(data[0].id);
          setAmount(String(parseFloat(data[0].balance_due.toFixed(2))));
        }
      } catch (e: any) {
        setDocsError(e.message);
      } finally {
        setDocsLoading(false);
      }
    })();
  }, [entity.id, isCustomer]);

  const selectedDoc = docs.find(d => d.id === selectedId);

  const handleDocChange = (id: number | '') => {
    setSelectedId(id);
    if (id !== '') {
      const doc = docs.find(d => d.id === id);
      if (doc) setAmount(String(parseFloat(doc.balance_due.toFixed(2))));
    } else {
      setAmount('');
    }
    setError('');
  };

  const amountNum  = parseFloat(amount) || 0;
  const balanceDue = selectedDoc ? Number(selectedDoc.balance_due) : 0;
  const newBalance = parseFloat((balanceDue - amountNum).toFixed(2));
  const willBeFull = amountNum >= balanceDue - 0.005;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedId) { setError('Please select an invoice'); return; }
    if (!amountNum || amountNum <= 0) { setError('Please enter a valid amount'); return; }
    if (amountNum > balanceDue + 0.01) {
      setError(`Amount exceeds balance due (${formatCurrency(balanceDue)})`); return;
    }
    setError(''); setLoading(true);
    try {
      if (isCustomer) {
        await api.payments.recordSalePayment({
          sale_id:        selectedId,
          amount:         amountNum,
          payment_date:   paymentDate,
          payment_method: method,
          reference_no:   referenceNo,
          notes,
        });
      } else {
        await api.payments.recordPurchasePayment({
          purchase_id:    selectedId,
          amount:         amountNum,
          payment_date:   paymentDate,
          payment_method: method,
          reference_no:   referenceNo,
          notes,
        });
      }
      setSuccess(`Payment of ${formatCurrency(amountNum)} recorded against ${selectedDoc?.ref_no}.`);
      onPaymentRecorded();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const accentCls = isCustomer ? 'ring-teal-500' : 'ring-violet-500';
  const btnCls    = isCustomer
    ? 'bg-teal-600 hover:bg-teal-700'
    : 'bg-teal-600 hover:bg-teal-700';
  const iconBgCls = isCustomer ? 'bg-teal-50' : 'bg-teal-50';
  const iconCls   = isCustomer ? 'text-teal-600' : 'text-teal-600';

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 ${iconBgCls} rounded-xl flex items-center justify-center`}>
              <CreditCard size={18} className={iconCls} />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                Record {isCustomer ? 'Payment Received' : 'Payment Made'}
              </h2>
              <p className="text-xs text-slate-400">{entity.name} · {entity.code}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={16} className="text-slate-500" />
          </button>
        </div>

        <div className="p-5">
          {docsLoading ? (
            <div className="flex items-center justify-center h-24 gap-2 text-slate-400">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Loading unpaid {isCustomer ? 'invoices' : 'purchase orders'}…</span>
            </div>
          ) : docsError ? (
            <ErrorBanner error={docsError} />
          ) : docs.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-24 text-slate-400 gap-2">
              <CheckCircle2 size={24} className="text-emerald-400" />
              <p className="text-sm font-medium text-slate-600">No outstanding balance</p>
              <p className="text-xs">All {isCustomer ? 'invoices' : 'purchase orders'} are fully paid.</p>
            </div>
          ) : success ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-700">
                <CheckCircle2 size={15} className="flex-shrink-0" /><span>{success}</span>
              </div>
              <button onClick={onClose}
                className={`w-full py-2.5 text-sm font-semibold text-white ${btnCls} rounded-xl transition-colors`}>
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <ErrorBanner error={error} />

              {/* Invoice / PO selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  {isCustomer ? 'Invoice' : 'Purchase Order'} <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <select
                    value={selectedId}
                    onChange={e => handleDocChange(e.target.value === '' ? '' : Number(e.target.value))}
                    className={`w-full appearance-none px-3 py-2.5 pr-8 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 ${accentCls} bg-white`}
                    required
                  >
                    <option value="">Select {isCustomer ? 'invoice' : 'purchase order'}…</option>
                    {docs.map(doc => (
                      <option key={doc.id} value={doc.id}>
                        {doc.ref_no} — {formatDate(doc.date)} — Balance: {formatCurrency(Number(doc.balance_due))}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                </div>

                {/* Selected doc summary */}
                {selectedDoc && (
                  <div className="mt-2 bg-slate-50 rounded-xl px-3 py-2.5 grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">Total</p>
                      <p className="text-xs font-bold text-slate-800 mt-0.5">{formatCurrency(Number(selectedDoc.total))}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">Paid</p>
                      <p className="text-xs font-bold text-emerald-600 mt-0.5">{formatCurrency(Number(selectedDoc.amount_paid))}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wide">Balance</p>
                      <p className="text-xs font-bold text-amber-600 mt-0.5">{formatCurrency(Number(selectedDoc.balance_due))}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Amount */}
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Amount <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-semibold">PKR</span>
                  <input
                    type="number" step="0.01" min="0.01"
                    value={amount}
                    onChange={e => { setAmount(e.target.value); setError(''); }}
                    placeholder={selectedDoc ? String(parseFloat(selectedDoc.balance_due.toFixed(2))) : '0.00'}
                    className={`w-full pl-12 pr-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 ${accentCls}`}
                    required
                  />
                </div>
                {amountNum > 0 && selectedDoc && (
                  <div className={`mt-1.5 text-xs px-2 py-1 rounded-lg inline-flex items-center gap-1 ${
                    willBeFull ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'
                  }`}>
                    <DollarSign size={10} />
                    {willBeFull
                      ? `${isCustomer ? 'Invoice' : 'PO'} fully paid`
                      : `Remaining: ${formatCurrency(Math.max(0, newBalance))}`}
                  </div>
                )}
              </div>

              {/* Date + Method */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Date</label>
                  <input
                    type="date" value={paymentDate}
                    onChange={e => setPaymentDate(e.target.value)}
                    className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 ${accentCls}`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Method</label>
                  <select
                    value={method} onChange={e => setMethod(e.target.value)}
                    className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 ${accentCls} bg-white`}
                  >
                    {PAYMENT_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Reference / Cheque No. <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  type="text" value={referenceNo} onChange={e => setReferenceNo(e.target.value)}
                  placeholder="e.g. CHQ-12345 or TXN-9876"
                  className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 ${accentCls}`}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Notes <span className="text-slate-400 font-normal">(optional)</span></label>
                <input
                  type="text" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Any additional notes…"
                  className={`w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 ${accentCls}`}
                />
              </div>

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={onClose}
                  className="flex-1 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={loading}
                  className={`flex-1 py-2.5 text-sm font-semibold text-white ${btnCls} rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2`}>
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
                  {loading ? 'Recording…' : 'Record Payment'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
