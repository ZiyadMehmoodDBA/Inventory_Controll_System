import { useCallback, useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, ChevronRight, Loader2, Plus, Search, Trash2, X } from 'lucide-react';
import { api } from '../api/client';

type Tab = 'network' | 'transfers' | 'setup' | 'counts';
interface Props { role?: string; onClose: () => void; onChanged: () => void }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const btn = 'text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 disabled:opacity-50';
const primary = 'text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50';
const money = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (n: number | null | undefined) => Number(n ?? 0).toLocaleString();
const when = (d?: string | null) => (d ? String(d).slice(0, 16).replace('T', ' ') : '—');
const day = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');
const Err = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Ok = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Spin = () => <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-slate-400 py-6 text-center">{children}</p>;
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <div><label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>{children}</div>;
const Stat = ({ label, value, tone = '' }: { label: string; value: string; tone?: string }) => (
  <div className="bg-slate-50 border border-slate-100 rounded-xl px-3 py-2"><p className="text-[11px] text-slate-500">{label}</p><p className={`text-base font-bold ${tone || 'text-slate-900'}`}>{value}</p></div>
);
const STATUS: Record<string, string> = { in_transit: 'bg-amber-100 text-amber-700', received: 'bg-emerald-100 text-emerald-700', completed: 'bg-emerald-100 text-emerald-700', cancelled: 'bg-slate-100 text-slate-500' };
const EVENT: Record<string, string> = { dispatched: 'Dispatched', received: 'Received', received_short: 'Received with shortage', cancelled: 'Cancelled' };
const DIR: Record<string, string> = { outgoing: 'Outgoing', incoming: 'Incoming', internal: 'Within branch', cross: 'Between branches' };

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const load = useCallback(() => { const n = ++seq.current; setError(''); return fn().then(d => { if (n === seq.current) setData(d); }).catch(e => { if (n === seq.current) setError(e.message); }); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}

function Overlay({ title, children, onCancel, wide = false }: { title: string; children: React.ReactNode; onCancel: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[85vh] overflow-auto p-5 space-y-3`}>
        <div className="flex items-center justify-between"><h4 className="text-sm font-bold text-slate-900">{title}</h4><button onClick={onCancel} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><X size={14} /></button></div>
        {children}
      </div>
    </div>
  );
}

// Warehouses and multi-location stock: what is where across branches, moving it safely between places, and who may touch which location.
export default function WarehouseModal({ role, onClose, onChanged }: Props) {
  const canManage = role === 'org_admin' || role === 'branch_manager';
  const readOnly = role === 'demo';
  const [tab, setTab] = useState<Tab>('network');
  const [transitCount, setTransitCount] = useState(0);
  const tabs: [Tab, string][] = [['network', 'Stock by location'], ['transfers', 'Transfers'], ['counts', 'Counts'], ...(canManage ? [['setup', 'Warehouses & access'] as [Tab, string]] : [])];
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full sm:max-w-5xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-sky-50 flex items-center justify-center"><Building2 size={18} className="text-sky-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Warehouses & Locations</h3>
              <p className="text-xs text-slate-500">Stock by organisation, branch, warehouse and location. Transfers keep a record of dispatch and receipt.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>
        <div className="flex gap-1 px-5 pt-3 border-b border-slate-100 overflow-x-auto">
          {tabs.map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`text-xs font-semibold px-3 py-2 rounded-t-lg whitespace-nowrap border-b-2 ${tab === k ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              {l}{k === 'transfers' && transitCount > 0 && <span className="ml-1.5 text-[10px] bg-amber-500 text-white rounded-full px-1.5 py-0.5">{transitCount}</span>}
            </button>
          ))}
        </div>
        <div className="p-5 overflow-auto flex-1">
          {tab === 'network' && <NetworkTab />}
          {tab === 'transfers' && <TransfersTab canManage={canManage} readOnly={readOnly} onCount={setTransitCount} onChanged={onChanged} />}
          {tab === 'counts' && <CountsTab readOnly={readOnly} />}
          {tab === 'setup' && canManage && <SetupTab readOnly={readOnly} />}
        </div>
      </div>
    </div>
  );
}

// ── Stock by location ───────────────────────────────────────────────────────
function NetworkTab() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const { data, error } = useLoad(() => api.inventory.warehouse.network(applied), [applied]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [drill, setDrill] = useState<{ id: number; name: string } | null>(null);
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }));
  if (error) return <Err msg={error} />;
  if (!data) return <Spin />;
  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setApplied(q.trim()); }}>
        <div className="relative flex-1"><Search size={13} className="absolute left-3 top-3 text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Find an item by name or SKU to see where it is" className={`${input} w-full pl-8`} /></div>
        <button className={primary}>Search</button>
        {applied && <button type="button" className={btn} onClick={() => { setQ(''); setApplied(''); }}>Clear</button>}
      </form>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <Stat label={data.scope === 'organisation' ? 'Whole organisation' : 'This branch'} value={`${num(data.totals.units)} units`} />
        <Stat label="Cost value" value={money(data.totals.value)} />
        <Stat label="Branches" value={num(data.totals.branches)} />
        <Stat label="Locations" value={num(data.totals.locations)} />
        <Stat label="On the way" value={`${num(data.totals.in_transit_units)} units`} tone={data.totals.in_transit_units ? 'text-amber-600' : ''} />
      </div>
      {!data.branches.length && <Empty>No stock locations yet.</Empty>}
      {data.branches.map((b: any) => (
        <div key={b.id} className="border border-slate-200 rounded-xl overflow-hidden">
          <button onClick={() => toggle('b' + b.id)} className="w-full flex items-center gap-2 px-4 py-3 bg-slate-50 text-left">
            {open['b' + b.id] === false ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            <span className="text-sm font-bold text-slate-900 flex-1">{b.name}</span>
            {(b.in_transit_out > 0 || b.in_transit_in > 0) && <span className="text-[11px] text-amber-700 bg-amber-100 rounded-full px-2 py-0.5">{b.in_transit_out > 0 ? `${num(b.in_transit_out)} out` : ''}{b.in_transit_out > 0 && b.in_transit_in > 0 ? ' · ' : ''}{b.in_transit_in > 0 ? `${num(b.in_transit_in)} in` : ''} in transit</span>}
            <span className="text-xs text-slate-600">{num(b.units)} units · {money(b.value)}</span>
          </button>
          {open['b' + b.id] !== false && b.warehouses.map((w: any) => (
            <div key={w.id ?? 'x'} className="border-t border-slate-100">
              <div className="flex items-center gap-2 px-6 py-2 text-xs font-semibold text-slate-700 bg-white"><Building2 size={12} className="text-sky-500" /><span className="flex-1">{w.name}</span><span className="text-slate-500 font-normal">{num(w.units)} units · {money(w.value)}</span></div>
              <table className="w-full text-xs">
                <tbody>
                  {w.locations.map((l: any) => (
                    <tr key={l.id} className="border-t border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => setDrill({ id: l.id, name: l.name })}>
                      <td className="pl-10 py-1.5 text-slate-800">{l.name}{l.is_default && <span className="ml-1 text-[10px] text-slate-400">default</span>}{l.kind !== 'normal' && <span className="ml-1 text-[10px] bg-amber-100 text-amber-700 rounded px-1">{l.kind}</span>}{!l.is_active && <span className="ml-1 text-[10px] bg-slate-100 text-slate-500 rounded px-1">inactive</span>}</td>
                      <td className="py-1.5 text-right text-slate-500">{num(l.items)} items</td>
                      <td className="py-1.5 text-right font-semibold text-slate-800">{num(l.units)}</td>
                      <td className="py-1.5 pr-4 text-right text-slate-500">{money(l.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ))}
      {drill && <LocationStock id={drill.id} name={drill.name} onClose={() => setDrill(null)} />}
    </div>
  );
}

function LocationStock({ id, name, onClose }: { id: number; name: string; onClose: () => void }) {
  const { data, error } = useLoad(() => api.inventory.warehouse.locationStock(id), [id]);
  return (
    <Overlay title={`Stock in ${name}`} onCancel={onClose} wide>
      <Err msg={error} />
      {!data && !error && <Spin />}
      {data && !data.items.length && <Empty>Nothing is stored here.</Empty>}
      {data && data.items.length > 0 && (
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Item</th><th>SKU</th><th className="text-right">Qty</th><th className="text-right">Value</th></tr></thead>
          <tbody>{data.items.map((i: any) => <tr key={i.tire_id} className="border-t border-slate-100"><td className="py-1.5">{i.item_name}</td><td className="text-slate-500">{i.sku}</td><td className="text-right font-semibold">{num(i.qty)}</td><td className="text-right text-slate-500">{money(i.value)}</td></tr>)}</tbody>
        </table>
      )}
    </Overlay>
  );
}

// ── Transfers ───────────────────────────────────────────────────────────────
function TransfersTab({ canManage, readOnly, onCount, onChanged }: { canManage: boolean; readOnly: boolean; onCount: (n: number) => void; onChanged: () => void }) {
  const board = useLoad(() => api.inventory.warehouse.inTransit(), []);
  const [filter, setFilter] = useState('');
  const history = useLoad(() => api.inventory.warehouse.transfers(filter === 'discrepancy' ? { discrepancy: 1 } : filter ? { status: filter } : {}), [filter]);
  const [creating, setCreating] = useState(false);
  const [receiving, setReceiving] = useState<any>(null);
  const [detail, setDetail] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { onCount(board.data?.count ?? 0); }, [board.data, onCount]);
  const refresh = () => { board.reload(); history.reload(); onChanged(); };
  const cancel = async (t: any) => {
    if (!window.confirm(`Cancel ${t.transfer_no}? All units go back to ${t.from_name}.`)) return;
    setErr(''); setMsg('');
    try { const r = await api.inventory.warehouse.cancel(t.id); setMsg(`${r.transferNo} cancelled; stock returned to ${t.from_name}.`); refresh(); } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="space-y-5">
      <Err msg={err || board.error || history.error} /><Ok msg={msg} />
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-bold text-slate-900">On the way{board.data ? ` (${board.data.count})` : ''}</h4>
          {board.data && board.data.overdue > 0 && <p className="text-xs text-red-600">{board.data.overdue} overdue</p>}
        </div>
        {!readOnly && <button className={primary} onClick={() => setCreating(true)}><Plus size={12} className="inline mr-1" />New transfer</button>}
      </div>
      {!board.data ? <Spin /> : !board.data.transfers.length ? <Empty>Nothing is in transit.</Empty> : (
        <div className="space-y-2">
          {board.data.transfers.map((t: any) => (
            <div key={t.id} className={`border rounded-xl px-4 py-3 flex flex-wrap items-center gap-3 ${t.overdue ? 'border-red-200 bg-red-50/40' : 'border-slate-200'}`}>
              <div className="flex-1 min-w-[200px]">
                <button className="text-sm font-bold text-teal-700 hover:underline" onClick={() => setDetail(t.id)}>{t.transfer_no}</button>
                <span className="ml-2 text-[11px] bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">{DIR[t.direction] ?? t.direction}</span>
                {t.overdue === 1 && <span className="ml-1 text-[11px] bg-red-100 text-red-700 rounded-full px-2 py-0.5">overdue</span>}
                <p className="text-xs text-slate-600 mt-0.5">{t.from_branch} · {t.from_name} → {t.to_branch} · {t.to_name}</p>
                <p className="text-[11px] text-slate-400">{num(t.units)} units, {t.lines} line(s) · sent {day(t.created_at)} by {t.created_by_name ?? '—'}{t.expected_at ? ` · due ${day(t.expected_at)}` : ''}{t.carrier ? ` · ${t.carrier}` : ''}</p>
              </div>
              {!readOnly && (t.direction !== 'outgoing') && <button className={primary} onClick={() => setReceiving(t)}>Confirm receipt</button>}
              {!readOnly && (t.direction !== 'incoming') && <button className={btn} onClick={() => cancel(t)}>Cancel</button>}
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between pt-2 border-t border-slate-100">
        <h4 className="text-sm font-bold text-slate-900">History</h4>
        <select value={filter} onChange={e => setFilter(e.target.value)} className={`${input} !py-1 text-xs`} aria-label="Transfer filter">
          <option value="">All</option><option value="in_transit">In transit</option><option value="received">Received</option><option value="completed">Completed at once</option><option value="cancelled">Cancelled</option><option value="discrepancy">With shortages</option>
        </select>
      </div>
      {!history.data ? <Spin /> : !history.data.length ? <Empty>No transfers.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th className="py-1">No.</th><th>From</th><th>To</th><th className="text-right">Units</th><th>Status</th><th>Sent</th><th>Received</th></tr></thead>
            <tbody>
              {history.data.map((t: any) => (
                <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setDetail(t.id)}>
                  <td className="py-1.5 font-semibold text-teal-700">{t.transfer_no}</td>
                  <td>{t.from_branch} · {t.from_name}</td><td>{t.to_branch} · {t.to_name}</td>
                  <td className="text-right">{num(t.units)}{t.units_short > 0 && <span className="text-red-600"> (-{t.units_short})</span>}</td>
                  <td><span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS[t.status] ?? ''}`}>{t.status.replace('_', ' ')}</span>{t.has_discrepancy ? <span className="ml-1 text-[11px] text-red-600">shortage</span> : null}</td>
                  <td className="text-slate-500">{day(t.created_at)}</td><td className="text-slate-500">{day(t.received_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <NewTransfer canManage={canManage} onClose={() => setCreating(false)} onDone={m => { setCreating(false); setMsg(m); refresh(); }} />}
      {receiving && <ReceiveTransfer id={receiving.id} canWriteOff={canManage} onClose={() => setReceiving(null)} onDone={m => { setReceiving(null); setMsg(m); refresh(); }} />}
      {detail != null && <TransferDetail id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

interface Line { tire_id: number; name: string; qty: number; on_hand: number }

function NewTransfer({ canManage, onClose, onDone }: { canManage: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const locs = useLoad(() => api.inventory.locations(), []);
  const dest = useLoad(() => (canManage ? api.inventory.warehouse.destinations() : Promise.resolve([] as any[])), []);
  const [from, setFrom] = useState(0);
  const [toBranch, setToBranch] = useState(0);   // 0 = this branch
  const [to, setTo] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<any[]>([]);
  const [inTransit, setInTransit] = useState(false);
  const [expected, setExpected] = useState('');
  const [carrier, setCarrier] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const here = (locs.data ?? []).filter(l => l.is_active);
  const there = toBranch ? (dest.data ?? []).find((b: any) => b.id === toBranch)?.locations ?? [] : here.filter(l => l.id !== from);
  useEffect(() => { if (!from && here.length) setFrom(here.find(l => l.is_default)?.id ?? here[0].id); }, [here, from]);
  useEffect(() => { setTo(0); }, [toBranch, from]);
  useEffect(() => {
    if (!q.trim()) { setFound([]); return; }
    const h = setTimeout(() => { api.inventory.position(q.trim()).then(r => setFound(r.items.slice(0, 8))).catch(() => setFound([])); }, 250);
    return () => clearTimeout(h);
  }, [q]);
  const add = (i: any) => { if (!lines.some(l => l.tire_id === i.tire_id)) setLines(ls => [...ls, { tire_id: i.tire_id, name: i.item_name, qty: 1, on_hand: i.on_hand }]); setQ(''); setFound([]); };
  const cross = toBranch !== 0;
  const submit = async () => {
    setError('');
    if (!from || !to) return setError('Choose where the stock leaves from and where it goes.');
    if (!lines.length) return setError('Add at least one item.');
    if (lines.some(l => !Number.isInteger(l.qty) || l.qty < 1)) return setError('Quantities must be whole numbers of at least 1.');
    setBusy(true);
    try {
      const r = await api.inventory.warehouse.send({ from_location_id: from, to_location_id: to, items: lines.map(l => ({ tire_id: l.tire_id, qty: l.qty })), notes: notes.trim() || undefined,
        in_transit: cross || inTransit, expected_at: expected || undefined, carrier: carrier.trim() || undefined, reference: reference.trim() || undefined });
      onDone(r.status === 'in_transit' ? `${r.transferNo} dispatched; it stays in transit until the destination confirms receipt.` : `${r.transferNo} completed.`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Overlay title="New transfer" onCancel={onClose} wide>
      <Err msg={error || locs.error || dest.error} />
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="From location (this branch)"><select value={from} onChange={e => setFrom(Number(e.target.value))} className={`${input} w-full`}>{here.map(l => <option key={l.id} value={l.id}>{l.name} ({num(l.units)})</option>)}</select></Field>
        {canManage && (dest.data ?? []).length > 0 && (
          <Field label="To branch"><select value={toBranch} onChange={e => setToBranch(Number(e.target.value))} className={`${input} w-full`}><option value={0}>This branch</option>{(dest.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        )}
        <Field label="To location"><select value={to} onChange={e => setTo(Number(e.target.value))} className={`${input} w-full`}><option value={0}>Choose…</option>{there.map((l: any) => <option key={l.id} value={l.id}>{l.name}{l.warehouse ? ` · ${l.warehouse}` : ''}</option>)}</select></Field>
      </div>
      <Field label="Items">
        <div className="relative"><Search size={13} className="absolute left-3 top-3 text-slate-400" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search items to add" className={`${input} w-full pl-8`} /></div>
        {found.length > 0 && <div className="border border-slate-200 rounded-xl mt-1 divide-y divide-slate-100 max-h-40 overflow-auto">{found.map(i => <button key={i.tire_id} type="button" onClick={() => add(i)} className="w-full text-left px-3 py-1.5 text-xs hover:bg-slate-50">{i.item_name} <span className="text-slate-400">· {num(i.on_hand)} on hand</span></button>)}</div>}
      </Field>
      {lines.length > 0 && (
        <table className="w-full text-xs">
          <tbody>{lines.map(l => (
            <tr key={l.tire_id} className="border-t border-slate-100">
              <td className="py-1.5">{l.name}</td>
              <td className="w-24"><input type="number" min={1} value={l.qty} onChange={e => setLines(ls => ls.map(x => x.tire_id === l.tire_id ? { ...x, qty: Number(e.target.value) } : x))} className={`${input} !py-1 w-full text-right`} aria-label={`Quantity of ${l.name}`} /></td>
              <td className="w-8 text-right"><button onClick={() => setLines(ls => ls.filter(x => x.tire_id !== l.tire_id))} className="p-1 text-slate-400 hover:text-red-600" aria-label={`Remove ${l.name}`}><Trash2 size={12} /></button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <div className="grid sm:grid-cols-3 gap-3">
        <Field label="Expected arrival"><input type="date" value={expected} onChange={e => setExpected(e.target.value)} className={`${input} w-full`} /></Field>
        <Field label="Carrier / vehicle"><input value={carrier} onChange={e => setCarrier(e.target.value)} maxLength={100} className={`${input} w-full`} /></Field>
        <Field label="Waybill / reference"><input value={reference} onChange={e => setReference(e.target.value)} maxLength={100} className={`${input} w-full`} /></Field>
      </div>
      <Field label="Notes"><input value={notes} onChange={e => setNotes(e.target.value)} maxLength={500} className={`${input} w-full`} /></Field>
      <label className="flex items-center gap-2 text-xs text-slate-700">
        <input type="checkbox" checked={cross || inTransit} disabled={cross} onChange={e => setInTransit(e.target.checked)} />
        {cross ? 'Transfers to another branch stay in transit until that branch confirms receipt.' : 'Keep in transit until the destination confirms receipt'}
      </label>
      <div className="flex justify-end gap-2 pt-1"><button className={btn} onClick={onClose}>Close</button><button className={primary} disabled={busy} onClick={submit}>{busy ? 'Sending…' : cross || inTransit ? 'Dispatch' : 'Transfer now'}</button></div>
    </Overlay>
  );
}

function ReceiveTransfer({ id, canWriteOff, onClose, onDone }: { id: number; canWriteOff: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const { data, error: loadError } = useLoad(() => api.inventory.warehouse.transfer(id), [id]);
  const [got, setGot] = useState<Record<number, number>>({});
  const [note, setNote] = useState('');
  const [action, setAction] = useState<'return' | 'write_off'>('return');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!data) return <Overlay title="Confirm receipt" onCancel={onClose}>{loadError ? <Err msg={loadError} /> : <Spin />}</Overlay>;
  const recv = (l: any) => got[l.tire_id] ?? l.qty;
  const short = data.lines.reduce((a: number, l: any) => a + (l.qty - recv(l)), 0);
  const submit = async () => {
    setError(''); setBusy(true);
    try {
      const r = await api.inventory.warehouse.receive(id, { lines: data.lines.map((l: any) => ({ tire_id: l.tire_id, qty_received: recv(l) })), note: note.trim() || undefined, short_action: action });
      onDone(r.discrepancy ? `${r.transferNo} received with a shortage; ${action === 'write_off' ? 'missing units written off' : 'missing units returned to the source'}.` : `${r.transferNo} received in full.`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Overlay title={`Confirm receipt of ${data.transfer_no}`} onCancel={onClose} wide>
      <Err msg={error} />
      <p className="text-xs text-slate-500">{data.from_branch} · {data.from_name} → {data.to_branch} · {data.to_name}. Enter what actually arrived.</p>
      <table className="w-full text-xs">
        <thead><tr className="text-left text-slate-500"><th className="py-1">Item</th><th className="text-right">Sent</th><th className="text-right w-28">Received</th></tr></thead>
        <tbody>{data.lines.map((l: any) => (
          <tr key={l.tire_id} className="border-t border-slate-100"><td className="py-1.5">{l.item_name}</td><td className="text-right">{num(l.qty)}</td>
            <td><input type="number" min={0} max={l.qty} value={recv(l)} onChange={e => setGot(g => ({ ...g, [l.tire_id]: Number(e.target.value) }))} className={`${input} !py-1 w-full text-right`} aria-label={`Received ${l.item_name}`} /></td></tr>
        ))}</tbody>
      </table>
      {short > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-2">
          <p className="text-xs text-amber-800 font-semibold">{short} unit(s) short. Say what happened and what to do with them.</p>
          <input value={note} onChange={e => setNote(e.target.value)} maxLength={500} placeholder="e.g. 3 crushed in transit" className={`${input} w-full`} aria-label="Shortage note" />
          <select value={action} onChange={e => setAction(e.target.value as any)} className={`${input} w-full`} aria-label="Short quantity handling">
            <option value="return">Return the missing units to the sending location</option>
            {canWriteOff && <option value="write_off">Write the missing units off as lost in transit (administrator or sending manager)</option>}
          </select>
        </div>
      )}
      <div className="flex justify-end gap-2"><button className={btn} onClick={onClose}>Close</button><button className={primary} disabled={busy} onClick={submit}>{busy ? 'Saving…' : 'Confirm receipt'}</button></div>
    </Overlay>
  );
}

function TransferDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, error } = useLoad(() => api.inventory.warehouse.transfer(id), [id]);
  return (
    <Overlay title={data ? `Transfer ${data.transfer_no}` : 'Transfer'} onCancel={onClose} wide>
      <Err msg={error} />
      {!data && !error && <Spin />}
      {data && (
        <>
          <p className="text-xs text-slate-600">{data.from_branch} · {data.from_name} → {data.to_branch} · {data.to_name} <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] ${STATUS[data.status] ?? ''}`}>{data.status.replace('_', ' ')}</span></p>
          <p className="text-[11px] text-slate-400">{[data.carrier && `Carrier ${data.carrier}`, data.reference && `Ref ${data.reference}`, data.expected_at && `Due ${day(data.expected_at)}`, data.notes].filter(Boolean).join(' · ')}</p>
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th className="py-1">Item</th><th className="text-right">Sent</th><th className="text-right">Received</th><th className="text-right">Short</th></tr></thead>
            <tbody>{data.lines.map((l: any) => <tr key={l.tire_id} className="border-t border-slate-100"><td className="py-1.5">{l.item_name}</td><td className="text-right">{num(l.qty)}</td><td className="text-right">{l.qty_received == null ? '—' : num(l.qty_received)}</td><td className={`text-right ${l.qty_short > 0 ? 'text-red-600 font-semibold' : ''}`}>{l.qty_short == null ? '—' : num(l.qty_short)}</td></tr>)}</tbody>
          </table>
          <h5 className="text-xs font-bold text-slate-800 pt-1">Trail</h5>
          <ol className="space-y-2">
            {data.events.map((e: any) => (
              <li key={e.id} className="text-xs border-l-2 border-teal-300 pl-3">
                <p className="font-semibold text-slate-800">{EVENT[e.event] ?? e.event} <span className="font-normal text-slate-500">· {e.user_name ?? 'system'} · {when(e.created_at)}</span></p>
                {e.details && <p className="text-slate-500">{[e.details.from && `from ${e.details.from}`, e.details.to && `to ${e.details.to}`, e.details.at && `at ${e.details.at}`, e.details.units != null && `${e.details.units} unit(s)`, e.details.units_received != null && `${e.details.units_received} received`, e.details.units_short > 0 && `${e.details.units_short} short`].filter(Boolean).join(' · ')}</p>}
                {e.note && <p className="text-slate-600">“{e.note}”</p>}
              </li>
            ))}
          </ol>
        </>
      )}
    </Overlay>
  );
}

// ── Counts by location ─────────────────────────────────────────────────────
function CountsTab({ readOnly }: { readOnly: boolean }) {
  const { data, error, reload } = useLoad(() => api.inventory.warehouse.counts(), []);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const start = async (id: number) => {
    setErr(''); setMsg('');
    try { const r = await api.inventory.startCount({ location_id: id }); setMsg(`Count ${r.count_no ?? ''} started. Enter the counted quantities under Stock Control > Counts.`); reload(); } catch (e: any) { setErr(e.message); }
  };
  if (error) return <Err msg={error} />;
  if (!data) return <Spin />;
  return (
    <div className="space-y-3">
      <Err msg={err} /><Ok msg={msg} />
      <p className="text-xs text-slate-500">Each location is counted on its own. Variances become stock adjustments that follow the normal approval rules.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead><tr className="text-left text-slate-500"><th className="py-1">Location</th><th>Warehouse</th><th className="text-right">Units</th><th>Last count</th><th className="text-right">Variances</th><th>Open count</th><th /></tr></thead>
          <tbody>
            {data.map((l: any) => (
              <tr key={l.location_id} className="border-t border-slate-100">
                <td className="py-1.5 font-semibold text-slate-800">{l.location_name}</td><td className="text-slate-500">{l.warehouse_name ?? '—'}</td><td className="text-right">{num(l.units)}</td>
                <td>{l.last_count_no ? `${l.last_count_no} · ${day(l.last_counted_at)} (${l.days_since}d ago)` : <span className="text-amber-600">never counted</span>}</td>
                <td className={`text-right ${l.last_variances > 0 ? 'text-red-600 font-semibold' : ''}`}>{l.last_count_no ? num(l.last_variances) : '—'}</td>
                <td>{l.open_count_no ?? '—'}</td>
                <td className="text-right">{!readOnly && !l.open_count_id && <button className={btn} onClick={() => start(l.location_id)}>Start count</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Warehouses, location assignment and access ─────────────────────────────────
function SetupTab({ readOnly }: { readOnly: boolean }) {
  const wh = useLoad(() => api.inventory.warehouse.list(), []);
  const locs = useLoad(() => api.inventory.locations(), []);
  const net = useLoad(() => api.inventory.warehouse.network(), []);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [access, setAccess] = useState<{ id: number; name: string } | null>(null);
  const warehouseOf: Record<number, number | null> = {};
  for (const b of net.data?.branches ?? []) for (const w of b.warehouses) for (const l of w.locations) warehouseOf[l.id] = w.id;
  const reloadAll = () => { wh.reload(); locs.reload(); net.reload(); };
  const run = async (fn: () => Promise<unknown>, ok: string) => { setErr(''); setMsg(''); try { await fn(); setMsg(ok); reloadAll(); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="space-y-5">
      <Err msg={err || wh.error || locs.error} /><Ok msg={msg} />
      <section>
        <h4 className="text-sm font-bold text-slate-900 mb-2">Warehouses in this branch</h4>
        {!wh.data ? <Spin /> : !wh.data.length ? <Empty>No warehouses yet. Locations can stay ungrouped, or be grouped into warehouses here.</Empty> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th className="py-1">Warehouse</th><th>Code</th><th className="text-right">Locations</th><th className="text-right">Units</th><th /></tr></thead>
            <tbody>{wh.data.map((w: any) => (
              <tr key={w.id} className="border-t border-slate-100"><td className="py-1.5 font-semibold">{w.name}{!w.is_active && <span className="ml-1 text-[10px] bg-slate-100 text-slate-500 rounded px-1">inactive</span>}</td><td className="text-slate-500">{w.code}</td><td className="text-right">{w.locations}</td><td className="text-right">{num(w.units)}</td>
                <td className="text-right">{!readOnly && <button className={btn} onClick={() => run(() => api.inventory.warehouse.update(w.id, { is_active: !w.is_active }), `${w.name} ${w.is_active ? 'deactivated' : 'activated'}.`)}>{w.is_active ? 'Deactivate' : 'Activate'}</button>}</td></tr>
            ))}</tbody>
          </table>
        )}
        {!readOnly && (
          <form className="flex flex-wrap gap-2 mt-3" onSubmit={e => { e.preventDefault(); if (!name.trim()) return; run(async () => { await api.inventory.warehouse.create({ name: name.trim(), code: code.trim() || undefined }); setName(''); setCode(''); }, 'Warehouse added.'); }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="Warehouse name" maxLength={100} className={`${input} flex-1 min-w-[160px]`} aria-label="Warehouse name" />
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="Code" maxLength={30} className={`${input} w-28`} aria-label="Warehouse code" />
            <button className={primary}>Add warehouse</button>
          </form>
        )}
      </section>
      <section>
        <h4 className="text-sm font-bold text-slate-900 mb-2">Locations</h4>
        {!locs.data || !net.data ? <Spin /> : (
          <table className="w-full text-xs">
            <thead><tr className="text-left text-slate-500"><th className="py-1">Location</th><th>Warehouse</th><th className="text-right">Units</th><th /></tr></thead>
            <tbody>{locs.data.filter(l => l.is_active).map(l => (
              <tr key={l.id} className="border-t border-slate-100">
                <td className="py-1.5 font-semibold">{l.name}{l.is_default && <span className="ml-1 text-[10px] text-slate-400">default</span>}</td>
                <td><select disabled={readOnly} value={warehouseOf[l.id] ?? ''} onChange={e => run(() => api.inventory.warehouse.assign(l.id, e.target.value ? Number(e.target.value) : null), `${l.name} updated.`)} className={`${input} !py-1 text-xs`} aria-label={`Warehouse of ${l.name}`}>
                  <option value="">Not in a warehouse</option>{(wh.data ?? []).filter((w: any) => w.is_active).map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></td>
                <td className="text-right">{num(l.units)}</td>
                <td className="text-right"><button className={btn} onClick={() => setAccess({ id: l.id, name: l.name })}>Access</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {access && <AccessEditor id={access.id} name={access.name} readOnly={readOnly} onClose={() => setAccess(null)} onSaved={m => { setAccess(null); setMsg(m); }} />}
    </div>
  );
}

function AccessEditor({ id, name, readOnly, onClose, onSaved }: { id: number; name: string; readOnly: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const { data, error: loadError } = useLoad(() => api.inventory.warehouse.access(id), [id]);
  const [rules, setRules] = useState<Record<number, { can_issue: boolean; can_receive: boolean; can_count: boolean }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (data && !rules) { const m: Record<number, any> = {}; for (const r of data.rules) m[r.user_id] = { can_issue: !!r.can_issue, can_receive: !!r.can_receive, can_count: !!r.can_count }; setRules(m); }
  }, [data, rules]);
  if (!data || !rules) return <Overlay title={`Access to ${name}`} onCancel={onClose}>{loadError ? <Err msg={loadError} /> : <Spin />}</Overlay>;
  const users: { id: number; name: string }[] = [...data.users];
  for (const r of data.rules) if (!users.some(u => u.id === r.user_id)) users.push({ id: r.user_id, name: r.name });
  const set = (uid: number, patch: Record<string, boolean>) => setRules(m => ({ ...(m ?? {}), [uid]: { ...(m?.[uid] ?? { can_issue: true, can_receive: true, can_count: true }), ...patch } }));
  const save = async () => {
    setBusy(true); setError('');
    try {
      const list = Object.entries(rules).map(([uid, r]) => ({ user_id: Number(uid), ...r }));
      await api.inventory.warehouse.setAccess(id, list);
      onSaved(list.length ? `${name} is now limited to ${list.length} named user(s).` : `${name} is open to all staff of the branch.`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Overlay title={`Access to ${name}`} onCancel={onClose} wide>
      <Err msg={error} />
      <p className="text-xs text-slate-500">With nobody ticked, every staff member of the branch can use this location. Tick people to limit it to them. Administrators and the branch manager always have access.</p>
      {!users.length && <Empty>No staff users in this branch.</Empty>}
      <table className="w-full text-xs">
        <thead><tr className="text-left text-slate-500"><th className="py-1">Staff</th><th>Allowed</th><th>Issue / sell</th><th>Receive</th><th>Count</th></tr></thead>
        <tbody>{users.map(u => {
          const r = rules[u.id];
          return (
            <tr key={u.id} className="border-t border-slate-100">
              <td className="py-1.5">{u.name}</td>
              <td><input type="checkbox" disabled={readOnly} checked={!!r} onChange={e => setRules(m => { const n = { ...(m ?? {}) }; if (e.target.checked) n[u.id] = { can_issue: true, can_receive: true, can_count: true }; else delete n[u.id]; return n; })} aria-label={`Allow ${u.name}`} /></td>
              {(['can_issue', 'can_receive', 'can_count'] as const).map(k => <td key={k}><input type="checkbox" disabled={readOnly || !r} checked={!!r?.[k]} onChange={e => set(u.id, { [k]: e.target.checked })} aria-label={`${u.name} ${k}`} /></td>)}
            </tr>
          );
        })}</tbody>
      </table>
      <div className="flex justify-end gap-2"><button className={btn} onClick={onClose}>Close</button>{!readOnly && <button className={primary} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save access'}</button>}</div>
    </Overlay>
  );
}
