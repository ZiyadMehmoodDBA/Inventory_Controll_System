import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Layers, Loader2, Search, X } from 'lucide-react';
import { api } from '../api/client';
import StockCountsPanel from './StockCountsPanel';

type Tab = 'position' | 'reservations' | 'transit' | 'counts';
interface Props { onClose: () => void; onChanged: () => void; initialTireId?: number }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '');

const COLS: { key: string; label: string; hint: string; tone?: string }[] = [
  { key: 'on_hand', label: 'On hand', hint: 'Physically recorded in all locations' },
  { key: 'reserved', label: 'Reserved', hint: 'Held for orders', tone: 'text-blue-600' },
  { key: 'quarantined', label: 'Quarantined', hint: 'On hand in restricted locations', tone: 'text-amber-600' },
  { key: 'expired', label: 'Expired', hint: 'On hand but past expiry', tone: 'text-red-600' },
  { key: 'held', label: 'On hold', hint: 'In batches on quality hold, recalled or damaged', tone: 'text-orange-600' },
  { key: 'available', label: 'Available', hint: 'On hand − quarantined − expired − on hold − reserved', tone: 'text-emerald-600 font-bold' },
  { key: 'in_transit', label: 'In transit', hint: 'Dispatched, not yet received (not in on hand)', tone: 'text-violet-600' },
  { key: 'on_order', label: 'On order', hint: 'Pending purchase orders (not in on hand)', tone: 'text-slate-600' },
];

// Stock position (on hand / reserved / available / quarantined / in transit / on order), reservations, in-transit transfers and counts.
export default function StockControlModal({ onClose, onChanged, initialTireId }: Props) {
  const [tab, setTab] = useState<Tab>('position');
  const [tireId, setTireId] = useState<number | null>(initialTireId ?? null);
  const tabs: [Tab, string][] = [['position', 'Position'], ['reservations', 'Reservations'], ['transit', 'In transit'], ['counts', 'Stock counts']];
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full sm:max-w-4xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><Layers size={18} className="text-teal-600" /></div>
            <div><h3 className="text-sm font-bold text-slate-900">Stock Control</h3><p className="text-xs text-slate-500">Availability, reservations, transfers on the way and physical counts.</p></div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>
        <div className="flex gap-1 px-5 pt-3 border-b border-slate-100">
          {tabs.map(([k, label]) => (
            <button key={k} onClick={() => { setTab(k); if (k !== 'position') setTireId(null); }}
              className={`px-3 py-2 text-sm font-medium rounded-t-lg border-b-2 -mb-px ${tab === k ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>
          ))}
        </div>
        <div className="overflow-auto p-5 flex-1">
          {tab === 'position' && (tireId ? <ItemPosition id={tireId} onBack={() => setTireId(null)} onChanged={onChanged} /> : <PositionList onOpen={setTireId} />)}
          {tab === 'reservations' && <Reservations onChanged={onChanged} />}
          {tab === 'transit' && <InTransit onChanged={onChanged} />}
          {tab === 'counts' && <StockCountsPanel onChanged={onChanged} />}
        </div>
      </div>
    </div>
  );
}

function PositionList({ onOpen }: { onOpen: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ items: any[]; totals: Record<string, number> } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const t = setTimeout(() => api.inventory.position(q.trim()).then(setData).catch(e => setError(e.message)), 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="space-y-3">
      <div className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item or SKU…" className={`${input} w-full pl-8`} /></div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!data ? <div className="flex justify-center py-8"><Loader2 className="animate-spin text-slate-400" size={20} /></div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-slate-500 uppercase tracking-wider"><th className="pb-2 text-left">Item</th>{COLS.map(c => <th key={c.key} title={c.hint} className="pb-2 text-right px-2 whitespace-nowrap">{c.label}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">
              <tr className="bg-slate-50 font-semibold"><td className="py-2 pl-2">All items</td>{COLS.map(c => <td key={c.key} className={`py-2 px-2 text-right ${c.tone ?? ''}`}>{data.totals[c.key]}</td>)}</tr>
              {data.items.map(i => (
                <tr key={i.tire_id} className="hover:bg-slate-50 cursor-pointer" onClick={() => onOpen(i.tire_id)}>
                  <td className="py-2 pl-2 text-slate-800">{i.item_name}{i.sku && <span className="block text-[10px] font-mono text-slate-400">{i.sku}</span>}</td>
                  {COLS.map(c => <td key={c.key} className={`py-2 px-2 text-right ${Number(i[c.key]) === 0 ? 'text-slate-300' : c.tone ?? 'text-slate-700'}`}>{i[c.key]}</td>)}
                </tr>
              ))}
              {data.items.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-slate-400">No stock matches.</td></tr>}
            </tbody>
          </table>
          <p className="text-[11px] text-slate-400 mt-2">Available = on hand − quarantined − expired − on quality hold − reserved. In transit and on order are not part of on hand, so nothing is counted twice. Click an item for locations and to reserve.</p>
        </div>
      )}
    </div>
  );
}

function ItemPosition({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ qty: '', location_id: '', reference: '', expires_at: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.inventory.positionOf(id).then(x => { setD(x); setF(p => ({ ...p, location_id: p.location_id || String(x.locations.find((l: any) => l.is_default)?.location_id ?? '') })); }).catch(e => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="flex justify-center py-8">{error ? <p className="text-sm text-red-600">{error}</p> : <Loader2 className="animate-spin text-slate-400" size={20} />}</div>;

  const reserve = async () => {
    setBusy(true); setError('');
    try {
      await api.inventory.reserve({ tire_id: id, qty: Number(f.qty), location_id: f.location_id ? Number(f.location_id) : undefined, reference: f.reference.trim() || undefined, notes: f.notes.trim() || undefined, expires_at: f.expires_at || undefined });
      setF(p => ({ ...p, qty: '', reference: '', expires_at: '', notes: '' })); await load(); onChanged();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const release = async (rid: number) => { setError(''); try { await api.inventory.releaseReservation(rid); await load(); onChanged(); } catch (e: any) { setError(e.message); } };
  const kindBadge = (k: string) => k !== 'normal' && <span className="ml-1.5 text-[10px] font-bold text-amber-700 bg-amber-50 rounded-full px-1.5 py-0.5 uppercase">{k}</span>;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline"><ArrowLeft size={12} /> All items</button>
      <div><p className="text-sm font-bold text-slate-800">{d.item_name}</p>{d.sku && <p className="text-[11px] font-mono text-slate-400">{d.sku}</p>}</div>
      <div className="grid grid-cols-3 sm:grid-cols-8 gap-2">
        {COLS.map(c => <div key={c.key} title={c.hint} className="rounded-xl border border-slate-200 px-2 py-2 text-center"><p className="text-[10px] uppercase tracking-wider text-slate-400">{c.label}</p><p className={`text-lg ${c.tone ?? 'text-slate-800 font-semibold'}`}>{d[c.key]}</p></div>)}
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">By location</p>
        <table className="w-full text-xs">
          <thead><tr className="text-slate-500"><th className="text-left pb-1">Location</th><th className="text-right pb-1">On hand</th><th className="text-right pb-1">Reserved</th><th className="text-right pb-1">Expired</th><th className="text-right pb-1">On hold</th><th className="text-right pb-1">Available</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {d.locations.map((l: any) => <tr key={l.location_id}><td className="py-1.5">{l.name}{kindBadge(l.kind)}</td><td className="text-right">{l.on_hand}</td><td className="text-right">{l.reserved}</td><td className="text-right">{l.expired}</td><td className="text-right">{l.held ?? 0}</td><td className="text-right font-semibold text-emerald-600">{l.available}</td></tr>)}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-slate-200 p-3 space-y-2 bg-slate-50/60">
        <p className="text-xs font-semibold text-slate-700">Reserve stock</p>
        <div className="flex flex-wrap gap-2">
          <input type="number" min={1} value={f.qty} onChange={e => setF({ ...f, qty: e.target.value })} placeholder="Qty" aria-label="Reserve quantity" className={`${input} w-20 text-center`} />
          <select value={f.location_id} onChange={e => setF({ ...f, location_id: e.target.value })} aria-label="Reserve location" className={input}>{d.locations.filter((l: any) => l.kind === 'normal').map((l: any) => <option key={l.location_id} value={l.location_id}>{l.name} ({l.available} free)</option>)}</select>
          <input value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} placeholder="For (order / customer)" maxLength={100} className={`${input} flex-1 min-w-32`} />
          <input type="date" value={f.expires_at} onChange={e => setF({ ...f, expires_at: e.target.value })} title="Hold until (optional)" className={input} />
          <button onClick={reserve} disabled={busy || !f.qty} className="bg-teal-600 text-white text-sm font-medium px-4 rounded-xl hover:bg-teal-700 disabled:opacity-50">Reserve</button>
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Active reservations</p>
        {d.reservations.length === 0 ? <p className="text-xs text-slate-400">None.</p> : d.reservations.map((r: any) => (
          <div key={r.id} className="flex items-center gap-2 py-1.5 text-xs border-b border-slate-100">
            <span className="font-semibold w-10">{r.qty}</span><span className="flex-1 text-slate-600">{r.reference || '—'} · {r.location_name}{r.expires_at ? ` · until ${fmtDate(r.expires_at)}` : ''}</span>
            <button onClick={() => release(r.id)} className="text-red-600 hover:underline">Release</button>
          </div>
        ))}
      </div>
      {(d.in_transit_transfers.length > 0 || d.open_orders.length > 0) && (
        <div className="grid sm:grid-cols-2 gap-4 text-xs">
          <div><p className="font-bold text-slate-500 uppercase tracking-wider mb-1">In transit</p>{d.in_transit_transfers.map((t: any) => <p key={t.id} className="py-1 text-slate-600">{t.qty} · {t.transfer_no} · {t.from_name} → {t.to_name}</p>)}{!d.in_transit_transfers.length && <p className="text-slate-400">None.</p>}</div>
          <div><p className="font-bold text-slate-500 uppercase tracking-wider mb-1">On order</p>{d.open_orders.map((o: any) => <p key={o.id} className="py-1 text-slate-600">{o.qty} · {o.po_number} · {o.supplier_name ?? '—'}</p>)}{!d.open_orders.length && <p className="text-slate-400">None.</p>}</div>
        </div>
      )}
    </div>
  );
}

function Reservations({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState('active');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.inventory.reservations(status).then(setRows).catch(e => setError(e.message)), [status]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const release = async (id: number) => { setError(''); try { await api.inventory.releaseReservation(id); await load(); onChanged(); } catch (e: any) { setError(e.message); } };
  return (
    <div className="space-y-3">
      <select value={status} onChange={e => setStatus(e.target.value)} className={input}><option value="active">Active</option><option value="fulfilled">Fulfilled</option><option value="released">Released</option><option value="all">All</option></select>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!rows ? <Loader2 className="animate-spin text-slate-400 mx-auto" size={20} /> : (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-500 uppercase tracking-wider"><th className="pb-2">Item</th><th className="pb-2 text-right">Qty</th><th className="pb-2">For</th><th className="pb-2">Location</th><th className="pb-2">Until</th><th className="pb-2">Status</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(r => (
              <tr key={r.id}><td className="py-2">{r.item_name}</td><td className="py-2 text-right font-semibold">{r.qty}</td><td className="py-2 text-slate-600">{r.reference || '—'}</td><td className="py-2">{r.location_name}</td>
                <td className="py-2">{fmtDate(r.expires_at) || '—'}{r.is_expired && <span className="ml-1 text-red-600">expired</span>}</td>
                <td className="py-2 capitalize">{r.status}</td><td className="py-2 text-right">{r.status === 'active' && <button onClick={() => release(r.id)} className="text-red-600 hover:underline">Release</button>}</td></tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-slate-400">No reservations.</td></tr>}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-slate-400">Reserved stock cannot be sold, transferred or written off. To use it, pick the reservation on the sale line.</p>
    </div>
  );
}

function InTransit({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const load = useCallback(() => api.inventory.transfers().then(r => setRows(r)).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const act = async (id: number, kind: 'receive' | 'cancel') => {
    setBusyId(id); setError('');
    try { await (kind === 'receive' ? api.inventory.receiveTransfer(id) : api.inventory.cancelTransfer(id)); await load(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusyId(null); }
  };
  const open = (rows ?? []).filter(r => r.status === 'in_transit');
  const recent = (rows ?? []).filter(r => r.status !== 'in_transit').slice(0, 15);
  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
      {!rows ? <Loader2 className="animate-spin text-slate-400 mx-auto" size={20} /> : (
        <>
          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">On the way</p>
            {open.length === 0 ? <p className="text-xs text-slate-400">Nothing in transit. Use Transfer Stock › "Send as in transit".</p> : open.map(t => (
              <div key={t.id} className="flex items-center gap-3 py-2 border-b border-slate-100 text-xs">
                <div className="flex-1"><p className="font-mono font-semibold text-slate-800">{t.transfer_no}</p><p className="text-slate-500">{t.from_name} → {t.to_name} · {t.units} unit{t.units === 1 ? '' : 's'} · {fmtDate(t.created_at)}</p></div>
                <button onClick={() => act(t.id, 'receive')} disabled={busyId === t.id} className="bg-teal-600 text-white font-medium px-3 py-1.5 rounded-lg hover:bg-teal-700 disabled:opacity-50">Receive</button>
                <button onClick={() => act(t.id, 'cancel')} disabled={busyId === t.id} title="Return the stock to the source location" className="text-red-600 hover:underline">Cancel & return</button>
              </div>
            ))}
          </div>
          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Recent transfers</p>
            {recent.map(t => <p key={t.id} className="py-1 text-xs text-slate-600"><span className="font-mono">{t.transfer_no}</span> · {t.from_name} → {t.to_name} · {t.units} unit{t.units === 1 ? '' : 's'} · <span className="capitalize">{t.status === 'completed' ? 'completed' : t.status}</span></p>)}
          </div>
        </>
      )}
    </div>
  );
}
