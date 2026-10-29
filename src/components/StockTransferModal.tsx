import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Loader2, Plus, Trash2, X } from 'lucide-react';
import { api } from '../api/client';
import { useTerms } from '../lib/businessTypes';

interface Loc { id: number; name: string; is_default: boolean; is_active: boolean }
interface Line { tire_id: string; qty: string }
interface Props { onClose: () => void; onDone: () => void; initialTireId?: number }

export default function StockTransferModal({ onClose, onDone, initialTireId }: Props) {
  const terms = useTerms();
  const [locs, setLocs]     = useState<Loc[]>([]);
  const [from, setFrom]     = useState('');
  const [to, setTo]         = useState('');
  const [avail, setAvail]   = useState<{ tire_id: number; qty: number }[]>([]);
  const [items, setItems]   = useState<any[]>([]);
  const [lines, setLines]   = useState<Line[]>([{ tire_id: initialTireId ? String(initialTireId) : '', qty: '1' }]);
  const [notes, setNotes]   = useState('');
  const [inTransit, setInTransit] = useState(false);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');
  const [done, setDone]     = useState('');

  useEffect(() => {
    api.inventory.locations().then(ls => {
      const active = ls.filter(l => l.is_active);
      setLocs(active);
      setFrom(String(active.find(l => l.is_default)?.id ?? active[0]?.id ?? ''));
      setTo(String(active.find(l => !l.is_default)?.id ?? ''));
    }).catch(e => setError(e.message));
    api.inventory.list().then(setItems).catch(() => {});
  }, []);

  // Items with stock at the source location, and how many.
  useEffect(() => {
    if (!from) return;
    api.inventory.stockByLocation({ location_id: Number(from) }).then(r => setAvail(r)).catch(() => setAvail([]));
  }, [from]);
  const availMap = useMemo(() => new Map(avail.map(a => [a.tire_id, a.qty])), [avail]);
  const options = useMemo(() => items.filter(i => (availMap.get(i.id) ?? 0) > 0), [items, availMap]);
  const nameOf = (i: any) => [i.brand, i.model, i.size].map((p: string) => (p ?? '').trim()).filter(Boolean).join(' ');

  const setLine = (i: number, patch: Partial<Line>) => setLines(ls => ls.map((l, n) => n === i ? { ...l, ...patch } : l));
  const valid = from && to && from !== to && lines.length > 0 && lines.every(l => {
    const q = Number(l.qty), a = availMap.get(Number(l.tire_id)) ?? 0;
    return l.tire_id && Number.isInteger(q) && q > 0 && q <= a;
  }) && new Set(lines.map(l => l.tire_id)).size === lines.length;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.inventory.transfer({
        from_location_id: Number(from), to_location_id: Number(to), notes: notes.trim() || undefined, in_transit: inTransit || undefined,
        items: lines.map(l => ({ tire_id: Number(l.tire_id), qty: Number(l.qty) })),
      }, `trf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      setDone(inTransit ? `Transfer ${r.transferNo} dispatched. Receive it in Stock Control › In transit.` : `Transfer ${r.transferNo} completed.`);
      setTimeout(() => { onDone(); onClose(); }, 1200);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  const sel = 'w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><ArrowRightLeft size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Transfer Stock</h3>
              <p className="text-xs text-slate-500">Move {terms.items.toLowerCase()} between locations of this branch.</p>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-auto">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">From</label>
              <select value={from} onChange={e => { setFrom(e.target.value); setLines([{ tire_id: '', qty: '1' }]); }} className={sel}>
                {locs.map(l => <option key={l.id} value={l.id}>{l.name}{l.is_default ? ' (default)' : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">To</label>
              <select value={to} onChange={e => setTo(e.target.value)} className={sel}>
                <option value="">Select…</option>
                {locs.filter(l => String(l.id) !== from).map(l => <option key={l.id} value={l.id}>{l.name}{l.is_default ? ' (default)' : ''}</option>)}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">{terms.items}</label>
            {lines.map((l, i) => {
              const a = availMap.get(Number(l.tire_id)) ?? 0;
              return (
                <div key={i} className="flex items-center gap-2">
                  <select value={l.tire_id} onChange={e => setLine(i, { tire_id: e.target.value })} className={`${sel} flex-1 min-w-0`}>
                    <option value="">{options.length ? `Select ${terms.item.toLowerCase()}…` : 'No stock at the source location'}</option>
                    {options.filter(o => String(o.id) === l.tire_id || !lines.some(x => x.tire_id === String(o.id))).map(o =>
                      <option key={o.id} value={o.id}>{nameOf(o)} — {availMap.get(o.id)} available</option>)}
                  </select>
                  <input type="number" min={1} max={a || undefined} value={l.qty} onChange={e => setLine(i, { qty: e.target.value })}
                    className="w-20 text-sm border border-slate-200 rounded-xl px-2 py-2.5 text-center focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
                  <button onClick={() => setLines(ls => ls.length > 1 ? ls.filter((_, n) => n !== i) : ls)} disabled={lines.length === 1}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg disabled:opacity-30"><Trash2 size={14} /></button>
                </div>
              );
            })}
            <button onClick={() => setLines(ls => [...ls, { tire_id: '', qty: '1' }])} className="flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline"><Plus size={12} /> Add line</button>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Notes</label>
            <input value={notes} onChange={e => setNotes(e.target.value)} maxLength={500} className={sel} />
          </div>

          <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
            <input type="checkbox" checked={inTransit} onChange={e => setInTransit(e.target.checked)} className="mt-0.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
            <span><span className="font-semibold">Send as in transit</span> — stock leaves the source now and arrives at the destination only when someone receives it.</span>
          </label>

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          {done && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">{done}</p>}
        </div>

        <div className="flex gap-2 px-5 pb-5">
          <button onClick={onClose} disabled={busy} className="flex-1 px-4 py-2.5 text-sm font-medium border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={submit} disabled={busy || !valid || !!done}
            className="flex-1 px-4 py-2.5 text-sm font-semibold bg-teal-600 text-white rounded-xl hover:bg-teal-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {busy && <Loader2 size={14} className="animate-spin" />} {inTransit ? 'Dispatch' : 'Transfer'}
          </button>
        </div>
      </div>
    </div>
  );
}
