import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, RefreshCw, Target } from 'lucide-react';
import { api } from '../api/client';
import { usePermissions } from '../lib/permissions';

interface Measure {
  id: string; group: string; label: string; unit: 'pct' | 'ratio' | 'days' | 'money'; better: 'higher' | 'lower'; money: boolean;
  value: number | null; target: number | null; suggested_target: number | null;
  status: 'on_target' | 'watch' | 'off_target' | 'no_target' | 'no_data' | 'not_configured' | 'hidden'; basis: string; detail: Record<string, any>;
}
interface Result { period: { from: string; to: string; days: number }; measures: Measure[]; carrying_cost_rate: number | null; summary: { measured: number; with_target: number; on_target: number; watch: number; off_target: number } }

const PERIODS: [string, number][] = [['30 days', 30], ['90 days', 90], ['180 days', 180], ['1 year', 365]];
const TONE: Record<string, string> = {
  on_target: 'bg-emerald-50 text-emerald-700 border-emerald-200', watch: 'bg-amber-50 text-amber-700 border-amber-200', off_target: 'bg-red-50 text-red-700 border-red-200',
  no_target: 'bg-slate-50 text-slate-500 border-slate-200', no_data: 'bg-slate-50 text-slate-400 border-slate-200', not_configured: 'bg-slate-50 text-slate-500 border-slate-200', hidden: 'bg-slate-50 text-slate-400 border-slate-200',
};
const STATUS_TEXT: Record<string, string> = { on_target: 'On target', watch: 'Watch', off_target: 'Off target', no_target: 'No target set', no_data: 'No data in period', not_configured: 'Rate not set', hidden: 'Restricted' };
const fmt = (m: Measure, v: number | null) => {
  if (v === null || v === undefined) return '—';
  if (m.unit === 'pct') return `${v}%`;
  if (m.unit === 'days') return `${v} days`;
  if (m.unit === 'ratio') return `${v}×`;
  return v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};
const input = 'text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 w-28';

// Eleven operating measures from the ledger and documents, against targets the business sets. Nothing here is typed in except the targets.
export default function InventoryScorecard({ org }: { org: boolean }) {
  const { can } = usePermissions();
  const [days, setDays] = useState(90);
  const [data, setData] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [rate, setRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => { setError(''); api.inventory.insights.kpis({ days, scope: org ? 'org' : undefined }).then(setData).catch(e => setError(e.message)); }, [days, org]);
  useEffect(() => { load(); }, [load]);

  const startEdit = () => {
    if (!data) return;
    setDraft(Object.fromEntries(data.measures.filter(m => m.status !== 'hidden').map(m => [m.id, m.target === null ? '' : String(m.target)])));
    setRate(data.carrying_cost_rate === null ? '' : String(data.carrying_cost_rate));
    setEditing(true);
  };
  const save = async () => {
    setSaving(true); setError('');
    try {
      const targets: Record<string, number | null> = {};
      for (const [id, v] of Object.entries(draft)) targets[id] = v.trim() === '' ? null : Number(v);
      await api.inventory.insights.saveKpiTargets({ targets, carrying_cost_rate: rate.trim() === '' ? null : Number(rate) });
      setEditing(false); load();
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  };

  if (!data) return error ? <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2" role="alert">{error}</p> : <div className="flex justify-center py-10"><Loader2 size={18} className="animate-spin text-slate-400" /></div>;
  const groups = [...new Set(data.measures.map(m => m.group))];
  const S = data.summary;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <p className="text-sm font-bold text-slate-900">Business performance</p>
          <p className="text-xs text-slate-500">{data.period.from} to {data.period.to}. {S.with_target === 0 ? 'No targets set yet.' : `${S.on_target} on target, ${S.watch} to watch, ${S.off_target} off target.`}</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={e => setDays(Number(e.target.value))} className={`${input} !w-auto`} aria-label="Period">
            {PERIODS.map(([l, d]) => <option key={d} value={d}>Last {l}</option>)}
          </select>
          <button onClick={load} className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-500" aria-label="Refresh scorecard"><RefreshCw size={14} /></button>
          {can('policy.configure') && !editing && <button onClick={startEdit} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 inline-flex items-center gap-1.5"><Target size={13} /> Set targets</button>}
        </div>
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3" role="alert">{error}</p>}
      {editing && (
        <div className="mb-4 border border-teal-200 bg-teal-50/40 rounded-xl p-4">
          <p className="text-xs text-slate-600 mb-3">Set each target from what this business actually does. Leave blank for no target. The suggestion is your own current figure improved by 10%. It is a starting point, not a benchmark.</p>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
            {data.measures.filter(m => m.id in draft).map(m => (
              <label key={m.id} className="flex items-center justify-between gap-2 text-xs text-slate-700">
                <span>{m.label} <span className="text-slate-400">({m.better === 'higher' ? 'higher is better' : 'lower is better'})</span></span>
                <span className="flex items-center gap-1.5">
                  <input aria-label={`Target for ${m.label}`} className={input} inputMode="decimal" value={draft[m.id]} onChange={e => setDraft({ ...draft, [m.id]: e.target.value })} placeholder={m.suggested_target !== null ? String(m.suggested_target) : ''} />
                  {m.suggested_target !== null && <button type="button" className="text-[11px] text-teal-700 hover:underline" onClick={() => setDraft({ ...draft, [m.id]: String(m.suggested_target) })}>Use {m.suggested_target}</button>}
                </span>
              </label>
            ))}
            <label className="flex items-center justify-between gap-2 text-xs text-slate-700">
              <span>Annual carrying-cost rate (%) <span className="text-slate-400">storage, insurance, handling, capital</span></span>
              <input aria-label="Annual carrying-cost rate" className={input} inputMode="decimal" value={rate} onChange={e => setRate(e.target.value)} />
            </label>
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={save} disabled={saving} className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">{saving ? 'Saving…' : 'Save targets'}</button>
            <button onClick={() => setEditing(false)} className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-white">Cancel</button>
          </div>
        </div>
      )}
      {groups.map(g => (
        <section key={g} className="mb-5" aria-label={g}>
          <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-400 mb-2">{g}</h4>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.measures.filter(m => m.group === g).map(m => (
              <div key={m.id} className="border border-slate-200 rounded-xl p-3.5" data-measure={m.id}>
                <div className="flex items-start justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-600">{m.label}</p>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap ${TONE[m.status]}`}>{STATUS_TEXT[m.status]}</span>
                </div>
                <p className="text-2xl font-bold text-slate-900 mt-1.5" data-value>{m.status === 'hidden' ? '—' : fmt(m, m.value)}</p>
                <p className="text-[11px] text-slate-400 mt-0.5">{m.target !== null ? `Target ${m.better === 'higher' ? '≥' : '≤'} ${fmt(m, m.target)}` : m.status === 'hidden' ? 'You do not have permission to see cost figures' : m.suggested_target !== null ? `Suggested target ${fmt(m, m.suggested_target)}` : ' '}</p>
                <button onClick={() => setOpen(open === m.id ? null : m.id)} className="text-[11px] text-teal-700 hover:underline mt-2 inline-flex items-center gap-1"><Pencil size={10} /> {open === m.id ? 'Hide how it is measured' : 'How it is measured'}</button>
                {open === m.id && (
                  <div className="mt-2 text-[11px] text-slate-500 space-y-1.5">
                    <p>{m.basis}</p>
                    {Object.entries(m.detail).filter(([, v]) => typeof v !== 'object' && v !== null).map(([k, v]) => <p key={k}><span className="text-slate-400">{k.replace(/_/g, ' ')}:</span> {String(v)}</p>)}
                    {m.id === 'supplier_fulfillment' && Array.isArray(m.detail.suppliers) && m.detail.suppliers.map((s: any) => <p key={s.supplier}>{s.supplier}: {s.on_time} of {s.orders} on time{s.avg_days_late ? `, ${s.avg_days_late} days late on average` : ''}</p>)}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
