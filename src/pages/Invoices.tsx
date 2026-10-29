import { useState, useEffect, useCallback, useRef } from 'react';
import { Search, Printer, Download, Eye, Plus, ArrowLeft, RefreshCw, AlertCircle, Loader2, FileSpreadsheet } from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency, formatDate } from '../lib/utils';
import { printInvoice, downloadInvoice } from '../lib/invoicePdf';
import NewSaleModal from '../components/NewSaleModal';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { getCachedSettings } from '../lib/appSettings';
import { usePagination } from '../lib/usePagination';
import Pagination from '../components/Pagination';
import ExcelImportModal from '../components/ExcelImportModal';
import EmptyState from '../components/EmptyState';

const statusColor: Record<string, string> = {
  paid:    'bg-emerald-50 text-emerald-700',
  pending: 'bg-amber-50 text-amber-700',
  overdue: 'bg-red-50 text-red-700',
};

export default function Invoices() {
  const [sales, setSales]         = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoaded = useRef(false);
  const [error, setError]         = useState('');
  const [search, setSearch]       = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail]       = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<'print' | 'download' | null>(null);
  const [mobileView, setMobileView] = useState<'list' | 'preview'>('list');
  const [showNewSale, setShowNewSale] = useState(false);
  const [showImport, setShowImport]   = useState(false);

  const fetchSales = useCallback(async () => {
    if (!hasLoaded.current) setLoading(true);
    setRefreshing(true); setError('');
    try { setSales(await api.sales.list()); hasLoaded.current = true; }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useAutoRefresh(fetchSales);
  useEffect(() => { fetchSales(); }, [fetchSales]);

  const handleSelect = async (id: number) => {
    setSelectedId(id);
    setMobileView('preview');
    setDetail(null);
    setDetailLoading(true);
    try { setDetail(await api.sales.get(id)); }
    catch (e: any) { setError(e.message); }
    finally { setDetailLoading(false); }
  };

  const handlePrint = async () => {
    if (!detail) return;
    setActionLoading('print');
    try { await printInvoice(detail); }
    finally { setActionLoading(null); }
  };

  const handleDownload = async () => {
    if (!detail) return;
    setActionLoading('download');
    try { await downloadInvoice(detail); }
    finally { setActionLoading(null); }
  };

  const filtered = sales.filter(s =>
    (s.customer_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (s.invoice_no    || '').toLowerCase().includes(search.toLowerCase())
  );
  const { paged, paginationProps } = usePagination(filtered);

  return (
    <div className="p-4 sm:p-6 h-full">
      <div className="flex flex-col xl:flex-row gap-4 sm:gap-5" style={{ minHeight: 'calc(100vh - 140px)' }}>

        {/* Invoice List — hidden on mobile when preview is open */}
        <div className={`bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col xl:w-80 flex-shrink-0 ${mobileView === 'preview' ? 'hidden xl:flex' : 'flex'}`}>
          <div className="p-4 border-b border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm sm:text-base font-bold text-slate-900">Invoices</h3>
              <div className="flex items-center gap-1.5">
                <button onClick={fetchSales} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                  <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
                </button>
                <button
                  onClick={() => setShowImport(true)}
                  title="Import invoices from Excel"
                  className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <FileSpreadsheet size={14} />
                </button>
                <button
                  onClick={() => setShowNewSale(true)}
                  className="flex items-center gap-1 bg-teal-600 text-white text-xs font-medium px-2.5 py-1.5 rounded-lg hover:bg-teal-700 transition-colors"
                >
                  <Plus size={13} /> New
                </button>
              </div>
            </div>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search..."
                className="pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 w-full"
              />
            </div>
          </div>

          {error && (
            <div className="mx-3 mt-3 flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-xs text-red-700">
              <AlertCircle size={13} className="flex-shrink-0" />{error}
            </div>
          )}

          {!loading && <Pagination {...paginationProps} position="top" />}

          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="p-3 space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse" />)}</div>
            ) : (
              <>
                {paged.map(inv => (
                  <button
                    key={inv.id}
                    onClick={() => handleSelect(inv.id)}
                    className={`w-full text-left px-4 py-3.5 border-b border-slate-50 hover:bg-slate-50 transition-colors ${selectedId === inv.id ? 'bg-teal-50 border-l-2 border-l-teal-500' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs sm:text-sm font-semibold text-teal-600">{inv.invoice_no}</span>
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor[inv.status] || 'bg-slate-100 text-slate-600'}`}>{inv.status}</span>
                    </div>
                    <p className="text-xs sm:text-sm text-slate-900 font-medium mt-0.5 truncate">{inv.customer_name}</p>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-xs text-slate-500">{formatDate(inv.date)}</span>
                      <span className="text-xs sm:text-sm font-bold text-slate-900">{formatCurrency(Number(inv.total))}</span>
                    </div>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <EmptyState message="No invoices found" />
                )}
              </>
            )}
          </div>
          <Pagination {...paginationProps} position="bottom" />
        </div>

        {/* Invoice Preview */}
        <div className={`flex-1 bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden flex flex-col ${mobileView === 'list' ? 'hidden xl:flex' : 'flex'}`}>
          {selectedId ? (
            <>
              <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-100 flex-shrink-0">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setMobileView('list'); setSelectedId(null); setDetail(null); }}
                    className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors xl:hidden"
                  >
                    <ArrowLeft size={16} />
                  </button>
                  <h3 className="text-sm sm:text-base font-bold text-slate-900">Invoice Preview</h3>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handlePrint}
                    disabled={!detail || actionLoading === 'print'}
                    className="flex items-center gap-1.5 text-xs sm:text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 px-2 sm:px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {actionLoading === 'print' ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />}
                    <span className="hidden sm:inline">Print</span>
                  </button>
                  <button
                    onClick={handleDownload}
                    disabled={!detail || actionLoading === 'download'}
                    className="flex items-center gap-1.5 text-xs sm:text-sm text-white bg-teal-600 hover:bg-teal-700 px-2 sm:px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {actionLoading === 'download' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                    <span className="hidden sm:inline">Download PDF</span>
                    <span className="sm:hidden">PDF</span>
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 sm:p-8">
                {detailLoading ? (
                  <div className="max-w-2xl mx-auto space-y-4">
                    {[1,2,3,4].map(i => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}
                  </div>
                ) : detail ? (
                  <div className="max-w-2xl mx-auto">
                    {/* Header */}
                    <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-6 sm:mb-8">
                      <div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-9 h-9 bg-teal-600 rounded-xl flex items-center justify-center">
                            <span className="text-white font-bold text-xs">
                              {getCachedSettings().company_name.split(' ').map((w: string) => w[0] || '').join('').slice(0, 2).toUpperCase()}
                            </span>
                          </div>
                          <div>
                            <h1 className="text-lg font-bold text-slate-900">{getCachedSettings().company_name}</h1>
                            <p className="text-xs text-slate-500">{getCachedSettings().company_tagline}</p>
                          </div>
                        </div>
                        <p className="text-xs sm:text-sm text-slate-500 mt-2">
                          {getCachedSettings().company_address}
                          {getCachedSettings().company_phone && <><br />{getCachedSettings().company_phone}</>}
                          {getCachedSettings().company_email && <> · {getCachedSettings().company_email}</>}
                        </p>
                      </div>
                      <div className="sm:text-right">
                        <p className="text-2xl sm:text-3xl font-bold text-slate-200 uppercase tracking-widest">Invoice</p>
                        <p className="text-base sm:text-lg font-bold text-teal-600 mt-1">{detail.invoice_no}</p>
                        <p className="text-xs sm:text-sm text-slate-500 mt-1">Date: {formatDate(detail.date)}</p>
                        <span className={`inline-block mt-2 text-xs font-semibold px-2.5 py-1 rounded-full ${statusColor[detail.status] || 'bg-slate-100 text-slate-600'}`}>
                          {(detail.status || '').toUpperCase()}
                        </span>
                      </div>
                    </div>

                    <div className="bg-slate-50 rounded-xl p-3 sm:p-4 mb-5 sm:mb-6">
                      <p className="text-xs font-semibold text-slate-500 uppercase mb-1">Bill To</p>
                      <p className="text-sm sm:text-base font-bold text-slate-900">{detail.customer_name}</p>
                      {detail.customer_phone && <p className="text-xs text-slate-500 mt-0.5">{detail.customer_phone}</p>}
                    </div>

                    <div className="overflow-x-auto mb-5 sm:mb-6">
                      <table className="w-full min-w-[360px]">
                        <thead>
                          <tr className="border-b-2 border-slate-200">
                            <th className="text-xs font-semibold text-slate-500 uppercase text-left pb-2">Description</th>
                            <th className="text-xs font-semibold text-slate-500 uppercase text-center pb-2">Qty</th>
                            <th className="text-xs font-semibold text-slate-500 uppercase text-right pb-2 hidden sm:table-cell">Unit Price</th>
                            <th className="text-xs font-semibold text-slate-500 uppercase text-right pb-2">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {(detail.items || []).map((item: any, i: number) => (
                            <tr key={i}>
                              <td className="py-2.5 text-xs sm:text-sm text-slate-900 pr-2">
                                {item.tire_name || [item.brand, item.model, item.size].filter(Boolean).join(' ')}
                              </td>
                              <td className="py-2.5 text-xs sm:text-sm text-slate-700 text-center">{item.qty}</td>
                              <td className="py-2.5 text-xs sm:text-sm text-slate-700 text-right hidden sm:table-cell">{formatCurrency(Number(item.unit_price))}</td>
                              <td className="py-2.5 text-xs sm:text-sm font-semibold text-slate-900 text-right">{formatCurrency(Number(item.qty) * Number(item.unit_price))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex justify-end">
                      <div className="w-48 sm:w-56 space-y-2">
                        <div className="flex justify-between text-xs sm:text-sm text-slate-600">
                          <span>Subtotal</span>
                          <span>{formatCurrency(Number(detail.total))}</span>
                        </div>
                        <div className="flex justify-between text-sm sm:text-base font-bold text-slate-900 pt-2 border-t-2 border-slate-200">
                          <span>Total</span>
                          <span className="text-teal-600">{formatCurrency(Number(detail.total))}</span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-6 sm:mt-8 pt-4 sm:pt-6 border-t border-slate-100 text-xs text-slate-400 text-center">
                      Thank you for your business · Payment due within {getCachedSettings().payment_due_days} days · {getCachedSettings().company_name}
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center flex-1 text-slate-400 gap-3 py-16">
              <Eye size={36} className="text-slate-200" />
              <p className="text-sm">Select an invoice to preview</p>
            </div>
          )}
        </div>
      </div>

      {showImport && (
        <ExcelImportModal
          entity="sales"
          onClose={() => setShowImport(false)}
          onImported={fetchSales}
        />
      )}

      {showNewSale && (
        <NewSaleModal
          onClose={() => setShowNewSale(false)}
          onCreated={() => { fetchSales(); setShowNewSale(false); }}
        />
      )}
    </div>
  );
}
