import { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, Loader2, X } from 'lucide-react';
import { api } from '../api/client';
import { useTerms } from '../lib/businessTypes';
import { formatCurrency } from '../lib/utils';

type Tab = 'valuation' | 'reorder' | 'margin';
interface Props { onClose: () => void; isAdmin: boolean }

const th = 'px-3 py-2 font-semibold text-left text-slate-400 uppercase tracking-wide text-[11px]';
const td = 'px-3 py-2';

export default function InventoryReportsModal({ onClose, isAdmin }: Props) {
  const terms = useTerms();
  const [tab, setTab]         = useState<Tab>('valuation');
  // Data is tagged with the tab it belongs to, so a tab never renders another tab's payload.
  const [loaded, setLoaded]   = useState<{ kind: Tab; data: any } | null>(null);
  const data = loaded && loaded.kind === tab ? loaded.data : null;
  const reqId = useRef(0);
  const [method, setMethod]   = useState('');
  const [options, setOptions] = useState<{ value: string; label: string; description?: string; needs_ack?: boolean }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = useCallback(async (t: Tab) => {
    const id = ++reqId.current;
    setLoading(true); setError('');
    try {
      const d = await api.inventory.report(t);
      if (id === reqId.current) setLoaded({ kind: t, data: d });
    } catch (e: any) { if (id === reqId.current) setError(e.message); }
    finally { if (id === reqId.current) setLoading(false); }
  }, []);
  useEffect(() => { load(tab); }, [tab, load]);
  useEffect(() => { api.inventory.valuationMethod().then(r => { setMethod(r.method); setOptions(r.options); }).catch(() => {}); }, []);

  const changeMethod = async (m: string) => {
    setError('');
    try {
      const opt = options.find(o => o.value === m);
      let ack = false;
      if (opt?.needs_ack) {
        if (!window.confirm(`${opt.label}\n\n${opt.description}\n\nThis changes cost of goods sold and stock value only; physical picking order is set separately. Enable it?`)) return;
        ack = true;
      }
      await api.inventory.setValuationMethod(m, { acknowledge_legal: ack });
      setMethod(m); load(tab);
    }
    catch (e: any) { setError(e.message); }
  };

  const tabBtn = (t: Tab, label: string) => (
    <button key={t} onClick={() => setTab(t)}
      className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${tab === t ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>
  );
  const stat = (label: string, value: string) => (
    <div className="rounded-xl border border-slate-200 px-4 py-2.5"><p className="text-[11px] text-slate-400 uppercase font-semibold">{label}</p><p className="text-base font-bold text-slate-900">{value}</p></div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><BarChart3 size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Inventory Reports</h3>
              <p className="text-xs text-slate-500">Stock value, what to reorder, and margin on what you sold.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-b border-slate-100">
          {tabBtn('valuation', 'Stock value')}{tabBtn('reorder', 'Reorder')}{tabBtn('margin', 'Margin (30 days)')}
          {tab === 'valuation' && method && (
            <label className="ml-auto flex items-center gap-2 text-xs text-slate-500">
              Costing
              <select value={method} disabled={!isAdmin} onChange={e => changeMethod(e.target.value)}
                className="border border-slate-200 rounded-lg px-2 py-1 bg-slate-50 text-slate-700 disabled:opacity-60">
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
        </div>

        <div className="overflow-auto flex-1">
          {loading && <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>}
          {error && <p className="m-5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

          {data && tab === 'valuation' && data.totals && (
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {stat('Units on hand', String(data.totals.units))}{stat('Stock value (cost)', formatCurrency(data.totals.value))}{stat('Retail value', formatCurrency(data.totals.retail_value))}
              </div>
              <table className="w-full text-xs">
                <thead><tr><th className={th}>Category</th><th className={`${th} text-right`}>Units</th><th className={`${th} text-right`}>Cost value</th><th className={`${th} text-right`}>Retail value</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.categories.map((c: any) => (
                    <tr key={c.category}><td className={`${td} font-medium text-slate-800`}>{c.category}</td><td className={`${td} text-right`}>{c.units}</td>
                      <td className={`${td} text-right`}>{formatCurrency(c.value)}</td><td className={`${td} text-right text-slate-500`}>{formatCurrency(c.retail_value)}</td></tr>
                  ))}
                </tbody>
              </table>
              <table className="w-full text-xs">
                <thead><tr><th className={th}>{terms.item}</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Unit cost</th><th className={`${th} text-right`}>Value</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((i: any) => (
                    <tr key={i.tire_id}><td className={`${td} text-slate-800`}>{i.item_name}</td><td className={`${td} text-right`}>{i.stock}</td>
                      <td className={`${td} text-right text-slate-500`}>{formatCurrency(i.unit_cost)}</td><td className={`${td} text-right font-semibold`}>{formatCurrency(i.value)}</td></tr>
                  ))}
                  {!data.items.length && <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">No stock on hand.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {data && tab === 'reorder' && data.items && (
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {stat('Need attention', String(data.items.length))}{stat('Out of stock', String(data.out_of_stock))}{stat('Suggested order cost', formatCurrency(data.suggested_cost))}
              </div>
              <table className="w-full text-xs">
                <thead><tr><th className={th}>{terms.item}</th><th className={`${th} text-right`}>Stock</th><th className={`${th} text-right`}>Reorder at</th>
                  <th className={`${th} text-right`}>Sold/30d</th><th className={`${th} text-right`}>Cover</th><th className={`${th} text-right`}>Suggest</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((i: any) => (
                    <tr key={i.tire_id}>
                      <td className={`${td} text-slate-800`}>{i.item_name}{i.status === 'out' && <span className="ml-1.5 text-[10px] font-bold text-red-600">OUT</span>}</td>
                      <td className={`${td} text-right`}>{i.stock}</td><td className={`${td} text-right text-slate-500`}>{i.reorder_level}</td>
                      <td className={`${td} text-right text-slate-500`}>{i.sold_30d}</td>
                      <td className={`${td} text-right text-slate-500`}>{i.days_of_cover == null ? '—' : `${i.days_of_cover}d`}</td>
                      <td className={`${td} text-right font-semibold text-teal-700`}>{i.suggested_qty}</td>
                    </tr>
                  ))}
                  {!data.items.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Everything is above its reorder level.</td></tr>}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-400">Suggestion covers 30 days of recent sales or twice the reorder level, minus stock and open purchase orders.</p>
            </div>
          )}

          {data && tab === 'margin' && data.totals && (
            <div className="p-5 space-y-4">
              <div className="grid grid-cols-4 gap-3">
                {stat('Revenue', formatCurrency(data.totals.revenue))}{stat('Cost of goods', formatCurrency(data.totals.cogs))}
                {stat('Margin', formatCurrency(data.totals.margin))}{stat('Margin %', data.totals.margin_pct == null ? '—' : `${data.totals.margin_pct}%`)}
              </div>
              <table className="w-full text-xs">
                <thead><tr><th className={th}>{terms.item}</th><th className={`${th} text-right`}>Units</th><th className={`${th} text-right`}>Revenue</th>
                  <th className={`${th} text-right`}>Cost</th><th className={`${th} text-right`}>Margin</th><th className={`${th} text-right`}>%</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {data.items.map((i: any) => (
                    <tr key={i.tire_id}><td className={`${td} text-slate-800`}>{i.item_name}</td><td className={`${td} text-right`}>{i.units}</td>
                      <td className={`${td} text-right`}>{formatCurrency(i.revenue)}</td><td className={`${td} text-right text-slate-500`}>{formatCurrency(i.cogs)}</td>
                      <td className={`${td} text-right font-semibold ${i.margin < 0 ? 'text-red-600' : ''}`}>{formatCurrency(i.margin)}</td>
                      <td className={`${td} text-right text-slate-500`}>{i.margin_pct == null ? '—' : `${i.margin_pct}%`}</td></tr>
                  ))}
                  {!data.items.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No sales in this period.</td></tr>}
                </tbody>
              </table>
              <p className="text-[11px] text-slate-400">Cost uses what each sale took out of stock under the current costing method, so it follows your FIFO or average setting.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
