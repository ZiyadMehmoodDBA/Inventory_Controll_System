import { X, Printer, Download } from 'lucide-react';
import { formatCurrency, formatDate } from '../lib/utils';
import { printInvoice, downloadInvoice } from '../lib/invoicePdf';
import { getCachedSettings } from '../lib/appSettings';

interface InvoiceViewModalProps {
  sale: any;
  onClose: () => void;
}

const statusColor: Record<string, string> = {
  paid:    'bg-emerald-50 text-emerald-700 border border-emerald-200',
  pending: 'bg-amber-50  text-amber-700  border border-amber-200',
  overdue: 'bg-red-50    text-red-700    border border-red-200',
};

export default function InvoiceViewModal({ sale, onClose }: InvoiceViewModalProps) {
  if (!sale) return null;

  const s     = getCachedSettings();
  const items = sale.items || [];

  // Build abbreviation from company name (up to 2 initials)
  const initials = s.company_name
    .split(/\s+/)
    .slice(0, 2)
    .map((w: string) => w[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">

        {/* Modal header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <h2 className="text-base font-bold text-slate-900">Invoice — {sale.invoice_no}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => printInvoice(sale)}
              className="flex items-center gap-1.5 text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors"
            >
              <Printer size={14} /> Print
            </button>
            <button
              onClick={() => downloadInvoice(sale)}
              className="flex items-center gap-1.5 text-sm text-white bg-teal-600 hover:bg-teal-700 px-3 py-1.5 rounded-lg transition-colors"
            >
              <Download size={14} /> Download PDF
            </button>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
              <X size={16} className="text-slate-500" />
            </button>
          </div>
        </div>

        {/* Invoice body */}
        <div className="overflow-y-auto flex-1 p-6 sm:p-8">
          <div className="max-w-xl mx-auto">

            {/* Company + Invoice info */}
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-6">
              <div>
                <div className="flex items-center gap-2.5 mb-2">
                  <div className="w-10 h-10 bg-teal-600 rounded-xl flex items-center justify-center flex-shrink-0">
                    <span className="text-white font-bold text-sm">{initials}</span>
                  </div>
                  <div>
                    <p className="text-base font-bold text-slate-900 leading-tight">{s.company_name}</p>
                    {s.company_tagline && <p className="text-xs text-slate-500">{s.company_tagline}</p>}
                  </div>
                </div>
                {s.company_address && (
                  <p className="text-xs text-slate-500 mt-1">{s.company_address}</p>
                )}
                {(s.company_email || s.company_phone) && (
                  <p className="text-xs text-slate-500">
                    {[s.company_email, s.company_phone].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>

              <div className="sm:text-right">
                <p className="text-2xl font-bold text-slate-200 uppercase tracking-widest">Invoice</p>
                <p className="text-base font-bold text-teal-600 mt-1">{sale.invoice_no}</p>
                <p className="text-xs text-slate-500 mt-1">Date: {formatDate(sale.date)}</p>
                <span className={`inline-block mt-2 text-xs font-semibold px-2.5 py-1 rounded-full ${statusColor[sale.status] ?? ''}`}>
                  {(sale.status || '').toUpperCase()}
                </span>
              </div>
            </div>

            {/* Bill to */}
            <div className="bg-slate-50 rounded-xl p-4 mb-5">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Bill To</p>
              <p className="text-sm font-bold text-slate-900">{sale.customer_name || 'N/A'}</p>
              {sale.customer_phone   && <p className="text-xs text-slate-500 mt-0.5">{sale.customer_phone}</p>}
              {sale.customer_address && <p className="text-xs text-slate-500">{sale.customer_address}</p>}
            </div>

            {/* Items table */}
            <div className="overflow-x-auto mb-5">
              <table className="w-full min-w-[380px]">
                <thead>
                  <tr className="bg-teal-600 text-white">
                    <th className="text-xs font-semibold text-left px-3 py-2.5 rounded-l-lg">#</th>
                    <th className="text-xs font-semibold text-left px-3 py-2.5">Description</th>
                    <th className="text-xs font-semibold text-center px-3 py-2.5">Qty</th>
                    <th className="text-xs font-semibold text-right px-3 py-2.5">Unit Price</th>
                    <th className="text-xs font-semibold text-right px-3 py-2.5 rounded-r-lg">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item: any, i: number) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5 text-xs text-slate-500">{i + 1}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-900">{item.tire_name || item.tire}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-700 text-center">{item.qty}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-700 text-right">
                        {formatCurrency(item.unit_price ?? item.price ?? 0)}
                      </td>
                      <td className="px-3 py-2.5 text-sm font-semibold text-slate-900 text-right">
                        {formatCurrency(item.amount ?? (item.qty * (item.unit_price ?? item.price ?? 0)))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-56 space-y-2">
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Subtotal</span>
                  <span>{formatCurrency(sale.subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Tax ({s.default_tax_rate}%)</span>
                  <span>{formatCurrency(sale.tax)}</span>
                </div>
                <div className="flex justify-between text-base font-bold pt-2 border-t-2 border-slate-200">
                  <span className="text-slate-900">Total</span>
                  <span className="text-teal-600">{formatCurrency(sale.total)}</span>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-8 pt-5 border-t border-slate-100 text-center text-xs text-slate-400">
              Thank you for your business · Payment due within {s.payment_due_days} days · {s.company_name}
              {s.company_tagline ? ` — ${s.company_tagline}` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
