import { useCallback, useEffect, useRef, useState } from 'react';
import { FlaskConical, Loader2, X } from 'lucide-react';
import { api } from '../api/client';

type Tab = 'compliance' | 'items' | 'classes' | 'locations' | 'inspections' | 'incidents';
interface Props { role?: string; onClose: () => void; onChanged: () => void }
const input = 'text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const btn = 'text-xs font-semibold px-2.5 py-1 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-700 disabled:opacity-50';
const primary = 'text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50';
const date = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');
const Err = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Ok = ({ msg }: { msg: string }) => (msg ? <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-3">{msg}</p> : null);
const Spin = () => <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-slate-400 py-6 text-center">{children}</p>;
const SEV: Record<string, string> = { low: 'bg-slate-100 text-slate-600', medium: 'bg-amber-100 text-amber-700', high: 'bg-orange-100 text-orange-700', critical: 'bg-red-100 text-red-700' };

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
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <div><label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>{children}</div>;

// Hazardous materials & special handling. The rules (permitted locations, segregation, SDS, inspections, incidents, holds) are enforced by the
// server on every receipt, sale and transfer; this screen manages the data. Only items with a hazard class or temperature range are affected.
export default function HazmatModal({ role, onClose, onChanged }: Props) {
  const canManage = role === 'org_admin' || role === 'branch_manager';
  const isAdmin = role === 'org_admin';
  const readOnly = role === 'demo';
  const [tab, setTab] = useState<Tab>('compliance');
  const tabs: [Tab, string][] = [['compliance', 'Compliance'], ['items', 'Items'], ['classes', 'Classes & segregation'], ['locations', 'Locations'], ['inspections', 'Inspections'], ['incidents', 'Incidents']];
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full sm:max-w-5xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><FlaskConical size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Hazardous Materials</h3>
              <p className="text-xs text-slate-500">Special storage, handling and dispatch controls. They apply only to items with a hazard class or temperature range.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>
        <div className="flex flex-wrap gap-1.5 px-5 py-3 border-b border-slate-100">
          {tabs.map(([t, label]) => <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-semibold rounded-lg ${tab === t ? 'bg-teal-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>)}
        </div>
        <div className="overflow-auto flex-1 p-5">
          {tab === 'compliance' && <Compliance />}
          {tab === 'items' && <Items canManage={canManage} readOnly={readOnly} onChanged={onChanged} />}
          {tab === 'classes' && <Classes isAdmin={isAdmin} />}
          {tab === 'locations' && <Locations canManage={canManage} readOnly={readOnly} onChanged={onChanged} />}
          {tab === 'inspections' && <Inspections readOnly={readOnly} onChanged={onChanged} />}
          {tab === 'incidents' && <Incidents canManage={canManage} readOnly={readOnly} onChanged={onChanged} />}
        </div>
      </div>
    </div>
  );
}

// ── Compliance ──────────────────────────────────────────────────────────────
function Compliance() {
  const { data: c, error } = useLoad<any>(() => api.inventory.hazmat.compliance());
  if (error) return <Err msg={error} />;
  if (!c) return <Spin />;
  const cards: [string, number, string][] = [
    ['Incompatible stock together', c.summary.incompatible, 'text-red-600'], ['Stock in unapproved locations', c.summary.misplaced, 'text-red-600'], ['Temperature mismatch', c.summary.temperature, 'text-orange-600'],
    ['SDS / transport details', c.summary.sds, 'text-orange-600'], ['Inspections due', c.summary.inspections, 'text-orange-600'], ['Open incidents', c.summary.incidents, 'text-red-600'], ['Safety holds', c.summary.holds, 'text-amber-600'],
  ];
  const list = (title: string, rows: any[], line: (r: any) => string) => rows.length > 0 && (
    <div className="mb-4"><p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">{title} ({rows.length})</p>
      <ul className="text-xs divide-y divide-slate-100">{rows.slice(0, 40).map((r, i) => <li key={i} className="py-1.5">{line(r)}</li>)}</ul></div>
  );
  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-5">
        {cards.map(([label, n, tone]) => <div key={label} className="rounded-xl border border-slate-200 px-3 py-2.5"><p className="text-[10px] uppercase tracking-wider text-slate-400">{label}</p><p className={`text-lg font-bold ${n ? tone : 'text-slate-300'}`}>{n}</p></div>)}
      </div>
      {c.needs_attention === 0 && <Empty>No findings. Hazardous stock is stored, segregated and documented as required.</Empty>}
      {list('Incompatible products in the same location', c.incompatible, r => `${r.a_name} (${r.a_class}) with ${r.b_name} (${r.b_class}) at ${r.location_name}${r.reason ? ` — ${r.reason}` : ''}`)}
      {list('Stock in locations not approved for its class', c.misplaced, r => `${r.item_name} (${r.class_name}): ${r.qty} at ${r.location_name}`)}
      {list('Locations over their quantity limit', c.over_capacity, r => `${r.location_name}: ${r.qty} of ${r.class_name}, limit ${r.max_qty}`)}
      {list('Temperature-sensitive stock outside its range', c.temperature, r => `${r.item_name} needs ${r.storage_temp_min_c ?? '…'} to ${r.storage_temp_max_c ?? '…'} °C; ${r.location_name} is ${r.temp_min_c == null && r.temp_max_c == null ? 'not rated' : `${r.temp_min_c ?? '…'} to ${r.temp_max_c ?? '…'} °C`}`)}
      {list('Safety Data Sheet missing', c.sds_missing, r => `${r.item_name} (${r.class_name}) cannot be dispatched until an SDS is recorded`)}
      {list('Safety Data Sheet out of date', c.sds_old, r => `${r.item_name}: ${r.reason}`)}
      {list('UN number missing', c.transport_missing, r => `${r.item_name} (${r.class_name}) cannot be dispatched without transport details`)}
      {list('Location inspections', c.location_inspections, r => `${r.location_name}: ${r.failed ? 'failed its last inspection' : r.never ? 'never inspected' : `overdue since ${date(r.due)}`}; hazardous intake is blocked`)}
      {list('Item inspections', c.item_inspections, r => `${r.item_name}: ${r.failed ? 'failed its last inspection' : r.never ? 'never inspected' : `overdue since ${date(r.due)}`}`)}
      {list('Open incidents', c.open_incidents, r => `${r.incident_no} · ${r.severity}${r.blocks_dispatch ? ' · blocks dispatch' : ''} · ${r.item_name ?? r.location_name}: ${r.description}`)}
      {list('Safety holds', c.holds, r => `${r.item_name} (${r.on_hand} on hand): ${r.hazard_hold_reason ?? ''}`)}
      {list('Stock of an inactive class', c.inactive_class, r => `${r.item_name} (${r.class_name}) — ${r.on_hand} on hand`)}
    </div>
  );
}

// ── Items ───────────────────────────────────────────────────────────────────
function Items({ canManage, readOnly, onChanged }: { canManage: boolean; readOnly: boolean; onChanged: () => void }) {
  const { data, error, reload } = useLoad<any[]>(() => api.inventory.hazmat.items());
  const { data: locs } = useLoad<any[]>(() => api.inventory.hazmat.locations());
  const [dlg, setDlg] = useState<{ kind: 'hold' | 'lift' | 'inspect' | 'incident'; it: any } | null>(null);
  const [msg, setMsg] = useState('');
  const [chk, setChk] = useState<any>({ tire_id: '', location_id: '', action: 'store' });
  const [res, setRes] = useState<any>(null);
  const [err, setErr] = useState('');
  const check = async () => { setErr(''); setRes(null); try { setRes(await api.inventory.hazmat.check({ tire_id: Number(chk.tire_id), location_id: chk.location_id ? Number(chk.location_id) : undefined, qty: 1, action: chk.action })); } catch (e: any) { setErr(e.message); } };
  return (
    <div>
      <Err msg={error || err} /><Ok msg={msg} />
      <div className="rounded-xl border border-slate-200 p-3 mb-4 flex flex-wrap gap-2 items-end">
        <Field label="Can this move happen?">
          <select value={chk.tire_id} onChange={e => setChk({ ...chk, tire_id: e.target.value })} className={input}><option value="">Item…</option>{(data ?? []).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
        </Field>
        <select value={chk.action} onChange={e => setChk({ ...chk, action: e.target.value })} className={input}><option value="store">Store in</option><option value="dispatch">Dispatch from</option></select>
        <select value={chk.location_id} onChange={e => setChk({ ...chk, location_id: e.target.value })} className={input}><option value="">Default location</option>{(locs ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        <button disabled={!chk.tire_id} onClick={check} className={primary}>Check</button>
        {res && <p className={`text-xs ${res.allowed ? 'text-emerald-700' : 'text-red-600'}`}>{res.allowed ? 'Allowed.' : res.message}</p>}
      </div>
      {!data ? <Spin /> : data.length === 0 ? <Empty>No special-handling items. Set a hazard class or temperature range on an item to switch the controls on for it.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-slate-500"><th className="text-left pb-1">Item</th><th className="text-left pb-1">Class</th><th className="text-left pb-1">UN / PG</th><th className="text-left pb-1">SDS</th><th className="text-left pb-1">Temp °C</th><th className="text-right pb-1">On hand</th><th className="text-left pb-1 pl-3">Stored at</th><th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {data.map(i => (
                <tr key={i.id} className="align-top">
                  <td className="py-1.5 font-semibold">{i.name}{!!i.hazard_hold && <span className="ml-1 text-[10px] font-bold text-red-600">ON HOLD</span>}{i.hazard_hold_reason && <div className="font-normal text-slate-500">{i.hazard_hold_reason}</div>}</td>
                  <td>{i.class_code ? `${i.class_code} ${i.class_name}` : '—'}</td>
                  <td>{[i.un_number, i.packing_group && `PG ${i.packing_group}`].filter(Boolean).join(' ') || '—'}</td>
                  <td>{i.sds_ref ? `${i.sds_ref}${i.sds_date ? ` (${date(i.sds_date)})` : ''}` : <span className={i.requires_sds ? 'text-red-600' : 'text-slate-400'}>{i.requires_sds ? 'missing' : '—'}</span>}</td>
                  <td>{i.storage_temp_min_c != null || i.storage_temp_max_c != null ? `${i.storage_temp_min_c ?? '…'} to ${i.storage_temp_max_c ?? '…'}` : '—'}</td>
                  <td className="text-right">{i.on_hand}</td>
                  <td className="pl-3 text-slate-600">{i.locations.map((l: any) => `${l.name} ${l.qty}`).join(', ') || '—'}</td>
                  <td className="py-1 text-right whitespace-nowrap space-x-1">
                    {!readOnly && !i.hazard_hold && <button className={btn} onClick={() => setDlg({ kind: 'hold', it: i })}>Hold</button>}
                    {!readOnly && !!i.hazard_hold && canManage && <button className={btn} onClick={() => setDlg({ kind: 'lift', it: i })}>Lift hold</button>}
                    {!readOnly && <button className={btn} onClick={() => setDlg({ kind: 'inspect', it: i })}>Inspect</button>}
                    {!readOnly && <button className={btn} onClick={() => setDlg({ kind: 'incident', it: i })}>Incident</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {dlg && <ItemDialog dlg={dlg} locs={locs ?? []} onCancel={() => setDlg(null)} onDone={m => { setDlg(null); setMsg(m); reload(); onChanged(); }} />}
    </div>
  );
}

function ItemDialog({ dlg, locs, onCancel, onDone }: { dlg: { kind: 'hold' | 'lift' | 'inspect' | 'incident'; it: any }; locs: any[]; onCancel: () => void; onDone: (m: string) => void }) {
  const { kind, it } = dlg;
  const [text, setText] = useState('');
  const [result, setResult] = useState('pass');
  const [type, setType] = useState('leak');
  const [sev, setSev] = useState('medium');
  const [loc, setLoc] = useState('');
  const [holdItem, setHoldItem] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titles = { hold: 'Place safety hold', lift: 'Lift safety hold', inspect: 'Record item inspection', incident: 'Report incident' } as const;
  const go = async () => {
    setBusy(true); setError('');
    try {
      const H = api.inventory.hazmat;
      if (kind === 'hold') await H.hold(it.id, true, text);
      else if (kind === 'lift') await H.hold(it.id, false, text);
      else if (kind === 'inspect') await H.inspect({ subject_type: 'item', tire_id: it.id, result, findings: text });
      else { const r = await H.reportIncident({ incident_type: type, severity: sev, tire_id: it.id, location_id: loc ? Number(loc) : undefined, description: text, hold_item: holdItem }); return onDone(`${r.incident_no} reported${r.blocks_dispatch ? '; dispatch of this item is blocked until it is closed' : ''}.`); }
      onDone(`${titles[kind]}: ${it.name}.`);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <Overlay title={`${titles[kind]} · ${it.name}`} onCancel={onCancel}>
      <Err msg={error} />
      {kind === 'inspect' && <Field label="Result"><select value={result} onChange={e => setResult(e.target.value)} className={`${input} w-full`}><option value="pass">Pass</option><option value="fail">Fail (places the item on hold)</option></select></Field>}
      {kind === 'incident' && <>
        <div className="grid grid-cols-2 gap-2">
          <select value={type} onChange={e => setType(e.target.value)} className={input}><option value="spill">Spill</option><option value="leak">Leak</option><option value="fire">Fire / explosion</option><option value="exposure">Exposure / injury</option><option value="temperature_excursion">Temperature excursion</option><option value="damage">Damaged packaging</option><option value="near_miss">Near miss</option><option value="other">Other</option></select>
          <select value={sev} onChange={e => setSev(e.target.value)} className={input}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High (blocks dispatch)</option><option value="critical">Critical (blocks dispatch)</option></select>
        </div>
        <select value={loc} onChange={e => setLoc(e.target.value)} className={`${input} w-full`}><option value="">Location (optional)</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={holdItem} onChange={e => setHoldItem(e.target.checked)} /> Also place this item on a safety hold</label>
      </>}
      <Field label={kind === 'inspect' ? (result === 'fail' ? 'Findings (required)' : 'Notes') : kind === 'incident' ? 'What happened (required)' : 'Reason (required)'}><textarea rows={3} value={text} onChange={e => setText(e.target.value)} className={`${input} w-full`} /></Field>
      <div className="flex justify-end gap-2"><button onClick={onCancel} className={btn}>Cancel</button><button disabled={busy || (kind === 'inspect' && result === 'pass' ? false : text.trim().length < 3)} onClick={go} className={primary}>{busy ? 'Saving…' : 'Confirm'}</button></div>
    </Overlay>
  );
}

// ── Classes & segregation ───────────────────────────────────────────────────
function Classes({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, reload } = useLoad(() => api.inventory.hazmat.classes());
  const { data: meta, reload: reloadMeta } = useLoad<any>(() => api.inventory.hazmat.meta());
  const [f, setF] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [sets, setSets] = useState<any>(null);
  useEffect(() => { if (meta) setSets({ sds_max_age_days: meta.settings.sds_max_age_days ?? '', location_inspection_days: meta.settings.location_inspection_days ?? '' }); }, [meta]);
  const run = async (fn: () => Promise<any>, ok: string) => { setErr(''); setMsg(''); try { await fn(); setMsg(ok); reload(); } catch (e: any) { setErr(e.message); } };
  if (!data) return error ? <Err msg={error} /> : <Spin />;
  const pairOn = (a: number, b: number) => data.incompatibilities.some(p => p.class_a === Math.min(a, b) && p.class_b === Math.max(a, b));
  const cls = data.classes;
  return (
    <div className="space-y-6">
      <Err msg={err} /><Ok msg={msg} />
      <div>
        <div className="flex items-center justify-between mb-2"><p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Hazard & handling classes <span className="normal-case font-normal text-slate-400">define them to match the regulations that apply to you</span></p>
          {isAdmin && <div className="space-x-1"><button className={btn} onClick={() => run(async () => { const r = await api.inventory.hazmat.seedClasses(); setMsg(`${r.classes_added} classes and ${r.pairs_added} segregation pairs added. Review them against your regulations.`); }, '')}>Add standard UN classes</button>
            <button className={btn} onClick={() => setF({ code: '', name: '', kind: 'hazard', regulation: '', description: '', requires_sds: true, requires_transport_info: false, is_active: true })}>New class</button></div>}</div>
        {cls.length === 0 ? <Empty>No classes yet. Add the standard UN classes as a starting point, or define your own (for example “Cold chain”).</Empty> : (
          <table className="w-full text-xs">
            <thead><tr className="text-slate-500"><th className="text-left pb-1">Code</th><th className="text-left pb-1">Name</th><th className="text-left pb-1">Kind</th><th className="text-left pb-1">Regulation</th><th className="text-left pb-1">Requires</th><th className="text-right pb-1">Items</th><th /></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {cls.map(c => <tr key={c.id} className={c.is_active ? '' : 'opacity-50'}><td className="py-1.5 font-mono font-semibold">{c.code}</td><td>{c.name}{!c.is_active && ' (inactive)'}</td><td>{c.kind}</td><td>{c.regulation ?? ''}</td><td>{[c.requires_sds && 'SDS', c.requires_transport_info && 'UN no.'].filter(Boolean).join(', ') || '—'}</td><td className="text-right">{c.item_count}</td>
                <td className="text-right whitespace-nowrap">{isAdmin && <><button className={btn} onClick={() => setF({ ...c })}>Edit</button> <button className={btn} onClick={() => run(() => api.inventory.hazmat.deleteClass(c.id), 'Class deleted.')}>Delete</button></>}</td></tr>)}
            </tbody>
          </table>
        )}
      </div>
      {cls.length > 1 && (
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">Segregation <span className="normal-case font-normal text-slate-400">tick pairs that must never share a location or shipment</span></p>
          <div className="overflow-x-auto"><table className="text-xs"><thead><tr><th />{cls.map(c => <th key={c.id} className="px-2 font-mono text-slate-500">{c.code}</th>)}</tr></thead>
            <tbody>{cls.map((a, i) => <tr key={a.id}><th className="pr-2 text-left font-mono text-slate-500">{a.code}</th>{cls.map((b, j) => j < i ? <td key={b.id} /> : (
              <td key={b.id} className="px-2 text-center"><input type="checkbox" disabled={!isAdmin} checked={pairOn(a.id, b.id)} title={`${a.name} / ${b.name}`}
                onChange={e => run(() => api.inventory.hazmat.setIncompatible(a.id, b.id, e.target.checked), 'Segregation updated.')} /></td>))}</tr>)}</tbody></table></div>
        </div>
      )}
      {sets && (
        <div>
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Company defaults</p>
          <div className="flex flex-wrap gap-3 items-end">
            <Field label="SDS considered old after (days)"><input type="number" min={30} disabled={!isAdmin} value={sets.sds_max_age_days} onChange={e => setSets({ ...sets, sds_max_age_days: e.target.value })} className={`${input} w-40`} /></Field>
            <Field label="Default location inspection (days)"><input type="number" min={1} disabled={!isAdmin} placeholder="none" value={sets.location_inspection_days} onChange={e => setSets({ ...sets, location_inspection_days: e.target.value })} className={`${input} w-40`} /></Field>
            {isAdmin && <button className={primary} onClick={() => run(async () => { await api.inventory.hazmat.setSettings({ sds_max_age_days: sets.sds_max_age_days === '' ? null : Number(sets.sds_max_age_days), location_inspection_days: sets.location_inspection_days === '' ? null : Number(sets.location_inspection_days) }); reloadMeta(); }, 'Settings saved.')}>Save</button>}
          </div>
        </div>
      )}
      {f && (
        <Overlay title={f.id ? 'Edit class' : 'New class'} onCancel={() => setF(null)}>
          <div className="grid grid-cols-3 gap-2"><input value={f.code} onChange={e => setF({ ...f, code: e.target.value })} placeholder="Code" className={input} /><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Name" className={`${input} col-span-2`} /></div>
          <select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })} className={`${input} w-full`}><option value="hazard">Hazard class</option><option value="special">Special handling (e.g. cold chain)</option></select>
          <input value={f.regulation ?? ''} onChange={e => setF({ ...f, regulation: e.target.value })} placeholder="Applicable regulation" className={`${input} w-full`} />
          <textarea rows={2} value={f.description ?? ''} onChange={e => setF({ ...f, description: e.target.value })} placeholder="Description" className={`${input} w-full`} />
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!f.requires_sds} onChange={e => setF({ ...f, requires_sds: e.target.checked })} /> Dispatch needs a Safety Data Sheet on file</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!f.requires_transport_info} onChange={e => setF({ ...f, requires_transport_info: e.target.checked })} /> Dispatch needs a UN number</label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!f.is_active} onChange={e => setF({ ...f, is_active: e.target.checked })} /> Active</label>
          <div className="flex justify-end gap-2"><button onClick={() => setF(null)} className={btn}>Cancel</button><button disabled={!f.code.trim() || !f.name.trim()} className={primary} onClick={() => run(async () => { await api.inventory.hazmat.saveClass(f.id ?? null, f); setF(null); }, 'Class saved.')}>Save</button></div>
        </Overlay>
      )}
    </div>
  );
}

// ── Locations ───────────────────────────────────────────────────────────────
function Locations({ canManage, readOnly, onChanged }: { canManage: boolean; readOnly: boolean; onChanged: () => void }) {
  const { data, error, reload } = useLoad<any[]>(() => api.inventory.hazmat.locations());
  const { data: cd } = useLoad(() => api.inventory.hazmat.classes());
  const [f, setF] = useState<any>(null);
  const [insp, setInsp] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const classes = cd?.classes ?? [];
  const name = (id: number) => classes.find(c => c.id === id)?.code ?? id;
  const save = async () => {
    setErr('');
    try {
      const r = await api.inventory.hazmat.saveLocation(f.id, { temp_min_c: f.temp_min_c === '' ? null : f.temp_min_c, temp_max_c: f.temp_max_c === '' ? null : f.temp_max_c, inspection_interval_days: f.inspection_interval_days === '' ? null : f.inspection_interval_days, hazard_notes: f.hazard_notes, permits: f.permits });
      setMsg(r.items_without_permit ? `Saved. ${r.items_without_permit} item(s) stored here are not covered by a permit.` : 'Location saved.'); setF(null); reload(); onChanged();
    } catch (e: any) { setErr(e.message); }
  };
  const inspect = async () => { setErr(''); try { await api.inventory.hazmat.inspect({ subject_type: 'location', location_id: insp.id, result: insp.result, findings: insp.findings }); setMsg(`Inspection recorded for ${insp.name}.`); setInsp(null); reload(); onChanged(); } catch (e: any) { setErr(e.message); } };
  return (
    <div>
      <Err msg={error || err} /><Ok msg={msg} />
      <p className="text-[11px] text-slate-500 mb-3">Hazardous items can only be stored in a location approved for their class. Receiving goes to the default location, so approve the class there too (or receive hazardous goods into an approved location by adjustment or transfer). Quarantine and damaged locations always accept stock for containment.</p>
      {!data ? <Spin /> : (
        <table className="w-full text-xs">
          <thead><tr className="text-slate-500"><th className="text-left pb-1">Location</th><th className="text-left pb-1">Approved classes</th><th className="text-left pb-1">Rating °C</th><th className="text-left pb-1">Inspection</th><th className="text-right pb-1">Hazard units</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.map(l => (
              <tr key={l.id} className="align-top"><td className="py-1.5 font-semibold">{l.name}{l.kind !== 'normal' && <span className="ml-1 text-[10px] text-amber-600">{l.kind}</span>}</td>
                <td>{l.permits.length ? l.permits.map((p: any) => `${name(p.hazard_class_id)}${p.max_qty ? ` ≤${p.max_qty}` : ''}`).join(', ') : <span className="text-slate-400">none</span>}</td>
                <td>{l.temp_min_c != null || l.temp_max_c != null ? `${l.temp_min_c ?? '…'} to ${l.temp_max_c ?? '…'}` : '—'}</td>
                <td>{l.inspection.interval_days ? <span className={l.inspection.failed || l.inspection.overdue ? 'text-red-600 font-semibold' : ''}>{l.inspection.failed ? 'FAILED' : l.inspection.never ? 'never inspected' : l.inspection.overdue ? `overdue ${date(l.inspection.due)}` : `due ${date(l.inspection.due)}`}</span> : l.inspection.last_result ? `last ${l.inspection.last_result}` : '—'}</td>
                <td className="text-right">{l.hazard_units}</td>
                <td className="py-1 text-right whitespace-nowrap space-x-1">{canManage && !readOnly && <button className={btn} onClick={() => setF({ id: l.id, name: l.name, temp_min_c: l.temp_min_c ?? '', temp_max_c: l.temp_max_c ?? '', inspection_interval_days: l.inspection_interval_days ?? '', hazard_notes: l.hazard_notes ?? '', permits: l.permits.map((p: any) => ({ ...p })) })}>Edit</button>}
                  {!readOnly && <button className={btn} onClick={() => setInsp({ id: l.id, name: l.name, result: 'pass', findings: '' })}>Inspect</button>}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {f && (
        <Overlay title={`Location rules · ${f.name}`} onCancel={() => setF(null)}>
          <Err msg={err} />
          <div className="grid grid-cols-3 gap-2">
            <Field label="Min °C"><input type="number" step="any" value={f.temp_min_c} onChange={e => setF({ ...f, temp_min_c: e.target.value })} className={`${input} w-full`} /></Field>
            <Field label="Max °C"><input type="number" step="any" value={f.temp_max_c} onChange={e => setF({ ...f, temp_max_c: e.target.value })} className={`${input} w-full`} /></Field>
            <Field label="Inspect every (days)"><input type="number" min={1} value={f.inspection_interval_days} onChange={e => setF({ ...f, inspection_interval_days: e.target.value })} className={`${input} w-full`} /></Field>
          </div>
          <p className="text-[11px] text-slate-500">A temperature-sensitive item is only accepted where the declared range sits inside its tolerance. With an inspection interval set, hazardous stock is refused until the first passing inspection and whenever it is overdue or failed.</p>
          <p className="text-xs font-semibold text-slate-700">Approved classes (max units optional)</p>
          <div className="space-y-1 max-h-48 overflow-auto">
            {classes.filter(c => c.is_active).map(c => {
              const p = f.permits.find((x: any) => x.hazard_class_id === c.id);
              return (
                <div key={c.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={!!p} onChange={e => setF({ ...f, permits: e.target.checked ? [...f.permits, { hazard_class_id: c.id, max_qty: null }] : f.permits.filter((x: any) => x.hazard_class_id !== c.id) })} />
                  <span className="flex-1">{c.code} — {c.name}</span>
                  {p && <input type="number" min={1} placeholder="limit" value={p.max_qty ?? ''} onChange={e => setF({ ...f, permits: f.permits.map((x: any) => (x.hazard_class_id === c.id ? { ...x, max_qty: e.target.value === '' ? null : Number(e.target.value) } : x)) })} className="w-24 text-xs border border-slate-200 rounded-lg px-2 py-1" />}
                </div>
              );
            })}
            {!classes.length && <p className="text-[11px] text-slate-400">Define classes first (Classes & segregation tab).</p>}
          </div>
          <textarea rows={2} value={f.hazard_notes} onChange={e => setF({ ...f, hazard_notes: e.target.value })} placeholder="Notes (bunding, ventilation, signage)" className={`${input} w-full`} />
          <div className="flex justify-end gap-2"><button onClick={() => setF(null)} className={btn}>Cancel</button><button onClick={save} className={primary}>Save</button></div>
        </Overlay>
      )}
      {insp && (
        <Overlay title={`Inspect · ${insp.name}`} onCancel={() => setInsp(null)}>
          <Err msg={err} />
          <select value={insp.result} onChange={e => setInsp({ ...insp, result: e.target.value })} className={`${input} w-full`}><option value="pass">Pass</option><option value="fail">Fail (blocks hazardous intake)</option></select>
          <textarea rows={3} value={insp.findings} onChange={e => setInsp({ ...insp, findings: e.target.value })} placeholder={insp.result === 'fail' ? 'Findings (required)' : 'Notes'} className={`${input} w-full`} />
          <div className="flex justify-end gap-2"><button onClick={() => setInsp(null)} className={btn}>Cancel</button><button disabled={insp.result === 'fail' && insp.findings.trim().length < 3} onClick={inspect} className={primary}>Record</button></div>
        </Overlay>
      )}
    </div>
  );
}

// ── Inspections log ─────────────────────────────────────────────────────────
function Inspections({ readOnly, onChanged }: { readOnly: boolean; onChanged: () => void }) {
  const { data, error, reload } = useLoad<any[]>(() => api.inventory.hazmat.inspections());
  const { data: locs } = useLoad<any[]>(() => api.inventory.hazmat.locations());
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState('');
  const go = async () => { setErr(''); try { await api.inventory.hazmat.inspect({ subject_type: 'location', location_id: Number(f.location_id), result: f.result, findings: f.findings }); setF(null); reload(); onChanged(); } catch (e: any) { setErr(e.message); } };
  return (
    <div>
      <Err msg={error} />
      {!readOnly && <button className={`${btn} mb-3`} onClick={() => setF({ location_id: '', result: 'pass', findings: '' })}>Record location inspection</button>}
      {!data ? <Spin /> : data.length === 0 ? <Empty>No inspections recorded. Item inspections are recorded from the Items tab.</Empty> : (
        <table className="w-full text-xs">
          <thead><tr className="text-slate-500"><th className="text-left pb-1">Date</th><th className="text-left pb-1">Subject</th><th className="text-left pb-1">Result</th><th className="text-left pb-1">Findings</th><th className="text-left pb-1">Next due</th><th className="text-left pb-1">By</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{data.map(i => <tr key={i.id}><td className="py-1.5">{date(i.inspected_at)}</td><td>{i.subject_type === 'location' ? i.location_name : i.item_name}</td><td className={i.result === 'fail' ? 'text-red-600 font-semibold' : 'text-emerald-700'}>{i.result}</td><td>{i.findings ?? ''}</td><td>{date(i.next_due)}</td><td>{i.user_name ?? ''}</td></tr>)}</tbody>
        </table>
      )}
      {f && (
        <Overlay title="Location inspection" onCancel={() => setF(null)}>
          <Err msg={err} />
          <select value={f.location_id} onChange={e => setF({ ...f, location_id: e.target.value })} className={`${input} w-full`}><option value="">Location…</option>{(locs ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <select value={f.result} onChange={e => setF({ ...f, result: e.target.value })} className={`${input} w-full`}><option value="pass">Pass</option><option value="fail">Fail</option></select>
          <textarea rows={3} value={f.findings} onChange={e => setF({ ...f, findings: e.target.value })} placeholder={f.result === 'fail' ? 'Findings (required)' : 'Notes'} className={`${input} w-full`} />
          <div className="flex justify-end gap-2"><button onClick={() => setF(null)} className={btn}>Cancel</button><button disabled={!f.location_id || (f.result === 'fail' && f.findings.trim().length < 3)} onClick={go} className={primary}>Record</button></div>
        </Overlay>
      )}
    </div>
  );
}

// ── Incidents ───────────────────────────────────────────────────────────────
function Incidents({ canManage, readOnly, onChanged }: { canManage: boolean; readOnly: boolean; onChanged: () => void }) {
  const [status, setStatus] = useState('');
  const { data, error, reload } = useLoad<any[]>(() => api.inventory.hazmat.incidents(status || undefined), [status]);
  const { data: locs } = useLoad<any[]>(() => api.inventory.hazmat.locations());
  const { data: items } = useLoad<any[]>(() => api.inventory.hazmat.items());
  const [f, setF] = useState<any>(null);
  const [closing, setClosing] = useState<any>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const report = async () => {
    setErr('');
    try { const r = await api.inventory.hazmat.reportIncident({ ...f, tire_id: f.tire_id ? Number(f.tire_id) : undefined, location_id: f.location_id ? Number(f.location_id) : undefined }); setMsg(`${r.incident_no} reported.`); setF(null); reload(); onChanged(); }
    catch (e: any) { setErr(e.message); }
  };
  const close = async () => { setErr(''); try { await api.inventory.hazmat.closeIncident(closing.id, closing.resolution); setClosing(null); setMsg('Incident closed.'); reload(); onChanged(); } catch (e: any) { setErr(e.message); } };
  return (
    <div>
      <Err msg={error} /><Ok msg={msg} />
      <div className="flex gap-2 mb-3">
        {!readOnly && <button className={primary} onClick={() => setF({ incident_type: 'leak', severity: 'medium', tire_id: '', location_id: '', description: '', actions_taken: '', hold_item: false })}>Report incident</button>}
        <select value={status} onChange={e => setStatus(e.target.value)} className={input}><option value="">All</option><option value="open">Open</option><option value="closed">Closed</option></select>
      </div>
      {!data ? <Spin /> : data.length === 0 ? <Empty>No incidents recorded.</Empty> : (
        <table className="w-full text-xs">
          <thead><tr className="text-slate-500"><th className="text-left pb-1">No.</th><th className="text-left pb-1">Date</th><th className="text-left pb-1">Type</th><th className="text-left pb-1">Severity</th><th className="text-left pb-1">Where</th><th className="text-left pb-1">Description</th><th className="text-left pb-1">Status</th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {data.map(i => <tr key={i.id} className="align-top"><td className="py-1.5 font-mono">{i.incident_no}</td><td>{date(i.reported_at)}</td><td>{i.type_label}</td><td><span className={`px-2 py-0.5 rounded-full font-semibold ${SEV[i.severity] ?? ''}`}>{i.severity_label}</span>{!!i.blocks_dispatch && i.status === 'open' && <div className="text-[10px] text-red-600">blocks dispatch</div>}</td>
              <td>{[i.item_name, i.location_name].filter(Boolean).join(' @ ')}</td><td>{i.description}{i.resolution && <div className="text-slate-500">Resolved: {i.resolution}</div>}</td><td>{i.status}</td>
              <td className="text-right">{i.status === 'open' && canManage && !readOnly && <button className={btn} onClick={() => setClosing({ id: i.id, resolution: '' })}>Close</button>}</td></tr>)}
          </tbody>
        </table>
      )}
      {f && (
        <Overlay title="Report incident" onCancel={() => setF(null)}>
          <Err msg={err} />
          <div className="grid grid-cols-2 gap-2">
            <select value={f.incident_type} onChange={e => setF({ ...f, incident_type: e.target.value })} className={input}><option value="spill">Spill</option><option value="leak">Leak</option><option value="fire">Fire / explosion</option><option value="exposure">Exposure / injury</option><option value="temperature_excursion">Temperature excursion</option><option value="damage">Damaged packaging</option><option value="near_miss">Near miss</option><option value="other">Other</option></select>
            <select value={f.severity} onChange={e => setF({ ...f, severity: e.target.value })} className={input}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High (blocks dispatch)</option><option value="critical">Critical (blocks dispatch)</option></select>
          </div>
          <select value={f.tire_id} onChange={e => setF({ ...f, tire_id: e.target.value })} className={`${input} w-full`}><option value="">Item (optional)…</option>{(items ?? []).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
          <select value={f.location_id} onChange={e => setF({ ...f, location_id: e.target.value })} className={`${input} w-full`}><option value="">Location (optional)…</option>{(locs ?? []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <textarea rows={2} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} placeholder="What happened (required)" className={`${input} w-full`} />
          <textarea rows={2} value={f.actions_taken} onChange={e => setF({ ...f, actions_taken: e.target.value })} placeholder="Immediate actions taken" className={`${input} w-full`} />
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.hold_item} onChange={e => setF({ ...f, hold_item: e.target.checked })} /> Place the item on a safety hold</label>
          <div className="flex justify-end gap-2"><button onClick={() => setF(null)} className={btn}>Cancel</button><button disabled={f.description.trim().length < 3 || (!f.tire_id && !f.location_id)} onClick={report} className={primary}>Report</button></div>
        </Overlay>
      )}
      {closing && (
        <Overlay title="Close incident" onCancel={() => setClosing(null)}>
          <Err msg={err} />
          <textarea rows={3} value={closing.resolution} onChange={e => setClosing({ ...closing, resolution: e.target.value })} placeholder="Resolution (required)" className={`${input} w-full`} />
          <p className="text-[11px] text-slate-500">Closing lifts the dispatch block. Safety holds placed on items stay until a manager lifts them.</p>
          <div className="flex justify-end gap-2"><button onClick={() => setClosing(null)} className={btn}>Cancel</button><button disabled={closing.resolution.trim().length < 3} onClick={close} className={primary}>Close incident</button></div>
        </Overlay>
      )}
    </div>
  );
}
