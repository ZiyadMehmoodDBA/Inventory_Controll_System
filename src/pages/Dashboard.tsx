import { useState, useEffect } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell,
} from 'recharts';
import {
  Bell, ShoppingCart, AlertTriangle, CheckCircle, RefreshCw, TrendingUp,
  Package, Megaphone, PieChart as PieIcon, BookOpen, Award,
} from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency, formatDate } from '../lib/utils';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { getCachedSettings } from '../lib/appSettings';
import { BUSINESS_TYPES, useTerms } from '../lib/businessTypes';
import TableSkeleton from '../components/TableSkeleton';

const BASE_MONTHS = [
  { month: 'Jan' }, { month: 'Feb' }, { month: 'Mar' },
  { month: 'Apr' }, { month: 'May' }, { month: 'Jun' },
  { month: 'Jul' }, { month: 'Aug' }, { month: 'Sep' },
  { month: 'Oct' }, { month: 'Nov' }, { month: 'Dec' },
];

const TYPE_COLORS = ['#14b8a6','#8b5cf6','#f59e0b','#10b981','#3b82f6','#ef4444','#f97316','#6366f1'];

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good Morning';
  if (h < 17) return 'Good Afternoon';
  return 'Good Evening';
}

export default function Dashboard() {
  const terms = useTerms();
  const businessLabel = BUSINESS_TYPES.find(b => b.id === getCachedSettings().business_type)?.label ?? '';
  const [sales,        setSales]        = useState<any[]>([]);
  const [purchases,    setPurchases]    = useState<any[]>([]);
  const [tires,        setTires]        = useState<any[]>([]);
  const [tireTypeData, setTireTypeData] = useState<{ name: string; value: number; revenue: number; color: string }[]>([]);
  const [finance,      setFinance]      = useState<any>(null);
  const [dashStats,    setDashStats]    = useState<any>(null);
  const [loading,      setLoading]      = useState(true);
  const [refreshing,   setRefreshing]   = useState(false);

  const fetchAll = async () => {
    setRefreshing(true);
    const [sRes, pRes, tRes, ttRes, fRes, dsRes] = await Promise.allSettled([
      api.sales.list(),
      api.purchases.list(),
      api.inventory.list(),
      api.sales.byTireType(),
      api.ledger.summary(),
      api.sales.dashboardStats(),
    ]);

    if (sRes.status  === 'fulfilled') setSales(sRes.value as any[]);
    if (pRes.status  === 'fulfilled') setPurchases(pRes.value as any[]);
    if (tRes.status  === 'fulfilled') setTires(tRes.value as any[]);
    if (fRes.status  === 'fulfilled') setFinance(fRes.value);
    if (dsRes.status === 'fulfilled') setDashStats(dsRes.value);

    if (ttRes.status === 'fulfilled') {
      const tt = ttRes.value as { tire_type: string; item_count: number; revenue: number }[];
      const totalRevenue = tt.reduce((sum, r) => sum + Number(r.revenue || 0), 0);
      setTireTypeData(tt.map((r, i) => ({
        name:    r.tire_type,
        value:   totalRevenue > 0 ? Math.round((Number(r.revenue) / totalRevenue) * 100) : 0,
        revenue: Number(r.revenue),
        color:   TYPE_COLORS[i % TYPE_COLORS.length],
      })));
    }

    setLoading(false);
    setRefreshing(false);
  };

  const { secondsLeft } = useAutoRefresh(fetchAll);
  useEffect(() => { fetchAll(); }, []);

  // Batches that have expired or will within 30 days (only exists for items tracked by batch with an expiry).
  const [expiry, setExpiry] = useState<{ expired_units: number; expiring_units: number } | null>(null);
  useEffect(() => { api.inventory.expiry(30).then(setExpiry).catch(() => setExpiry(null)); }, []);

  const activeSales      = sales.filter(s => s.status !== 'voided');
  const lowStock         = tires.filter(t => Number(t.stock) <= Number(t.reorder_level));
  const healthyStock     = tires.filter(t => Number(t.stock) >  Number(t.reorder_level));
  const pendingSales     = activeSales.filter(s => s.status === 'pending' || s.status === 'partial' || s.status === 'overdue');
  const paidSales        = activeSales.filter(s => s.status === 'paid');
  const recentSales      = [...activeSales].slice(0, 10);
  const lowStockTop10    = [...lowStock].sort((a, b) => Number(a.stock) - Number(b.stock)).slice(0, 10);
  const pendingPurchases = purchases.filter(p => p.status === 'pending');

  const revenueByMonth: Record<string, number> = {};
  activeSales.forEach(s => {
    const m = new Date(s.date).toLocaleString('en', { month: 'short' });
    revenueByMonth[m] = (revenueByMonth[m] || 0) + Number(s.total);
  });
  const chartData = BASE_MONTHS.map(r => ({
    ...r,
    revenue: revenueByMonth[r.month] || 0,
    profit:  Math.round((revenueByMonth[r.month] || 0) * 0.28),
  }));

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const statusColor: Record<string, string> = {
    paid:    'bg-emerald-50 text-emerald-700',
    partial: 'bg-teal-50 text-teal-700',
    pending: 'bg-amber-50 text-amber-700',
    overdue: 'bg-red-50 text-red-700',
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">

      {expiry && (expiry.expired_units > 0 || expiry.expiring_units > 0) && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs sm:text-sm text-amber-800">
          <span className="font-semibold">Expiry alert:</span>
          {expiry.expired_units > 0 && <span><b className="text-red-700">{expiry.expired_units}</b> unit{expiry.expired_units === 1 ? '' : 's'} expired (cannot be sold)</span>}
          {expiry.expired_units > 0 && expiry.expiring_units > 0 && <span>·</span>}
          {expiry.expiring_units > 0 && <span><b>{expiry.expiring_units}</b> expiring within 30 days</span>}
          <span className="text-amber-600">— see Inventory → Expiry</span>
        </div>
      )}

      {/* ── Welcome Banner ─────────────────────────────────────────────────── */}
      <div className="bg-gradient-to-r from-teal-700 via-teal-600 to-cyan-500 rounded-2xl p-5 sm:p-6 text-white shadow-lg shadow-teal-200/50">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center flex-shrink-0">
              <Megaphone size={22} className="text-white" />
            </div>
            <div>
              <p className="text-teal-100 text-sm font-medium">{getGreeting()}!</p>
              <h2 className="text-xl sm:text-2xl font-bold text-white leading-tight mt-0.5">
                {getCachedSettings().company_name}
              </h2>
              <p className="text-teal-200 text-xs mt-1">{businessLabel && `${businessLabel} · `}{today}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="text-center bg-white/15 rounded-xl px-3 sm:px-4 py-2.5">
              <p className="text-lg sm:text-xl font-bold leading-none">{loading ? '—' : activeSales.length}</p>
              <p className="text-xs text-teal-100 mt-0.5">Invoices</p>
            </div>
            <div className="text-center bg-white/15 rounded-xl px-3 sm:px-4 py-2.5">
              <p className="text-lg sm:text-xl font-bold leading-none">{loading ? '—' : pendingSales.length}</p>
              <p className="text-xs text-teal-100 mt-0.5">Pending</p>
            </div>
            <div className="text-center bg-white/15 rounded-xl px-3 sm:px-4 py-2.5">
              <p className="text-lg sm:text-xl font-bold leading-none">{loading ? '—' : purchases.length}</p>
              <p className="text-xs text-teal-100 mt-0.5">Purchases</p>
            </div>
            <div className="text-center bg-white/15 rounded-xl px-3 sm:px-4 py-2.5">
              <p className="text-lg sm:text-xl font-bold leading-none">{loading ? '—' : lowStock.length}</p>
              <p className="text-xs text-teal-100 mt-0.5">Low Stock</p>
            </div>
            <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
              {secondsLeft > 0 && secondsLeft <= 5 ? (
                <span className="text-xs font-bold tabular-nums text-white leading-none">{secondsLeft}s</span>
              ) : (
                <span className="text-xs leading-none opacity-0 select-none">0s</span>
              )}
              <button
                onClick={fetchAll}
                className="p-2.5 bg-white/15 hover:bg-white/25 rounded-xl transition-colors"
                title="Refresh"
              >
                <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── KPI Cluster Cards ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">

        {/* Today & Month Revenue */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-50">
            <div className="flex items-center gap-2">
              <TrendingUp size={15} className="text-teal-500" />
              <h3 className="text-sm font-bold text-slate-900">Sales Performance</h3>
            </div>
            <Bell size={14} className="text-slate-300" />
          </div>
          <div className="p-4 grid grid-cols-3 gap-3">
            <div className="bg-teal-50 border border-teal-100 rounded-xl p-3.5 text-center">
              <p className="text-[10px] text-teal-600 font-bold uppercase tracking-wide mb-1.5">Today</p>
              <p className="text-base sm:text-lg font-bold text-teal-700 leading-none truncate">
                {loading ? '—' : `${(Number(dashStats?.today_revenue || 0) / 1000).toFixed(1)}k`}
              </p>
              <p className="text-[10px] text-teal-500 mt-1.5">{loading ? '—' : dashStats?.today_invoices ?? 0} inv.</p>
            </div>
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3.5 text-center">
              <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-wide mb-1.5">This Month</p>
              <p className="text-base sm:text-lg font-bold text-emerald-700 leading-none truncate">
                {loading ? '—' : `${(Number(dashStats?.month_revenue || 0) / 1000).toFixed(1)}k`}
              </p>
              <p className="text-[10px] text-emerald-500 mt-1.5">{loading ? '—' : dashStats?.month_invoices ?? 0} inv.</p>
            </div>
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3.5 text-center">
              <p className="text-[10px] text-amber-600 font-bold uppercase tracking-wide mb-1.5">Units Sold</p>
              <p className="text-xl sm:text-2xl font-bold text-amber-700 leading-none">
                {loading ? '—' : (dashStats?.month_units ?? 0)}
              </p>
              <p className="text-[10px] text-amber-500 mt-1.5">This month</p>
            </div>
          </div>
          <div className="px-4 pb-3 grid grid-cols-2 gap-2">
            <div className="bg-slate-50 rounded-lg p-2.5 text-center">
              <p className="text-[10px] text-slate-500 font-medium">Paid Invoices</p>
              <p className="text-sm font-bold text-slate-700 mt-0.5">{loading ? '—' : paidSales.length}</p>
            </div>
            <div className="bg-slate-50 rounded-lg p-2.5 text-center">
              <p className="text-[10px] text-slate-500 font-medium">Pending</p>
              <p className="text-sm font-bold text-amber-600 mt-0.5">{loading ? '—' : pendingSales.length}</p>
            </div>
          </div>
        </div>

        {/* Inventory Status */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-50">
            <div className="flex items-center gap-2">
              <Package size={15} className="text-teal-500" />
              <h3 className="text-sm font-bold text-slate-900">Inventory Status</h3>
            </div>
            <Bell size={14} className="text-slate-300" />
          </div>
          <div className="p-4 grid grid-cols-3 gap-3">
            <div className="bg-teal-50 border border-teal-100 rounded-xl p-3.5 text-center">
              <p className="text-[10px] text-teal-600 font-bold uppercase tracking-wide mb-1.5">Total {terms.items}</p>
              <p className="text-xl sm:text-2xl font-bold text-teal-700 leading-none">
                {loading ? '—' : tires.length}
              </p>
              <p className="text-[10px] text-teal-500 mt-1.5">Products</p>
            </div>
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3.5 text-center">
              <p className="text-[10px] text-emerald-600 font-bold uppercase tracking-wide mb-1.5">In Stock</p>
              <p className="text-xl sm:text-2xl font-bold text-emerald-700 leading-none">
                {loading ? '—' : healthyStock.length}
              </p>
              <p className="text-[10px] text-emerald-500 mt-1.5">Healthy</p>
            </div>
            <div className={`${lowStock.length > 0 ? 'bg-red-50 border-red-100' : 'bg-slate-50 border-slate-100'} border rounded-xl p-3.5 text-center`}>
              <p className={`text-[10px] font-bold uppercase tracking-wide mb-1.5 ${lowStock.length > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                Low Stock
              </p>
              <p className={`text-xl sm:text-2xl font-bold leading-none ${lowStock.length > 0 ? 'text-red-700' : 'text-slate-500'}`}>
                {loading ? '—' : lowStock.length}
              </p>
              <p className={`text-[10px] mt-1.5 ${lowStock.length > 0 ? 'text-red-500' : 'text-slate-400'}`}>
                {lowStock.length > 0 ? 'Reorder' : 'All OK'}
              </p>
            </div>
          </div>
        </div>

        {/* Finance Summary */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-50">
            <div className="flex items-center gap-2">
              <BookOpen size={15} className="text-teal-500" />
              <h3 className="text-sm font-bold text-slate-900">Finance Overview</h3>
            </div>
            <Bell size={14} className="text-slate-300" />
          </div>
          <div className="p-4 grid grid-cols-3 gap-3">
            <div className="bg-teal-50 border border-teal-100 rounded-xl p-3.5 text-center">
              <p className="text-[10px] text-teal-600 font-bold uppercase tracking-wide mb-1.5">Receivable</p>
              <p className="text-sm sm:text-base font-bold text-teal-700 leading-none truncate">
                {loading || !finance ? '—' : `${(Number(finance.total_receivable) / 1000).toFixed(1)}k`}
              </p>
              <p className="text-[10px] text-teal-500 mt-1.5">To Collect</p>
            </div>
            <div className="bg-red-50 border border-red-100 rounded-xl p-3.5 text-center">
              <p className="text-[10px] text-red-600 font-bold uppercase tracking-wide mb-1.5">Payable</p>
              <p className="text-sm sm:text-base font-bold text-red-700 leading-none truncate">
                {loading || !finance ? '—' : `${(Number(finance.total_payable) / 1000).toFixed(1)}k`}
              </p>
              <p className="text-[10px] text-red-500 mt-1.5">To Pay</p>
            </div>
            <div className="bg-teal-50 border border-teal-100 rounded-xl p-3.5 text-center">
              <p className="text-[10px] text-teal-600 font-bold uppercase tracking-wide mb-1.5">Purchases</p>
              <p className="text-xl sm:text-2xl font-bold text-teal-700 leading-none">
                {loading ? '—' : pendingPurchases.length}
              </p>
              <p className="text-[10px] text-teal-500 mt-1.5">Pending POs</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Charts ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Revenue Overview</h3>
              <p className="text-xs text-slate-400 mt-0.5">Monthly totals from sales</p>
            </div>
            <div className="flex gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-teal-500 inline-block" />Revenue
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" />Profit (~28%)
              </span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#14b8a6" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gProfit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#10b981" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis
                tickFormatter={v => `${(v / 1000).toFixed(0)}k`}
                tick={{ fontSize: 10, fill: '#94a3b8' }}
                axisLine={false} tickLine={false} width={32}
              />
              <Tooltip
                formatter={(v: any) => formatCurrency(Number(v) || 0)}
                contentStyle={{ borderRadius: '10px', border: '1px solid #e2e8f0', fontSize: '11px' }}
              />
              <Area type="monotone" dataKey="revenue" stroke="#14b8a6" strokeWidth={2} fill="url(#gRevenue)" />
              <Area type="monotone" dataKey="profit"  stroke="#10b981" strokeWidth={2} fill="url(#gProfit)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-2xl p-4 sm:p-5 shadow-sm border border-slate-100">
          <div className="flex items-start justify-between mb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">Sales by {terms.groupBy}</h3>
              <p className="text-xs text-slate-400 mt-0.5">Revenue distribution — live data</p>
            </div>
            {tireTypeData.length > 0 && (
              <span className="text-[10px] font-semibold bg-teal-50 text-teal-700 border border-teal-100 px-1.5 py-0.5 rounded-full">
                {tireTypeData.length} {terms.tyre ? 'types' : 'categories'}
              </span>
            )}
          </div>

          {loading ? (
            <div className="h-[160px] flex items-center justify-center">
              <div className="w-20 h-20 rounded-full border-4 border-slate-100 border-t-teal-500 animate-spin" />
            </div>
          ) : tireTypeData.length === 0 ? (
            <div className="h-[160px] flex flex-col items-center justify-center gap-2 text-slate-400">
              <PieIcon className="w-8 h-8 opacity-30" />
              <p className="text-xs">No {terms.item.toLowerCase()} sales data yet</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie
                  data={tireTypeData} cx="50%" cy="50%"
                  innerRadius={45} outerRadius={70} paddingAngle={3} dataKey="value"
                >
                  {tireTypeData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Tooltip
                  formatter={(v: any, _name: any, props: any) => [
                    `${v}% (${formatCurrency(props?.payload?.revenue ?? 0)})`,
                    props?.payload?.name ?? '',
                  ]}
                  contentStyle={{ borderRadius: '10px', fontSize: '11px' }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}

          <div className="grid grid-cols-2 gap-1.5 mt-2">
            {tireTypeData.map(t => (
              <div key={t.name} className="flex items-center gap-1.5 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: t.color }} />
                <span className="text-xs text-slate-500 truncate">
                  {t.name}: <strong className="text-slate-700">{t.value}%</strong>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Recent Sales + Low Stock + Top SKUs ─────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">

        {/* Recent Sales */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-50">
            <div className="flex items-center gap-2">
              <ShoppingCart size={15} className="text-teal-500" />
              <h3 className="text-sm font-bold text-slate-900">Recent Sales</h3>
            </div>
            <span className="text-xs text-teal-600 font-semibold bg-teal-50 px-2.5 py-0.5 rounded-full border border-teal-100">
              {loading ? '...' : `${activeSales.length} total`}
            </span>
          </div>
          <div className="p-3 sm:p-4">
            {loading ? <TableSkeleton rows={3} rowHeight="h-10" /> : (
              <div className="space-y-0.5">
                {recentSales.length === 0 && (
                  <p className="text-sm text-slate-400 text-center py-8">No sales yet. Create your first invoice.</p>
                )}
                {recentSales.map(sale => (
                  <div key={sale.id} className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-slate-50 transition-colors">
                    <div className="w-8 h-8 bg-teal-50 rounded-lg flex items-center justify-center flex-shrink-0">
                      <ShoppingCart size={13} className="text-teal-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-900 truncate">{sale.customer_name}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{sale.invoice_no} · {formatDate(sale.date)}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs font-bold text-slate-900">{formatCurrency(Number(sale.total))}</p>
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${statusColor[sale.status] || 'bg-slate-50 text-slate-500'}`}>
                        {sale.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Low Stock Alerts */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-50">
            <div className="flex items-center gap-2">
              <AlertTriangle size={15} className={lowStock.length > 0 ? 'text-red-500' : 'text-emerald-500'} />
              <h3 className="text-sm font-bold text-slate-900">Low Stock Alerts</h3>
            </div>
            <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full border ${
              lowStock.length > 0
                ? 'bg-red-50 text-red-600 border-red-100'
                : 'bg-emerald-50 text-emerald-600 border-emerald-100'
            }`}>
              {loading ? '...' : `${lowStock.length} items`}
            </span>
          </div>
          <div className="p-3 sm:p-4">
            {loading ? <TableSkeleton rows={3} rowHeight="h-10" /> : (
              <div className="space-y-0.5">
                {lowStock.length === 0 && (
                  <div className="flex items-center justify-center gap-2.5 py-8 text-emerald-600">
                    <CheckCircle size={18} />
                    <span className="text-sm font-medium">All stock levels healthy</span>
                  </div>
                )}
                {lowStockTop10.map((tire: any) => (
                  <div key={tire.id} className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-slate-50 transition-colors">
                    <div className="w-8 h-8 bg-red-50 rounded-lg flex items-center justify-center flex-shrink-0">
                      <AlertTriangle size={13} className="text-red-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-900 truncate">{tire.brand} {tire.model}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{tire.size} · Min: {tire.reorder_level}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs font-bold text-red-600">{tire.stock} left</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">Reorder now</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Top 5 SKUs (last 30 days) */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-50">
            <div className="flex items-center gap-2">
              <Award size={15} className="text-amber-500" />
              <h3 className="text-sm font-bold text-slate-900">Top 10 {terms.items}</h3>
            </div>
            <span className="text-xs font-semibold bg-amber-50 text-amber-600 border border-amber-100 px-2.5 py-0.5 rounded-full">
              Last 30 days
            </span>
          </div>
          <div className="p-3 sm:p-4">
            {loading ? <TableSkeleton rows={3} rowHeight="h-10" /> : (
              <div className="space-y-0.5">
                {(!dashStats?.top_skus || dashStats.top_skus.length === 0) && (
                  <p className="text-sm text-slate-400 text-center py-8">No {terms.item.toLowerCase()} sales in the last 30 days.</p>
                )}
                {(dashStats?.top_skus || []).map((sku: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 px-2 py-2.5 rounded-xl hover:bg-slate-50 transition-colors">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 font-bold text-sm
                      ${i === 0 ? 'bg-amber-100 text-amber-700' : i === 1 ? 'bg-slate-100 text-slate-600' : 'bg-slate-50 text-slate-500'}`}>
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-slate-900 truncate">{sku.sku_name}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{formatCurrency(sku.revenue)}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs font-bold text-slate-900">{sku.qty_sold}</p>
                      <p className="text-[10px] text-slate-400 mt-0.5">units</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
