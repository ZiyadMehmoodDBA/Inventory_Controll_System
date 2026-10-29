import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, Download, FileSpreadsheet, FileText, Loader2, Printer, RefreshCw, X } from 'lucide-react';
import { api } from '../api/client';
import InventoryScorecard from './InventoryScorecard';
import { cellDisplay, exportPdf, exportXlsx, printReport, type ReportColumn, type ReportResult } from '../lib/inventoryReportExport';

type Tab = 'dashboard' | 'scorecard' | 'reports';
interface Props { role?: string; initialReport?: string; onClose: () => void; onOpen: (target: string) => void }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const btn = 'text-xs font-semibold px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 disabled:opacity-50 inline-flex items-center gap-1.5';
const primary = 'text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50';
const money = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (n: number | null | undefined) => Number(n ?? 0).toLocaleString();
const Err = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3" role="alert">{msg}</p> : null);
const Spin = () => <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-slate-400 py-6 text-center">{children}</p>;
const SEV: Record<string, string> = { critical: 'border-red-200 bg-red-50/60', warning: 'border-amber-200 bg-amber-50/50', info: 'border-slate-200 bg-slate-50' };
const SEV_CHIP: Record<string, string> = { critical: 'bg-red-600 text-white', warning: 'bg-amber-500 text-white', info: 'bg-slate-400 text-white' };
const STATUS_TONE: Record<string, string> = { out_of_stock: 'text-red-600', critical: 'text-red-600', low: 'text-amber-600' };

// Local calendar date: toISOString() is UTC and would drop today's records east of Greenwich around midnight.
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000));
const PRESETS: [string, number][] = [['7 days', 6], ['30 days', 29], ['90 days', 89], ['1 year', 364]];

const REASONS = ['sale', 'sale_voided', 'sale_deleted', 'grn_received', 'purchase_deleted', 'adjustment', 'transfer_in', 'transfer_out', 'opening_stock', 'count_correction'];
const CAUSES = ['expiry', 'deterioration', 'breakage', 'contamination', 'theft', 'missing', 'handling', 'obsolete', 'recall', 'other'];
const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

const STATUS_OPTIONS: Record<string, [string, string][]> = {
  low_stock: [['', 'Needs attention'], ['out_of_stock', 'Out of stock only'], ['excess', 'Excess stock'], ['all', 'All items']],
  batch_expiry: [['', 'Expired and expiring'], ['expired', 'Expired only'], ['near', 'Expiring only'], ['all', 'All batches']],
  demand_replenishment: [['', 'Items with sales or need'], ['all', 'All items'], ['out_of_stock', 'Out of stock'], ['critical', 'Critical'], ['low', 'Low'], ['excess', 'Excess']],
};
const BY_OPTIONS: Record<string, [string, string][]> = {
  current_stock: [['', 'By item'], ['location', 'By location']],
  branch_comparison: [['branch', 'By branch'], ['warehouse', 'By warehouse'], ['location', 'By location'], ['item', 'Item across branches']],
};

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const load = useCallback(() => { const n = ++seq.current; setError(''); return fn().then(d => { if (n === seq.current) setData(d); }).catch(e => { if (n === seq.current) setError(e.message); }); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}

// Inventory dashboard (exceptions and decisions first) and the standard reports with filters and exports.
export default function InventoryInsightsModal({ role, initialReport, onClose, onOpen }: Props) {
  const [tab, setTab] = useState<Tab>(initialReport ? 'reports' : 'dashboard');
  const [report, setReport] = useState<string>(initialReport || 'current_stock');
  const [orgScope, setOrgScope] = useState(false);
  const isAdmin = role === 'org_admin';
  const openReport = (id: string) => { setReport(id); setTab('reports'); };
  const go = (target: string) => { if (target.startsWith('reports:')) openReport(target.slice(8)); else onOpen(target); };
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full sm:max-w-6xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[94vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center"><BarChart3 size={18} className="text-indigo-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Inventory Dashboard & Reports</h3>
              <p className="text-xs text-slate-500">Exceptions that need a decision first, then the standard inventory reports.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <select value={orgScope ? 'org' : 'branch'} onChange={e => setOrgScope(e.target.value === 'org')} className={`${input} !py-1 text-xs`} aria-label="Scope">
                <option value="branch">This branch</option><option value="org">All branches</option>
              </select>
            )}
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400" aria-label="Close"><X size={16} /></button>
          </div>
        </div>
        <div className="flex gap-1 px-5 pt-3 border-b border-slate-100">
          {([['dashboard', 'Dashboard'], ['scorecard', 'Performance'], ['reports', 'Reports']] as [Tab, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`text-xs font-semibold px-3 py-2 rounded-t-lg border-b-2 ${tab === k ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{l}</button>
          ))}
        </div>
        <div className="p-5 overflow-auto flex-1">
          {tab === 'dashboard' && <Dashboard org={orgScope} onGo={go} />}
          {tab === 'scorecard' && <InventoryScorecard org={orgScope} />}
          {tab === 'reports' && <Reports id={report} onPick={setReport} org={orgScope} role={role} />}
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ───────────────────────────────────────────────────────────────
function Dashboard({ org, onGo }: { org: boolean; onGo: (t: string) => void }) {
  const { data, error, reload } = useLoad<any>(() => api.inventory.insights.dashboard(org ? 'org' : undefined), [org]);
  if (error) return <Err msg={error} />;
  if (!data) return <Spin />;
  const K = data.kpis, D = K.discrepancies;
  const tiles: { label: string; value: string; sub?: string; tone?: string; target: string }[] = [
    { label: 'Stock on hand', value: `${num(K.units)} units`, sub: `${num(K.available_units)} available · ${num(K.reserved_units)} reserved`, target: 'reports:current_stock' },
    { label: 'Inventory value', value: money(K.inventory_value), sub: `${K.valuation_method} cost · retail ${money(K.retail_value)}`, target: 'reports:valuation' },
    { label: 'Active products', value: num(K.active_products), sub: `${num(K.products)} in the catalogue`, target: 'reports:current_stock' },
    { label: 'Out of stock', value: num(K.out_of_stock), sub: `${num(K.out_of_stock_with_demand)} with recent sales`, tone: K.out_of_stock ? 'text-red-600' : '', target: 'reports:low_stock' },
    { label: 'Low stock', value: num(K.low_stock), sub: `${num(K.critical)} will run out before resupply`, tone: K.low_stock ? 'text-amber-600' : '', target: 'reports:low_stock' },
    { label: 'Replenishment', value: `${num(K.reorder.items)} to order`, sub: `about ${money(K.reorder.cost)} at cost`, tone: K.reorder.items ? 'text-amber-600' : '', target: 'replenishment' },
    { label: 'Excess stock', value: money(K.excess.value), sub: `${num(K.excess.items)} item(s), ${num(K.excess.units)} units over`, target: 'reports:low_stock' },
    { label: 'Slow & non-moving', value: money(K.slow_moving.value), sub: `${num(K.slow_moving.items)} item(s) · provision ${money(K.slow_moving.provision)}`, target: 'reports:slow_moving' },
    { label: 'Near expiry', value: `${num(K.expiry.near_units)} units`, sub: `${money(K.expiry.near_value)} within ${K.expiry.near_days} days`, tone: K.expiry.near_units ? 'text-amber-600' : '', target: 'reports:batch_expiry' },
    { label: 'Expired', value: `${num(K.expiry.expired_units)} units`, sub: `${money(K.expiry.expired_value)} to dispose or return`, tone: K.expiry.expired_units ? 'text-red-600' : '', target: 'quality' },
    { label: 'Damaged & quarantined', value: `${num(K.quarantine.units)} units`, sub: `${num(K.quarantine.held_units)} more on quality hold`, target: 'quality' },
    { label: 'Pending receipts', value: `${num(K.pending_receipts.orders)} order(s)`, sub: `${num(K.pending_receipts.units)} units · ${num(K.pending_receipts.overdue)} overdue`, tone: K.pending_receipts.overdue ? 'text-amber-600' : '', target: 'reports:demand_replenishment' },
    { label: 'Pending transfers', value: `${num(K.pending_transfers.transfers)} in transit`, sub: `${num(K.pending_transfers.units)} units · ${num(K.pending_transfers.overdue)} overdue`, tone: K.pending_transfers.overdue ? 'text-red-600' : '', target: 'warehouse' },
    { label: 'Discrepancies', value: num(D.total), sub: `${num(D.count_variance_lines)} count variance · ${num(D.ledger_mismatches + D.location_mismatches)} record mismatch`, tone: D.total ? 'text-amber-600' : '', target: 'reports:count_variance' },
    { label: 'Awaiting approval', value: num(K.pending_approvals), sub: 'stock adjustments', tone: K.pending_approvals ? 'text-amber-600' : '', target: 'approvals' },
  ];
  const max = Math.max(1, ...data.trend.map((t: any) => Math.max(t.units_in, t.units_out)));
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500">{data.scope === 'organisation' ? 'All branches' : 'This branch'} · updated {new Date(data.generated_at).toLocaleTimeString()}</p>
        <button className={btn} onClick={reload}><RefreshCw size={12} />Refresh</button>
      </div>

      <section aria-label="Needs attention">
        <h4 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-2"><AlertTriangle size={14} className="text-amber-500" />Needs attention
          <span className="text-[11px] font-normal text-slate-500">{data.exception_counts.critical} critical · {data.exception_counts.warning} warning · {data.exception_counts.info} for information</span></h4>
        {!data.exceptions.length ? <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">No exceptions. Stock is healthy.</p> : (
          <ul className="space-y-2">
            {data.exceptions.map((e: any) => (
              <li key={e.id} className={`border rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-3 ${SEV[e.severity]}`}>
                <span className={`text-[10px] font-bold uppercase rounded px-1.5 py-0.5 ${SEV_CHIP[e.severity]}`}>{e.severity}</span>
                <div className="flex-1 min-w-[220px]"><p className="text-sm font-semibold text-slate-900">{e.title} <span className="text-slate-500 font-normal">({num(e.count)})</span></p><p className="text-xs text-slate-600">{e.detail}</p></div>
                {e.value > 0 && <span className="text-xs font-semibold text-slate-700">{money(e.value)}</span>}
                <button className={btn} onClick={() => onGo(e.target)}>{e.target.startsWith('reports:') ? 'View report' : 'Open'}</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Key figures">
        <h4 className="text-sm font-bold text-slate-900 mb-2">Key figures</h4>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
          {tiles.map(t => (
            <button key={t.label} onClick={() => onGo(t.target)} className="text-left bg-white border border-slate-200 hover:border-teal-400 rounded-xl px-3 py-2.5 transition-colors">
              <p className="text-[11px] text-slate-500">{t.label}</p>
              <p className={`text-base font-bold ${t.tone || 'text-slate-900'}`}>{t.value}</p>
              {t.sub && <p className="text-[11px] text-slate-500 leading-snug">{t.sub}</p>}
            </button>
          ))}
        </div>
      </section>

      <div className="grid lg:grid-cols-2 gap-6">
        <section aria-label="Stock movement">
          <h4 className="text-sm font-bold text-slate-900 mb-2">Stock movement, last 14 days <span className="text-[11px] font-normal text-slate-500">(units; transfers excluded)</span></h4>
          <svg viewBox="0 0 280 90" className="w-full h-28" role="img" aria-label="Units in and out per day">
            {data.trend.map((t: any, i: number) => {
              const x = i * 20 + 2, hi = (t.units_in / max) * 70, ho = (t.units_out / max) * 70;
              return (<g key={t.day}><title>{`${t.day}: ${t.units_in} in, ${t.units_out} out`}</title>
                <rect x={x} y={78 - hi} width={8} height={hi} className="fill-emerald-500" rx={1} />
                <rect x={x + 9} y={78 - ho} width={8} height={ho} className="fill-rose-400" rx={1} />
                {i % 3 === 0 && <text x={x} y={88} fontSize={6} className="fill-slate-400">{t.day.slice(5)}</text>}</g>);
            })}
            <line x1={0} y1={78} x2={280} y2={78} className="stroke-slate-200" strokeWidth={0.5} />
          </svg>
          <p className="text-[11px] text-slate-500"><span className="inline-block w-2 h-2 bg-emerald-500 rounded-sm mr-1" />In <span className="inline-block w-2 h-2 bg-rose-400 rounded-sm mx-1 ml-3" />Out</p>
        </section>
        <section aria-label="Recent movements">
          <div className="flex items-center justify-between mb-2"><h4 className="text-sm font-bold text-slate-900">Recent stock movements</h4><button className={btn} onClick={() => onGo('reports:movement_ledger')}>Full ledger</button></div>
          {!data.recent_movements.length ? <Empty>No movements yet.</Empty> : (
            <table className="w-full text-xs"><tbody>
              {data.recent_movements.map((m: any) => (
                <tr key={m.id} className="border-t border-slate-100"><td className="py-1 text-slate-500 whitespace-nowrap">{String(m.created_at).slice(5, 16).replace('T', ' ')}</td><td className="truncate max-w-[180px]">{String(m.item_name).trim()}</td>
                  <td className="text-slate-500">{m.reason_label}</td><td className={`text-right font-semibold ${m.qty_change < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{m.qty_change > 0 ? '+' : ''}{m.qty_change}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>
        <section aria-label="Items to reorder">
          <div className="flex items-center justify-between mb-2"><h4 className="text-sm font-bold text-slate-900">Most urgent to reorder</h4><button className={btn} onClick={() => onGo('reports:low_stock')}>Report</button></div>
          {!data.low_stock_list.length ? <Empty>Nothing is low.</Empty> : (
            <table className="w-full text-xs"><tbody>
              {data.low_stock_list.map((x: any) => (
                <tr key={x.tire_id} className="border-t border-slate-100"><td className="py-1 truncate max-w-[200px]">{x.item_name}</td><td className={`font-semibold ${STATUS_TONE[x.status] ?? ''}`}>{label(x.status)}</td>
                  <td className="text-right text-slate-500">{x.available} / {x.reorder_point}</td><td className="text-right text-slate-500">{x.days_of_cover != null ? `${x.days_of_cover}d` : '—'}</td></tr>
              ))}
            </tbody></table>
          )}
          <p className="text-[11px] text-slate-400 mt-1">Available / reorder point, days of cover.</p>
        </section>
        <section aria-label="Expiring batches">
          <div className="flex items-center justify-between mb-2"><h4 className="text-sm font-bold text-slate-900">Expired and expiring batches</h4><button className={btn} onClick={() => onGo('reports:batch_expiry')}>Report</button></div>
          {!data.expiring_list.length ? <Empty>No batches near expiry.</Empty> : (
            <table className="w-full text-xs"><tbody>
              {data.expiring_list.map((x: any) => (
                <tr key={x.batch_id} className="border-t border-slate-100"><td className="py-1 truncate max-w-[180px]">{String(x.item_name).trim()}</td><td className="text-slate-500">{x.batch_no}</td>
                  <td className={`font-semibold ${x.days_left < 0 ? 'text-red-600' : 'text-amber-600'}`}>{x.days_left < 0 ? `expired ${-x.days_left}d ago` : `${x.days_left}d left`}</td><td className="text-right text-slate-500">{num(x.qty)}</td></tr>
              ))}
            </tbody></table>
          )}
        </section>
      </div>
      <p className="text-[11px] text-slate-400">{data.note}</p>
    </div>
  );
}

// ── Reports ─────────────────────────────────────────────────────────────────
interface Filters { from: string; to: string; q: string; category: string; supplier: string; location: string; reason: string; cause: string; status: string; class: string; by: string; days: string; entity: string; action: string; include_zero: boolean; variances_only: boolean }
const blank = (): Filters => ({ from: daysAgo(29), to: daysAgo(0), q: '', category: '', supplier: '', location: '', reason: '', cause: '', status: '', class: '', by: '', days: '90', entity: '', action: '', include_zero: false, variances_only: true });
const params = (f: Filters, def: any, org: boolean): Record<string, string | number | undefined> => {
  const used = new Set<string>(def?.filters ?? []);
  const p: Record<string, string | number | undefined> = { scope: org ? 'org' : undefined };
  if (used.has('period')) { p.from = f.from; p.to = f.to; }
  for (const k of ['q', 'category', 'supplier', 'location', 'reason', 'cause', 'status', 'class', 'by', 'days', 'entity', 'action'] as const) if (used.has(k) && f[k]) p[k] = f[k];
  if (used.has('include_zero') && f.include_zero) p.include_zero = 1;
  if (used.has('variances_only') && !f.variances_only) p.variances_only = 0;
  return p;
};

function Reports({ id, onPick, org, role }: { id: string; onPick: (id: string) => void; org: boolean; role?: string }) {
  const defs = useLoad<any[]>(() => api.inventory.insights.reports(), []);
  const cats = useLoad<any[]>(() => api.inventory.categories(), []);
  const locs = useLoad<any[]>(() => api.inventory.locations(), []);
  const sups = useLoad<any[]>(() => api.suppliers.list() as Promise<any[]>, []);
  const [f, setF] = useState<Filters>(blank());
  const [applied, setApplied] = useState<Filters>(f);
  const [rep, setRep] = useState<ReportResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const seq = useRef(0);
  const def = (defs.data ?? []).find(d => d.id === id);
  const used = new Set<string>(def?.filters ?? []);
  const set = (patch: Partial<Filters>) => setF(x => ({ ...x, ...patch }));

  // switching report resets the report-specific filters but keeps the period and search
  useEffect(() => { setF(x => ({ ...blank(), from: x.from, to: x.to, q: x.q })); }, [id]);
  const run = useCallback((flt: Filters) => {
    if (!def) return;
    const n = ++seq.current;
    setLoading(true); setError('');
    api.inventory.insights.report(id, params(flt, def, org)).then(r => { if (n === seq.current) { setRep(r); setApplied(flt); } })
      .catch(e => { if (n === seq.current) { setError(e.message); setRep(null); } }).finally(() => { if (n === seq.current) setLoading(false); });
  }, [id, def, org]);
  // run when the report (or scope) changes, with the filters as they are right after the reset above
  useEffect(() => { if (def) run(blank()); }, [id, def, org]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportAs = async (kind: 'csv' | 'xlsx' | 'pdf' | 'print') => {
    if (!def) return;
    setBusy(kind); setError('');
    try {
      const p = params(applied, def, org);
      if (kind === 'csv') await api.inventory.insights.downloadCsv(id, p);
      else {
        const full = (await api.inventory.insights.report(id, { ...p, export: kind })) as ReportResult;
        if (kind === 'xlsx') exportXlsx(full); else if (kind === 'pdf') exportPdf(full); else printReport(full);
      }
    } catch (e: any) { setError(e.message); } finally { setBusy(''); }
  };

  const shown = rep ? rep.rows.slice(0, 500) : [];
  const align = (c: ReportColumn) => (c.type === 'text' || c.type === 'date' || c.type === 'datetime' ? 'text-left' : 'text-right');
  return (
    <div className="space-y-4">
      <Err msg={defs.error} />
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Reports">
        {(defs.data ?? []).map(d => (
          <button key={d.id} role="tab" aria-selected={d.id === id} onClick={() => onPick(d.id)} title={d.description}
            className={`text-xs font-semibold px-2.5 py-1.5 rounded-lg border ${d.id === id ? 'bg-teal-600 text-white border-teal-600' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}>{d.title.replace(' Report', '')}</button>
        ))}
      </div>
      {def && <p className="text-xs text-slate-500">{def.description}</p>}

      {def && (
        <form className="flex flex-wrap items-end gap-2 bg-slate-50 border border-slate-100 rounded-xl p-3" onSubmit={e => { e.preventDefault(); run(f); }}>
          {used.has('period') && (<>
            <label className="text-[11px] font-semibold text-slate-600">From<input type="date" value={f.from} max={f.to} onChange={e => set({ from: e.target.value })} className={`${input} block !py-1 text-xs`} /></label>
            <label className="text-[11px] font-semibold text-slate-600">To<input type="date" value={f.to} min={f.from} onChange={e => set({ to: e.target.value })} className={`${input} block !py-1 text-xs`} /></label>
            <div className="flex gap-1">{PRESETS.map(([l, d]) => <button key={l} type="button" className={btn} onClick={() => { const nf = { ...f, from: daysAgo(d), to: daysAgo(0) }; setF(nf); run(nf); }}>{l}</button>)}</div>
          </>)}
          {used.has('q') && <label className="text-[11px] font-semibold text-slate-600">Item<input value={f.q} onChange={e => set({ q: e.target.value })} placeholder="Name, SKU or barcode" className={`${input} block !py-1 text-xs w-44`} /></label>}
          {used.has('category') && <label className="text-[11px] font-semibold text-slate-600">Category<select value={f.category} onChange={e => set({ category: e.target.value })} className={`${input} block !py-1 text-xs`}><option value="">All</option>{(cats.data ?? []).map(c => <option key={c.id} value={c.id}>{c.parent_id ? '— ' : ''}{c.name}</option>)}</select></label>}
          {used.has('supplier') && <label className="text-[11px] font-semibold text-slate-600">Supplier<select value={f.supplier} onChange={e => set({ supplier: e.target.value })} className={`${input} block !py-1 text-xs`}><option value="">All</option>{(sups.data ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
          {used.has('location') && <label className="text-[11px] font-semibold text-slate-600">Location<select value={f.location} onChange={e => set({ location: e.target.value })} className={`${input} block !py-1 text-xs`}><option value="">All</option>{(locs.data ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>}
          {used.has('by') && <label className="text-[11px] font-semibold text-slate-600">View<select value={f.by} onChange={e => set({ by: e.target.value })} className={`${input} block !py-1 text-xs`}>{(BY_OPTIONS[id] ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
          {used.has('status') && <label className="text-[11px] font-semibold text-slate-600">Show<select value={f.status} onChange={e => set({ status: e.target.value })} className={`${input} block !py-1 text-xs`}>{(STATUS_OPTIONS[id] ?? []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
          {used.has('class') && <label className="text-[11px] font-semibold text-slate-600">Class<select value={f.class} onChange={e => set({ class: e.target.value })} className={`${input} block !py-1 text-xs`}><option value="">Slow, non-moving, obsolete</option><option value="slow">Slow</option><option value="non_moving">Non-moving</option><option value="obsolete">Obsolete</option><option value="all">All items</option></select></label>}
          {used.has('days') && <label className="text-[11px] font-semibold text-slate-600">Expiring within (days)<input type="number" min={1} max={3650} value={f.days} onChange={e => set({ days: e.target.value })} className={`${input} block !py-1 text-xs w-24`} /></label>}
          {used.has('reason') && <label className="text-[11px] font-semibold text-slate-600">Reason<select value={f.reason} onChange={e => set({ reason: e.target.value })} className={`${input} block !py-1 text-xs`}><option value="">All</option>{REASONS.map(r => <option key={r} value={r}>{label(r)}</option>)}</select></label>}
          {used.has('cause') && <label className="text-[11px] font-semibold text-slate-600">Cause<select value={f.cause} onChange={e => set({ cause: e.target.value })} className={`${input} block !py-1 text-xs`}><option value="">All</option>{CAUSES.map(r => <option key={r} value={r}>{label(r)}</option>)}</select></label>}
          {used.has('entity') && <label className="text-[11px] font-semibold text-slate-600">Record<select value={f.entity} onChange={e => set({ entity: e.target.value })} className={`${input} block !py-1 text-xs`}><option value="">All</option>{['inventory', 'stock_adjustment', 'stock_transfer', 'stock_count', 'stock_reservation', 'stock_location', 'warehouse', 'location_access', 'valuation_adjustment', 'rotation_policy'].map(r => <option key={r} value={r}>{label(r)}</option>)}</select></label>}
          {used.has('action') && <label className="text-[11px] font-semibold text-slate-600">Action<select value={f.action} onChange={e => set({ action: e.target.value })} className={`${input} block !py-1 text-xs`}><option value="">All</option><option value="CREATE">Create</option><option value="UPDATE">Update</option><option value="DELETE">Delete</option></select></label>}
          {used.has('include_zero') && <label className="text-xs text-slate-700 flex items-center gap-1.5 pb-1.5"><input type="checkbox" checked={f.include_zero} onChange={e => set({ include_zero: e.target.checked })} />Include zero stock</label>}
          {used.has('variances_only') && <label className="text-xs text-slate-700 flex items-center gap-1.5 pb-1.5"><input type="checkbox" checked={f.variances_only} onChange={e => set({ variances_only: e.target.checked })} />Variances only</label>}
          <button className={primary} disabled={loading}>{loading ? 'Running…' : 'Run report'}</button>
        </form>
      )}

      <Err msg={error} />
      {loading && !rep && <Spin />}
      {rep && (
        <div className={`space-y-3 ${loading ? 'opacity-60' : ''}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h4 className="text-sm font-bold text-slate-900">{rep.title}</h4>
              <p className="text-[11px] text-slate-500">{def?.filters.includes('period') ? `${applied.from} to ${applied.to} · ` : ''}{rep.scope === 'organisation' ? 'All branches' : 'This branch'} · {num(rep.row_count)} row(s) · generated {new Date(rep.generated_at).toLocaleString()}</p>
            </div>
            <div className="flex flex-wrap gap-1.5" aria-label="Export">
              <button className={btn} disabled={!!busy} onClick={() => exportAs('csv')}><Download size={12} />CSV</button>
              <button className={btn} disabled={!!busy} onClick={() => exportAs('xlsx')}><FileSpreadsheet size={12} />Excel</button>
              <button className={btn} disabled={!!busy} onClick={() => exportAs('pdf')}><FileText size={12} />PDF</button>
              <button className={btn} disabled={!!busy} onClick={() => exportAs('print')}><Printer size={12} />Print</button>
              {busy && <Loader2 size={14} className="animate-spin text-slate-400 self-center" />}
            </div>
          </div>
          {rep.summary.length > 0 && (
            <div className="flex flex-wrap gap-2">{rep.summary.map(s => <div key={s.label} className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-1.5"><p className="text-[11px] text-slate-500">{s.label}</p><p className="text-sm font-bold text-slate-900">{s.money ? money(Number(s.value)) : typeof s.value === 'number' ? num(s.value) : s.value}</p></div>)}</div>
          )}
          {rep.breakdown.length > 0 && (
            <div className="flex flex-wrap gap-1.5">{rep.breakdown.map(b => <span key={b.label} className="text-[11px] bg-teal-50 text-teal-800 border border-teal-100 rounded-full px-2.5 py-1">{b.label}: {b.units != null ? `${num(b.units)} units` : ''}{b.value != null ? ` · ${money(b.value)}` : ''}{b.share != null ? ` (${b.share}%)` : ''}</span>)}</div>
          )}
          {rep.truncated && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Showing the first {num(rep.row_count)} rows. Narrow the filters, or export for the full report.</p>}
          {!rep.rows.length ? <Empty>No data for these filters.</Empty> : (
            <div className="overflow-auto border border-slate-200 rounded-xl max-h-[48vh]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-100 z-10"><tr>{rep.columns.map(c => <th key={c.key} className={`px-2.5 py-2 font-semibold text-slate-600 whitespace-nowrap ${align(c)}`}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {shown.map((row, i) => (
                    <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                      {rep.columns.map(c => <td key={c.key} className={`px-2.5 py-1.5 ${align(c)} ${c.type === 'text' ? '' : 'whitespace-nowrap'} ${c.key === 'variance' || c.key === 'qty_change' || c.key === 'variance_value' ? (Number(row[c.key]) < 0 ? 'text-rose-600' : Number(row[c.key]) > 0 ? 'text-emerald-600' : '') : ''}`}>{cellDisplay(c, row[c.key])}</td>)}
                    </tr>
                  ))}
                </tbody>
                {Object.keys(rep.totals).length > 0 && (
                  <tfoot className="sticky bottom-0 bg-slate-100 font-bold"><tr>{rep.columns.map((c, i) => <td key={c.key} className={`px-2.5 py-2 ${align(c)}`}>{i === 0 ? 'Total' : rep.totals[c.key] !== undefined ? cellDisplay(c, rep.totals[c.key]) : ''}</td>)}</tr></tfoot>
                )}
              </table>
            </div>
          )}
          {rep.rows.length > shown.length && <p className="text-[11px] text-slate-500">Showing {num(shown.length)} of {num(rep.rows.length)} rows. Export for all rows.</p>}
          {rep.notes.length > 0 && <ul className="text-[11px] text-slate-400 list-disc pl-4 space-y-0.5">{rep.notes.map(n => <li key={n}>{n}</li>)}</ul>}
        </div>
      )}
      {!def && !defs.error && <Spin />}
      {role === 'demo' && <p className="text-[11px] text-slate-400">Demo mode: reports are read-only.</p>}
    </div>
  );
}
