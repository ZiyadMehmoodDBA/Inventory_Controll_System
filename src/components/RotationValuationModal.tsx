import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCw, X } from 'lucide-react';
import { api } from '../api/client';

type Tab = 'policies' | 'pick' | 'age' | 'expiry' | 'valuation';
interface Props { role?: string; onClose: () => void; onChanged: () => void }
interface Item { id: number; brand?: string; model: string; size?: string; sku?: string | null; tracking?: string }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const money = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const itemName = (t: Item) => [t.brand, t.model, t.size].filter(Boolean).join(' ');

// Rotation = which physical units leave first. Valuation = which cost is booked. Two independent settings, kept on separate tabs.
export default function RotationValuationModal({ role, onClose, onChanged }: Props) {
  const isAdmin = role === 'org_admin';
  const canManage = isAdmin || role === 'branch_manager';
  const [tab, setTab] = useState<Tab>('policies');
  const tabs: [Tab, string][] = [['policies', 'Rotation policy'], ['pick', 'Pick guide'], ['age', 'Stock age'], ['expiry', 'Expiry exposure'], ['valuation', 'Valuation']];
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full sm:max-w-4xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><RotateCw size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Stock rotation &amp; valuation</h3>
              <p className="text-xs text-slate-500">Rotation decides which units leave first. Valuation decides what cost is booked. They are set separately.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap gap-1.5 px-5 py-3 border-b border-slate-100">
          {tabs.map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${tab === t ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>
          ))}
        </div>
        <div className="overflow-auto flex-1 p-5">
          {tab === 'policies' && <Policies canManage={canManage} isAdmin={isAdmin} onChanged={onChanged} />}
          {tab === 'pick' && <PickGuide />}
          {tab === 'age' && <StockAge />}
          {tab === 'expiry' && <ExpiryExposure />}
          {tab === 'valuation' && <Valuation isAdmin={isAdmin} canManage={canManage} onChanged={onChanged} />}
        </div>
      </div>
    </div>
  );
}

const Err = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Spin = () => <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;

function Policies({ canManage, isAdmin, onChanged }: { canManage: boolean; isAdmin: boolean; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.inventory.rotation().then(setD).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const set = async (scope: 'company' | 'category' | 'item', id: number | null, policy: string) => {
    setError('');
    try { await api.inventory.setRotation(scope, id, policy || null); await load(); onChanged(); } catch (e: any) { setError(e.message); }
  };
  if (!d) return error ? <Err msg={error} /> : <Spin />;
  const sel = (value: string | null, onChange: (v: string) => void, blank: string, disabled: boolean, label: string) => (
    <select aria-label={label} value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} className={input + ' py-1.5 disabled:opacity-60'}>
      <option value="">{blank}</option>
      {d.policies.map((p: any) => <option key={p.value} value={p.value}>{p.label}</option>)}
    </select>
  );
  return (
    <div className="space-y-5">
      <Err msg={error} />
      <p className="text-xs text-slate-500">{d.note} An item uses its own policy, else its category's, else the company default, else FEFO for goods with an expiry date and FIFO for everything else.</p>
      <div className="rounded-xl border border-slate-200 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[12rem]"><p className="text-sm font-semibold text-slate-800">Company default</p><p className="text-[11px] text-slate-500">Used when neither the item nor its category has a policy.</p></div>
          {sel(d.company, v => set('company', null, v), 'Automatic (FEFO if expiry, else FIFO)', !isAdmin, 'Company rotation policy')}
        </div>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        {d.policies.map((p: any) => <div key={p.value} className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-2"><p className="text-xs font-semibold text-slate-700">{p.label}</p><p className="text-[11px] text-slate-500">{p.description}</p></div>)}
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-800 mb-2">By category</p>
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {d.categories.length === 0 && <p className="p-3 text-xs text-slate-400">No categories yet.</p>}
          {d.categories.map((c: any) => (
            <div key={c.id} className="flex items-center gap-3 px-3 py-2">
              <span className={'flex-1 text-sm text-slate-800 ' + (c.parent_id ? 'pl-4' : '')}>{c.name} <span className="text-xs text-slate-400">· {c.item_count} item{c.item_count === 1 ? '' : 's'}</span></span>
              {sel(c.rotation_policy, v => set('category', c.id, v), 'Use company default', !canManage, `Rotation policy for ${c.name}`)}
            </div>
          ))}
        </div>
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-800 mb-2">Item overrides</p>
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {d.items.length === 0 && <p className="p-3 text-xs text-slate-400">No item has its own policy. Set one in the item form under Stock tracking.</p>}
          {d.items.map((t: Item & { rotation_policy: string }) => (
            <div key={t.id} className="flex items-center gap-3 px-3 py-2">
              <span className="flex-1 text-sm text-slate-800">{itemName(t)}</span>
              {sel(t.rotation_policy, v => set('item', t.id, v), 'Remove override', !canManage, `Rotation policy for ${itemName(t)}`)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PickGuide() {
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [tireId, setTireId] = useState<number | null>(null);
  const [qty, setQty] = useState('1');
  const [res, setRes] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.inventory.list().then((r: any) => setItems((r.items ?? r) as Item[])).catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!tireId) { setRes(null); return; }
    let live = true; setBusy(true); setError('');
    api.inventory.pickSuggestion(tireId, Math.max(1, parseInt(qty, 10) || 1)).then(r => { if (live) setRes(r); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [tireId, qty]);
  const matches = q.trim() ? items.filter(t => (itemName(t) + ' ' + (t.sku ?? '')).toLowerCase().includes(q.toLowerCase())).slice(0, 8) : [];
  return (
    <div className="space-y-4">
      <Err msg={error} />
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[14rem]">
          <input value={q} onChange={e => { setQ(e.target.value); setTireId(null); }} placeholder="Search an item to pick" className={input + ' w-full'} />
          {matches.length > 0 && !tireId && (
            <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
              {matches.map(t => <button key={t.id} onClick={() => { setTireId(t.id); setQ(itemName(t)); }} className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50">{itemName(t)} <span className="text-xs text-slate-400">{t.sku}</span></button>)}
            </div>
          )}
        </div>
        <input aria-label="Quantity to pick" type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} className={input + ' w-24'} />
      </div>
      {busy && <Spin />}
      {res && !busy && (
        <div className="space-y-3">
          <div className="rounded-xl border border-teal-100 bg-teal-50/50 px-4 py-3 text-sm">
            <p className="font-semibold text-teal-800">{res.policy_label}</p>
            <p className="text-xs text-slate-600">Policy from {res.source === 'default' ? 'the automatic default' : res.source}. Location: {res.location.name}. Eligible {res.eligible}, reserved {res.reserved}, free {res.free}.{res.shortfall > 0 ? ` Short by ${res.shortfall}.` : ''}</p>
            {res.note && <p className="text-xs text-slate-500 mt-1">{res.note}</p>}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">Batch</th><th>Received</th><th>Age</th><th>Expiry</th><th className="text-right">Here</th><th className="text-right">Pick</th></tr></thead>
            <tbody>
              {res.plan.map((p: any, i: number) => (
                <tr key={i} className={'border-t border-slate-100 ' + (p.pick > 0 ? 'bg-emerald-50/50' : '')}>
                  <td className="py-1.5 font-mono text-xs">{p.batch_no ?? 'Untracked'}</td><td>{p.received_date ?? '—'}</td><td>{p.age_days != null ? p.age_days + ' d' : '—'}</td><td>{p.expiry_date ?? '—'}</td>
                  <td className="text-right">{p.qty_here}</td><td className="text-right font-bold text-emerald-700">{p.pick || ''}</td>
                </tr>
              ))}
              {res.excluded.map((p: any, i: number) => (
                <tr key={'x' + i} className="border-t border-slate-100 text-slate-400">
                  <td className="py-1.5 font-mono text-xs">{p.batch_no ?? 'Untracked'}</td><td>{p.received_date ?? '—'}</td><td>{p.age_days != null ? p.age_days + ' d' : '—'}</td><td>{p.expiry_date ?? '—'}</td>
                  <td className="text-right">{p.qty}</td><td className="text-right text-xs text-red-500">{p.label}</td>
                </tr>
              ))}
              {res.plan.length + res.excluded.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-xs text-slate-400">No stock at this location.</td></tr>}
            </tbody>
          </table>
          {res.elsewhere.length > 0 && <p className="text-xs text-slate-500">Also held elsewhere: {res.elsewhere.map((e: any) => `${e.name} (${e.qty}${e.kind !== 'normal' ? ', ' + e.kind : ''})`).join(', ')}.</p>}
        </div>
      )}
    </div>
  );
}

function StockAge() {
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.inventory.stockAge().then(setD).catch(e => setError(e.message)); }, []);
  if (!d) return error ? <Err msg={error} /> : <Spin />;
  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500">{d.basis}</p>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {d.buckets.map((b: string) => <div key={b} className="rounded-xl border border-slate-200 px-3 py-2"><p className="text-[11px] text-slate-400 font-semibold">{b} days</p><p className="text-sm font-bold text-slate-900">{d.totals[b].units} units</p><p className="text-[11px] text-slate-500">{money(d.totals[b].value)}</p></div>)}
      </div>
      <p className="text-sm text-slate-700">Older than 180 days: <b>{d.slow_units}</b> units worth <b>{money(d.slow_value)}</b>.</p>
      <table className="w-full text-sm">
        <thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">Item</th><th className="text-right">Units</th><th className="text-right">Value</th><th className="text-right">Avg age</th><th className="text-right">Oldest</th></tr></thead>
        <tbody>{d.items.map((i: any) => (
          <tr key={i.tire_id} className="border-t border-slate-100"><td className="py-1.5">{i.name}<span className="text-xs text-slate-400"> {i.category}</span></td><td className="text-right">{i.units}</td><td className="text-right">{money(i.value)}</td><td className="text-right">{i.average_days} d</td><td className={'text-right ' + (i.oldest_days > 180 ? 'text-red-600 font-semibold' : '')}>{i.oldest_days} d</td></tr>
        ))}{d.items.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-xs text-slate-400">No stock on hand.</td></tr>}</tbody>
      </table>
    </div>
  );
}

function ExpiryExposure() {
  const [days, setDays] = useState(90);
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { setD(null); api.inventory.expiryExposure(days).then(setD).catch(e => setError(e.message)); }, [days]);
  return (
    <div className="space-y-4">
      <Err msg={error} />
      <label className="flex items-center gap-2 text-xs text-slate-500">Look ahead
        <select value={days} onChange={e => setDays(Number(e.target.value))} className="border border-slate-200 rounded-lg px-2 py-1 bg-slate-50">{[30, 60, 90, 180, 365].map(n => <option key={n} value={n}>{n} days</option>)}</select>
      </label>
      {!d ? <Spin /> : (
        <>
          <p className="text-xs text-slate-500">{d.basis}</p>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {Object.entries(d.buckets).map(([k, b]: [string, any]) => <div key={k} className={'rounded-xl border px-3 py-2 ' + (k === 'expired' ? 'border-red-200 bg-red-50' : 'border-slate-200')}><p className="text-[11px] text-slate-400 font-semibold">{k === 'expired' ? 'Expired' : k + ' days'}</p><p className="text-sm font-bold text-slate-900">{b.units} units</p><p className="text-[11px] text-slate-500">{b.batches} batch{b.batches === 1 ? '' : 'es'} · {money(b.value)}</p></div>)}
          </div>
          <p className="text-sm text-slate-700">Already expired: <b>{money(d.expired_value)}</b>. Expected loss within {d.horizon} days (incl. expired): <b className="text-red-600">{money(d.at_risk_value)}</b>.</p>
          <table className="w-full text-sm">
            <thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">Item / batch</th><th>Expiry</th><th className="text-right">Qty</th><th className="text-right">Sales/day</th><th className="text-right">Unsold</th><th className="text-right">At risk</th></tr></thead>
            <tbody>{d.rows.map((r: any) => (
              <tr key={r.batch_id} className="border-t border-slate-100"><td className="py-1.5">{r.item_name} <span className="font-mono text-xs text-slate-400">{r.batch_no}</span></td><td className={r.days_to_expiry < 0 ? 'text-red-600' : ''}>{r.expiry_date}{r.days_to_expiry < 0 ? ' (expired)' : ` (${r.days_to_expiry} d)`}</td><td className="text-right">{r.qty}</td><td className="text-right">{r.daily_sales}</td><td className="text-right">{r.expected_unsold}</td><td className="text-right text-red-600">{money(r.at_risk_value)}</td></tr>
            ))}{d.rows.length === 0 && <tr><td colSpan={6} className="py-4 text-center text-xs text-slate-400">Nothing expires in this window.</td></tr>}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Valuation({ isAdmin, canManage, onChanged }: { isAdmin: boolean; canManage: boolean; onChanged: () => void }) {
  const [m, setM] = useState<any>(null);
  const [adjs, setAdjs] = useState<any[]>([]);
  const [snaps, setSnaps] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [adj, setAdj] = useState({ tire_id: '', cost: '', reason: '' });
  const [snapNote, setSnapNote] = useState('');
  const load = useCallback(async () => {
    try {
      const [a, b, c] = await Promise.all([api.inventory.valuationMethod(), api.inventory.valuationAdjustments(), api.inventory.valuationSnapshots()]);
      setM(a); setAdjs(b); setSnaps(c);
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); api.inventory.list().then((r: any) => setItems((r.items ?? r) as Item[])).catch(() => {}); }, [load]);
  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await load(); onChanged(); } catch (e: any) { setError(e.message); } };
  if (!m) return error ? <Err msg={error} /> : <Spin />;
  const change = (value: string) => run(async () => {
    const opt = m.options.find((o: any) => o.value === value);
    let ack = false;
    if (opt?.needs_ack) {
      if (!window.confirm(`${opt.label}\n\n${opt.description}\n\nThis changes cost of goods sold and stock value only; physical picking order is set separately. Enable it?`)) return;
      ack = true;
    }
    await api.inventory.setValuationMethod(value, { acknowledge_legal: ack, note: note.trim() || undefined });
    setNote('');
  });
  return (
    <div className="space-y-6">
      <Err msg={error} />
      <section className="space-y-2">
        <p className="text-sm font-semibold text-slate-800">Costing policy</p>
        <p className="text-xs text-slate-500">A change applies to new sales and receipts from now on. Past movements keep the cost they were booked at.</p>
        <div className="grid sm:grid-cols-2 gap-2">
          {m.options.map((o: any) => (
            <label key={o.value} className={'rounded-xl border px-3 py-2 cursor-pointer ' + (m.method === o.value ? 'border-teal-500 bg-teal-50/50' : 'border-slate-200 hover:border-slate-300') + (isAdmin ? '' : ' opacity-70 cursor-not-allowed')}>
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-800"><input type="radio" name="valmethod" checked={m.method === o.value} disabled={!isAdmin} onChange={() => change(o.value)} />{o.label}</span>
              <span className="block text-[11px] text-slate-500 mt-0.5">{o.description}</span>
            </label>
          ))}
        </div>
        {isAdmin && <input value={note} onChange={e => setNote(e.target.value)} placeholder="Reason for the next change (optional, kept in history)" maxLength={500} className={input + ' w-full'} />}
        {m.history?.length > 0 && <ul className="text-[11px] text-slate-500 space-y-0.5">{m.history.map((h: any, i: number) => <li key={i}>{new Date(h.changed_at).toLocaleString()} — {h.old_method ?? 'none'} → <b>{h.new_method}</b>{h.user_name ? ` by ${h.user_name}` : ''}{h.note ? ` · ${h.note}` : ''}</li>)}</ul>}
      </section>

      <section className="space-y-2">
        <p className="text-sm font-semibold text-slate-800">Valuation adjustment</p>
        <p className="text-xs text-slate-500">Revalue or write down the stock on hand without moving units. The previous cost of every cost layer is kept.</p>
        {isAdmin ? (
          <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); run(async () => { await api.inventory.adjustValuation({ tire_id: Number(adj.tire_id), new_unit_cost: Number(adj.cost), reason: adj.reason }); setAdj({ tire_id: '', cost: '', reason: '' }); }); }}>
            <select aria-label="Item to revalue" value={adj.tire_id} onChange={e => setAdj({ ...adj, tire_id: e.target.value })} className={input}>
              <option value="">Item…</option>{items.filter((t: any) => Number(t.stock) > 0).map(t => <option key={t.id} value={t.id}>{itemName(t)}</option>)}
            </select>
            <input aria-label="New unit cost" type="number" min={0} step="0.01" value={adj.cost} onChange={e => setAdj({ ...adj, cost: e.target.value })} placeholder="New unit cost" className={input + ' w-32'} />
            <input aria-label="Adjustment reason" value={adj.reason} onChange={e => setAdj({ ...adj, reason: e.target.value })} placeholder="Reason (required)" maxLength={500} className={input + ' flex-1 min-w-[10rem]'} />
            <button type="submit" disabled={!adj.tire_id || adj.cost === '' || adj.reason.trim().length < 3} className="bg-teal-600 text-white text-sm font-medium px-4 rounded-xl hover:bg-teal-700 disabled:opacity-50">Apply</button>
          </form>
        ) : <p className="text-xs text-slate-400">Only an administrator can adjust valuation.</p>}
        {adjs.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">When</th><th>Item</th><th className="text-right">Qty</th><th className="text-right">Old → new unit</th><th className="text-right">Change</th><th>Reason</th></tr></thead>
            <tbody>{adjs.map(a => <tr key={a.id} className="border-t border-slate-100"><td className="py-1.5 text-xs">{new Date(a.created_at).toLocaleDateString()}</td><td>{a.item_name}</td><td className="text-right">{a.qty}</td><td className="text-right">{money(a.old_unit_cost)} → {money(a.new_unit_cost)}</td><td className={'text-right ' + (Number(a.delta) < 0 ? 'text-red-600' : 'text-emerald-600')}>{money(a.delta)}</td><td className="text-xs text-slate-500">{a.reason}</td></tr>)}</tbody></table>
        )}
      </section>

      <section className="space-y-2">
        <p className="text-sm font-semibold text-slate-800">Valuation snapshots</p>
        <p className="text-xs text-slate-500">Freeze the stock value as at today under the current costing policy, for period-end records. Snapshots never change afterwards.</p>
        {canManage && (
          <form className="flex gap-2" onSubmit={e => { e.preventDefault(); run(async () => { await api.inventory.takeValuationSnapshot(snapNote.trim() || undefined); setSnapNote(''); }); }}>
            <input value={snapNote} onChange={e => setSnapNote(e.target.value)} placeholder="Label, e.g. Month end" maxLength={500} className={input + ' flex-1'} />
            <button type="submit" className="bg-slate-800 text-white text-sm font-medium px-4 rounded-xl hover:bg-slate-900">Take snapshot</button>
          </form>
        )}
        {snaps.length > 0 && (
          <table className="w-full text-sm"><thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">Taken</th><th>Label</th><th>Method</th><th className="text-right">Units</th><th className="text-right">Value</th><th /></tr></thead>
            <tbody>{snaps.map(s => <tr key={s.id} className="border-t border-slate-100"><td className="py-1.5 text-xs">{new Date(s.taken_at).toLocaleString()}</td><td>{s.note ?? ''}</td><td>{s.method}</td><td className="text-right">{s.total_units}</td><td className="text-right">{money(s.total_value)}</td><td className="text-right"><button className="text-xs text-teal-700 hover:underline" onClick={() => run(async () => setDetail(await api.inventory.valuationSnapshot(s.id)))}>View</button></td></tr>)}</tbody></table>
        )}
        {detail && (
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="flex justify-between"><p className="text-sm font-semibold">{detail.note || 'Snapshot'} · {detail.label} · {money(detail.total_value)}</p><button onClick={() => setDetail(null)} className="text-slate-400"><X size={14} /></button></div>
            <div className="max-h-48 overflow-auto mt-2"><table className="w-full text-xs"><tbody>{detail.items.map((i: any) => <tr key={i.tire_id} className="border-t border-slate-100"><td className="py-1">{i.item_name}</td><td className="text-right">{i.qty}</td><td className="text-right">{money(i.unit_cost)}</td><td className="text-right">{money(i.value)}</td></tr>)}</tbody></table></div>
          </div>
        )}
      </section>
    </div>
  );
}
