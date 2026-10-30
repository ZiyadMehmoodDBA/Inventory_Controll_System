import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Loader2, RefreshCw, CheckCircle, AlertTriangle, XCircle, Plus, Pencil, Trash2, Play, Clock, Database, HardDrive, ShieldCheck, Save, X,
} from 'lucide-react';
import { api } from '../../api/client';
import ErrorBanner from '../../components/ErrorBanner';
import ConfirmDialog from '../../components/ConfirmDialog';
import { Field } from './shared';
import { DAYS, EVERY_CHOICES, compose, describeCron, parseCron, type Schedule } from '../../lib/cronText';

const KIND_LABEL: Record<string, string> = {
  full: 'Full backup', log: 'Transaction log backup', drill: 'Restore drill', pitr: 'Point-in-time drill', prune: 'Delete old backup files',
};
const KIND_HELP: Record<string, string> = {
  full: 'Copies the whole database and verifies the file. Also copies it to the off-host folder when one is set.',
  log: 'Saves the changes since the last backup. This sets how much work could be lost: run it often (every 5 to 30 minutes).',
  drill: 'Restores the newest full backup into a scratch database and checks it. Proves a backup can really be restored.',
  pitr: 'Proves the database can be restored to an exact moment, using the full backup plus log backups.',
  prune: 'Deletes backup files older than the retention period, from the backup and off-host folders.',
};

// The API sends UTC timestamps; treat one without a zone as UTC.
const ms = (iso: string) => new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').getTime();
const when = (iso?: string | null) => (iso ? new Date(ms(iso)).toLocaleString() : '—');
const ago = (iso?: string | null) => {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - ms(iso)) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 2880) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
};

function Badge({ ok, label }: { ok: boolean | null; label?: string }) {
  const cls = ok === null ? 'bg-slate-100 text-slate-500 border-slate-200' : ok ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-red-50 text-red-700 border-red-100';
  return <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border ${cls}`}>{label ?? (ok === null ? 'never run' : ok ? 'OK' : 'Failed')}</span>;
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-50 ${on ? 'bg-teal-500' : 'bg-slate-300'}`}>
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

const inputCls = 'w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400 bg-white';

// ── Job editor ──────────────────────────────────────────────────────────────
function JobModal({ job, onClose, onSaved }: { job: any | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName]       = useState(job?.name ?? '');
  const [kind, setKind]       = useState<string>(job?.kind ?? 'full');
  const [enabled, setEnabled] = useState<boolean>(job?.enabled ?? true);
  const [sched, setSched]     = useState<Schedule>(() => parseCron(job?.cron_expr ?? '0 2 * * *'));
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');
  const cron = compose(sched);
  const set = (p: Partial<Schedule>) => setSched(s => ({ ...s, ...p, cron: p.cron ?? compose({ ...s, ...p }) }));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const body = { name, kind, cron_expr: cron, enabled };
      if (job) await api.backups.updateJob(job.id, body); else await api.backups.createJob(body);
      onSaved();
    } catch (e: any) { setError(e.message || 'Could not save the job'); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" role="dialog" aria-label={job ? 'Edit job' : 'Add job'}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-base font-bold text-slate-900">{job ? 'Edit job' : 'Add job'}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <ErrorBanner error={error} />
          <Field label="Name"><input aria-label="Job name" className={inputCls} value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="e.g. Nightly full backup" /></Field>
          <Field label="Type" help={KIND_HELP[kind]}>
            <select aria-label="Job type" className={inputCls} value={kind} onChange={e => setKind(e.target.value)}>
              {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Schedule" help="Times are the database server's clock.">
            <select aria-label="Schedule type" className={inputCls} value={sched.preset} onChange={e => set({ preset: e.target.value as Schedule['preset'], cron: cron })}>
              <option value="every">Every few minutes</option>
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="custom">Custom (cron expression)</option>
            </select>
          </Field>
          {sched.preset === 'every' && (
            <Field label="Run every">
              <select aria-label="Every minutes" className={inputCls} value={sched.every} onChange={e => set({ every: Number(e.target.value) })}>
                {EVERY_CHOICES.map(n => <option key={n} value={n}>{n} minutes</option>)}
              </select>
            </Field>
          )}
          {sched.preset === 'hourly' && (
            <Field label="At minute"><input aria-label="Minute" type="number" min={0} max={59} className={inputCls} value={sched.minute} onChange={e => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
          )}
          {(sched.preset === 'daily' || sched.preset === 'weekly') && (
            <div className="grid grid-cols-2 gap-3">
              {sched.preset === 'weekly' && (
                <div className="col-span-2">
                  <Field label="Day">
                    <select aria-label="Day of week" className={inputCls} value={sched.dow} onChange={e => set({ dow: Number(e.target.value) })}>
                      {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  </Field>
                </div>
              )}
              <Field label="Hour (0-23)"><input aria-label="Hour" type="number" min={0} max={23} className={inputCls} value={sched.hour} onChange={e => set({ hour: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
              <Field label="Minute (0-59)"><input aria-label="Minute" type="number" min={0} max={59} className={inputCls} value={sched.minute} onChange={e => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} /></Field>
            </div>
          )}
          {sched.preset === 'custom' && (
            <Field label="Cron expression" help="Five numbers or * separated by spaces: minute hour day-of-month month day-of-week. Example: 0 2 * * 1-5 is 02:00 on weekdays.">
              <input aria-label="Cron expression" className={`${inputCls} font-mono`} value={sched.cron} onChange={e => setSched(s => ({ ...s, cron: e.target.value }))} placeholder="0 2 * * *" />
            </Field>
          )}
          <p className="text-xs text-slate-500 bg-slate-50 rounded-xl px-3 py-2">Runs: <strong>{describeCron(cron)}</strong> <span className="font-mono text-slate-400">({cron})</span></p>
          <label className="flex items-center gap-3 text-sm text-slate-700 font-medium">
            <Toggle on={enabled} onChange={setEnabled} label="Job enabled" /> Enabled
          </label>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
          <button onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
          <button onClick={save} disabled={saving || !name.trim()} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-500 hover:bg-teal-600 disabled:opacity-50 rounded-xl">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {job ? 'Save job' : 'Add job'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Console ─────────────────────────────────────────────────────────────────
export default function BackupsTab() {
  const [ov, setOv]             = useState<any>(null);
  const [error, setError]       = useState('');
  const [notice, setNotice]     = useState('');
  const [loading, setLoading]   = useState(true);
  const [editing, setEditing]   = useState<any | 'new' | null>(null);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [working, setWorking]   = useState<number | 'cfg' | null>(null);
  const [cfg, setCfg]           = useState({ backup_dir: '', offsite_dir: '', retention_days: '14' });
  const [cfgDirty, setCfgDirty] = useState(false);
  const [runs, setRuns]         = useState<{ rows: any[]; total: number }>({ rows: [], total: 0 });
  const [kindF, setKindF]       = useState('');
  const [okF, setOkF]           = useState('');
  const [page, setPage]         = useState(0);
  const PAGE = 15;
  const cfgDirtyRef = useRef(false);
  cfgDirtyRef.current = cfgDirty;

  const loadRuns = useCallback(async () => {
    try { setRuns(await api.backups.runs({ kind: kindF, ok: okF, limit: PAGE, offset: page * PAGE })); } catch (e: any) { setError(e.message); }
  }, [kindF, okF, page]);

  const load = useCallback(async () => {
    try {
      const d = await api.backups.overview();
      setOv(d);
      if (!cfgDirtyRef.current) setCfg({ backup_dir: d.config.backup_dir.source === 'console' ? d.config.backup_dir.value ?? '' : '', offsite_dir: d.config.offsite_dir.source === 'console' ? d.config.offsite_dir.value ?? '' : '', retention_days: String(d.config.retention_days.value) });
      setError('');
    } catch (e: any) { setError(e.message || 'Could not load backup status'); } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  // Refresh quickly while a job runs, slowly otherwise.
  const busy = !!ov?.busy;
  useEffect(() => {
    const id = setInterval(() => { load(); loadRuns(); }, busy ? 4000 : 30000);
    return () => clearInterval(id);
  }, [busy, load, loadRuns]);

  const act = async (key: number | 'cfg', fn: () => Promise<any>, ok?: string) => {
    setWorking(key); setError(''); setNotice('');
    try { const r = await fn(); if (ok) setNotice(ok); if (r?.warning) setNotice(r.warning); await load(); await loadRuns(); return r; }
    catch (e: any) { setError(e.message || 'That did not work'); } finally { setWorking(null); }
  };

  const saveConfig = () => act('cfg', async () => {
    const r = await api.backups.saveConfig({ backup_dir: cfg.backup_dir, offsite_dir: cfg.offsite_dir, retention_days: Number(cfg.retention_days) });
    setCfgDirty(false);
    return r;
  }, 'Configuration saved.');

  if (loading) return <div className="flex items-center justify-center h-40"><Loader2 size={20} className="animate-spin text-slate-400" /></div>;
  if (!ov) return <ErrorBanner error={error || 'Backup status is not available.'} />;

  const kindsByName = Object.fromEntries((ov.kinds as any[]).map(k => [k.kind, k]));
  const healthy = ov.health.ok;
  const pages = Math.max(1, Math.ceil(runs.total / PAGE));

  return (
    <div className="space-y-6" data-testid="backups-console">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">Backups & recovery</h2>
          <p className="text-xs text-slate-400 mt-0.5">Covers the whole database, every organisation. Visible to platform administrators only.</p>
        </div>
        <button onClick={() => { load(); loadRuns(); }} aria-label="Refresh" className="p-2 text-slate-500 hover:bg-slate-100 rounded-xl"><RefreshCw size={15} /></button>
      </div>

      <ErrorBanner error={error} />
      {notice && <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-700"><CheckCircle size={15} /> {notice}</div>}

      {/* Health */}
      <div className={`rounded-2xl border px-4 py-3.5 ${healthy ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`} data-testid="backup-health">
        <div className="flex items-center gap-2 font-semibold text-sm">
          {healthy ? <><ShieldCheck size={16} className="text-emerald-600" /><span className="text-emerald-800">Backups are healthy</span></> : <><AlertTriangle size={16} className="text-amber-600" /><span className="text-amber-800">{ov.health.problems.length} problem{ov.health.problems.length === 1 ? ' needs' : 's need'} attention</span></>}
        </div>
        {!healthy && <ul className="mt-2 space-y-1 text-sm text-amber-800 list-disc pl-5">{ov.health.problems.map((p: string) => <li key={p}>{p}</li>)}</ul>}
        {ov.busy && <p className="mt-2 text-xs text-slate-600 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Running now: {ov.busy.name} ({ov.busy.source})</p>}
      </div>

      {/* Latest results */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {(['full', 'log', 'drill', 'pitr'] as const).map(k => {
          const r = kindsByName[k];
          const stale = r?.last_ok && r.max_age_hours && (Date.now() - ms(r.last_ok)) / 3600000 > r.max_age_hours;
          return (
            <div key={k} className="bg-white border border-slate-100 rounded-2xl p-3.5">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{KIND_LABEL[k]}</p>
              <p className={`text-sm font-bold mt-1 ${!r?.last_ok || stale ? 'text-amber-600' : 'text-slate-900'}`}>{r?.last_ok ? ago(r.last_ok) : 'never'}</p>
              <p className="text-[11px] text-slate-400 mt-0.5">{r?.last_ok ? when(r.last_ok) : 'no successful run'}</p>
              {r && r.latest_ok === false && <p className="text-[11px] text-red-600 font-semibold mt-1">latest run failed</p>}
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
        <div className="bg-slate-50 rounded-2xl px-4 py-3 flex items-center gap-3"><Database size={16} className="text-slate-400" /><div><p className="text-[10px] font-bold text-slate-400 uppercase">Database size</p><p className="font-semibold text-slate-800">{ov.database ? `${Math.round(ov.database.size_mb).toLocaleString()} MB` : '—'}</p></div></div>
        <div className="bg-slate-50 rounded-2xl px-4 py-3 flex items-center gap-3"><ShieldCheck size={16} className="text-slate-400" /><div><p className="text-[10px] font-bold text-slate-400 uppercase">Recovery model</p><p className="font-semibold text-slate-800">{ov.database?.recovery_model ?? '—'}</p></div></div>
        <div className="bg-slate-50 rounded-2xl px-4 py-3 flex items-center gap-3"><CheckCircle size={16} className="text-slate-400" /><div><p className="text-[10px] font-bold text-slate-400 uppercase">Runs, last 30 days</p><p className="font-semibold text-slate-800">{ov.last_30_days.ok} ok / {ov.last_30_days.failed} failed</p></div></div>
        <div className="bg-slate-50 rounded-2xl px-4 py-3 flex items-center gap-3"><HardDrive size={16} className="text-slate-400" /><div className="min-w-0"><p className="text-[10px] font-bold text-slate-400 uppercase">Off-host copy</p><p className={`font-semibold truncate ${ov.config.offsite_dir.value ? 'text-slate-800' : 'text-amber-600'}`}>{ov.config.offsite_dir.value ? 'configured' : 'not set'}</p></div></div>
      </div>

      {/* Configuration */}
      <section className="border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Configuration</h3>
            <p className="text-xs text-slate-400">Folders are on the database server. The off-host folder should be a share on a different machine.</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            Scheduled backups
            <Toggle on={ov.enabled} label="Scheduled backups" disabled={working !== null}
              onChange={v => act('cfg', () => api.backups.saveConfig({ enabled: v }), v ? 'Scheduled backups switched on.' : 'Scheduled backups switched off.')} />
          </label>
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Backup folder" help={`In use: ${ov.config.effective_backup_dir ?? 'not available'}${ov.config.backup_dir.source === 'console' ? '' : ' (default)'}`}>
            <input aria-label="Backup folder" className={inputCls} value={cfg.backup_dir} placeholder="Leave empty for the server default" onChange={e => { setCfg(c => ({ ...c, backup_dir: e.target.value })); setCfgDirty(true); }} />
          </Field>
          <Field label="Off-host folder" help="A share on another machine, e.g. \\fileserver\sqlbackups">
            <input aria-label="Off-host folder" className={inputCls} value={cfg.offsite_dir} placeholder="\\fileserver\sqlbackups\tunegen" onChange={e => { setCfg(c => ({ ...c, offsite_dir: e.target.value })); setCfgDirty(true); }} />
          </Field>
          <Field label="Keep backups for (days)" help="Older files are deleted by the prune job.">
            <input aria-label="Retention days" type="number" min={1} max={3650} className={inputCls} value={cfg.retention_days} onChange={e => { setCfg(c => ({ ...c, retention_days: e.target.value })); setCfgDirty(true); }} />
          </Field>
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex justify-end">
          <button onClick={saveConfig} disabled={!cfgDirty || working !== null} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-500 hover:bg-teal-600 disabled:opacity-40 rounded-xl">
            {working === 'cfg' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save configuration
          </button>
        </div>
      </section>

      {/* Jobs */}
      <section className="border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Scheduled jobs</h3>
            <p className="text-xs text-slate-400">{ov.enabled ? 'Jobs run on the schedule below.' : 'Scheduled backups are switched off: jobs run only when you start them.'}</p>
          </div>
          <button onClick={() => setEditing('new')} className="flex items-center gap-2 px-3.5 py-2 text-sm font-semibold text-white bg-teal-500 hover:bg-teal-600 rounded-xl"><Plus size={14} /> Add job</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="jobs-table">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
              <th className="px-4 py-2.5 font-bold">Job</th><th className="px-3 py-2.5 font-bold">Schedule</th><th className="px-3 py-2.5 font-bold">Next run</th><th className="px-3 py-2.5 font-bold">Last run</th><th className="px-3 py-2.5 font-bold">On</th><th className="px-4 py-2.5 font-bold text-right">Actions</th>
            </tr></thead>
            <tbody>
              {ov.jobs.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No jobs. Add one to start protecting the data.</td></tr>}
              {ov.jobs.map((j: any) => (
                <tr key={j.id} className="border-b border-slate-50 last:border-0" data-job={j.name}>
                  <td className="px-4 py-3"><p className="font-semibold text-slate-900">{j.name}</p><p className="text-xs text-slate-400">{KIND_LABEL[j.kind]}</p></td>
                  <td className="px-3 py-3 text-slate-700">{describeCron(j.cron_expr)}</td>
                  <td className="px-3 py-3 text-slate-600 whitespace-nowrap">{j.next_run ? new Date(j.next_run).toLocaleString() : <span className="text-slate-400">{j.enabled ? 'scheduling off' : 'disabled'}</span>}</td>
                  <td className="px-3 py-3 whitespace-nowrap">{j.last_run ? <><Badge ok={!!j.last_run.ok} /> <span className="text-xs text-slate-400 ml-1">{ago(j.last_run.finished_at)}</span></> : <Badge ok={null} />}</td>
                  <td className="px-3 py-3"><Toggle on={j.enabled} label={`Enable ${j.name}`} disabled={working !== null} onChange={v => act(j.id, () => api.backups.updateJob(j.id, { name: j.name, kind: j.kind, cron_expr: j.cron_expr, enabled: v }))} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button title="Run now" aria-label={`Run ${j.name} now`} disabled={working !== null || busy} onClick={() => act(j.id, () => api.backups.runJob(j.id), `${j.name} started.`)} className="p-2 text-teal-600 hover:bg-teal-50 disabled:opacity-40 rounded-lg">{working === j.id ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}</button>
                      <button title="Edit" aria-label={`Edit ${j.name}`} onClick={() => setEditing(j)} className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg"><Pencil size={15} /></button>
                      <button title="Delete" aria-label={`Delete ${j.name}`} onClick={() => setDeleting(j)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* History */}
      <section className="border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2"><Clock size={14} className="text-slate-400" /> Run history</h3>
          <div className="flex items-center gap-2">
            <select aria-label="Filter by type" className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white" value={kindF} onChange={e => { setKindF(e.target.value); setPage(0); }}>
              <option value="">All types</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select aria-label="Filter by result" className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white" value={okF} onChange={e => { setOkF(e.target.value); setPage(0); }}>
              <option value="">Any result</option><option value="1">Succeeded</option><option value="0">Failed</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="runs-table">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
              <th className="px-4 py-2.5 font-bold">When</th><th className="px-3 py-2.5 font-bold">Type</th><th className="px-3 py-2.5 font-bold">Result</th><th className="px-3 py-2.5 font-bold">Started by</th><th className="px-3 py-2.5 font-bold">Details</th>
            </tr></thead>
            <tbody>
              {runs.rows.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">No runs match.</td></tr>}
              {runs.rows.map(r => (
                <tr key={r.id} className="border-b border-slate-50 last:border-0 align-top">
                  <td className="px-4 py-2.5 whitespace-nowrap text-slate-600">{when(r.finished_at)}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className="px-3 py-2.5">{r.ok ? <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold text-xs"><CheckCircle size={13} /> OK</span> : <span className="inline-flex items-center gap-1 text-red-700 font-semibold text-xs"><XCircle size={13} /> Failed</span>}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-500 capitalize">{r.source}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-500 max-w-md"><p className="truncate" title={r.message || ''}>{r.message || '—'}</p>{r.file && <p className="truncate font-mono text-[11px] text-slate-400" title={r.file}>{r.file}</p>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <span>{runs.total} run{runs.total === 1 ? '' : 's'}</span>
          <div className="flex items-center gap-2">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="px-2.5 py-1 rounded-lg border border-slate-200 disabled:opacity-40">Previous</button>
            <span>Page {page + 1} of {pages}</span>
            <button disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)} className="px-2.5 py-1 rounded-lg border border-slate-200 disabled:opacity-40">Next</button>
          </div>
        </div>
      </section>

      {editing && <JobModal job={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setNotice('Job saved.'); load(); }} />}
      {deleting && (
        <ConfirmDialog title="Delete job" message={`Delete "${deleting.name}"? Its past runs stay in the history. Backups it already made are not touched.`} confirmLabel="Delete job"
          loading={working === deleting.id} onCancel={() => setDeleting(null)}
          onConfirm={async () => { await act(deleting.id, () => api.backups.deleteJob(deleting.id), 'Job deleted.'); setDeleting(null); }} />
      )}
    </div>
  );
}
