import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, PackagePlus, X } from 'lucide-react';
import { api } from '../api/client';

type Tab = 'plan' | 'board' | 'supply' | 'setup' | 'log';
interface Props { role?: string; onClose: () => void; onChanged: () => void }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const small = 'text-xs border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white';
const money = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');

const STATUS: Record<string, { label: string; cls: string }> = {
  out_of_stock: { label: 'Out of stock', cls: 'bg-red-100 text-red-700' },
  critical:     { label: 'Critical',     cls: 'bg-orange-100 text-orange-700' },
  low:          { label: 'Low',          cls: 'bg-amber-100 text-amber-700' },
  on_order:     { label: 'On order',     cls: 'bg-blue-100 text-blue-700' },
  ok:           { label: 'OK',           cls: 'bg-emerald-100 text-emerald-700' },
  excess:       { label: 'Excess',       cls: 'bg-violet-100 text-violet-700' },
};
const Badge = ({ s }: { s: string }) => <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS[s]?.cls ?? ''}`}>{STATUS[s]?.label ?? s}</span>;
const Err = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Spin = () => <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;
const why = (i: any) => `Reorder point ${i.reorder_point} (${i.rop_basis}): demand ${i.daily_demand}/day x ${i.lead_time_days} days lead time (${i.lead_time_source}) + safety stock ${i.safety_stock} (${i.safety_basis}). Target ${i.target}. Position ${i.position} = available ${i.available} + incoming ${i.incoming}.`;

// Replenishment & stockout prevention: what to order, how much, from whom. Nothing is ordered until an authorised user approves it.
export default function ReplenishmentModal({ role, onClose, onChanged }: Props) {
  const canManage = role === 'org_admin' || role === 'branch_manager';
  const isAdmin = role === 'org_admin';
  const [tab, setTab] = useState<Tab>('plan');
  const tabs: [Tab, string][] = [['plan', 'Recommendations'], ['board', 'Stock status'], ['supply', 'Incoming & requirements'], ['setup', 'Settings'], ['log', 'Approvals']];
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full sm:max-w-5xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><PackagePlus size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Replenishment</h3>
              <p className="text-xs text-slate-500">Spot shortages early and order the right amount. Nothing is ordered until an authorised user approves it.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap gap-1.5 px-5 py-3 border-b border-slate-100">
          {tabs.map(([t, label]) => <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${tab === t ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>)}
        </div>
        <div className="overflow-auto flex-1 p-5">
          {tab === 'plan' && <Recommendations canManage={canManage} onChanged={onChanged} />}
          {tab === 'board' && <Board canManage={canManage} onChanged={onChanged} />}
          {tab === 'supply' && <Supply canManage={canManage} />}
          {tab === 'setup' && <Setup isAdmin={isAdmin} canManage={canManage} />}
          {tab === 'log' && <Log />}
        </div>
      </div>
    </div>
  );
}

function Recommendations({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const [plan, setPlan] = useState<any>(null);
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([]);
  const [budget, setBudget] = useState('');
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [qty, setQty] = useState<Record<number, string>>({});
  const [reason, setReason] = useState<Record<number, string>>({});
  const [pick, setPick] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [done, setDone] = useState<any[]>([]);
  const [busy, setBusy] = useState('');
  const load = useCallback(async (b = budget) => {
    setError('');
    try {
      const p = await api.inventory.replenishmentPlan(b ? Number(b) : undefined);
      setPlan(p);
      const c: Record<number, boolean> = {}, q: Record<number, string> = {};
      for (const i of p.items) if (i.suggested_qty > 0) { c[i.tire_id] = i.funded_qty > 0; q[i.tire_id] = String(i.funded_qty || i.suggested_qty); }
      setChecked(c); setQty(q); setReason({});
    } catch (e: any) { setError(e.message); }
  }, [budget]);
  useEffect(() => { load(''); api.inventory.replenishmentSuppliers().then(setSuppliers).catch(() => {}); /* eslint-disable-next-line */ }, []);
  if (!plan) return error ? <Err msg={error} /> : <Spin />;
  const byTire: Record<number, any> = Object.fromEntries(plan.items.map((i: any) => [i.tire_id, i]));
  const s = plan.summary;
  const approve = async (g: any) => {
    const key = String(g.supplier_id ?? 'none');
    const supplierId = g.supplier_id ?? Number(pick[key]);
    if (!supplierId) { setError(`Choose a supplier for the unassigned items first`); return; }
    const lines = plan.items.filter((i: any) => (i.supplier_id ?? null) === (g.supplier_id ?? null) && i.suggested_qty > 0 && checked[i.tire_id])
      .map((i: any) => ({ tire_id: i.tire_id, qty: Number(qty[i.tire_id]), reason: reason[i.tire_id]?.trim() || undefined }));
    if (!lines.length) { setError('Tick at least one line'); return; }
    const total = lines.reduce((a: number, l: any) => a + l.qty * byTire[l.tire_id].cost_price, 0);
    const name = g.supplier_id ? g.supplier_name : suppliers.find(x => x.id === supplierId)?.name;
    if (!window.confirm(`Create a purchase order for ${name}?\n\n${lines.length} line(s), ${lines.reduce((a: number, l: any) => a + l.qty, 0)} units, about ${money(total)}.\n\nThis commits your business to buy from the supplier.`)) return;
    setBusy(key); setError('');
    try {
      const r = await api.inventory.approveReplenishment([{ supplier_id: supplierId, lines }], budget ? Number(budget) : undefined);
      setDone(d => [...r.orders, ...d]); onChanged(); await load();
    } catch (e: any) { setError(e.message); await load(); }
    finally { setBusy(''); }
  };
  return (
    <div className="space-y-4">
      <Err msg={error} />
      {done.length > 0 && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {done.map(o => <p key={o.purchase_id}>Purchase order <b>{o.po_no}</b> created for {o.supplier_name}: {o.units} units, {money(o.total)}, expected {date(o.expected_date)}.</p>)}
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        {([['out_of_stock', s.out_of_stock], ['critical', s.critical], ['low', s.low], ['on_order', s.on_order], ['excess', s.excess], ['ok', s.ok]] as [string, number][]).map(([k, n]) => (
          <div key={k} className="rounded-xl border border-slate-200 px-3 py-2"><Badge s={k} /><p className="text-lg font-bold text-slate-900 mt-1">{n}</p></div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-xs text-slate-500">Working capital limit
          <input aria-label="Budget" type="number" min={0} value={budget} onChange={e => setBudget(e.target.value)} placeholder={s.budget ? String(s.budget) + ' (saved)' : 'no limit'} className={small + ' w-36'} />
        </label>
        <button onClick={() => load(budget)} className="text-xs font-semibold text-teal-700 hover:underline">Recalculate</button>
        <span className="ml-auto text-xs text-slate-500">Suggested {money(s.suggested_cost)}{s.budget ? ` · within budget ${money(s.funded_cost)}` : ''}{s.deferred ? ` · ${s.deferred} deferred` : ''}</span>
      </div>
      {!canManage && <p className="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2">You can see the recommendations. Only a manager or administrator can approve them into purchase orders.</p>}
      {plan.groups.length === 0 && <p className="py-8 text-center text-sm text-slate-400">Nothing needs ordering right now.</p>}
      {plan.groups.map((g: any) => {
        const key = String(g.supplier_id ?? 'none');
        const lines = plan.items.filter((i: any) => (i.supplier_id ?? null) === (g.supplier_id ?? null) && i.suggested_qty > 0);
        const sel = lines.filter((i: any) => checked[i.tire_id]);
        const selTotal = sel.reduce((a: number, i: any) => a + Number(qty[i.tire_id] || 0) * i.cost_price, 0);
        const needReason = sel.some((i: any) => Number(qty[i.tire_id]) > i.funded_qty && (reason[i.tire_id]?.trim().length ?? 0) < 3);
        const invalid = sel.some((i: any) => !(Number(qty[i.tire_id]) > 0) || !Number.isInteger(Number(qty[i.tire_id])));
        return (
          <section key={key} className="rounded-xl border border-slate-200 overflow-hidden" data-supplier={key}>
            <div className="flex flex-wrap items-center gap-3 bg-slate-50 px-4 py-2.5">
              <div className="flex-1 min-w-[10rem]">
                <p className="text-sm font-bold text-slate-800">{g.supplier_name}</p>
                <p className="text-[11px] text-slate-500">{g.lines} line{g.lines === 1 ? '' : 's'} · lead time up to {g.lead_time_days} days · suggested {money(g.total_cost)}</p>
              </div>
              {g.supplier_id == null && canManage && (
                <select aria-label="Supplier for unassigned items" value={pick[key] ?? ''} onChange={e => setPick({ ...pick, [key]: e.target.value })} className={small}>
                  <option value="">Choose supplier…</option>{suppliers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              )}
              {g.below_min_order_value && <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">Below the supplier minimum order {money(g.min_order_value)} (short by {money(g.min_order_shortfall)})</span>}
              {canManage && (
                <button disabled={!sel.length || needReason || invalid || busy === key} onClick={() => approve(g)}
                  className="bg-teal-600 text-white text-xs font-semibold px-3 py-2 rounded-lg hover:bg-teal-700 disabled:opacity-50">
                  {busy === key ? 'Creating…' : `Approve & create PO (${money(selTotal)})`}
                </button>
              )}
            </div>
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="pl-4 py-1 w-8" /><th>Item</th><th>Status</th><th className="text-right">Avail.</th><th className="text-right">Incoming</th><th className="text-right">Reorder pt</th><th className="text-right">Cover</th><th className="text-right w-24">Order qty</th><th className="text-right pr-4">Cost</th></tr></thead>
              <tbody>
                {lines.map((i: any) => {
                  const over = Number(qty[i.tire_id]) > i.funded_qty;
                  return (
                    <tr key={i.tire_id} className="border-t border-slate-100 align-top">
                      <td className="pl-4 py-2"><input type="checkbox" aria-label={`Select ${i.item_name}`} disabled={!canManage} checked={!!checked[i.tire_id]} onChange={e => setChecked({ ...checked, [i.tire_id]: e.target.checked })} /></td>
                      <td className="py-2"><span title={why(i)}>{i.item_name}</span>
                        {i.constraints.length > 0 && <p className="text-[11px] text-slate-400">{i.constraints.join(' · ')}</p>}
                        {i.funding !== 'full' && <p className="text-[11px] text-amber-600">{i.funding === 'deferred' ? 'Deferred: over the working capital limit' : `Trimmed to ${i.funded_qty} by the working capital limit`}</p>}
                        {over && canManage && <input aria-label={`Reason for ordering more of ${i.item_name}`} value={reason[i.tire_id] ?? ''} onChange={e => setReason({ ...reason, [i.tire_id]: e.target.value })} placeholder="Reason for ordering more than recommended" className={small + ' mt-1 w-full'} />}
                      </td>
                      <td><Badge s={i.status} /></td>
                      <td className="text-right">{i.available}</td><td className="text-right">{i.incoming}</td><td className="text-right">{i.reorder_point}</td>
                      <td className="text-right">{i.days_of_cover != null ? i.days_of_cover + ' d' : '—'}</td>
                      <td className="text-right"><input aria-label={`Order quantity for ${i.item_name}`} type="number" min={1} disabled={!canManage} value={qty[i.tire_id] ?? ''} onChange={e => setQty({ ...qty, [i.tire_id]: e.target.value })} className={small + ' w-20 text-right'} /></td>
                      <td className="text-right pr-4">{money(Number(qty[i.tire_id] || 0) * i.cost_price)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

const PARAMS: [string, string, string?][] = [
  ['min_stock', 'Minimum'], ['max_stock', 'Maximum'], ['reorder_level', 'Fixed reorder pt'], ['safety_stock', 'Safety stock', 'blank = automatic'],
  ['lead_time_days', 'Lead time (days)', 'blank = supplier'], ['moq', 'Min. order qty'], ['order_multiple', 'Order multiple'], ['capacity_units', 'Storage capacity'],
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function ParamEditor({ item, onSaved, onClose }: { item: any; onSaved: () => void; onClose: () => void }) {
  const [v, setV] = useState<Record<string, string>>({
    min_stock: item.min_stock ?? '', max_stock: item.max_stock ?? '', reorder_level: '', safety_stock: item.safety_basis === 'set' ? String(item.safety_stock) : '',
    lead_time_days: item.lead_time_source === 'item' ? String(item.lead_time_days) : '', moq: item.moq ?? '', order_multiple: item.order_multiple ?? '', capacity_units: item.capacity_units ?? '',
  });
  const [mode, setMode] = useState(item.reorder_mode);
  const [seasonal, setSeasonal] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.inventory.seasonality().then((r: any) => { const it = r.items.find((x: any) => x.id === item.tire_id); setSeasonal((it?.seasonality ?? Array(12).fill(1)).map(String)); }).catch(() => setSeasonal(Array(12).fill(1).map(String))); }, [item.tire_id]);
  const save = async () => {
    setError('');
    try {
      const body: Record<string, unknown> = { reorder_mode: mode };
      for (const [k] of PARAMS) { if (k === 'reorder_level' && v[k] === '') continue; body[k] = v[k] === '' ? null : Number(v[k]); }
      body.seasonality = seasonal && seasonal.some(x => Number(x) !== 1) ? seasonal.map(Number) : null;
      await api.inventory.setReplenishmentParams(item.tire_id, body);
      onSaved();
    } catch (e: any) { setError(e.message); }
  };
  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/40 p-4 space-y-3" data-editor={item.tire_id}>
      <div className="flex justify-between"><p className="text-sm font-bold text-slate-800">{item.item_name}: replenishment settings</p><button onClick={onClose} className="text-slate-400"><X size={14} /></button></div>
      <Err msg={error} />
      <p className="text-[11px] text-slate-500">{why(item)}</p>
      <label className="block text-xs font-semibold text-slate-700">Reorder point is
        <select value={mode} onChange={e => setMode(e.target.value)} className={input + ' mt-1 w-full'}>
          <option value="auto">Calculated: demand during lead time + safety stock</option><option value="manual">Fixed: use the fixed reorder point</option>
        </select>
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {PARAMS.map(([k, label, ph]) => (
          <label key={k} className="block text-xs font-semibold text-slate-700">{label}
            <input aria-label={label} type="number" min={0} value={v[k]} placeholder={ph} onChange={e => setV({ ...v, [k]: e.target.value })} className={input + ' mt-1 w-full'} />
          </label>
        ))}
      </div>
      <div>
        <p className="text-xs font-semibold text-slate-700 mb-1">Seasonality (demand factor by month, 1 = normal)</p>
        <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
          {MONTHS.map((m, i) => (
            <label key={m} className="text-[10px] text-slate-500 text-center">{m}
              <input aria-label={`Seasonality ${m}`} type="number" step="0.1" min={0} max={10} value={seasonal?.[i] ?? '1'} onChange={e => setSeasonal((seasonal ?? Array(12).fill('1')).map((x, n) => (n === i ? e.target.value : x)))} className={small + ' w-full text-center'} />
            </label>
          ))}
        </div>
      </div>
      <button onClick={save} className="bg-teal-600 text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-teal-700">Save settings</button>
    </div>
  );
}

function Board({ canManage, onChanged }: { canManage: boolean; onChanged: () => void }) {
  const [plan, setPlan] = useState<any>(null);
  const [filter, setFilter] = useState('attention');
  const [edit, setEdit] = useState<number | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api.inventory.replenishmentPlan().then(setPlan).catch(e => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const rows = useMemo(() => {
    if (!plan) return [];
    const f = (i: any) => filter === 'all' ? true : filter === 'attention' ? ['out_of_stock', 'critical', 'low'].includes(i.status) : i.status === filter;
    const rank: Record<string, number> = { out_of_stock: 0, critical: 1, low: 2, on_order: 3, excess: 4, ok: 5 };
    return plan.items.filter(f).sort((a: any, b: any) => rank[a.status] - rank[b.status] || (a.days_of_cover ?? 1e9) - (b.days_of_cover ?? 1e9));
  }, [plan, filter]);
  if (!plan) return error ? <Err msg={error} /> : <Spin />;
  const editing = plan.items.find((i: any) => i.tire_id === edit);
  return (
    <div className="space-y-3">
      <Err msg={error} />
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Status filter" value={filter} onChange={e => setFilter(e.target.value)} className={small}>
          <option value="attention">Needs attention (out / critical / low)</option><option value="all">All items</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <span className="text-xs text-slate-500">{rows.length} item{rows.length === 1 ? '' : 's'} · excess stock worth {money(plan.summary.excess_value)}</span>
      </div>
      {editing && <ParamEditor item={editing} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); onChanged(); }} />}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">Item</th><th>Status</th><th className="text-right">Avail.</th><th className="text-right">Incoming</th><th className="text-right">Reorder pt</th><th className="text-right">Safety</th><th className="text-right">Lead</th><th className="text-right">Demand/day</th><th className="text-right">Cover</th><th>Runs out</th><th className="text-right">Surplus</th><th /></tr></thead>
          <tbody>
            {rows.map((i: any) => (
              <tr key={i.tire_id} className="border-t border-slate-100">
                <td className="py-1.5" title={why(i)}>{i.item_name}</td><td><Badge s={i.status} /></td>
                <td className="text-right">{i.available}</td><td className="text-right">{i.incoming}</td><td className="text-right">{i.reorder_point}</td><td className="text-right">{i.safety_stock}</td>
                <td className="text-right">{i.lead_time_days} d</td><td className="text-right">{i.daily_demand}</td><td className="text-right">{i.days_of_cover != null ? i.days_of_cover + ' d' : '—'}</td>
                <td className="text-xs">{date(i.stockout_date)}</td><td className="text-right text-violet-700">{i.excess_qty || ''}</td>
                <td className="text-right">{canManage && <button onClick={() => setEdit(i.tire_id)} className="text-xs text-teal-700 hover:underline">Settings</button>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={12} className="py-6 text-center text-xs text-slate-400">No items in this view.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Supply({ canManage }: { canManage: boolean }) {
  const [incoming, setIncoming] = useState<any>(null);
  const [reqs, setReqs] = useState<any[]>([]);
  const [sups, setSups] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [f, setF] = useState({ tire_id: '', qty: '', needed_by: '', note: '' });
  const [edits, setEdits] = useState<Record<number, { lt: string; mv: string }>>({});
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [a, b, c, p] = await Promise.all([api.inventory.replenishmentIncoming(), api.inventory.requirements(), api.inventory.replenishmentSuppliers(), api.inventory.replenishmentPlan()]);
      setIncoming(a); setReqs(b); setSups(c); setItems(p.items);
      setEdits(Object.fromEntries(c.map((s: any) => [s.id, { lt: s.lead_time_days ?? '', mv: s.min_order_value ?? '' }])));
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); await load(); } catch (e: any) { setError(e.message); } };
  if (!incoming) return error ? <Err msg={error} /> : <Spin />;
  return (
    <div className="space-y-6">
      <Err msg={error} />
      <section className="space-y-2">
        <p className="text-sm font-semibold text-slate-800">Incoming supply <span className="font-normal text-xs text-slate-500">· {incoming.units} units on open orders{incoming.overdue_lines ? ` · ${incoming.overdue_lines} late` : ''}</span></p>
        <table className="w-full text-sm"><thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">PO</th><th>Supplier</th><th>Item</th><th className="text-right">Qty</th><th>Expected</th></tr></thead>
          <tbody>{incoming.rows.map((r: any, n: number) => <tr key={n} className="border-t border-slate-100"><td className="py-1.5 font-mono text-xs">{r.po_no}</td><td>{r.supplier_name}</td><td>{r.item_name}</td><td className="text-right">{r.qty}</td><td className={r.overdue ? 'text-red-600 font-semibold' : ''}>{date(r.expected_date)}{r.overdue ? ` (${r.days_overdue} d late)` : ''}</td></tr>)}
            {incoming.rows.length === 0 && <tr><td colSpan={5} className="py-4 text-center text-xs text-slate-400">No open purchase orders.</td></tr>}</tbody></table>
      </section>

      <section className="space-y-2">
        <p className="text-sm font-semibold text-slate-800">Planned requirements</p>
        <p className="text-xs text-slate-500">Known future needs (a production run, a project, a promotion) that normal sales history will not show. Open requirements raise the reorder point and target.</p>
        {canManage && (
          <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); run(async () => { await api.inventory.addRequirement({ tire_id: Number(f.tire_id), qty: Number(f.qty), needed_by: f.needed_by, note: f.note || undefined }); setF({ tire_id: '', qty: '', needed_by: '', note: '' }); }); }}>
            <select aria-label="Requirement item" value={f.tire_id} onChange={e => setF({ ...f, tire_id: e.target.value })} className={input}><option value="">Item…</option>{items.map(i => <option key={i.tire_id} value={i.tire_id}>{i.item_name}</option>)}</select>
            <input aria-label="Requirement quantity" type="number" min={1} value={f.qty} onChange={e => setF({ ...f, qty: e.target.value })} placeholder="Qty" className={input + ' w-24'} />
            <input aria-label="Needed by" type="date" value={f.needed_by} onChange={e => setF({ ...f, needed_by: e.target.value })} className={input} />
            <input aria-label="Requirement note" value={f.note} onChange={e => setF({ ...f, note: e.target.value })} placeholder="Note, e.g. Production run" maxLength={300} className={input + ' flex-1 min-w-[10rem]'} />
            <button type="submit" disabled={!f.tire_id || !f.qty || !f.needed_by} className="bg-teal-600 text-white text-sm font-medium px-4 rounded-xl hover:bg-teal-700 disabled:opacity-50">Add</button>
          </form>
        )}
        <table className="w-full text-sm"><tbody>{reqs.map(r => (
          <tr key={r.id} className={'border-t border-slate-100 ' + (r.status === 'closed' ? 'text-slate-400' : '')}><td className="py-1.5">{r.item_name}</td><td className="text-right">{r.qty}</td><td className="pl-3">by {date(r.needed_by)}</td><td className="text-xs">{r.note}</td>
            <td className="text-right">{r.status === 'open' && canManage ? <button onClick={() => run(() => api.inventory.closeRequirement(r.id))} className="text-xs text-teal-700 hover:underline">Close</button> : r.status}</td></tr>))}
          {reqs.length === 0 && <tr><td className="py-3 text-center text-xs text-slate-400">No planned requirements.</td></tr>}</tbody></table>
      </section>

      <section className="space-y-2">
        <p className="text-sm font-semibold text-slate-800">Supplier lead times and minimum orders</p>
        <p className="text-xs text-slate-500">The lead time used for an item is, in order: the item's own, the supplier's, the observed average of received orders (at least two), then the company default.</p>
        <table className="w-full text-sm"><thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">Supplier</th><th className="text-right">Observed</th><th className="text-right">Orders</th><th className="text-right">Lead time (d)</th><th className="text-right">Min. order value</th><th /></tr></thead>
          <tbody>{sups.map(s => (
            <tr key={s.id} className="border-t border-slate-100"><td className="py-1.5">{s.name}</td><td className="text-right">{s.observed_days != null ? `${s.observed_days} d (${s.min_days}–${s.max_days})` : '—'}</td><td className="text-right">{s.received_orders}</td>
              <td className="text-right"><input aria-label={`Lead time for ${s.name}`} type="number" min={0} disabled={!canManage} value={edits[s.id]?.lt ?? ''} onChange={e => setEdits({ ...edits, [s.id]: { ...edits[s.id], lt: e.target.value } })} className={small + ' w-16 text-right'} /></td>
              <td className="text-right"><input aria-label={`Minimum order value for ${s.name}`} type="number" min={0} disabled={!canManage} value={edits[s.id]?.mv ?? ''} onChange={e => setEdits({ ...edits, [s.id]: { ...edits[s.id], mv: e.target.value } })} className={small + ' w-24 text-right'} /></td>
              <td className="text-right">{canManage && <button onClick={() => run(() => api.inventory.setSupplierReplenishment(s.id, { lead_time_days: edits[s.id].lt === '' ? null : Number(edits[s.id].lt), min_order_value: edits[s.id].mv === '' ? null : Number(edits[s.id].mv) }))} className="text-xs text-teal-700 hover:underline">Save</button>}</td></tr>))}
            {sups.length === 0 && <tr><td colSpan={6} className="py-3 text-center text-xs text-slate-400">No suppliers yet.</td></tr>}</tbody></table>
      </section>
    </div>
  );
}

function Setup({ isAdmin, canManage }: { isAdmin: boolean; canManage: boolean }) {
  const [s, setS] = useState<any>(null);
  const [v, setV] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [cats, setCats] = useState<any[]>([]);
  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([api.inventory.replenishmentSettings(), api.inventory.seasonality()]);
      setS(a); setCats(b.categories);
      setV({ service_level: String(Math.round(a.service_level * 1000) / 10), lookback_days: String(a.lookback_days), cover_days: String(a.cover_days), default_lead_days: String(a.default_lead_days), excess_days: String(a.excess_days), mode: a.mode, budget: a.budget ? String(a.budget) : '' });
    } catch (e: any) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!s) return error ? <Err msg={error} /> : <Spin />;
  const save = async () => {
    setError(''); setSaved(false);
    try {
      await api.inventory.setReplenishmentSettings({ service_level: Number(v.service_level) / 100, lookback_days: Number(v.lookback_days), cover_days: Number(v.cover_days), default_lead_days: Number(v.default_lead_days), excess_days: Number(v.excess_days), mode: v.mode, budget: v.budget === '' ? null : Number(v.budget) });
      setSaved(true); await load();
    } catch (e: any) { setError(e.message); }
  };
  const field = (k: string, label: string, hint: string, step?: string) => (
    <label className="block text-xs font-semibold text-slate-700">{label}
      <input aria-label={label} type="number" step={step} min={0} disabled={!isAdmin} value={v[k] ?? ''} onChange={e => setV({ ...v, [k]: e.target.value })} className={input + ' mt-1 w-full disabled:opacity-60'} />
      <span className="block font-normal text-[11px] text-slate-500 mt-0.5">{hint}</span>
    </label>
  );
  return (
    <div className="space-y-5">
      <Err msg={error} />
      <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3 text-xs text-slate-600 space-y-1">
        <p><b>Reorder point</b> = expected demand during lead time + safety stock (never below the item's minimum).</p>
        <p><b>Order quantity</b> = target stock − (available stock + confirmed incoming), raised to the supplier's minimum, rounded up to the pack multiple, and limited by storage capacity and working capital.</p>
        <p>Available stock excludes reserved, quarantined and expired units. Incoming means open purchase orders and transfers in transit.</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {field('service_level', 'Service level (%)', 'Used to size safety stock automatically from demand variability. 0 turns it off.', 'any')}
        {field('lookback_days', 'Demand history (days)', '14 to 365. Sales over this window set the demand rate.')}
        {field('cover_days', 'Order cycle (days)', 'How many days of demand an order should cover beyond the reorder point.')}
        {field('default_lead_days', 'Default lead time (days)', 'Used when neither the item nor the supplier has one.')}
        {field('excess_days', 'Excess threshold (days of cover)', 'Stock covering more days than this is flagged as excess.')}
        {field('budget', 'Working capital limit', 'Total to spend per replenishment run. Blank = no limit.', 'any')}
        <label className="block text-xs font-semibold text-slate-700">Default reorder point
          <select disabled={!isAdmin} value={v.mode ?? 'auto'} onChange={e => setV({ ...v, mode: e.target.value })} className={input + ' mt-1 w-full disabled:opacity-60'}>
            <option value="auto">Calculated from demand</option><option value="manual">Fixed per item</option>
          </select>
          <span className="block font-normal text-[11px] text-slate-500 mt-0.5">Each item can override this in its Replenishment settings.</span>
        </label>
      </div>
      {isAdmin ? <div className="flex items-center gap-3"><button onClick={save} className="bg-teal-600 text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-teal-700">Save settings</button>{saved && <span className="text-xs text-emerald-600">Saved</span>}</div>
        : <p className="text-xs text-slate-400">Only an administrator can change company settings.</p>}
      <CategorySeasonality cats={cats} canManage={canManage} onSaved={load} />
    </div>
  );
}

function CategorySeasonality({ cats, canManage, onSaved }: { cats: any[]; canManage: boolean; onSaved: () => void }) {
  const [id, setId] = useState('');
  const [f, setF] = useState<string[]>(Array(12).fill('1'));
  const [error, setError] = useState('');
  const pickCat = (v: string) => { setId(v); const c = cats.find(x => String(x.id) === v); setF((c?.seasonality ?? Array(12).fill(1)).map(String)); };
  return (
    <section className="space-y-2">
      <p className="text-sm font-semibold text-slate-800">Seasonality by category</p>
      <p className="text-xs text-slate-500">Demand factor per month for every item in a category (1 = normal, 2 = double). An item's own seasonality takes precedence. Past sales are adjusted for the season they fell in, then projected over the lead time.</p>
      <Err msg={error} />
      <select aria-label="Seasonality category" value={id} onChange={e => pickCat(e.target.value)} className={small}><option value="">Choose a category…</option>{cats.map(c => <option key={c.id} value={c.id}>{c.name}{c.seasonality ? ' (set)' : ''}</option>)}</select>
      {id && (
        <>
          <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5">
            {MONTHS.map((m, i) => <label key={m} className="text-[10px] text-slate-500 text-center">{m}<input aria-label={`Category seasonality ${m}`} type="number" step="0.1" min={0} max={10} disabled={!canManage} value={f[i]} onChange={e => setF(f.map((x, n) => (n === i ? e.target.value : x)))} className={small + ' w-full text-center'} /></label>)}
          </div>
          {canManage && <button onClick={async () => { setError(''); try { await api.inventory.setCategorySeasonality(Number(id), f.some(x => Number(x) !== 1) ? f.map(Number) : null); onSaved(); } catch (e: any) { setError(e.message); } }} className="bg-slate-800 text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-slate-900">Save category seasonality</button>}
        </>
      )}
    </section>
  );
}

function Log() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api.inventory.replenishmentApprovals().then(setRows).catch(e => setError(e.message)); }, []);
  if (!rows) return error ? <Err msg={error} /> : <Spin />;
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500">Every purchase order raised from a recommendation: what was suggested, what was ordered, why it differed, and who approved it.</p>
      <table className="w-full text-sm"><thead><tr className="text-[11px] uppercase text-slate-400 text-left"><th className="py-1">When</th><th>PO</th><th>Item</th><th className="text-right">Suggested</th><th className="text-right">Ordered</th><th>Reason</th><th>By</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id} className="border-t border-slate-100"><td className="py-1.5 text-xs">{new Date(r.approved_at).toLocaleString()}</td><td className="font-mono text-xs">{r.po_no}</td><td title={r.basis ? why({ ...r.basis, rop_basis: '', lead_time_source: '', safety_basis: '', incoming: 0, available: 0 }) : ''}>{r.item_name}</td>
            <td className="text-right">{r.suggested_qty}</td><td className="text-right font-semibold">{r.ordered_qty}</td><td className="text-xs text-slate-500">{r.reason ?? ''}</td><td className="text-xs">{r.user_name ?? ''}</td></tr>))}
          {rows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-xs text-slate-400">No recommendations approved yet.</td></tr>}</tbody></table>
    </div>
  );
}
