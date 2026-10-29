import { useState, useEffect, useCallback, useRef } from 'react';
import { useFetch } from '../lib/useFetch';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend
} from 'recharts';
import { RefreshCw, FileText, FileSpreadsheet, Download, AlertTriangle } from 'lucide-react';
import ErrorBanner from '../components/ErrorBanner';
import { api } from '../api/client';
import { useTerms } from '../lib/businessTypes';
import { formatCurrency, formatDate } from '../lib/utils';
import {
  exportSalesReportPDF, exportSalesReportExcel,
  exportStockReportPDF, exportStockReportExcel,
  exportLowStockReportPDF, exportLowStockReportExcel,
} from '../lib/reportExport';
import { usePagination } from '../lib/usePagination';
import Pagination from '../components/Pagination';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
type TabId = 'pnl' | 'sales' | 'stock' | 'lowstock';

const TABS: { id: TabId; label: string }[] = [
  { id: 'pnl',      label: 'P&L Summary' },
  { id: 'sales',    label: 'Sales Report' },
  { id: 'stock',    label: 'Stock Report' },
  { id: 'lowstock', label: 'Low Stock' },
];

export default function Reports() {
  const terms = useTerms();
  // Tyre shops group by tyre type; every other business by item category.
  const [catNames, setCatNames] = useState<Record<number, string>>({});
  useEffect(() => {
    if (terms.tyre) return;
    api.inventory.categories().then(cs => setCatNames(Object.fromEntries(cs.map(c => [c.id, c.name])))).catch(() => {});
  }, [terms.tyre]);
  const groupOf = (t: any): string => terms.tyre ? (t.type || '') : (catNames[t.category_id] ?? '');
  const stockLabels = { brand: terms.brand, name: terms.tyre ? 'Model' : terms.name, size: terms.size, group: terms.tyre ? 'Type' : 'Category', groupOf };
  const [activeTab, setActiveTab]   = useState<TabId>('pnl');

  const { data: sales,     loading: salesLoad,  refreshing: salesRef,  error: salesErr,  setError, refresh: refreshSales } = useFetch<any>(api.sales.list);
  const { data: purchases, loading: purchLoad,  refreshing: purchRef,  error: purchErr,  refresh: refreshPurchases } = useFetch<any>(api.purchases.list);
  const { data: tires,     loading: tiresLoad,  refreshing: tiresRef,  error: tiresErr,  refresh: refreshTires }     = useFetch<any>(api.inventory.list);

  const loading    = salesLoad  || purchLoad  || tiresLoad;
  const refreshing = salesRef   || purchRef   || tiresRef;
  const error      = salesErr   || purchErr   || tiresErr;
  const fetchAll   = () => { refreshSales(); refreshPurchases(); refreshTires(); };

  const stockTopRef    = useRef<HTMLDivElement>(null);
  const salesTopRef    = useRef<HTMLDivElement>(null);
  const lowstockTopRef = useRef<HTMLDivElement>(null);
  const brandTopRef    = useRef<HTMLDivElement>(null);

  // Sales report state
  const [salesFrom,    setSalesFrom]    = useState('');
  const [salesTo,      setSalesTo]      = useState('');
  const [salesReport,  setSalesReport]  = useState<any[]>([]);
  const [salesLoading, setSalesLoading] = useState(false);
  const [salesFetched, setSalesFetched] = useState(false);

  const fetchSalesReport = useCallback(async () => {
    setSalesLoading(true);
    try {
      const data = await api.sales.listFiltered({ from: salesFrom || undefined, to: salesTo || undefined });
      setSalesReport(data.filter((s: any) => s.status !== 'voided'));
      setSalesFetched(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSalesLoading(false);
    }
  }, [salesFrom, salesTo]);

  // Recompute on tab switch to sales
  useEffect(() => {
    if (activeTab === 'sales' && !salesFetched) fetchSalesReport();
  }, [activeTab, salesFetched, fetchSalesReport]);

  // Monthly aggregates from real data
  const currentYear = new Date().getFullYear();
  const activeSales = sales.filter(s => s.status !== 'voided');
  const monthlyData = MONTHS.map(month => {
    const rev = activeSales
      .filter(s => {
        const d = new Date(s.date);
        return d.getFullYear() === currentYear &&
               d.toLocaleString('en', { month: 'short' }) === month;
      })
      .reduce((sum, s) => sum + Number(s.total), 0);
    const pur = purchases
      .filter(p => {
        const d = new Date(p.date);
        return d.getFullYear() === currentYear &&
               d.toLocaleString('en', { month: 'short' }) === month;
      })
      .reduce((sum, p) => sum + Number(p.total), 0);
    return { month, revenue: rev, purchases: pur, profit: Math.round((rev - pur)) };
  });

  const totalRevenue = activeSales.reduce((s, i) => s + Number(i.total), 0);
  const totalCOGS    = purchases.filter(p => p.status === 'received').reduce((s, p) => s + Number(p.total), 0);
  const grossProfit  = totalRevenue - totalCOGS;
  const margin       = totalRevenue > 0 ? ((grossProfit / totalRevenue) * 100).toFixed(1) : '0.0';

  const brandMap: Record<string, { units: number; value: number }> = {};
  tires.forEach((t: any) => {
    const b = t.brand || 'Unknown';
    if (!brandMap[b]) brandMap[b] = { units: 0, value: 0 };
    brandMap[b].units += Number(t.stock);
    brandMap[b].value += Number(t.stock) * Number(t.sale_price);
  });
  const brandData = Object.entries(brandMap)
    .map(([brand, d]) => ({ brand, units: d.units, revenue: d.value }))
    .sort((a, b) => b.revenue - a.revenue);
  const totalBrandRev = brandData.reduce((s, b) => s + b.revenue, 0);

  const lowStockTires = tires.filter(t => Number(t.stock) <= Number(t.reorder_level));
  const salesDateLabel = salesFrom || salesTo
    ? `${salesFrom || 'All'} to ${salesTo || 'All'}`
    : 'All Dates';

  // ── Pagination hooks ────────────────────────────────────────────────────────
  const stockPag    = usePagination(tires);
  const salesPag    = usePagination(salesReport);
  const lowstockPag = usePagination(lowStockTires);
  const brandPag    = usePagination(brandData);

  // Wrap onPage to also scroll to card top
  const goStockPage    = (p: number) => { stockPag.paginationProps.onPage(p);    stockTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const goSalesPage    = (p: number) => { salesPag.paginationProps.onPage(p);    salesTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const goLowstockPage = (p: number) => { lowstockPag.paginationProps.onPage(p); lowstockTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const goBrandPage    = (p: number) => { brandPag.paginationProps.onPage(p);    brandTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">

      {/* Tab Bar */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-1.5 flex gap-1 overflow-x-auto">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-shrink-0 px-4 py-2 text-sm font-semibold rounded-xl transition-colors ${
              activeTab === tab.id
                ? 'bg-teal-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {tab.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={fetchAll}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-100 transition-colors flex-shrink-0">
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <ErrorBanner error={error} />

      {/* ── P&L Summary tab ─────────────────────────────────────────────────── */}
      {activeTab === 'pnl' && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            {[
              { label: 'Total Revenue',  value: formatCurrency(totalRevenue), sub: 'All invoices',    color: 'border-t-blue-500' },
              { label: 'Cost of Goods',  value: formatCurrency(totalCOGS),    sub: 'Received POs',   color: 'border-t-violet-500' },
              { label: 'Gross Profit',   value: formatCurrency(grossProfit),  sub: 'Before expenses', color: 'border-t-emerald-500' },
              { label: 'Margin',         value: `${margin}%`,                 sub: 'Gross margin %',  color: 'border-t-amber-500' },
            ].map(s => (
              <div key={s.label} className={`bg-white rounded-xl p-3 sm:p-4 border border-slate-100 border-t-2 shadow-sm ${s.color}`}>
                <p className="text-xs text-slate-500 font-medium truncate">{s.label}</p>
                <p className={`text-sm sm:text-xl font-bold text-slate-900 mt-1 truncate ${loading ? 'opacity-40' : ''}`}>{s.value}</p>
                <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">{s.sub}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm sm:text-base font-bold text-slate-900 mb-1">Monthly Revenue Trend</h3>
              <p className="text-xs text-slate-500 mb-4">Revenue vs Purchases (PKR) — {currentYear}</p>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={monthlyData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={30} />
                  <Tooltip formatter={(v: any) => formatCurrency(Number(v) || 0)} contentStyle={{ borderRadius: '10px', fontSize: '11px' }} />
                  <Legend iconType="circle" iconSize={7} wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="revenue"   name="Revenue"   fill="#3b82f6" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="purchases" name="Purchases" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-slate-100">
              <h3 className="text-sm sm:text-base font-bold text-slate-900 mb-1">Profit Trend</h3>
              <p className="text-xs text-slate-500 mb-4">Monthly gross profit (Revenue − Purchases)</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={monthlyData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={v => `${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={30} />
                  <Tooltip formatter={(v: any) => formatCurrency(Number(v) || 0)} contentStyle={{ borderRadius: '10px', fontSize: '11px' }} />
                  <Line type="monotone" dataKey="profit" name="Profit" stroke="#10b981" strokeWidth={2.5} dot={{ r: 3, fill: '#10b981' }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Inventory by Brand */}
          <div ref={brandTopRef} className="bg-white rounded-2xl shadow-sm border border-slate-100">
            <div className="px-4 sm:px-5 pt-4 sm:pt-5 pb-3 border-b border-slate-100">
              <h3 className="text-sm sm:text-base font-bold text-slate-900">Inventory by Brand</h3>
              <p className="text-xs text-slate-500 mt-0.5">Current stock units and value per brand</p>
            </div>
            {loading ? (
              <div className="p-4 space-y-2">{[1,2,3,4].map(i => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}</div>
            ) : brandData.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">No inventory data</p>
            ) : (
              <>
                <Pagination {...brandPag.paginationProps} onPage={goBrandPage} position="top" />
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-100">
                        {['Brand', 'Units in Stock', 'Inventory Value', 'Avg. Sale Price', 'Value Share'].map(h => (
                          <th key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3 text-left">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {brandPag.paged.map(b => {
                        const share    = totalBrandRev > 0 ? ((b.revenue / totalBrandRev) * 100).toFixed(1) : '0.0';
                        const avgPrice = b.units > 0 ? b.revenue / b.units : 0;
                        return (
                          <tr key={b.brand} className="hover:bg-slate-50/50 transition-colors">
                            <td className="px-4 py-3 text-sm font-semibold text-slate-900">{b.brand}</td>
                            <td className="px-4 py-3 text-sm text-slate-700">{b.units} pcs</td>
                            <td className="px-4 py-3 text-sm font-bold text-slate-900">{formatCurrency(b.revenue)}</td>
                            <td className="px-4 py-3 text-sm text-slate-600">{formatCurrency(avgPrice)}</td>
                            <td className="px-4 py-3.5">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-2 bg-slate-100 rounded-full max-w-24">
                                  <div className="h-full bg-teal-500 rounded-full" style={{ width: `${share}%` }} />
                                </div>
                                <span className="text-sm font-medium text-slate-700">{share}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="sm:hidden divide-y divide-slate-50">
                  {brandPag.paged.map(b => {
                    const share = totalBrandRev > 0 ? ((b.revenue / totalBrandRev) * 100).toFixed(1) : '0.0';
                    return (
                      <div key={b.brand} className="flex items-center gap-3 p-4">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-slate-900">{b.brand}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{b.units} units · {formatCurrency(b.revenue)}</p>
                          <div className="mt-2 flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-slate-200 rounded-full">
                              <div className="h-full bg-teal-500 rounded-full" style={{ width: `${share}%` }} />
                            </div>
                            <span className="text-xs font-semibold text-slate-600">{share}%</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <Pagination {...brandPag.paginationProps} onPage={goBrandPage} position="bottom" />
              </>
            )}
          </div>
        </>
      )}

      {/* ── Sales Report tab ─────────────────────────────────────────────────── */}
      {activeTab === 'sales' && (
        <div ref={salesTopRef} className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 border-b border-slate-100">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Sales Report</h3>
              <p className="text-xs text-slate-400 mt-0.5">Filter by date range and export</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date" value={salesFrom} onChange={e => setSalesFrom(e.target.value)}
                className="text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <input
                type="date" value={salesTo} onChange={e => setSalesTo(e.target.value)}
                className="text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <button
                onClick={() => { setSalesFetched(false); fetchSalesReport(); }}
                className="flex items-center gap-1.5 bg-teal-600 text-white text-xs font-semibold px-3 py-2 rounded-lg hover:bg-teal-700 transition-colors"
              >
                <RefreshCw size={12} className={salesLoading ? 'animate-spin' : ''} />
                Apply
              </button>
              {salesReport.length > 0 && (
                <>
                  <button
                    onClick={() => exportSalesReportPDF(salesReport, salesDateLabel)}
                    title="Export to PDF"
                    className="flex items-center gap-1.5 bg-red-50 text-red-700 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-red-100 transition-colors border border-red-100"
                  >
                    <FileText size={13} /> PDF
                  </button>
                  <button
                    onClick={() => exportSalesReportExcel(salesReport, salesDateLabel)}
                    title="Export to Excel"
                    className="flex items-center gap-1.5 bg-emerald-50 text-emerald-700 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-emerald-100 transition-colors border border-emerald-100"
                  >
                    <FileSpreadsheet size={13} /> Excel
                  </button>
                </>
              )}
            </div>
          </div>

          {salesLoading ? (
            <div className="p-4 space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}</div>
          ) : salesReport.length === 0 && salesFetched ? (
            <p className="text-center text-sm text-slate-400 py-12">No sales found for the selected date range.</p>
          ) : salesReport.length === 0 ? (
            <p className="text-center text-sm text-slate-400 py-12">Click Apply to load the sales report.</p>
          ) : (
            <>
              {/* Summary row */}
              <div className="grid grid-cols-3 gap-3 p-4 sm:p-5 border-b border-slate-50">
                {[
                  { label: 'Total Revenue',   value: formatCurrency(salesReport.reduce((s, r) => s + Number(r.total), 0)),                                               color: 'text-slate-900'   },
                  { label: 'Total Collected', value: formatCurrency(salesReport.reduce((s, r) => s + Number(r.amount_paid || 0), 0)),                                    color: 'text-emerald-600' },
                  { label: 'Outstanding',     value: formatCurrency(salesReport.reduce((s, r) => s + Math.max(0, Number(r.total) - Number(r.amount_paid || 0)), 0)),     color: 'text-amber-600'   },
                ].map(k => (
                  <div key={k.label} className="bg-slate-50 rounded-xl p-3 text-center">
                    <p className="text-xs text-slate-500">{k.label}</p>
                    <p className={`text-sm font-bold mt-0.5 ${k.color}`}>{k.value}</p>
                  </div>
                ))}
              </div>
              <Pagination {...salesPag.paginationProps} onPage={goSalesPage} position="top" />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      {['Invoice #', 'Date', 'Customer', 'Subtotal', 'Tax', 'Total', 'Paid', 'Balance', 'Status'].map(h => (
                        <th key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {salesPag.paged.map(s => {
                      const bal = Math.max(0, Number(s.total) - Number(s.amount_paid || 0));
                      return (
                        <tr key={s.id} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-4 py-3 text-xs font-semibold text-teal-600">{s.invoice_no}</td>
                          <td className="px-4 py-3 text-xs text-slate-600">{formatDate(s.date)}</td>
                          <td className="px-4 py-3 text-xs font-medium text-slate-900 max-w-[140px] truncate">{s.customer_name}</td>
                          <td className="px-4 py-3 text-xs text-slate-600">{formatCurrency(s.subtotal)}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{formatCurrency(s.tax)}</td>
                          <td className="px-4 py-3 text-xs font-bold text-slate-900">{formatCurrency(s.total)}</td>
                          <td className="px-4 py-3 text-xs font-semibold text-emerald-600">{formatCurrency(Number(s.amount_paid || 0))}</td>
                          <td className="px-4 py-3 text-xs font-semibold">
                            <span className={bal > 0 ? 'text-amber-600' : 'text-slate-400'}>{formatCurrency(bal)}</span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${
                              s.status === 'paid'    ? 'bg-emerald-50 text-emerald-700' :
                              s.status === 'partial' ? 'bg-teal-50 text-teal-700'      :
                              s.status === 'overdue' ? 'bg-red-50 text-red-700'        :
                              'bg-amber-50 text-amber-700'
                            }`}>{s.status}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination {...salesPag.paginationProps} onPage={goSalesPage} position="bottom" />
            </>
          )}
        </div>
      )}

      {/* ── Stock Report tab ─────────────────────────────────────────────────── */}
      {activeTab === 'stock' && (
        <div ref={stockTopRef} className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-100">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Stock Report</h3>
              <p className="text-xs text-slate-400 mt-0.5">{tires.length} {terms.items.toLowerCase()} · Total value: {formatCurrency(tires.reduce((s, t) => s + Number(t.stock) * Number(t.sale_price), 0))}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => exportStockReportPDF(tires, stockLabels)}
                disabled={tires.length === 0}
                className="flex items-center gap-1.5 bg-red-50 text-red-700 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-red-100 transition-colors border border-red-100 disabled:opacity-40"
              >
                <FileText size={13} /> PDF
              </button>
              <button
                onClick={() => exportStockReportExcel(tires, stockLabels)}
                disabled={tires.length === 0}
                className="flex items-center gap-1.5 bg-emerald-50 text-emerald-700 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-emerald-100 transition-colors border border-emerald-100 disabled:opacity-40"
              >
                <FileSpreadsheet size={13} /> Excel
              </button>
            </div>
          </div>
          {loading ? (
            <div className="p-4 space-y-2">{[1,2,3,4,5].map(i => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}</div>
          ) : tires.length === 0 ? (
            <p className="text-center text-sm text-slate-400 py-12">No inventory data.</p>
          ) : (
            <>
              <Pagination {...stockPag.paginationProps} onPage={goStockPage} position="top" />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      {[stockLabels.brand, stockLabels.name, stockLabels.size, stockLabels.group, 'Stock', 'Reorder Lvl', 'Cost Price', 'Sale Price', 'Stock Value'].map(h => (
                        <th key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {stockPag.paged.map((t: any) => {
                      const isLow = Number(t.stock) <= Number(t.reorder_level);
                      return (
                        <tr key={t.id} className={`hover:bg-slate-50/50 transition-colors ${isLow ? 'bg-red-50/30' : ''}`}>
                          <td className="px-4 py-3 text-xs font-semibold text-slate-900">{t.brand}</td>
                          <td className="px-4 py-3 text-xs text-slate-700">{t.model}</td>
                          <td className="px-4 py-3 text-xs text-slate-600">{t.size}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{groupOf(t) || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs font-bold ${isLow ? 'text-red-600' : 'text-slate-900'}`}>{t.stock}</span>
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">{t.reorder_level}</td>
                          <td className="px-4 py-3 text-xs text-slate-600">{formatCurrency(t.cost_price)}</td>
                          <td className="px-4 py-3 text-xs font-semibold text-slate-900">{formatCurrency(t.sale_price)}</td>
                          <td className="px-4 py-3 text-xs font-bold text-slate-900">{formatCurrency(Number(t.stock) * Number(t.sale_price))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination {...stockPag.paginationProps} onPage={goStockPage} position="bottom" />
            </>
          )}
        </div>
      )}

      {/* ── Low Stock Report tab ─────────────────────────────────────────────── */}
      {activeTab === 'lowstock' && (
        <div ref={lowstockTopRef} className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between p-4 sm:p-5 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className={lowStockTires.length > 0 ? 'text-red-500' : 'text-emerald-500'} />
              <div>
                <h3 className="text-sm font-bold text-slate-900">Low Stock Report</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {lowStockTires.length === 0 ? 'All stock levels healthy' : `${lowStockTires.length} ${terms.items.toLowerCase()} at or below reorder level`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => exportLowStockReportPDF(lowStockTires, stockLabels)}
                disabled={lowStockTires.length === 0}
                className="flex items-center gap-1.5 bg-red-50 text-red-700 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-red-100 transition-colors border border-red-100 disabled:opacity-40"
              >
                <FileText size={13} /> PDF
              </button>
              <button
                onClick={() => exportLowStockReportExcel(lowStockTires, stockLabels)}
                disabled={lowStockTires.length === 0}
                className="flex items-center gap-1.5 bg-emerald-50 text-emerald-700 text-xs font-semibold px-3 py-2 rounded-lg hover:bg-emerald-100 transition-colors border border-emerald-100 disabled:opacity-40"
              >
                <FileSpreadsheet size={13} /> Excel
              </button>
            </div>
          </div>
          {loading ? (
            <div className="p-4 space-y-2">{[1,2,3].map(i => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}</div>
          ) : lowStockTires.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-emerald-600">
              <Download size={32} className="opacity-30" />
              <p className="text-sm font-medium">All stock levels are healthy — nothing to report.</p>
            </div>
          ) : (
            <>
              <Pagination {...lowstockPag.paginationProps} onPage={goLowstockPage} position="top" />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px]">
                  <thead>
                    <tr className="bg-red-50 border-b border-red-100">
                      {[stockLabels.brand, stockLabels.name, stockLabels.size, stockLabels.group, 'Current Stock', 'Reorder Level', 'Deficit', 'Sale Price'].map(h => (
                        <th key={h} className="text-xs font-semibold text-red-600 uppercase tracking-wider px-4 py-3 text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-red-50">
                    {lowstockPag.paged.map((t: any) => {
                      const deficit = Math.max(0, Number(t.reorder_level) - Number(t.stock));
                      return (
                        <tr key={t.id} className="hover:bg-red-50/40 transition-colors">
                          <td className="px-4 py-3 text-xs font-semibold text-slate-900">{t.brand}</td>
                          <td className="px-4 py-3 text-xs text-slate-700">{t.model}</td>
                          <td className="px-4 py-3 text-xs text-slate-600">{t.size}</td>
                          <td className="px-4 py-3 text-xs text-slate-500">{groupOf(t) || '—'}</td>
                          <td className="px-4 py-3 text-xs font-bold text-red-600">{t.stock}</td>
                          <td className="px-4 py-3 text-xs text-slate-600">{t.reorder_level}</td>
                          <td className="px-4 py-3">
                            <span className="text-xs font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded-full">−{deficit}</span>
                          </td>
                          <td className="px-4 py-3 text-xs font-semibold text-slate-900">{formatCurrency(t.sale_price)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination {...lowstockPag.paginationProps} onPage={goLowstockPage} position="bottom" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
