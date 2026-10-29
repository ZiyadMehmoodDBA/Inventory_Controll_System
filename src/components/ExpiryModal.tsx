import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Loader2, X } from 'lucide-react';
import { api } from '../api/client';
import { useTerms } from '../lib/businessTypes';

interface Row { batch_id: number; tire_id: number; item_name: string; batch_no: string; expiry_date: string; days_to_expiry: number; qty: number; value: number }
interface Props { onClose: () => void }

export default function ExpiryModal({ onClose }: Props) {
  const terms = useTerms();
  const [days, setDays]       = useState(30);
  const [data, setData]       = useState<{ expired: Row[]; expiring: Row[]; expired_units: number; expiring_units: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [q, setQ]               = useState('');
  const [trace, setTrace]       = useState<any[] | null>(null);
  const [tracing, setTracing]   = useState(false);
  const runTrace = async () => {
    if (!q.trim()) { setTrace(null); return; }
    setTracing(true); setError('');
    try { setTrace((await api.inventory.trace(q.trim())).matches); } catch (e: any) { setError(e.message); } finally { setTracing(false); }
  };

  const load = useCallback(async (d: number) => {
    setLoading(true); setError('');
    try { setData(await api.inventory.expiry(d)); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(days); }, [days, load]);

  const table = (rows: Row[], tone: string, empty: string) => rows.length === 0
    ? <p className="px-5 py-4 text-xs text-slate-400">{empty}</p>
    : (
      <table className="w-full text-xs">
        <thead><tr className="text-left text-slate-400 uppercase tracking-wide">
          <th className="px-5 py-2 font-semibold">{terms.item}</th><th className="px-3 py-2 font-semibold">Batch</th>
          <th className="px-3 py-2 font-semibold">Expires</th><th className="px-3 py-2 font-semibold text-right">Units</th>
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map(r => (
            <tr key={r.batch_id}>
              <td className="px-5 py-2 font-medium text-slate-800">{r.item_name.trim()}</td>
              <td className="px-3 py-2 font-mono text-slate-500">{r.batch_no}</td>
              <td className={`px-3 py-2 whitespace-nowrap font-semibold ${tone}`}>
                {String(r.expiry_date).slice(0, 10)} · {r.days_to_expiry < 0 ? `${-r.days_to_expiry}d ago` : r.days_to_expiry === 0 ? 'today' : `in ${r.days_to_expiry}d`}
              </td>
              <td className="px-3 py-2 text-right font-semibold text-slate-800">{r.qty}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center"><CalendarClock size={18} className="text-amber-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Expiry Report</h3>
              <p className="text-xs text-slate-500">Expired stock cannot be sold. Write it off with Adjust Stock → Expired / obsolete.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-100 text-xs text-slate-600">
          Expiring within
          <select value={days} onChange={e => setDays(Number(e.target.value))} className="border border-slate-200 rounded-lg px-2 py-1 bg-slate-50">
            {[7, 14, 30, 60, 90, 180].map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
        </div>

        <form className="flex items-center gap-2 px-5 py-3 border-b border-slate-100" onSubmit={e => { e.preventDefault(); runTrace(); }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Trace a batch or serial number" maxLength={60}
            className="flex-1 min-w-0 text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-teal-500" />
          <button type="submit" disabled={tracing || !q.trim()} className="text-xs font-semibold px-3 py-2 rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">{tracing ? 'Searching…' : 'Trace'}</button>
          {trace && <button type="button" onClick={() => { setTrace(null); setQ(''); }} className="text-xs text-slate-500 hover:text-slate-800">Clear</button>}
        </form>

        {trace && (
          <div className="px-5 py-3 border-b border-slate-100 space-y-3 max-h-64 overflow-auto bg-slate-50/50">
            {!trace.length && <p className="text-xs text-slate-500">No batch or serial number "{q}" found.</p>}
            {trace.map((m: any) => (
              <div key={m.batch_id} className="text-xs">
                <p className="font-semibold text-slate-800">{m.item_name} · <span className="font-mono">{m.batch_no}</span>
                  <span className="font-normal text-slate-500"> · {m.on_hand} on hand{m.expiry_date ? ` · expires ${String(m.expiry_date).slice(0, 10)}` : ''}</span></p>
                <ul className="mt-1 space-y-0.5 text-slate-600">
                  {m.movements.map((v: any) => (
                    <li key={v.id}>{String(v.created_at).slice(0, 10)} · {v.reason.replace(/_/g, ' ')} · <b className={v.qty_change < 0 ? 'text-red-600' : 'text-emerald-600'}>{v.qty_change > 0 ? '+' : ''}{v.qty_change}</b>{v.reference ? ` · ${v.reference}` : ''}{v.location_name ? ` · ${v.location_name}` : ''}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="overflow-auto flex-1">
          {loading && <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>}
          {error && <p className="m-5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          {data && !loading && (
            <>
              <h4 className="px-5 pt-4 pb-1 text-xs font-bold text-red-600 uppercase tracking-wider">Expired · {data.expired_units} unit{data.expired_units === 1 ? '' : 's'}</h4>
              {table(data.expired, 'text-red-600', 'Nothing has expired.')}
              <h4 className="px-5 pt-4 pb-1 text-xs font-bold text-amber-600 uppercase tracking-wider">Expiring soon · {data.expiring_units} unit{data.expiring_units === 1 ? '' : 's'}</h4>
              {table(data.expiring, 'text-amber-600', `Nothing expires in the next ${days} days.`)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
