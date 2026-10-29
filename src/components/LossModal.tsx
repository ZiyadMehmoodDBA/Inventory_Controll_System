import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, TrendingDown, X } from 'lucide-react';
import { api } from '../api/client';

type Tab = 'overview' | 'writeoffs' | 'obsolete' | 'aging' | 'returns' | 'patterns' | 'settings';
interface Props { role?: string; onClose: () => void; onChanged: () => void }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const btn = 'text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 disabled:opacity-50';
const primary = 'text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50';
const money = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const date = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');
const Err = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Ok = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Spin = () => <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-slate-400 py-6 text-center">{children}</p>;
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <div><label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>{children}</div>;
const SEV: Record<string, string> = { low: 'bg-slate-100 text-slate-600', medium: 'bg-amber-100 text-amber-700', high: 'bg-red-100 text-red-700' };
const CLS: Record<string, string> = { active: 'bg-emerald-100 text-emerald-700', slow: 'bg-amber-100 text-amber-700', non_moving: 'bg-orange-100 text-orange-700', obsolete: 'bg-red-100 text-red-700' };
const stock = (t: any) => t.stock ?? t.quantity ?? 0;
const itemName = (t: any) => `${t.brand ?? ''} ${t.model ?? ''} ${t.size ?? ''}`.replace(/\s+/g, ' ').trim();

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  const load = useCallback(() => { const n = ++seq.current; setError(''); return fn().then(d => { if (n === seq.current) setData(d); }).catch(e => { if (n === seq.current) setError(e.message); }); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}

function Overlay({ title, children, onCancel }: { title: string; children: React.ReactNode; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] overflow-auto p-5 space-y-3">
        <div className="flex items-center justify-between"><h4 className="text-sm font-bold text-slate-900">{title}</h4><button onClick={onCancel} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><X size={14} /></button></div>
        {children}
      </div>
    </div>
  );
}

// Local calendar date: toISOString() is UTC and would drop today's records east of Greenwich around midnight.
const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const PRESETS: [string, number][] = [['30 days', 30], ['90 days', 90], ['1 year', 365]];

// Waste, damage and obsolete inventory. Physical losses (write-offs, disposals, shortages) and valuation changes (write-downs) are shown
// separately throughout: one removes units, the other only changes what the remaining units are worth.
export default function LossModal({ role, onClose, onChanged }: Props) {
  const canManage = role === 'org_admin' || role === 'branch_manager';
  const isAdmin = role === 'org_admin';
  const readOnly = role === 'demo';
  const [tab, setTab] = useState<Tab>('overview');
  const [days, setDays] = useState(90);
  const range = { from: iso(new Date(Date.now() - days * 86400000)), to: iso(new Date()) };
  const tabs: [Tab, string][] = [['overview', 'Overview'], ['writeoffs', 'Write-offs'], ['obsolete', 'Slow & obsolete'], ['aging', 'Aging'], ['returns', 'Supplier returns'], ['patterns', 'Patterns & actions'], ['settings', 'Settings']];
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full sm:max-w-5xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center"><TrendingDown size={18} className="text-red-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Waste, Damage & Obsolete Stock</h3>
              <p className="text-xs text-slate-500">Physical losses and accounting valuation changes are reported separately.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(tab === 'overview' || tab === 'writeoffs') && <select value={days} onChange={e => setDays(Number(e.target.value))} className={`${input} !py-1 text-xs`} aria-label="Period">{PRESETS.map(([l, d]) => <option key={d} value={d}>Last {l}</option>)}</select>}
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 px-5 py-3 border-b border-slate-100">
          {tabs.map(([t, label]) => <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${tab === t ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>)}
        </div>
        <div className="overflow-auto flex-1 p-5">
          {tab === 'overview' && <Overview range={range} />}
          {tab === 'writeoffs' && <WriteOffs range={range} canManage={canManage} readOnly={readOnly} onChanged={onChanged} />}
          {tab === 'obsolete' && <Obsolete canManage={canManage} isAdmin={isAdmin} readOnly={readOnly} onChanged={onChanged} />}
          {tab === 'aging' && <Aging />}
          {tab === 'returns' && <Returns canManage={canManage} readOnly={readOnly} onChanged={onChanged} />}
          {tab === 'patterns' && <Patterns canManage={canManage} readOnly={readOnly} />}
          {tab === 'settings' && <Settings isAdmin={isAdmin} />}
        </div>
      </div>
    </div>
  );
}

const Card = ({ label, value, sub, tone = 'text-slate-900' }: { label: string; value: string; sub?: string; tone?: string }) => (
  <div className="rounded-xl border border-slate-200 px-3 py-2.5"><p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p><p className={`text-lg font-bold ${tone}`}>{value}</p>{sub && <p className="text-[11px] text-slate-500">{sub}</p>}</div>
);
const Bars = ({ rows, tone = 'bg-red-400' }: { rows: { label: string; value: number; share?: number; note?: string }[]; tone?: string }) => {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div className="space-y-1.5">
      {rows.map(r => (
        <div key={r.label} className="text-xs">
          <div className="flex justify-between"><span className="text-slate-700">{r.label}</span><span className="text-slate-500">{money(r.value)}{r.share != null ? ` · ${r.share}%` : ''}{r.note ? ` · ${r.note}` : ''}</span></div>
          <div className="h-1.5 bg-slate-100 rounded-full mt-0.5"><div className={`h-1.5 rounded-full ${tone}`} style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
};

// ── Overview ────────────────────────────────────────────────────────────────
function Overview({ range }: { range: { from: string; to: string } }) {
  const { data: s, error } = useLoad<any>(() => api.inventory.losses.summary(range), [range.from, range.to]);
  const { data: items } = useLoad<any>(() => api.inventory.losses.breakdown('item', range), [range.from, range.to]);
  if (error) return <Err msg={error} />;
  if (!s) return <Spin />;
  const p = s.physical, v = s.valuation, e = s.exposure, r = s.supplier_returns;
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Physical losses <span className="normal-case font-normal text-slate-400">units that left stock without a sale · {s.period.from} to {s.period.to}</span></p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card label="Written off / disposed" value={money(p.value)} sub={`${p.units} units · ${p.events} records`} tone="text-red-600" />
          <Card label="Net shrinkage" value={money(s.net_shrinkage)} sub={`after ${money(s.gains.value)} found / surplus`} />
          <Card label="Unrecovered supplier returns" value={money(r.unrecovered_loss)} sub={`${money(r.credit_outstanding)} credit still due`} tone={r.unrecovered_loss ? 'text-orange-600' : 'text-slate-900'} />
          <Card label="Loss rate" value={s.loss_rate_pct == null ? '—' : `${s.loss_rate_pct}%`} sub={`of cost of sales (${money(s.cost_of_sales)})`} />
        </div>
        <p className="text-[11px] text-slate-500 mt-1">Net physical loss including unrecovered returns: <b>{money(s.net_physical_loss)}</b>.{r.unlinked.events > 0 && ` ${r.unlinked.events} return(s) worth ${money(r.unlinked.value)} were recorded without a supplier return document, so no credit is tracked.`}</p>
      </div>
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3">
        <p className="text-xs font-bold text-indigo-700 uppercase tracking-wider mb-2">Accounting valuation <span className="normal-case font-normal text-indigo-500">what stock on hand is worth · no units moved · not part of the physical loss above</span></p>
        <div className="grid grid-cols-3 gap-2">
          <Card label="Write-downs" value={money(v.write_down)} tone="text-indigo-700" /><Card label="Write-ups" value={money(v.write_up)} /><Card label="Net change" value={money(v.net_change)} />
        </div>
        {v.adjustments.length > 0 && <ul className="mt-2 text-xs divide-y divide-indigo-100">{v.adjustments.slice(0, 6).map((a: any) => <li key={a.id} className="py-1 flex justify-between gap-3"><span>{date(a.created_at)} · {a.item_name} ({a.qty} units): {a.reason}</span><span className="whitespace-nowrap">{money(a.old_value)} → {money(a.new_value)}</span></li>)}</ul>}
      </div>
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Already a loss, not yet recorded</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Card label="Expired on hand" value={money(e.expired.value)} sub={`${e.expired.units} units, ${e.expired.batches} batch(es)`} tone={e.expired.units ? 'text-red-600' : 'text-slate-900'} />
          <Card label="Held / damaged batches" value={money(e.held_batches.value)} sub={`${e.held_batches.units} units`} />
          <Card label="In damaged locations" value={money(e.damaged_location.value)} sub={`${e.damaged_location.units} units`} />
          <Card label="In quarantine" value={money(e.quarantine_location.value)} sub={`${e.quarantine_location.units} units`} />
        </div>
        <p className="text-[11px] text-slate-400 mt-1">{e.note}</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-6">
        <div><p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">By cause</p>{p.by_cause.length ? <Bars rows={p.by_cause.map((c: any) => ({ label: c.label, value: c.value, share: c.share }))} /> : <Empty>No physical losses in this period.</Empty>}</div>
        <div><p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Biggest items</p>{items?.rows?.length ? <Bars tone="bg-amber-400" rows={items.rows.slice(0, 8).map((c: any) => ({ label: c.label, value: c.value, note: `${c.units} units` }))} /> : <Empty>Nothing to show.</Empty>}</div>
      </div>
      <div><p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">By month</p><Bars tone="bg-slate-400" rows={p.by_month.map((m: any) => ({ label: m.month, value: m.value, note: `${m.events} records` }))} /></div>
    </div>
  );
}

// ── Write-offs: record + register ───────────────────────────────────────────
function WriteOffs({ range, canManage, readOnly, onChanged }: { range: { from: string; to: string }; canManage: boolean; readOnly: boolean; onChanged: () => void }) {
  const { data: meta } = useLoad<any>(() => api.inventory.losses.meta());
  const { data: tires } = useLoad<any[]>(() => api.inventory.list() as Promise<any[]>);
  const { data: locs } = useLoad<any[]>(() => api.inventory.locations() as Promise<any[]>);
  const [cause, setCause] = useState('');
  const [source, setSource] = useState('');
  const { data: reg, error, reload } = useLoad<any>(() => api.inventory.losses.register({ ...range, cause, source }), [range.from, range.to, cause, source]);
  const { data: pending, reload: reloadPending } = useLoad<any[]>(() => api.inventory.adjustments('pending'));
  const [f, setF] = useState({ tire_id: '', reason_code: 'damage', qty: '', location_id: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const lossCodes = new Set<string>((meta?.reasons ?? []).map((x: any) => x.code));
  const tire = (tires ?? []).find(t => String(t.id) === f.tire_id);
  const submit = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const r = await api.inventory.adjust({ tire_id: Number(f.tire_id), qty_change: -Number(f.qty), reason_code: f.reason_code, notes: f.notes || undefined, location_id: f.location_id ? Number(f.location_id) : undefined });
      setMsg(r.status === 'pending' ? 'Recorded and waiting for approval. Stock changes once a manager approves it.' : 'Write-off recorded and stock reduced.');
      setF({ ...f, qty: '', notes: '' }); reload(); reloadPending(); onChanged();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const decide = async (id: number, approve: boolean) => { setErr(''); try { await api.inventory.decideAdjustment(id, approve); reload(); reloadPending(); onChanged(); } catch (e: any) { setErr(e.message); } };
  const waiting = (pending ?? []).filter(a => lossCodes.has(a.reason_code) || a.reason_code === 'return_to_supplier');
  return (
    <div className="space-y-6">
      <Err msg={err || error} /><Ok msg={msg} />
      {!readOnly && (
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Record a loss</p>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
            <div className="col-span-2"><Field label="Item"><select value={f.tire_id} onChange={e => setF({ ...f, tire_id: e.target.value })} className={`${input} w-full`}><option value="">Choose…</option>{(tires ?? []).map(t => <option key={t.id} value={t.id}>{itemName(t)} ({stock(t)})</option>)}</select></Field></div>
            <div className="col-span-2"><Field label="Cause"><select value={f.reason_code} onChange={e => setF({ ...f, reason_code: e.target.value })} className={`${input} w-full`}>{(meta?.reasons ?? []).map((x: any) => <option key={x.code} value={x.code}>{x.label}</option>)}</select></Field></div>
            <Field label="Quantity"><input type="number" min={1} value={f.qty} onChange={e => setF({ ...f, qty: e.target.value })} className={`${input} w-full`} /></Field>
            <Field label="Location"><select value={f.location_id} onChange={e => setF({ ...f, location_id: e.target.value })} className={`${input} w-full`}><option value="">Default</option>{(locs ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
          </div>
          <div className="flex gap-2 mt-2 items-end">
            <div className="flex-1"><Field label={f.reason_code === 'missing_stock' ? 'Notes (required)' : 'Notes'}><input value={f.notes} maxLength={300} onChange={e => setF({ ...f, notes: e.target.value })} placeholder="What happened, where, who found it" className={`${input} w-full`} /></Field></div>
            <button disabled={busy || !f.tire_id || !(Number(f.qty) > 0)} onClick={submit} className={primary}>{busy ? 'Saving…' : 'Record'}</button>
          </div>
          <p className="text-[11px] text-slate-500 mt-1">{tire ? `${stock(tire)} on hand. ` : ''}Staff write-offs, and manager write-offs above the company limit, need approval. The cost is taken from the stock ledger when it posts. Batch disposals are made from Quality; returns to a supplier from the Supplier returns tab.</p>
        </div>
      )}
      {waiting.length > 0 && (
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Waiting for approval ({waiting.length})</p>
          <table className="w-full text-xs"><tbody className="divide-y divide-slate-100">
            {waiting.map(a => <tr key={a.id}><td className="py-1.5">{date(a.requested_at)}</td><td className="font-semibold">{a.item_name}</td><td>{Math.abs(a.qty_change)} units</td><td>{a.notes}</td><td>{a.requested_by_name ?? ''}</td>
              <td className="text-right space-x-1">{canManage && !readOnly && <><button className={btn} onClick={() => decide(a.id, true)}>Approve</button><button className={btn} onClick={() => decide(a.id, false)}>Reject</button></>}</td></tr>)}
          </tbody></table>
        </div>
      )}
      <div>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Register</p>
          <select value={cause} onChange={e => setCause(e.target.value)} className={`${input} !py-1 text-xs`}><option value="">All causes</option>{(meta?.causes ?? []).map((c: any) => <option key={c.value} value={c.value}>{c.label}</option>)}</select>
          <select value={source} onChange={e => setSource(e.target.value)} className={`${input} !py-1 text-xs`}><option value="">Write-offs and disposals</option><option value="adjustment">Write-offs only</option><option value="disposal">Batch disposals only</option></select>
          {reg && <span className="text-xs text-slate-500">{reg.totals.events} records · {reg.totals.units} units · <b>{money(reg.totals.value)}</b></span>}
        </div>
        {!reg ? <Spin /> : reg.rows.length === 0 ? <Empty>No losses recorded for this selection.</Empty> : (
          <div className="overflow-x-auto"><table className="w-full text-xs">
            <thead><tr className="text-slate-500"><th className="text-left pb-1">Date</th><th className="text-left pb-1">Ref</th><th className="text-left pb-1">Item</th><th className="text-right pb-1">Qty</th><th className="text-left pb-1 pl-3">Cause</th><th className="text-left pb-1">Reason</th><th className="text-right pb-1">Value</th><th className="text-left pb-1 pl-3">Recorded by</th><th className="text-left pb-1">Approved by</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{reg.rows.map((x: any) => (
              <tr key={`${x.source}${x.id}`} className="align-top"><td className="py-1.5 whitespace-nowrap">{date(x.at)}</td><td className="font-mono">{x.ref}</td><td className="font-semibold">{x.item_name}{x.batch_no && <span className="font-normal text-slate-500"> · {x.batch_no}</span>}</td><td className="text-right">{x.qty}</td>
                <td className="pl-3">{x.cause_label}</td><td title={x.notes ?? ''}>{x.reason_label}{x.notes && <div className="text-slate-400 max-w-[220px] truncate">{x.notes}</div>}</td><td className="text-right">{money(x.value)}</td><td className="pl-3">{x.recorded_by ?? (x.recorded_by_id ? `User ${x.recorded_by_id}` : '—')}</td><td>{x.approved_by ?? (x.approved_by_id ? `User ${x.approved_by_id}` : x.source === 'disposal' ? 'Manager rule' : '—')}</td></tr>
            ))}</tbody>
          </table>{reg.truncated && <p className="text-[11px] text-slate-400 mt-1">Showing the latest records only; narrow the period or cause to see more.</p>}</div>
        )}
      </div>
    </div>
  );
}

// ── Slow moving & obsolete ──────────────────────────────────────────────────
function Obsolete({ canManage, isAdmin, readOnly, onChanged }: { canManage: boolean; isAdmin: boolean; readOnly: boolean; onChanged: () => void }) {
  const [cls, setCls] = useState('');
  const { data, error, reload } = useLoad<any>(() => api.inventory.losses.obsolescence(cls), [cls]);
  const [dlg, setDlg] = useState<{ kind: 'retire' | 'writedown' | 'writeoff'; it: any } | null>(null);
  const [msg, setMsg] = useState('');
  if (error) return <Err msg={error} />;
  if (!data) return <Spin />;
  const t = data.thresholds;
  return (
    <div className="space-y-4">
      <Ok msg={msg} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {(['slow', 'non_moving', 'obsolete'] as const).map(k => <Card key={k} label={{ slow: 'Slow moving', non_moving: 'Non-moving', obsolete: 'Obsolete' }[k]} value={money(data.summary[k].value)} sub={`${data.summary[k].items} items · provision ${money(data.summary[k].provision)}`} tone={k === 'obsolete' ? 'text-red-600' : k === 'non_moving' ? 'text-orange-600' : 'text-amber-600'} />)}
        <Card label="Suggested provision" value={money(data.suggested_provision)} sub={`on ${money(data.at_risk_value)} at risk`} tone="text-indigo-700" />
      </div>
      <p className="text-[11px] text-slate-500">Slow after {t.slow_days} days without a sale (or {t.slow_cover_days}+ days of cover), non-moving after {t.non_moving_days}, obsolete after {t.obsolete_days} or when marked. Stock received in the last {t.grace_days} days is not judged. {data.note}</p>
      <div className="flex gap-1.5">{[['', 'At risk'], ['slow', 'Slow'], ['non_moving', 'Non-moving'], ['obsolete', 'Obsolete'], ['all', 'Everything']].map(([v, l]) => <button key={v} onClick={() => setCls(v)} className={`px-2.5 py-1 text-xs font-semibold rounded-lg ${cls === v ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>{l}</button>)}</div>
      {data.rows.length === 0 ? <Empty>Nothing in this class.</Empty> : (
        <div className="overflow-x-auto"><table className="w-full text-xs">
          <thead><tr className="text-slate-500"><th className="text-left pb-1">Item</th><th className="text-left pb-1">Class</th><th className="text-right pb-1">Stock</th><th className="text-right pb-1">Value</th><th className="text-right pb-1">Idle days</th><th className="text-left pb-1 pl-3">Last sale</th><th className="text-right pb-1">Cover</th><th className="text-right pb-1">Provision</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.rows.map((x: any) => (
            <tr key={x.tire_id} className="align-top"><td className="py-1.5 font-semibold">{x.name}<div className="font-normal text-slate-500">{x.reason ?? ''}{x.lifecycle_note ? ` · ${x.lifecycle_note}` : ''}</div></td>
              <td><span className={`px-2 py-0.5 rounded-full font-semibold ${CLS[x.class]}`}>{x.class_label}</span></td><td className="text-right">{x.stock}</td><td className="text-right">{money(x.value)}</td><td className="text-right">{x.idle_days}</td><td className="pl-3">{date(x.last_sale)}</td><td className="text-right">{x.cover_days ?? '—'}</td><td className="text-right">{x.provision_pct ? `${money(x.provision_value)} (${x.provision_pct}%)` : '—'}</td>
              <td className="py-1 text-right whitespace-nowrap space-x-1">
                {canManage && !readOnly && <button className={btn} onClick={() => setDlg({ kind: 'retire', it: x })}>{x.lifecycle_status ? 'Retired' : 'Retire'}</button>}
                {isAdmin && !readOnly && x.class !== 'active' && <button className={btn} onClick={() => setDlg({ kind: 'writedown', it: x })} title="Valuation only: no units leave stock">Write down</button>}
                {!readOnly && x.class !== 'active' && <button className={btn} onClick={() => setDlg({ kind: 'writeoff', it: x })} title="Physical: units leave stock">Write off</button>}
              </td></tr>
          ))}</tbody>
        </table>{data.truncated && <p className="text-[11px] text-slate-400 mt-1">Showing the first 500 items.</p>}</div>
      )}
      {dlg && <ObsoleteDialog dlg={dlg} onCancel={() => setDlg(null)} onDone={m => { setDlg(null); setMsg(m); reload(); onChanged(); }} />}
    </div>
  );
}

function ObsoleteDialog({ dlg, onCancel, onDone }: { dlg: { kind: 'retire' | 'writedown' | 'writeoff'; it: any }; onCancel: () => void; onDone: (m: string) => void }) {
  const { kind, it } = dlg;
  const [text, setText] = useState(kind === 'writedown' ? 'Write-down to net realisable value' : '');
  const [status, setStatus] = useState(it.lifecycle_status ?? 'obsolete');
  const [cost, setCost] = useState(String(it.suggested_unit_cost));
  const [qty, setQty] = useState(String(it.stock));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try {
      if (kind === 'retire') { await api.inventory.losses.setLifecycle(it.tire_id, status === 'active' ? null : status, text); return onDone(status === 'active' ? `${it.name} is active again.` : `${it.name} marked ${status}; it will no longer be proposed for reordering.`); }
      if (kind === 'writedown') { await api.inventory.adjustValuation({ tire_id: it.tire_id, new_unit_cost: Number(cost), reason: text }); return onDone(`Valuation of ${it.name} written down. No stock moved.`); }
      const r = await api.inventory.adjust({ tire_id: it.tire_id, qty_change: -Number(qty), reason_code: 'obsolete_writeoff', notes: text || 'Obsolete stock written off' });
      onDone(r.status === 'pending' ? 'Write-off recorded and waiting for approval.' : `${it.name}: ${qty} unit(s) written off.`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const titles = { retire: 'Retire item', writedown: 'Write down valuation', writeoff: 'Write off stock' } as const;
  return (
    <Overlay title={`${titles[kind]} · ${it.name}`} onCancel={onCancel}>
      <Err msg={error} />
      {kind === 'retire' && <Field label="Status"><select value={status} onChange={e => setStatus(e.target.value)} className={`${input} w-full`}><option value="obsolete">Obsolete</option><option value="discontinued">Discontinued (selling through)</option><option value="active">Active (clear the flag)</option></select></Field>}
      {kind === 'writedown' && <><p className="text-[11px] text-indigo-700 bg-indigo-50 rounded-lg px-3 py-2">Accounting valuation only. The {it.stock} units stay in stock; only their cost changes.</p>
        <Field label={`New unit cost (now ${money(it.unit_cost)})`}><input type="number" min={0} step="0.01" value={cost} onChange={e => setCost(e.target.value)} className={`${input} w-full`} /></Field></>}
      {kind === 'writeoff' && <><p className="text-[11px] text-red-700 bg-red-50 rounded-lg px-3 py-2">Physical loss. Units leave stock and are recorded as an obsolete write-off at ledger cost.</p>
        <Field label={`Quantity (${it.stock} on hand)`}><input type="number" min={1} max={it.stock} value={qty} onChange={e => setQty(e.target.value)} className={`${input} w-full`} /></Field></>}
      {status !== 'active' || kind !== 'retire' ? <Field label={kind === 'retire' ? 'Why (required)' : 'Reason'}><textarea rows={2} value={text} onChange={e => setText(e.target.value)} className={`${input} w-full`} /></Field> : null}
      <div className="flex justify-end gap-2"><button onClick={onCancel} className={btn}>Cancel</button><button disabled={busy || (kind === 'retire' && status !== 'active' && text.trim().length < 3) || (kind === 'writedown' && (text.trim().length < 3 || !(Number(cost) >= 0))) || (kind === 'writeoff' && !(Number(qty) > 0))} onClick={go} className={primary}>{busy ? 'Saving…' : 'Confirm'}</button></div>
    </Overlay>
  );
}

// ── Aging ───────────────────────────────────────────────────────────────────
function Aging() {
  const { data: age, error } = useLoad<any>(() => api.inventory.stockAge());
  const { data: ob } = useLoad<any>(() => api.inventory.losses.obsolescence('all'));
  if (error) return <Err msg={error} />;
  if (!age || !ob) return <Spin />;
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">By age of stock <span className="normal-case font-normal text-slate-400">days since receipt</span></p>
        <Bars tone="bg-teal-400" rows={age.buckets.map((b: string) => ({ label: `${b} days`, value: age.totals[b].value, note: `${age.totals[b].units} units` }))} />
        <p className="text-[11px] text-slate-500 mt-1">Stock older than 180 days: {age.slow_units} units worth {money(age.slow_value)}. {age.basis}</p>
      </div>
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">By time since last sale <span className="normal-case font-normal text-slate-400">value at current cost</span></p>
        <Bars tone="bg-amber-400" rows={ob.idle_buckets.map((b: any) => ({ label: `${b.label} days`, value: b.value, note: `${b.items} items` }))} />
      </div>
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Oldest stock</p>
        <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-slate-500"><th className="text-left pb-1">Item</th><th className="text-left pb-1">Category</th><th className="text-right pb-1">Units</th><th className="text-right pb-1">Value</th><th className="text-right pb-1">Oldest (days)</th><th className="text-right pb-1">Average (days)</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{age.items.slice(0, 25).map((i: any) => <tr key={i.tire_id}><td className="py-1.5 font-semibold">{i.name}</td><td>{i.category}</td><td className="text-right">{i.units}</td><td className="text-right">{money(i.value)}</td><td className="text-right">{i.oldest_days}</td><td className="text-right">{i.average_days}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}

// ── Supplier returns ────────────────────────────────────────────────────────
const RET: Record<string, string> = { awaiting_approval: 'Awaiting approval', rejected: 'Rejected', shipped: 'Credit due', credited: 'Credited', short_credited: 'Closed short' };
function Returns({ canManage, readOnly, onChanged }: { canManage: boolean; readOnly: boolean; onChanged: () => void }) {
  const { data, error, reload } = useLoad<any>(() => api.inventory.losses.returns());
  const { data: tires } = useLoad<any[]>(() => api.inventory.list() as Promise<any[]>);
  const { data: sups } = useLoad<any[]>(() => api.suppliers.list() as Promise<any[]>);
  const [f, setF] = useState({ supplier_id: '', tire_id: '', qty: '', reason: '', reference: '' });
  const [credit, setCredit] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const create = async () => {
    setErr(''); setMsg('');
    try { const r = await api.inventory.losses.createReturn({ ...f, supplier_id: Number(f.supplier_id), tire_id: Number(f.tire_id), qty: Number(f.qty) }); setMsg(`${r.return_no} ${r.status === 'awaiting_approval' ? 'recorded and waiting for approval' : 'shipped; stock reduced'}.`); setF({ ...f, qty: '', reason: '', reference: '' }); reload(); onChanged(); }
    catch (e: any) { setErr(e.message); }
  };
  const record = async () => {
    setErr('');
    try { const r = await api.inventory.losses.creditReturn(credit.id, { amount: Number(credit.amount || 0), reference: credit.reference, final: credit.final, note: credit.note }); setCredit(null); setMsg(r.closed ? (r.shortfall > 0 ? `Closed short. ${money(r.shortfall)} is an unrecovered loss.` : 'Credit received in full; return closed.') : 'Credit recorded; still open.'); reload(); onChanged(); }
    catch (e: any) { setErr(e.message); }
  };
  const t = data?.totals;
  return (
    <div className="space-y-4">
      <Err msg={err || error} /><Ok msg={msg} />
      {t && <div className="grid grid-cols-2 sm:grid-cols-4 gap-2"><Card label="Returned" value={money(t.shipped_value)} sub={`${t.documents} documents`} /><Card label="Credit received" value={money(t.credit_received)} tone="text-emerald-700" /><Card label="Credit still due" value={money(t.credit_outstanding)} tone={t.credit_outstanding ? 'text-orange-600' : 'text-slate-900'} /><Card label="Unrecovered loss" value={money(t.unrecovered_loss)} tone={t.unrecovered_loss ? 'text-red-600' : 'text-slate-900'} sub="closed without full credit" /></div>}
      {!readOnly && (
        <div className="rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Return goods to a supplier</p>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
            <div className="col-span-2"><Field label="Supplier"><select value={f.supplier_id} onChange={e => setF({ ...f, supplier_id: e.target.value })} className={`${input} w-full`}><option value="">Choose…</option>{(sups ?? []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field></div>
            <div className="col-span-2"><Field label="Item"><select value={f.tire_id} onChange={e => setF({ ...f, tire_id: e.target.value })} className={`${input} w-full`}><option value="">Choose…</option>{(tires ?? []).map(x => <option key={x.id} value={x.id}>{itemName(x)} ({stock(x)})</option>)}</select></Field></div>
            <Field label="Quantity"><input type="number" min={1} value={f.qty} onChange={e => setF({ ...f, qty: e.target.value })} className={`${input} w-full`} /></Field>
            <Field label="RMA / reference"><input value={f.reference} maxLength={100} onChange={e => setF({ ...f, reference: e.target.value })} className={`${input} w-full`} /></Field>
          </div>
          <div className="flex gap-2 mt-2 items-end"><div className="flex-1"><Field label="Reason (required)"><input value={f.reason} maxLength={300} onChange={e => setF({ ...f, reason: e.target.value })} placeholder="Faulty, wrong spec, damaged in transit" className={`${input} w-full`} /></Field></div>
            <button disabled={!f.supplier_id || !f.tire_id || !(Number(f.qty) > 0) || f.reason.trim().length < 3} onClick={create} className={primary}>Return</button></div>
          <p className="text-[11px] text-slate-500 mt-1">Stock leaves now (after approval where required). Record the supplier's credit note below; only an unrecovered shortfall counts as a loss.</p>
        </div>
      )}
      {!data ? <Spin /> : data.rows.length === 0 ? <Empty>No supplier returns yet.</Empty> : (
        <div className="overflow-x-auto"><table className="w-full text-xs">
          <thead><tr className="text-slate-500"><th className="text-left pb-1">No.</th><th className="text-left pb-1">Date</th><th className="text-left pb-1">Supplier</th><th className="text-left pb-1">Item</th><th className="text-right pb-1">Qty</th><th className="text-right pb-1">Value</th><th className="text-right pb-1">Credit</th><th className="text-left pb-1 pl-3">Status</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.rows.map((r: any) => (
            <tr key={r.id} className="align-top"><td className="py-1.5 font-mono">{r.return_no}</td><td>{date(r.created_at)}</td><td>{r.supplier_name}</td><td className="font-semibold">{r.item_name}<div className="font-normal text-slate-500">{r.reason}{r.reference ? ` · ${r.reference}` : ''}</div></td><td className="text-right">{r.qty}</td><td className="text-right">{money(r.value)}</td><td className="text-right">{money(r.credit_amount)}{r.credit_ref ? <div className="text-slate-400">{r.credit_ref}</div> : null}</td><td className="pl-3">{RET[r.status]}{r.shortfall > 0 && <div className="text-red-600">lost {money(r.shortfall)}</div>}</td>
              <td className="text-right">{canManage && !readOnly && r.status === 'shipped' && <button className={btn} onClick={() => setCredit({ id: r.id, amount: '', reference: '', final: false, note: '' })}>Record credit</button>}</td></tr>
          ))}</tbody></table></div>
      )}
      {credit && (
        <Overlay title="Record supplier credit" onCancel={() => setCredit(null)}>
          <Err msg={err} />
          <Field label="Credit amount received"><input type="number" min={0} step="0.01" value={credit.amount} onChange={e => setCredit({ ...credit, amount: e.target.value })} className={`${input} w-full`} /></Field>
          <Field label="Credit note reference"><input value={credit.reference} maxLength={100} onChange={e => setCredit({ ...credit, reference: e.target.value })} className={`${input} w-full`} /></Field>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={credit.final} onChange={e => setCredit({ ...credit, final: e.target.checked })} /> No more credit expected: close this return</label>
          {credit.final && <Field label="Note (needed if not credited in full)"><input value={credit.note} onChange={e => setCredit({ ...credit, note: e.target.value })} className={`${input} w-full`} /></Field>}
          <div className="flex justify-end gap-2"><button onClick={() => setCredit(null)} className={btn}>Cancel</button><button disabled={!credit.final && !(Number(credit.amount) > 0)} onClick={record} className={primary}>Save</button></div>
        </Overlay>
      )}
    </div>
  );
}

// ── Patterns & corrective actions ───────────────────────────────────────────
function Patterns({ canManage, readOnly }: { canManage: boolean; readOnly: boolean }) {
  const { data, error, reload } = useLoad<any>(() => api.inventory.losses.patterns());
  const { data: actions, reload: reloadActions } = useLoad<any[]>(() => api.inventory.losses.actions());
  const [f, setF] = useState<any>(null);
  const [closing, setClosing] = useState<any>(null);
  const [err, setErr] = useState('');
  const save = async () => { setErr(''); try { await api.inventory.losses.saveAction({ pattern_key: f.pattern_key, title: f.title, detail: f.detail, owner_name: f.owner_name, due_date: f.due_date || undefined }); setF(null); reload(); reloadActions(); } catch (e: any) { setErr(e.message); } };
  const close = async () => { setErr(''); try { await api.inventory.losses.closeAction(closing.id, closing.status, closing.resolution); setClosing(null); reload(); reloadActions(); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="space-y-6">
      <Err msg={err || error} />
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Repeated loss patterns {data && <span className="normal-case font-normal text-slate-400">last {data.days} days · {data.min_events}+ events</span>}</p>
        {!data ? <Spin /> : data.patterns.length === 0 ? <Empty>No repeated patterns found. Patterns appear when the same item, supplier, location or cause keeps losing stock.</Empty> : (
          <div className="space-y-2">{data.patterns.map((p: any) => (
            <div key={p.key} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-3">
                <div><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${SEV[p.severity]}`}>{p.severity}</span> <span className="text-sm font-semibold text-slate-900">{p.title}</span>
                  <p className="text-xs text-slate-500 mt-0.5">{p.detail} {p.evidence.events} record(s), {p.evidence.units} unit(s), {money(p.evidence.value)}.</p></div>
                <div className="whitespace-nowrap">{p.action ? <span className="text-xs text-slate-500">Action {p.action.status}</span> : canManage && !readOnly && <button className={btn} onClick={() => setF({ pattern_key: p.key, title: `Address: ${p.title}`.slice(0, 200), detail: p.recommendation, owner_name: '', due_date: '' })}>Create action</button>}</div>
              </div>
              <p className="text-xs text-teal-800 bg-teal-50 rounded-lg px-3 py-2 mt-2"><b>Recommended:</b> {p.recommendation}</p>
            </div>
          ))}</div>
        )}
      </div>
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Corrective actions</p>
        {!actions ? <Spin /> : actions.length === 0 ? <Empty>No corrective actions yet.</Empty> : (
          <table className="w-full text-xs"><tbody className="divide-y divide-slate-100">{actions.map(a => (
            <tr key={a.id} className="align-top"><td className="py-1.5 font-semibold">{a.title}{a.detail && <div className="font-normal text-slate-500 max-w-md">{a.detail}</div>}{a.resolution && <div className="font-normal text-slate-500">Outcome: {a.resolution}</div>}</td>
              <td>{a.owner_name ?? ''}</td><td className={a.overdue ? 'text-red-600 font-semibold' : ''}>{a.due_date ? `due ${date(a.due_date)}` : ''}{a.overdue ? ' (overdue)' : ''}</td><td>{a.status}</td>
              <td className="text-right whitespace-nowrap space-x-1">{a.status === 'open' && canManage && !readOnly && <><button className={btn} onClick={() => setClosing({ id: a.id, status: 'done', resolution: '' })}>Done</button><button className={btn} onClick={() => setClosing({ id: a.id, status: 'dismissed', resolution: '' })}>Dismiss</button></>}</td></tr>
          ))}</tbody></table>
        )}
      </div>
      {f && (
        <Overlay title="New corrective action" onCancel={() => setF(null)}>
          <Err msg={err} />
          <Field label="Action"><input value={f.title} maxLength={200} onChange={e => setF({ ...f, title: e.target.value })} className={`${input} w-full`} /></Field>
          <Field label="Detail"><textarea rows={3} value={f.detail} onChange={e => setF({ ...f, detail: e.target.value })} className={`${input} w-full`} /></Field>
          <div className="grid grid-cols-2 gap-2"><Field label="Owner"><input value={f.owner_name} maxLength={100} onChange={e => setF({ ...f, owner_name: e.target.value })} className={`${input} w-full`} /></Field><Field label="Due"><input type="date" value={f.due_date} onChange={e => setF({ ...f, due_date: e.target.value })} className={`${input} w-full`} /></Field></div>
          <div className="flex justify-end gap-2"><button onClick={() => setF(null)} className={btn}>Cancel</button><button disabled={f.title.trim().length < 3} onClick={save} className={primary}>Create</button></div>
        </Overlay>
      )}
      {closing && (
        <Overlay title={closing.status === 'done' ? 'Mark action done' : 'Dismiss action'} onCancel={() => setClosing(null)}>
          <Err msg={err} />
          <textarea rows={3} value={closing.resolution} onChange={e => setClosing({ ...closing, resolution: e.target.value })} placeholder={closing.status === 'done' ? 'What was done (required)' : 'Why it is not needed (required)'} className={`${input} w-full`} />
          <div className="flex justify-end gap-2"><button onClick={() => setClosing(null)} className={btn}>Cancel</button><button disabled={closing.resolution.trim().length < 3} onClick={close} className={primary}>Save</button></div>
        </Overlay>
      )}
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────
const FIELDS: [string, string, string][] = [
  ['loss_writeoff_approval_value', 'Manager write-offs above this value need approval', 'blank = no value limit'],
  ['obs_slow_days', 'Slow moving after (days without a sale)', ''], ['obs_nonmoving_days', 'Non-moving after (days)', ''], ['obs_obsolete_days', 'Obsolete after (days)', ''],
  ['obs_grace_days', 'Do not judge stock received within (days)', ''], ['obs_slow_cover_days', 'Slow if cover exceeds (days at current sales rate)', ''],
  ['obs_provision_slow', 'Suggested provision: slow (%)', ''], ['obs_provision_nonmoving', 'Suggested provision: non-moving (%)', ''], ['obs_provision_obsolete', 'Suggested provision: obsolete (%)', ''],
  ['loss_pattern_days', 'Pattern look-back (days)', ''], ['loss_pattern_min_events', 'Events needed to call it a pattern', ''],
];
function Settings({ isAdmin }: { isAdmin: boolean }) {
  const { data: meta, error, reload } = useLoad<any>(() => api.inventory.losses.meta());
  const [v, setV] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (meta) setV(Object.fromEntries(FIELDS.map(([k]) => [k, meta.settings[k] == null ? '' : String(meta.settings[k])]))); }, [meta]);
  const save = async () => {
    setErr(''); setMsg('');
    try { await api.inventory.losses.setSettings(Object.fromEntries(FIELDS.map(([k]) => [k, v[k] === '' ? null : Number(v[k])]))); setMsg('Settings saved.'); reload(); } catch (e: any) { setErr(e.message); }
  };
  if (!meta) return error ? <Err msg={error} /> : <Spin />;
  return (
    <div className="space-y-5">
      <Err msg={err} /><Ok msg={msg} />
      <div className="grid sm:grid-cols-2 gap-3">
        {FIELDS.map(([k, label, hint]) => <Field key={k} label={label}><input type="number" min={0} disabled={!isAdmin} value={v[k] ?? ''} placeholder={hint} onChange={e => setV({ ...v, [k]: e.target.value })} className={`${input} w-full`} /></Field>)}
      </div>
      {isAdmin ? <button onClick={save} className={primary}>Save settings</button> : <p className="text-xs text-slate-400">Only an administrator can change these.</p>}
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">What the system recommends for each cause</p>
        <ul className="text-xs space-y-1">{meta.causes.map((c: any) => <li key={c.value}><b>{c.label}:</b> <span className="text-slate-600">{c.recommendation}</span></li>)}</ul>
      </div>
    </div>
  );
}
