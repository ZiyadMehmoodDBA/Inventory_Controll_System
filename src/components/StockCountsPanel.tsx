import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CheckCircle2, ClipboardList, Loader2, Plus } from 'lucide-react';
import { api } from '../api/client';

interface Line { id: number; tire_id: number; batch_id: number | null; item_name: string; batch_no: string | null; sku: string | null; system_qty: number; counted_qty: number | null; adjustment_id: number | null; adjustment_status: string | null }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';

// Physical stock counts: start a count of a location, enter what was counted, finish to post the differences as adjustments.
export default function StockCountsPanel({ onChanged }: { onChanged: () => void }) {
  const [counts, setCounts] = useState<any[]>([]);
  const [locs, setLocs]     = useState<{ id: number; name: string; is_active: boolean; is_default: boolean }[]>([]);
  const [cats, setCats]     = useState<{ id: number; name: string }[]>([]);
  const [loc, setLoc]       = useState('');
  const [cat, setCat]       = useState('');
  const [notes, setNotes]   = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError]   = useState('');
  const [busy, setBusy]     = useState(false);

  const load = useCallback(() => api.inventory.counts().then(setCounts).catch(e => setError(e.message)), []);
  useEffect(() => {
    load();
    api.inventory.locations().then(ls => { const a = ls.filter(l => l.is_active); setLocs(a); setLoc(String(a.find(l => l.is_default)?.id ?? a[0]?.id ?? '')); }).catch(() => {});
    api.inventory.categories().then(setCats).catch(() => {});
  }, [load]);

  if (openId !== null) return <CountSheet id={openId} onBack={() => { setOpenId(null); load(); }} onChanged={onChanged} />;

  const start = async () => {
    setBusy(true); setError('');
    try {
      const r = await api.inventory.startCount({ location_id: Number(loc), category_id: cat ? Number(cat) : undefined, notes: notes.trim() || undefined });
      setNotes(''); setOpenId(r.id);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 p-3 space-y-2 bg-slate-50/60">
        <p className="text-xs font-semibold text-slate-700">Start a stock count</p>
        <div className="flex flex-wrap gap-2">
          <select value={loc} onChange={e => setLoc(e.target.value)} title="Location to count" className={input}>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <select value={cat} onChange={e => setCat(e.target.value)} title="Limit to a category" className={input}><option value="">All categories</option>{cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" maxLength={500} className={`${input} flex-1 min-w-32`} />
          <button onClick={start} disabled={busy || !loc} className="flex items-center gap-1.5 bg-teal-600 text-white text-sm font-medium px-3 rounded-xl hover:bg-teal-700 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Start count
          </button>
        </div>
        <p className="text-[11px] text-slate-500">Takes a snapshot of what the system says is in the location. Enter the quantities you physically counted, then finish: each difference becomes a stock adjustment (staff counts go to a manager for approval).</p>
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
      <table className="w-full text-xs">
        <thead><tr className="text-left text-slate-500 uppercase tracking-wider"><th className="pb-2">Count</th><th className="pb-2">Location</th><th className="pb-2 text-right">Counted</th><th className="pb-2 text-right">Differences</th><th className="pb-2">Status</th><th /></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {counts.map(c => (
            <tr key={c.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setOpenId(c.id)}>
              <td className="py-2 font-mono text-slate-700">{c.count_no}<span className="block text-[10px] text-slate-400 font-sans">{new Date(c.created_at).toLocaleDateString()}</span></td>
              <td className="py-2">{c.location_name}</td>
              <td className="py-2 text-right">{c.counted}/{c.lines}</td>
              <td className="py-2 text-right">{c.variances}</td>
              <td className="py-2"><span className={`text-[10px] font-bold uppercase rounded-full px-2 py-0.5 ${c.status === 'open' ? 'bg-amber-50 text-amber-700' : c.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{c.status}</span></td>
              <td className="py-2 text-right text-teal-600">Open</td>
            </tr>
          ))}
          {counts.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-slate-400">No counts yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function CountSheet({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const [data, setData]   = useState<any>(null);
  const [vals, setVals]   = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy]   = useState(false);
  const [result, setResult] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [add, setAdd]     = useState({ tire_id: '', batch_id: '', qty: '' });
  const [batches, setBatches] = useState<any[]>([]);

  const load = useCallback(async () => {
    try {
      const d = await api.inventory.count(id);
      setData(d);
      setVals(Object.fromEntries(d.lines.map((l: Line) => [l.id, l.counted_qty === null ? '' : String(l.counted_qty)])));
    } catch (e: any) { setError(e.message); }
  }, [id]);
  useEffect(() => { load(); api.inventory.list().then(setItems).catch(() => {}); }, [load]);
  const open = data?.status === 'open';

  const picked = items.find(i => String(i.id) === add.tire_id);
  useEffect(() => {
    setBatches([]);
    if (picked && picked.tracking && picked.tracking !== 'none') api.inventory.batches({ tire_id: picked.id }).then(setBatches).catch(() => {});
  }, [picked?.id]);   // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => (data?.lines ?? []).filter((l: Line) => (l.counted_qty === null ? '' : String(l.counted_qty)) !== (vals[l.id] ?? '')), [data, vals]);
  const save = async () => {
    if (!dirty.length) return true;
    setBusy(true); setError('');
    try {
      await api.inventory.saveCountLines(id, { lines: dirty.map((l: Line) => ({ id: l.id, counted_qty: vals[l.id] === '' ? null : Number(vals[l.id]) })) });
      await load(); return true;
    } catch (e: any) { setError(e.message); return false; } finally { setBusy(false); }
  };
  const finish = async () => {
    if (!(await save())) return;
    setBusy(true); setError('');
    try { setResult(await api.inventory.completeCount(id)); onChanged(); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true);
    try { await api.inventory.cancelCount(id); onBack(); } catch (e: any) { setError(e.message); setBusy(false); }
  };
  const addLine = async () => {
    setBusy(true); setError('');
    try {
      await api.inventory.saveCountLines(id, { add: { tire_id: Number(add.tire_id), batch_id: add.batch_id ? Number(add.batch_id) : undefined, counted_qty: Number(add.qty) } });
      setAdd({ tire_id: '', batch_id: '', qty: '' }); await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (!data) return <div className="flex justify-center py-8">{error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="animate-spin text-slate-400" size={20} />}</div>;
  const diff = (l: Line) => (vals[l.id] === '' || vals[l.id] === undefined ? null : Number(vals[l.id]) - l.system_qty);

  return (
    <div className="space-y-3">
      <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline"><ArrowLeft size={12} /> All counts</button>
      <div className="flex items-center gap-2"><ClipboardList size={16} className="text-teal-600" />
        <div><p className="text-sm font-bold text-slate-800">{data.count_no} <span className="font-normal text-slate-500">· {data.location_name}</span></p>{data.notes && <p className="text-xs text-slate-400">{data.notes}</p>}</div>
        <span className={`ml-auto text-[10px] font-bold uppercase rounded-full px-2 py-0.5 ${open ? 'bg-amber-50 text-amber-700' : data.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{data.status}</span>
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
      {result && (
        <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
          Count finished. {result.adjustments_applied} adjustment{result.adjustments_applied === 1 ? '' : 's'} posted{result.adjustments_pending ? `, ${result.adjustments_pending} waiting for approval` : ''}; {result.unchanged} line{result.unchanged === 1 ? '' : 's'} matched; {result.uncounted} not counted.
          {result.moved_since_snapshot > 0 && <> {result.moved_since_snapshot} line{result.moved_since_snapshot === 1 ? ' had' : 's had'} stock movements since the snapshot, so the adjustment is against the current balance.</>}
        </div>
      )}
      <table className="w-full text-xs">
        <thead><tr className="text-left text-slate-500 uppercase tracking-wider"><th className="pb-2">Item</th><th className="pb-2 text-right">System</th><th className="pb-2 text-right w-24">Counted</th><th className="pb-2 text-right">Diff</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {data.lines.map((l: Line) => {
            const d = diff(l);
            return (
              <tr key={l.id}>
                <td className="py-1.5 pr-2 text-slate-700">{l.item_name}{l.batch_no && <span className="ml-1.5 text-[10px] text-teal-700 font-semibold">batch {l.batch_no}</span>}{l.sku && <span className="block text-[10px] font-mono text-slate-400">{l.sku}</span>}</td>
                <td className="py-1.5 text-right text-slate-500">{l.system_qty}</td>
                <td className="py-1.5 text-right">
                  {open ? <input type="number" min={0} value={vals[l.id] ?? ''} onChange={e => setVals(v => ({ ...v, [l.id]: e.target.value }))} aria-label={`Counted ${l.item_name}`}
                    className="w-20 text-sm border border-slate-200 rounded-lg px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-teal-500" /> : (l.counted_qty ?? '—')}
                </td>
                <td className={`py-1.5 text-right font-semibold ${d === null ? 'text-slate-300' : d === 0 ? 'text-slate-400' : d > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {open ? (d === null ? '—' : d > 0 ? `+${d}` : d) : (l.counted_qty === null ? '—' : l.counted_qty - l.system_qty)}
                  {l.adjustment_status === 'pending' && <span className="ml-1 text-[10px] text-amber-600">pending</span>}
                </td>
              </tr>
            );
          })}
          {data.lines.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-slate-400">Nothing recorded in this location. Add anything you find below.</td></tr>}
        </tbody>
      </table>

      {open && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            <span className="text-xs font-semibold text-slate-600">Found something not listed?</span>
            <select value={add.tire_id} onChange={e => setAdd({ tire_id: e.target.value, batch_id: '', qty: add.qty })} className={`${input} !py-1.5 max-w-52`}>
              <option value="">Item…</option>{items.map(i => <option key={i.id} value={i.id}>{[i.brand, i.model, i.size].filter(Boolean).join(' ')}</option>)}
            </select>
            {picked && picked.tracking !== 'none' && (
              <select value={add.batch_id} onChange={e => setAdd(a => ({ ...a, batch_id: e.target.value }))} className={`${input} !py-1.5`}>
                <option value="">Batch…</option>{batches.map((b: any) => <option key={b.id} value={b.id}>{b.batch_no}</option>)}
              </select>
            )}
            <input type="number" min={0} value={add.qty} onChange={e => setAdd(a => ({ ...a, qty: e.target.value }))} placeholder="Qty" className={`${input} !py-1.5 w-20 text-center`} />
            <button onClick={addLine} disabled={busy || !add.tire_id || add.qty === ''} className="text-xs font-medium text-teal-600 hover:underline disabled:opacity-40">Add</button>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={cancel} disabled={busy} className="px-4 py-2 text-sm font-medium border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50">Cancel count</button>
            <button onClick={save} disabled={busy || !dirty.length} className="px-4 py-2 text-sm font-medium border border-teal-200 text-teal-700 rounded-xl hover:bg-teal-50 disabled:opacity-40">Save progress</button>
            <button onClick={finish} disabled={busy} className="ml-auto flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-teal-600 text-white rounded-xl hover:bg-teal-700 disabled:opacity-50">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Finish & post differences
            </button>
          </div>
        </>
      )}
    </div>
  );
}
