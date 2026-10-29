import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, ShieldCheck, X } from 'lucide-react';
import { api } from '../api/client';

type Tab = 'alerts' | 'batches' | 'recalls' | 'rules' | 'disposals';
interface Props { role?: string; onClose: () => void; onChanged: () => void }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const small = 'text-xs border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white';
const money = (n: unknown) => Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');
const btn = 'text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 disabled:opacity-50';
const primary = 'text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50';

const STATUS: Record<string, string> = {
  released: 'bg-emerald-100 text-emerald-700', on_hold: 'bg-amber-100 text-amber-700', recalled: 'bg-red-100 text-red-700', damaged: 'bg-slate-200 text-slate-700',
};
const LABEL: Record<string, string> = { released: 'Released', on_hold: 'On hold', recalled: 'Recalled', damaged: 'Damaged' };
const Badge = ({ s }: { s: string }) => <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS[s] ?? ''}`}>{LABEL[s] ?? s}</span>;
const Err = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Ok = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Spin = () => <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-slate-400 py-6 text-center">{children}</p>;

// Expiry, shelf life & product quality. Restrictions are enforced on the server for every issue path (sales, transfers, picks):
// held, recalled, damaged and expired stock never counts as available.
export default function QualityModal({ role, onClose, onChanged }: Props) {
  const canManage = role === 'org_admin' || role === 'branch_manager';
  const isAdmin = role === 'org_admin';
  const readOnly = role === 'demo';
  const [tab, setTab] = useState<Tab>('alerts');
  const tabs: [Tab, string][] = [['alerts', 'Alerts'], ['batches', 'Batches'], ['recalls', 'Recalls'], ['rules', 'Rules & profiles'], ['disposals', 'Disposals']];
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full sm:max-w-5xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><ShieldCheck size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Expiry &amp; Quality</h3>
              <p className="text-xs text-slate-500">Shelf life, inspections, quality holds, recalls and disposals. Restricted stock is blocked from sale and transfer.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap gap-1.5 px-5 py-3 border-b border-slate-100">
          {tabs.map(([t, label]) => <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${tab === t ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>)}
        </div>
        <div className="overflow-auto flex-1 p-5">
          {tab === 'alerts' && <Alerts goBatches={() => setTab('batches')} />}
          {tab === 'batches' && <Batches canManage={canManage} readOnly={readOnly} onChanged={onChanged} />}
          {tab === 'recalls' && <Recalls canManage={canManage} isAdmin={isAdmin} onChanged={onChanged} />}
          {tab === 'rules' && <Rules isAdmin={isAdmin} />}
          {tab === 'disposals' && <Disposals />}
        </div>
      </div>
    </div>
  );
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const seq = useRef(0);
  // Only the latest request may update the screen, so quick typing in a filter cannot show stale rows.
  const load = useCallback(() => { const n = ++seq.current; setError(''); return fn().then(d => { if (n === seq.current) setData(d); }).catch(e => { if (n === seq.current) setError(e.message); }); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}

// ── Alerts ──────────────────────────────────────────────────────────────────
function Alerts({ goBatches }: { goBatches: () => void }) {
  const { data: a, error } = useLoad<any>(() => api.inventory.quality.alerts());
  if (error) return <Err msg={error} />;
  if (!a) return <Spin />;
  const cards: [string, string, any, string][] = [
    ['Expired in stock', 'expired', a.summary.expired, 'text-red-600'], ['Near expiry', 'near_expiry', a.summary.near_expiry, 'text-amber-600'],
    ['Inspection overdue', 'inspection_overdue', a.summary.inspection_overdue, 'text-orange-600'], ['Stale holds', 'stale', a.summary.stale_holds, 'text-orange-600'],
    ['Recalled on hand', 'recalled', a.summary.recalled, 'text-red-600'], ['Damaged on hand', 'damaged', a.summary.damaged, 'text-slate-600'],
  ];
  const section = (title: string, rows: any[], extra: (r: any) => string) => rows.length > 0 && (
    <div className="mb-5">
      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">{title} ({rows.length})</p>
      <table className="w-full text-xs">
        <thead><tr className="text-slate-500"><th className="text-left pb-1">Item</th><th className="text-left pb-1">Batch</th><th className="text-right pb-1">Qty</th><th className="text-right pb-1">Value</th><th className="text-left pb-1 pl-3">Detail</th></tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.slice(0, 50).map(r => <tr key={r.batch_id}><td className="py-1.5">{r.item_name}</td><td className="font-mono">{r.batch_no}</td><td className="text-right">{r.qty}</td><td className="text-right">{money(r.value)}</td><td className="pl-3 text-slate-600">{extra(r)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
        {cards.map(([label, key, s, tone]) => (
          <div key={key} className="rounded-xl border border-slate-200 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p>
            <p className={`text-lg font-bold ${s.batches ? tone : 'text-slate-300'}`}>{s.batches} <span className="text-xs font-medium text-slate-400">batch{s.batches === 1 ? '' : 'es'} · {s.units} units · {money(s.value)}</span></p>
          </div>
        ))}
      </div>
      {a.open_recalls > 0 && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{a.open_recalls} open recall{a.open_recalls === 1 ? '' : 's'}. Close them from the Recalls tab once every batch is resolved.</p>}
      {a.needs_attention === 0 && <Empty>Nothing needs attention. No expired, near-expiry, overdue or recalled stock.</Empty>}
      {section('Expired stock (blocked from sale)', a.expired, r => `expired ${-r.days_left} day(s) ago · ${r.qty_normal} in sellable locations`)}
      {section('Near expiry', a.near_expiry, r => `${r.days_left} day(s) left (alert window ${r.near_expiry_days} d)`)}
      {section('Inspection overdue', a.inspection_overdue, r => `due ${date(r.inspection_due)} · ${r.inspection_days_overdue} day(s) late`)}
      {section('On quality hold', a.on_hold, r => `${r.stale ? 'STALE · ' : ''}${r.status_age_days ?? 0} day(s): ${r.status_reason ?? ''}`)}
      {section('Recalled', a.recalled, r => r.status_reason ?? '')}
      {section('Damaged', a.damaged, r => r.status_reason ?? '')}
      {section('Inspection due within 7 days', a.inspection_due_soon, r => `due ${date(r.inspection_due)}`)}
      <button onClick={goBatches} className={btn}>Open batch list</button>
    </div>
  );
}

// ── Batches ─────────────────────────────────────────────────────────────────
type Act = { kind: 'hold' | 'release' | 'damage' | 'fail' | 'dispose' | 'return'; b: any } | null;
function Batches({ canManage, readOnly, onChanged }: { canManage: boolean; readOnly: boolean; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [flag, setFlag] = useState('');
  const { data, error, reload } = useLoad<any[]>(() => api.inventory.quality.batches(`?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(flag ? { flag } : {}) })}`), [q, status, flag]);
  const [act, setAct] = useState<Act>(null);
  const [detail, setDetail] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<number[]>([]);
  const [recall, setRecall] = useState(false);
  const done = (m: string) => { setMsg(m); setAct(null); setSel([]); reload(); onChanged(); };
  const pass = async (b: any) => { try { await api.inventory.quality.inspect(b.batch_id, 'pass'); done(`Inspection recorded for ${b.item_name} ${b.batch_no}.`); } catch (e: any) { setErr(e.message); } };
  const open = async (b: any) => { try { setDetail(await api.inventory.quality.batch(b.batch_id)); } catch (e: any) { setErr(e.message); } };
  const flags = (b: any) => [
    b.expired && <span key="e" className="text-[10px] font-semibold text-red-600">EXPIRED</span>,
    b.near_expiry && <span key="n" className="text-[10px] font-semibold text-amber-600">NEAR EXPIRY</span>,
    b.inspection_overdue && <span key="i" className="text-[10px] font-semibold text-orange-600">INSPECT</span>,
  ].filter(Boolean);
  return (
    <div>
      <Err msg={error || err} /><Ok msg={msg} />
      <div className="flex flex-wrap gap-2 mb-3">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search item, SKU or batch" className={`${input} flex-1 min-w-[160px]`} />
        <select value={status} onChange={e => setStatus(e.target.value)} className={input}><option value="">All statuses</option>{Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select value={flag} onChange={e => setFlag(e.target.value)} className={input}><option value="">Any date state</option><option value="expired">Expired</option><option value="near">Near expiry</option><option value="inspection">Inspection overdue</option></select>
        {canManage && !readOnly && <button disabled={!sel.length} onClick={() => setRecall(true)} className={primary}>Recall selected ({sel.length})</button>}
      </div>
      {!data ? <Spin /> : data.length === 0 ? <Empty>No batches match. Only batch or serial tracked items have quality status; items without expiry tracking are not affected.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-slate-500"><th className="w-6" /><th className="text-left pb-1">Item</th><th className="text-left pb-1">Batch</th><th className="text-left pb-1">Mfg</th><th className="text-left pb-1">Expiry</th><th className="text-right pb-1">Left</th><th className="text-right pb-1">Qty</th><th className="text-left pb-1 pl-2">Status</th><th className="text-left pb-1 pl-2">Next inspection</th><th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.map(b => (
                <tr key={b.batch_id} className="align-top">
                  <td className="py-1.5">{canManage && !readOnly && <input type="checkbox" checked={sel.includes(b.batch_id)} onChange={e => setSel(s => (e.target.checked ? [...s, b.batch_id] : s.filter(x => x !== b.batch_id)))} />}</td>
                  <td className="py-1.5"><button onClick={() => open(b)} className="text-left text-teal-700 hover:underline">{b.item_name}</button><div className="space-x-1">{flags(b)}</div></td>
                  <td className="font-mono">{b.batch_no}</td><td>{date(b.mfg_date)}</td><td>{date(b.expiry_date)}</td>
                  <td className={`text-right ${b.days_left != null && b.days_left < 0 ? 'text-red-600' : ''}`}>{b.days_left ?? '—'}</td>
                  <td className="text-right">{b.qty}</td>
                  <td className="pl-2"><Badge s={b.quality_status} /></td>
                  <td className={`pl-2 ${b.inspection_overdue ? 'text-orange-600 font-semibold' : ''}`}>{b.inspection_due ? date(b.inspection_due) : '—'}</td>
                  <td className="py-1 text-right whitespace-nowrap space-x-1">
                    {!readOnly && b.quality_status === 'released' && <button className={btn} onClick={() => setAct({ kind: 'hold', b })}>Hold</button>}
                    {!readOnly && b.quality_status === 'on_hold' && canManage && <button className={btn} onClick={() => setAct({ kind: 'release', b })}>Release</button>}
                    {!readOnly && b.quality_status !== 'recalled' && b.quality_status !== 'damaged' && canManage && <button className={btn} onClick={() => setAct({ kind: 'damage', b })}>Damaged</button>}
                    {!readOnly && b.inspection_interval_days && <button className={btn} onClick={() => pass(b)}>Pass</button>}
                    {!readOnly && b.inspection_interval_days && <button className={btn} onClick={() => setAct({ kind: 'fail', b })}>Fail</button>}
                    {!readOnly && canManage && b.qty > 0 && <button className={btn} onClick={() => setAct({ kind: 'dispose', b })}>Dispose</button>}
                    {!readOnly && canManage && <button className={btn} onClick={() => setAct({ kind: 'return', b })}>Return</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {act && <ActionDialog act={act} onCancel={() => setAct(null)} onDone={done} />}
      {recall && <RecallDialog ids={sel} onCancel={() => setRecall(false)} onDone={m => { setRecall(false); done(m); }} />}
      {detail && <Detail d={detail} onClose={() => setDetail(null)} />}
    </div>
  );
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

function ActionDialog({ act, onCancel, onDone }: { act: NonNullable<Act>; onCancel: () => void; onDone: (m: string) => void }) {
  const { kind, b } = act;
  const [reason, setReason] = useState('');
  const [qty, setQty] = useState(kind === 'dispose' ? b.qty : 1);
  const [method, setMethod] = useState('destroy');
  const [ref, setRef] = useState('');
  const [disp, setDisp] = useState('quarantine');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titles = { hold: 'Place on quality hold', release: 'Release from hold', damage: 'Mark as damaged', fail: 'Failed inspection', dispose: 'Dispose / write off', return: 'Customer return' } as const;
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const Q = api.inventory.quality;
      if (kind === 'hold') await Q.setStatus(b.batch_id, 'on_hold', reason);
      else if (kind === 'release') await Q.setStatus(b.batch_id, 'released', reason);
      else if (kind === 'damage') await Q.setStatus(b.batch_id, 'damaged', reason);
      else if (kind === 'fail') await Q.inspect(b.batch_id, 'fail', reason);
      else if (kind === 'dispose') { const r = await Q.dispose(b.batch_id, { qty, method, reason, reference: ref || undefined }); return onDone(`${r.disposal_no}: ${r.qty} unit(s) of ${b.item_name} ${b.batch_no}, value ${money(r.value)}.`); }
      else { const r = await Q.customerReturn({ tire_id: b.tire_id, batch_id: b.batch_id, qty, reason, disposition: disp, reference: ref || undefined }); return onDone(`Return recorded: ${r.qty} unit(s) to ${r.location}.`); }
      onDone(`${titles[kind]}: ${b.item_name} ${b.batch_no}.`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Overlay title={titles[kind]} onCancel={onCancel}>
      <p className="text-xs text-slate-500">{b.item_name} · batch <span className="font-mono">{b.batch_no}</span> · {b.qty} in stock</p>
      <Err msg={error} />
      {(kind === 'dispose' || kind === 'return') && <div><label className="block text-xs font-semibold text-slate-700 mb-1">Quantity</label><input type="number" min={1} value={qty} onChange={e => setQty(Number(e.target.value))} className={`${input} w-full`} /></div>}
      {kind === 'dispose' && <div><label className="block text-xs font-semibold text-slate-700 mb-1">Method</label><select value={method} onChange={e => setMethod(e.target.value)} className={`${input} w-full`}><option value="destroy">Destroy / dispose</option><option value="return_to_supplier">Return to supplier</option><option value="write_off">Write off</option></select></div>}
      {kind === 'return' && <div><label className="block text-xs font-semibold text-slate-700 mb-1">Returned stock goes to</label><select value={disp} onChange={e => setDisp(e.target.value)} className={`${input} w-full`}><option value="quarantine">Quarantine (inspect first)</option><option value="restock">Back into sellable stock</option></select></div>}
      <div><label className="block text-xs font-semibold text-slate-700 mb-1">{kind === 'fail' ? 'What failed' : 'Reason'} (required)</label><textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} className={`${input} w-full`} /></div>
      {(kind === 'dispose' || kind === 'return') && <div><label className="block text-xs font-semibold text-slate-700 mb-1">Reference (certificate, credit note, RMA)</label><input value={ref} onChange={e => setRef(e.target.value)} className={`${input} w-full`} /></div>}
      {kind === 'release' && b.release_approval === 'admin' && <p className="text-[11px] text-amber-700">This product's quality profile needs an administrator to release.</p>}
      <div className="flex justify-end gap-2"><button onClick={onCancel} className={btn}>Cancel</button><button disabled={busy || reason.trim().length < 3} onClick={submit} className={primary}>{busy ? 'Saving…' : 'Confirm'}</button></div>
    </Overlay>
  );
}

function RecallDialog({ ids, onCancel, onDone }: { ids: number[]; onCancel: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({ title: '', reason: '', severity: 'class2', source: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true); setError('');
    try { const r = await api.inventory.quality.openRecall({ ...f, batch_ids: ids }); onDone(`${r.recall_no} opened: ${r.batches.length} batch(es) restricted.`); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Overlay title={`Open recall (${ids.length} batch${ids.length === 1 ? '' : 'es'})`} onCancel={onCancel}>
      <Err msg={error} />
      <input value={f.title} onChange={e => setF({ ...f, title: e.target.value })} placeholder="Title" className={`${input} w-full`} />
      <textarea rows={2} value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} placeholder="Why are these products recalled?" className={`${input} w-full`} />
      <select value={f.severity} onChange={e => setF({ ...f, severity: e.target.value })} className={`${input} w-full`}>
        <option value="class1">Class I (serious health risk)</option><option value="class2">Class II (temporary or reversible risk)</option><option value="class3">Class III (unlikely to cause harm)</option><option value="voluntary">Voluntary / quality</option>
      </select>
      <input value={f.source} onChange={e => setF({ ...f, source: e.target.value })} placeholder="Source (supplier notice, regulator, internal)" className={`${input} w-full`} />
      <p className="text-[11px] text-slate-500">The batches are blocked at once from sale and transfer. Units already sold are traced on the recall.</p>
      <div className="flex justify-end gap-2"><button onClick={onCancel} className={btn}>Cancel</button><button disabled={busy || !f.title.trim() || f.reason.trim().length < 3} onClick={go} className={primary}>Open recall</button></div>
    </Overlay>
  );
}

function Detail({ d, onClose }: { d: any; onClose: () => void }) {
  return (
    <Overlay title={`${d.item_name} · ${d.batch_no}`} onCancel={onClose}>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><span className="text-slate-400">Status</span><div><Badge s={d.quality_status} /></div></div>
        <div><span className="text-slate-400">Qty / value</span><div>{d.qty} · {money(d.value)}</div></div>
        <div><span className="text-slate-400">Manufactured</span><div>{date(d.mfg_date)}</div></div>
        <div><span className="text-slate-400">Expiry</span><div>{date(d.expiry_date)}{d.days_left != null ? ` (${d.days_left} d)` : ''}</div></div>
        {d.shelf_used_pct != null && <div className="col-span-2"><span className="text-slate-400">Shelf life used</span><div className="h-2 rounded bg-slate-100 mt-1"><div className="h-2 rounded bg-teal-500" style={{ width: `${d.shelf_used_pct}%` }} /></div></div>}
      </div>
      {d.status_reason && <p className="text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2">{d.status_reason}</p>}
      {d.balances?.length > 0 && <p className="text-xs text-slate-600">Locations: {d.balances.map((x: any) => `${x.location_name ?? x.location_id} ${x.qty}`).join(', ')}</p>}
      {d.recalls?.length > 0 && <p className="text-xs text-red-700">Recalls: {d.recalls.map((r: any) => `${r.recall_no} (${r.status})`).join(', ')}</p>}
      <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">History</p>
      <ul className="text-xs divide-y divide-slate-100">
        {d.events.map((e: any) => <li key={e.id} className="py-1.5"><span className="font-semibold">{e.event_type}</span>{e.to_status ? ` → ${e.to_status}` : ''}{e.result ? ` (${e.result})` : ''}{e.qty ? ` · ${e.qty}` : ''} <span className="text-slate-400">{date(e.created_at)} {e.user_name ?? ''}</span>{e.reason && <div className="text-slate-500">{e.reason}</div>}</li>)}
        {!d.events.length && <li className="py-2 text-slate-400">No quality events yet.</li>}
      </ul>
    </Overlay>
  );
}

// ── Recalls ─────────────────────────────────────────────────────────────────
function Recalls({ canManage, isAdmin, onChanged }: { canManage: boolean; isAdmin: boolean; onChanged: () => void }) {
  const { data, error, reload } = useLoad<any[]>(() => api.inventory.quality.recalls());
  const [open, setOpen] = useState<any>(null);
  const [res, setRes] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const show = async (id: number) => { setErr(''); setMsg(''); setRes({}); setNote(''); try { setOpen(await api.inventory.quality.recall(id)); } catch (e: any) { setErr(e.message); } };
  const close = async () => {
    setErr('');
    try {
      const r = await api.inventory.quality.closeRecall(open.id, note, open.batches.filter((b: any) => res[b.batch_id]).map((b: any) => ({ batch_id: b.batch_id, disposition: res[b.batch_id] })));
      setMsg(`${r.recall_no} closed: ${r.released} released, ${r.disposed} disposed, ${r.retained} retained.`); setOpen(null); reload(); onChanged();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div>
      <Err msg={error || err} /><Ok msg={msg} />
      {canManage && <p className="text-[11px] text-slate-400 mb-3">Open a recall from the Batches tab: tick the affected batches and choose “Recall selected”.</p>}
      {!data ? <Spin /> : data.length === 0 ? <Empty>No recalls recorded.</Empty> : (
        <table className="w-full text-xs mb-4">
          <thead><tr className="text-slate-500"><th className="text-left pb-1">Recall</th><th className="text-left pb-1">Title</th><th className="text-left pb-1">Severity</th><th className="text-right pb-1">Batches</th><th className="text-right pb-1">On hand</th><th className="text-right pb-1">Sold</th><th className="text-left pb-1 pl-3">Status</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.map(r => <tr key={r.id} className="cursor-pointer hover:bg-slate-50" onClick={() => show(r.id)}><td className="py-1.5 font-mono">{r.recall_no}</td><td>{r.title}</td><td>{r.severity_label}</td><td className="text-right">{r.batches}</td><td className="text-right">{r.on_hand}</td><td className="text-right">{r.sold}</td><td className="pl-3"><span className={`font-semibold ${r.status === 'open' ? 'text-red-600' : 'text-slate-500'}`}>{r.status}</span></td></tr>)}
          </tbody>
        </table>
      )}
      {open && (
        <div className="rounded-xl border border-slate-200 p-4 space-y-3">
          <div className="flex justify-between"><div><p className="text-sm font-bold">{open.recall_no} · {open.title}</p><p className="text-xs text-slate-500">{open.severity_label} · opened {date(open.created_at)} by {open.user_name ?? '—'}{open.source ? ` · source: ${open.source}` : ''}</p></div><button onClick={() => setOpen(null)} className="p-1 text-slate-400"><X size={14} /></button></div>
          <p className="text-xs text-slate-600">{open.reason}</p>
          <table className="w-full text-xs">
            <thead><tr className="text-slate-500"><th className="text-left pb-1">Item</th><th className="text-left pb-1">Batch</th><th className="text-right pb-1">At recall</th><th className="text-right pb-1">Sold</th><th className="text-right pb-1">In stock now</th><th className="text-right pb-1">Disposed</th><th className="text-left pb-1 pl-3">{open.status === 'open' && isAdmin ? 'Resolution' : 'Outcome'}</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {open.batches.map((b: any) => (
                <tr key={b.batch_id}><td className="py-1.5">{b.item_name}</td><td className="font-mono">{b.batch_no}</td><td className="text-right">{b.qty_at_recall}</td><td className="text-right">{b.qty_sold}</td><td className="text-right">{b.qty_now}</td><td className="text-right">{b.qty_disposed}</td>
                  <td className="pl-3">{open.status === 'open' && isAdmin ? (
                    <select value={res[b.batch_id] ?? ''} onChange={e => setRes({ ...res, [b.batch_id]: e.target.value })} className={small}><option value="">{b.qty_now === 0 ? 'Disposed (no stock)' : 'Choose…'}</option>{b.qty_now === 0 && <option value="disposed">Disposed</option>}<option value="release">Cleared: release</option><option value="retain">Retain restricted</option></select>
                  ) : (b.disposition ?? '—')}</td></tr>
              ))}
            </tbody>
          </table>
          {open.sales.length > 0 && <details><summary className="text-xs font-semibold text-slate-600 cursor-pointer">Units sold from recalled batches ({open.sales.length} movements)</summary>
            <table className="w-full text-xs mt-2"><tbody className="divide-y divide-slate-100">{open.sales.map((s: any, i: number) => <tr key={i}><td className="py-1">{date(s.created_at)}</td><td>{s.item_name}</td><td className="font-mono">{s.batch_no}</td><td>{s.reference ?? ''}</td><td className="text-right">{s.qty}</td></tr>)}</tbody></table></details>}
          {open.status === 'open' ? (isAdmin ? (
            <div className="flex gap-2 items-end"><input value={note} onChange={e => setNote(e.target.value)} placeholder="Closure note (required)" className={`${input} flex-1`} /><button disabled={note.trim().length < 3} onClick={close} className={primary}>Close recall</button></div>
          ) : <p className="text-[11px] text-slate-400">Only an administrator can close a recall. Dispose of stock from the Batches tab first.</p>)
            : <p className="text-xs text-slate-500">Closed {date(open.closed_at)} by {open.closed_by_name ?? '—'}: {open.closure_note}</p>}
        </div>
      )}
    </div>
  );
}

// ── Rules & profiles ────────────────────────────────────────────────────────
function Rules({ isAdmin }: { isAdmin: boolean }) {
  const { data: rules, error, reload } = useLoad<any>(() => api.inventory.quality.rules());
  const { data: profiles, reload: reloadP } = useLoad<any[]>(() => api.inventory.quality.profiles());
  const [f, setF] = useState<any>(null);
  const [p, setP] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { if (rules) setF({ ...rules, inspection_interval_days: rules.inspection_interval_days ?? '', min_remaining_days: rules.min_remaining_days ?? '', disposal_admin_value: rules.disposal_admin_value ?? '' }); }, [rules]);
  const save = async () => { setErr(''); setMsg(''); try { await api.inventory.quality.setRules({ ...f, inspection_interval_days: f.inspection_interval_days === '' ? null : f.inspection_interval_days, min_remaining_days: f.min_remaining_days === '' ? null : f.min_remaining_days, disposal_admin_value: f.disposal_admin_value === '' ? null : f.disposal_admin_value }); setMsg('Company rules saved.'); reload(); } catch (e: any) { setErr(e.message); } };
  const saveP = async () => { setErr(''); try { await api.inventory.quality.saveProfile(p.id ?? null, p); setP(null); reloadP(); setMsg('Profile saved.'); } catch (e: any) { setErr(e.message); } };
  const delP = async (id: number) => { setErr(''); try { await api.inventory.quality.deleteProfile(id); reloadP(); } catch (e: any) { setErr(e.message); } };
  if (!f) return error ? <Err msg={error} /> : <Spin />;
  const num = (k: string, ph = '') => <input type="number" min={0} disabled={!isAdmin} value={f[k]} placeholder={ph} onChange={e => setF({ ...f, [k]: e.target.value })} className={`${input} w-full`} />;
  return (
    <div className="space-y-6">
      <Err msg={err} /><Ok msg={msg} />
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Company defaults</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div><label className="block text-xs font-semibold mb-1">Near-expiry alert (days)</label>{num('near_expiry_days')}</div>
          <div><label className="block text-xs font-semibold mb-1">Inspect every (days)</label>{num('inspection_interval_days', 'off')}</div>
          <div><label className="block text-xs font-semibold mb-1">Min. shelf life on receipt (days)</label>{num('min_remaining_days', 'none')}</div>
          <div><label className="block text-xs font-semibold mb-1">Stale hold after (days)</label>{num('stale_hold_days')}</div>
          <div><label className="block text-xs font-semibold mb-1">Admin approval for disposals above</label>{num('disposal_admin_value', 'no limit')}</div>
          <div><label className="block text-xs font-semibold mb-1">Releasing a held batch</label>
            <select disabled={!isAdmin} value={f.release_approval} onChange={e => setF({ ...f, release_approval: e.target.value })} className={`${input} w-full`}><option value="manager">Manager or admin</option><option value="admin">Administrator only</option></select></div>
          <label className="flex items-center gap-2 text-xs font-semibold col-span-2"><input type="checkbox" disabled={!isAdmin} checked={!!f.require_mfg_date} onChange={e => setF({ ...f, require_mfg_date: e.target.checked })} /> Require a manufacturing date on tracked receipts</label>
        </div>
        {isAdmin ? <button onClick={save} className={`${primary} mt-3`}>Save company rules</button> : <p className="text-[11px] text-slate-400 mt-2">Only an administrator can change the rules.</p>}
      </div>
      <div>
        <div className="flex items-center justify-between mb-2"><p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Quality profiles <span className="normal-case font-normal text-slate-400">by product type or regulation; assign them on the item or its category</span></p>{isAdmin && <button className={btn} onClick={() => setP({ name: '', regulation: '', near_expiry_days: '', inspection_interval_days: '', min_remaining_days: '', require_mfg_date: '', release_approval: '', notes: '' })}>New profile</button>}</div>
        {!profiles ? <Spin /> : profiles.length === 0 ? <Empty>No profiles yet. Example: “Pharmaceuticals (GDP)”: 120-day alert, 30-day inspections, manufacturing date required, administrator release.</Empty> : (
          <table className="w-full text-xs">
            <thead><tr className="text-slate-500"><th className="text-left pb-1">Profile</th><th className="text-left pb-1">Regulation</th><th className="text-right pb-1">Alert</th><th className="text-right pb-1">Inspect</th><th className="text-right pb-1">Min life</th><th className="text-left pb-1 pl-3">Mfg</th><th className="text-left pb-1">Release</th><th className="text-right pb-1">Used by</th><th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {profiles.map(x => <tr key={x.id}><td className="py-1.5 font-semibold">{x.name}</td><td>{x.regulation ?? ''}</td><td className="text-right">{x.near_expiry_days ?? '—'}</td><td className="text-right">{x.inspection_interval_days ?? '—'}</td><td className="text-right">{x.min_remaining_days ?? '—'}</td><td className="pl-3">{x.require_mfg_date == null ? '—' : x.require_mfg_date ? 'yes' : 'no'}</td><td>{x.release_approval ?? '—'}</td><td className="text-right">{x.item_count} items, {x.category_count} categories</td>
                <td className="text-right whitespace-nowrap">{isAdmin && <><button className={btn} onClick={() => setP({ ...x, require_mfg_date: x.require_mfg_date == null ? '' : x.require_mfg_date ? 'yes' : 'no', near_expiry_days: x.near_expiry_days ?? '', inspection_interval_days: x.inspection_interval_days ?? '', min_remaining_days: x.min_remaining_days ?? '', release_approval: x.release_approval ?? '' })}>Edit</button> <button className={btn} onClick={() => delP(x.id)}>Delete</button></>}</td></tr>)}
            </tbody>
          </table>
        )}
      </div>
      {p && (
        <Overlay title={p.id ? 'Edit profile' : 'New profile'} onCancel={() => setP(null)}>
          <input value={p.name} onChange={e => setP({ ...p, name: e.target.value })} placeholder="Name" className={`${input} w-full`} />
          <input value={p.regulation ?? ''} onChange={e => setP({ ...p, regulation: e.target.value })} placeholder="Applicable regulation or standard" className={`${input} w-full`} />
          <div className="grid grid-cols-3 gap-2">
            {(['near_expiry_days', 'inspection_interval_days', 'min_remaining_days'] as const).map(k => <div key={k}><label className="block text-[11px] font-semibold mb-1">{k === 'near_expiry_days' ? 'Alert (days)' : k === 'inspection_interval_days' ? 'Inspect (days)' : 'Min life (days)'}</label><input type="number" min={0} value={p[k]} placeholder="inherit" onChange={e => setP({ ...p, [k]: e.target.value })} className={`${input} w-full`} /></div>)}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select value={p.require_mfg_date} onChange={e => setP({ ...p, require_mfg_date: e.target.value })} className={input}><option value="">Mfg date: inherit</option><option value="yes">Mfg date required</option><option value="no">Mfg date not required</option></select>
            <select value={p.release_approval} onChange={e => setP({ ...p, release_approval: e.target.value })} className={input}><option value="">Release: company default</option><option value="manager">Manager or admin</option><option value="admin">Administrator only</option></select>
          </div>
          <textarea rows={2} value={p.notes ?? ''} onChange={e => setP({ ...p, notes: e.target.value })} placeholder="Notes" className={`${input} w-full`} />
          <div className="flex justify-end gap-2"><button onClick={() => setP(null)} className={btn}>Cancel</button><button disabled={!p.name.trim()} onClick={saveP} className={primary}>Save</button></div>
        </Overlay>
      )}
    </div>
  );
}

// ── Disposals ───────────────────────────────────────────────────────────────
function Disposals() {
  const { data, error } = useLoad<any>(() => api.inventory.quality.disposals(365));
  if (error) return <Err msg={error} />;
  if (!data) return <Spin />;
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <div className="rounded-xl border border-slate-200 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-slate-400">Last 12 months</p><p className="text-lg font-bold">{data.total_qty} units · {money(data.total_value)}</p></div>
        {data.totals.map((t: any) => <div key={t.method} className="rounded-xl border border-slate-200 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-slate-400">{t.label}</p><p className="text-sm font-semibold">{t.qty} units · {money(t.value)}</p></div>)}
      </div>
      {data.rows.length === 0 ? <Empty>No disposals recorded.</Empty> : (
        <table className="w-full text-xs">
          <thead><tr className="text-slate-500"><th className="text-left pb-1">No.</th><th className="text-left pb-1">Date</th><th className="text-left pb-1">Item</th><th className="text-left pb-1">Batch</th><th className="text-right pb-1">Qty</th><th className="text-right pb-1">Value</th><th className="text-left pb-1 pl-3">Method / reason</th><th className="text-left pb-1">By</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.rows.map((r: any) => <tr key={r.id}><td className="py-1.5 font-mono">{r.disposal_no}</td><td>{date(r.created_at)}</td><td>{r.item_name}</td><td className="font-mono">{r.batch_no}</td><td className="text-right">{r.qty}</td><td className="text-right">{money(r.value)}</td><td className="pl-3">{r.method.replace(/_/g, ' ')}: {r.reason}{r.recall_no ? ` · ${r.recall_no}` : ''}{r.supplier_name ? ` · ${r.supplier_name}` : ''}</td><td>{r.user_name ?? ''}</td></tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}
