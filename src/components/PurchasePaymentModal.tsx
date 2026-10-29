import { X, CreditCard, DollarSign, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency } from '../lib/utils';
import { usePaymentForm, PAYMENT_METHODS } from '../lib/usePaymentForm';
import ErrorBanner from './ErrorBanner';

interface PurchasePaymentModalProps {
  po: {
    id: number;
    po_no: string;
    supplier_name: string;
    total: number;
    amount_paid?: number;
    status: string;
    date: string;
  };
  onClose: () => void;
  onPaymentRecorded: (updated: any) => void;
}

export default function PurchasePaymentModal({ po, onClose, onPaymentRecorded }: PurchasePaymentModalProps) {
  const totalAmt   = Number(po.total);
  const paidAmt    = Number(po.amount_paid || 0);
  const balanceDue = parseFloat((totalAmt - paidAmt).toFixed(2));

  const { amount, setAmount, paymentDate, setPaymentDate, method, setMethod, referenceNo, setReferenceNo, notes, setNotes, loading, setLoading, error, setError, success, setSuccess } = usePaymentForm(balanceDue > 0 ? String(balanceDue) : '');

  const amountNum  = parseFloat(amount) || 0;
  const newTotal   = parseFloat((paidAmt + amountNum).toFixed(2));
  const newBalance = parseFloat((totalAmt - newTotal).toFixed(2));
  const willBeFull = newTotal >= totalAmt;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amountNum || amountNum <= 0) { setError('Please enter a valid amount'); return; }
    if (amountNum > balanceDue + 0.01) { setError(`Amount cannot exceed the balance due (${formatCurrency(balanceDue)})`); return; }
    setError(''); setLoading(true);
    try {
      const result = await api.payments.recordPurchasePayment({
        purchase_id:    po.id,
        amount:         amountNum,
        payment_date:   paymentDate,
        payment_method: method,
        reference_no:   referenceNo,
        notes,
      });
      setSuccess(`Payment of ${formatCurrency(amountNum)} recorded successfully.`);
      onPaymentRecorded(result);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-teal-50 rounded-xl flex items-center justify-center">
              <CreditCard size={18} className="text-teal-600" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">Record Payment</h2>
              <p className="text-xs text-slate-400">{po.po_no}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={16} className="text-slate-500" />
          </button>
        </div>

        {/* PO Summary */}
        <div className="mx-5 mt-4 bg-slate-50 rounded-xl p-3.5 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Supplier</span>
            <span className="font-semibold text-slate-900">{po.supplier_name}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">PO Total</span>
            <span className="font-semibold text-slate-900">{formatCurrency(totalAmt)}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-500">Already Paid</span>
            <span className="font-semibold text-emerald-600">{formatCurrency(paidAmt)}</span>
          </div>
          <div className="flex justify-between text-xs border-t border-slate-200 pt-2">
            <span className="text-slate-700 font-semibold">Balance Due</span>
            <span className={`font-bold text-sm ${balanceDue > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {formatCurrency(Math.max(0, balanceDue))}
            </span>
          </div>
        </div>

        {/* Success */}
        {success && (
          <div className="mx-5 mt-4 flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-700">
            <CheckCircle2 size={15} className="flex-shrink-0" /><span>{success}</span>
          </div>
        )}

        {/* Form */}
        {!success && (
          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <ErrorBanner error={error} />

            {/* Amount */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Payment Amount <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs font-semibold">PKR</span>
                <input
                  type="number" step="0.01" min="0.01"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder={String(balanceDue)}
                  className="w-full pl-12 pr-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500"
                  required
                />
              </div>
              {amountNum > 0 && (
                <div className={`mt-1.5 text-xs px-2 py-1 rounded-lg inline-flex items-center gap-1 ${
                  willBeFull ? 'bg-emerald-50 text-emerald-700' : 'bg-blue-50 text-blue-700'
                }`}>
                  <DollarSign size={11} />
                  {willBeFull
                    ? 'PO will be fully paid'
                    : `Balance remaining: ${formatCurrency(newBalance)}`}
                </div>
              )}
            </div>

            {/* Date + Method */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Payment Date</label>
                <input
                  type="date" value={paymentDate}
                  onChange={e => setPaymentDate(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Payment Method</label>
                <select
                  value={method} onChange={e => setMethod(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
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
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Notes <span className="text-slate-400 font-normal">(optional)</span></label>
              <input
                type="text" value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Any additional notes..."
                className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
            </div>

            <div className="flex gap-3 pt-1">
              <button type="button" onClick={onClose}
                className="flex-1 py-2.5 text-sm font-medium text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={loading}
                className="flex-1 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
                {loading ? <Loader2 size={14} className="animate-spin" /> : <CreditCard size={14} />}
                {loading ? 'Recording...' : 'Record Payment'}
              </button>
            </div>
          </form>
        )}

        {success && (
          <div className="px-5 pb-5">
            <button onClick={onClose}
              className="w-full py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
