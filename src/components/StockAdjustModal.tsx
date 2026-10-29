import { useEffect, useState } from 'react';
import { Loader2, X, SlidersHorizontal } from 'lucide-react';
import { api } from '../api/client';

interface Reason { code: string; label: string; direction: 'in' | 'out' | 'any' }
interface Props {
  tire: { id: number; brand: string; model: string; size: string; stock: number; tracking?: 'none' | 'batch' | 'serial'; track_expiry?: boolean | number };
  onClose: () => void;
  onDone: () => void;
}

export default function StockAdjustModal({ tire, onClose, onDone }: Props) {
  const [reasons, setReasons] = useState<Reason[]>([]);
  const [code, setCode]       = useState('count_correction');
  const [mode, setMode]       = useState<'change' | 'count'>('change');
  const [value, setValue]     = useState('');
  const [notes, setNotes]     = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');
  const [result, setResult]   = useState<'approved' | 'pending' | null>(null);
  const [locs, setLocs]       = useState<{ id: number; name: string; is_default: boolean }[]>([]);
  const [locId, setLocId]     = useState('');
  const [byLoc, setByLoc]     = useState<{ location_id: number; qty: number }[]>([]);
  const [batches, setBatches] = useState<{ batch_id: number; batch_no: string; expiry_date: string | null; location_id: number; qty: number; days_to_expiry: number | null }[]>([]);
  const [batchId, setBatchId] = useState('');
  const [newBatch, setNewBatch] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const tracked = !!tire.tracking && tire.tracking !== 'none';

  useEffect(() => { api.inventory.adjustmentReasons().then(setReasons).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    api.inventory.locations().then(ls => {
      const active = ls.filter((l: any) => l.is_active);
      setLocs(active);
      setLocId(String(active.find((l: any) => l.is_default)?.id ?? active[0]?.id ?? ''));
    }).catch(() => {});
    api.inventory.stockByLocation({ tire_id: tire.id }).then(setByLoc).catch(() => {});
    if (tire.tracking && tire.tracking !== 'none') api.inventory.batches({ tire_id: tire.id }).then(setBatches).catch(() => {});
  }, [tire.id, tire.tracking]);
  // On-hand shown against the chosen location when there are several.
  const onHand = locs.length > 1 ? (byLoc.find(b => String(b.location_id) === locId)?.qty ?? 0) : tire.stock;

  const reason = reasons.find(r => r.code === code);
  const entered = value === '' ? NaN : Number(value);
  // "count" mode: enter the counted quantity and the change is derived.
  const delta = mode === 'count' ? entered - onHand : (reason?.direction === 'out' ? -Math.abs(entered) : reason?.direction === 'in' ? Math.abs(entered) : entered);
  const valid0 = Number.isInteger(delta) && delta !== 0 && !(reason?.code === 'other' && !notes.trim());

  const locBatches = batches.filter(b => locs.length <= 1 || String(b.location_id) === locId);
  const needsNewBatch = tracked && delta > 0;
  const batchOk = !needsNewBatch || (newBatch.trim() && (!tire.track_expiry || newExpiry || batches.some(b => b.batch_no === newBatch.trim())));

  const valid = valid0 && !!batchOk;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.inventory.adjust({ tire_id: tire.id, qty_change: delta, reason_code: code, notes: notes.trim() || undefined, location_id: locs.length > 1 && locId ? Number(locId) : undefined,
        ...(tracked && delta < 0 && batchId ? { batch_id: Number(batchId) } : {}),
        ...(needsNewBatch ? { batch_no: newBatch.trim(), expiry_date: newExpiry || undefined } : {}) });
      setResult(r.status);
      setTimeout(() => { onDone(); onClose(); }, 1400);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-start justify-between p-5 pb-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><SlidersHorizontal size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Adjust Stock</h3>
              <p className="text-xs text-slate-500">{tire.brand} {tire.model} {tire.size} · on hand {onHand}{locs.length > 1 ? ' here' : ''}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex gap-1 bg-slate-100 rounded-xl p-1 text-xs font-semibold">
            {([['change', 'Enter change'], ['count', 'Enter counted qty']] as const).map(([m, label]) => (
              <button key={m} onClick={() => { setMode(m); setValue(''); }}
                className={`flex-1 py-1.5 rounded-lg ${mode === m ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'}`}>{label}</button>
            ))}
          </div>

          {locs.length > 1 && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Location</label>
              <select value={locId} onChange={e => setLocId(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50">
                {locs.map(l => <option key={l.id} value={l.id}>{l.name}{l.is_default ? ' (default)' : ''}</option>)}
              </select>
            </div>
          )}

          {tracked && delta < 0 && (
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">{tire.tracking === 'serial' ? 'Serial number' : 'Batch'}</label>
              <select value={batchId} onChange={e => setBatchId(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50">
                <option value="">Automatic — earliest expiry first</option>
                {locBatches.map(b => (
                  <option key={b.batch_id + ':' + b.location_id} value={b.batch_id}>
                    {b.batch_no} · {b.qty} on hand{b.expiry_date ? ` · exp ${String(b.expiry_date).slice(0, 10)}${b.days_to_expiry != null && b.days_to_expiry < 0 ? ' (EXPIRED)' : ''}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          {needsNewBatch && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">{tire.tracking === 'serial' ? 'Serial number' : 'Batch / lot no.'}</label>
                <input value={newBatch} onChange={e => setNewBatch(e.target.value)} maxLength={60} list="adj-batches"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
                <datalist id="adj-batches">{batches.map(b => <option key={b.batch_id} value={b.batch_no} />)}</datalist>
              </div>
              {tire.tracking === 'batch' && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Expiry{tire.track_expiry ? '' : ' (optional)'}</label>
                  <input type="date" value={newExpiry} onChange={e => setNewExpiry(e.target.value)}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Reason</label>
            <select value={code} onChange={e => setCode(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50">
              {reasons.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              {mode === 'count' ? 'Counted quantity' : reason?.direction === 'any' ? 'Change (+ adds, − removes)' : 'Quantity'}
            </label>
            <input type="number" value={value} onChange={e => setValue(e.target.value)} min={mode === 'count' ? 0 : undefined}
              className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
            {Number.isFinite(delta) && delta !== 0 && (
              <p className="text-xs mt-1 text-slate-500">
                Stock changes by <b className={delta < 0 ? 'text-red-600' : 'text-emerald-600'}>{delta > 0 ? `+${delta}` : delta}</b> → {onHand + delta} on hand
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Notes{code === 'other' ? ' (required)' : ''}</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} maxLength={500}
              className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 resize-none" />
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          {result && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              {result === 'pending' ? 'Submitted for approval. Stock changes once a manager approves it.' : 'Adjustment posted and logged.'}
            </p>
          )}
        </div>

        <div className="flex gap-2 px-5 pb-5">
          <button onClick={onClose} disabled={busy} className="flex-1 px-4 py-2.5 text-sm font-medium border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={submit} disabled={busy || !valid || !!result}
            className="flex-1 px-4 py-2.5 text-sm font-semibold bg-teal-600 text-white rounded-xl hover:bg-teal-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {busy && <Loader2 size={14} className="animate-spin" />} Post Adjustment
          </button>
        </div>
      </div>
    </div>
  );
}
