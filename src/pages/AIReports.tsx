import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line,
} from 'recharts';
import { Sparkles, Send, Save, Download, History, Bookmark, Trash2, Play, AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency, formatDate, cn } from '../lib/utils';
import ErrorBanner from '../components/ErrorBanner';

type Col = { key: string; label: string; type: 'text' | 'number' | 'currency' | 'date' | 'percent' };
type Kpi = { label: string; value: number; type: Col['type'] };

interface ReportResult {
  status: 'ok' | 'clarification' | 'unsupported' | 'denied' | 'blocked' | 'error';
  message?: string;
  suggestions?: string[];
  options?: { label: string; spec: any }[];
  question?: string | null;
  reportId?: string;
  title?: string;
  classification?: string;
  interpretation?: { metric?: string; period?: string | null; filters: Record<string, string>; limit: number; scope: string };
  summary?: { headline: string; kpis: Kpi[] };
  evidence?: { columns: Col[]; rows: Record<string, any>[]; rowCount: number; truncated: boolean };
  calculation?: { name: string; basis: string; definition: string } | null;
  caveats?: string[];
  visualization?: { chart: { type: 'bar' | 'line'; x: string; y: string } | null };
  actions?: string[];
  spec?: any;
  generatedAt?: string;
}

const fmt = (v: any, type: Col['type']) => {
  if (v === null || v === undefined || v === '') return '—';
  if (type === 'currency') return formatCurrency(Number(v));
  if (type === 'percent')  return `${Number(v).toFixed(1)}%`;
  if (type === 'number')   return Number(v).toLocaleString('en-PK', { maximumFractionDigits: 2 });
  if (type === 'date')     return formatDate(String(v));
  return String(v);   // React escapes; untrusted text is never rendered as HTML
};

const CLASS_LABEL: Record<string, string> = {
  internal: 'Internal',
  confidential_financial: 'Confidential financial',
  personal_regulated: 'Personal / regulated',
};

type Tab = 'ask' | 'history' | 'saved';

export default function AIReports() {
  const [tab, setTab]             = useState<Tab>('ask');
  const [question, setQuestion]   = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [result, setResult]       = useState<ReportResult | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [history, setHistory]     = useState<any[]>([]);
  const [saved, setSaved]         = useState<any[]>([]);
  const [note, setNote]           = useState('');

  const loadLists = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([api.reports.history(), api.reports.saved()]);
      setHistory(h); setSaved(s);
    } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => {
    api.reports.definitions().then(d => setSuggestions(d.suggestions ?? [])).catch(e => setError(e.message));
    loadLists();
  }, [loadLists]);

  const run = async (body: { question?: string; spec?: any }, label?: string) => {
    setLoading(true); setError(''); setNote('');
    if (label) setQuestion(label);
    try {
      const r: ReportResult = body.spec && !body.question ? await api.reports.ask({ spec: body.spec }) : await api.reports.ask(body);
      setResult(r.status === 'ok' && !r.question && label ? { ...r, question: label } : r);
      setTab('ask');
      loadLists();
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };

  const submit = (e: React.FormEvent) => { e.preventDefault(); if (question.trim()) run({ question: question.trim() }); };

  const save = async () => {
    if (!result?.spec) return;
    const name = window.prompt('Name for this saved report:', result.title ?? 'Saved report');
    if (!name) return;
    try { await api.reports.save({ name, spec: result.spec, question: result.question ?? undefined }); setNote('Saved. It will be re-authorised every time it runs.'); loadLists(); }
    catch (e: any) { setError(e.message); }
  };

  const exportCsv = async () => {
    if (!result?.spec) return;
    try {
      const blob = await api.reports.exportCsv(result.spec);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${result.reportId}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setError(e.message); }
  };

  const ok = result?.status === 'ok' ? result : null;

  return (
    <div className="space-y-4 sm:space-y-6">
      <ErrorBanner error={error} />

      <div className="flex gap-2">
        {([['ask', 'Ask', Sparkles], ['history', 'History', History], ['saved', 'Saved', Bookmark]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => setTab(id)}
            className={cn('flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium border transition-colors',
              tab === id ? 'bg-teal-500 text-white border-teal-500' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50')}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'ask' && (
        <>
          <form onSubmit={submit} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-3 sm:p-4">
            <div className="flex gap-2">
              <input
                value={question} onChange={e => setQuestion(e.target.value)} maxLength={500}
                placeholder="Ask a business question, e.g. What is this month's revenue?"
                className="flex-1 min-w-0 px-4 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
              <button type="submit" disabled={loading || !question.trim()}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-teal-500 text-white text-sm font-semibold hover:bg-teal-600 disabled:opacity-50">
                <Send size={15} /> {loading ? 'Working…' : 'Ask'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2 mt-3">
              {suggestions.map(s => (
                <button key={s} type="button" onClick={() => run({ question: s }, s)}
                  className="text-xs px-2.5 py-1.5 rounded-full bg-slate-50 border border-slate-200 text-slate-600 hover:bg-teal-50 hover:border-teal-300 hover:text-teal-700">
                  {s}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-3 flex items-center gap-1">
              <ShieldAlert size={12} /> Answers come from approved reports under your permissions. The AI selects a report; it never runs SQL or changes data.
            </p>
          </form>

          {result && result.status !== 'ok' && (
            <div className={cn('rounded-2xl border p-4 text-sm',
              result.status === 'clarification' ? 'bg-sky-50 border-sky-200 text-sky-900' :
              result.status === 'unsupported'   ? 'bg-amber-50 border-amber-200 text-amber-900' :
                                                  'bg-red-50 border-red-200 text-red-800')}>
              <p className="font-medium flex items-start gap-2"><Info size={16} className="mt-0.5 flex-shrink-0" /> {result.message}</p>
              {result.options && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {result.options.map(o => (
                    <button key={o.label} onClick={() => run({ spec: o.spec, question: question || undefined })}
                      className="px-3 py-1.5 rounded-lg bg-white border border-sky-300 text-sky-800 text-xs font-medium hover:bg-sky-100">{o.label}</button>
                  ))}
                </div>
              )}
              {result.suggestions && (
                <div className="flex flex-wrap gap-2 mt-3">
                  {result.suggestions.map(s => (
                    <button key={s} onClick={() => run({ question: s }, s)} className="px-3 py-1.5 rounded-lg bg-white border border-sky-300 text-sky-800 text-xs hover:bg-sky-100">{s}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          {ok && ok.summary && ok.evidence && ok.interpretation && (
            <div className="space-y-4">
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    {ok.question && <p className="text-xs text-slate-400 truncate">Question: {ok.question}</p>}
                    <h2 className="text-lg font-bold text-slate-900">{ok.title}</h2>
                    <p className="text-sm text-slate-600 mt-1">{ok.summary.headline}</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={save} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"><Save size={14} /> Save</button>
                    <button onClick={exportCsv} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"><Download size={14} /> CSV</button>
                  </div>
                </div>
                {note && <p className="text-xs text-emerald-600 mt-2">{note}</p>}

                {ok.summary.kpis.length > 0 && (
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
                    {ok.summary.kpis.map(k => (
                      <div key={k.label} className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                        <p className="text-xs text-slate-500">{k.label}</p>
                        <p className="text-lg font-bold text-slate-900 truncate">{fmt(k.value, k.type)}</p>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-4 text-xs text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
                  {ok.interpretation.metric && <span><b>Metric:</b> {ok.interpretation.metric}</span>}
                  {ok.interpretation.period && <span><b>Period:</b> {ok.interpretation.period}</span>}
                  {Object.entries(ok.interpretation.filters).map(([k, v]) => <span key={k}><b>{k}:</b> {v}</span>)}
                  <span><b>Scope:</b> {ok.interpretation.scope}</span>
                  {ok.classification && <span><b>Class:</b> {CLASS_LABEL[ok.classification] ?? ok.classification}</span>}
                </div>
              </div>

              {ok.visualization?.chart && ok.evidence.rows.length > 0 && (
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      {ok.visualization.chart.type === 'line' ? (
                        <LineChart data={ok.evidence.rows}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey={ok.visualization.chart.x} tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <Tooltip />
                          <Line type="monotone" dataKey={ok.visualization.chart.y} stroke="#14b8a6" strokeWidth={2} dot={false} />
                        </LineChart>
                      ) : (
                        <BarChart data={ok.evidence.rows.slice(0, 15)}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey={ok.visualization.chart.x} tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={60} />
                          <YAxis tick={{ fontSize: 11 }} />
                          <Tooltip />
                          <Bar dataKey={ok.visualization.chart.y} fill="#14b8a6" radius={[4, 4, 0, 0]} />
                        </BarChart>
                      )}
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                      <tr>{ok.evidence.columns.map(c => (
                        <th key={c.key} className={cn('px-3 py-2.5 font-semibold whitespace-nowrap', c.type === 'text' || c.type === 'date' ? 'text-left' : 'text-right')}>{c.label}</th>
                      ))}</tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ok.evidence.rows.length === 0 && (
                        <tr><td colSpan={ok.evidence.columns.length} className="px-3 py-8 text-center text-slate-400">No records match these filters.</td></tr>
                      )}
                      {ok.evidence.rows.map((r, i) => (
                        <tr key={i} className="hover:bg-slate-50/60">
                          {ok.evidence!.columns.map(c => (
                            <td key={c.key} className={cn('px-3 py-2 whitespace-nowrap', c.type === 'text' || c.type === 'date' ? 'text-left text-slate-700' : 'text-right tabular-nums text-slate-800')}>
                              {fmt(r[c.key], c.type)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="px-3 py-2 text-[11px] text-slate-400 border-t border-slate-100">
                  {ok.evidence.rowCount} row(s){ok.evidence.truncated ? ' (limited)' : ''} · generated {ok.generatedAt ? new Date(ok.generatedAt).toLocaleString() : ''}
                </p>
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                {ok.calculation && (
                  <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
                    <h3 className="text-sm font-semibold text-slate-800 mb-1">Calculation</h3>
                    <p className="text-xs font-medium text-teal-700">{ok.calculation.name} · {ok.calculation.basis}</p>
                    <p className="text-xs text-slate-600 mt-1">{ok.calculation.definition}</p>
                  </div>
                )}
                {ok.caveats && ok.caveats.length > 0 && (
                  <div className="bg-amber-50 rounded-2xl border border-amber-200 p-4">
                    <h3 className="text-sm font-semibold text-amber-900 mb-1 flex items-center gap-1.5"><AlertTriangle size={14} /> Caveats</h3>
                    <ul className="list-disc pl-4 space-y-1 text-xs text-amber-900">{ok.caveats.map(c => <li key={c}>{c}</li>)}</ul>
                  </div>
                )}
              </div>

              {ok.actions && ok.actions.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-400">Follow-up:</span>
                  {ok.actions.map(a => (
                    <button key={a} onClick={() => run({ question: a }, a)} className="text-xs px-2.5 py-1.5 rounded-full bg-white border border-slate-200 text-slate-600 hover:border-teal-300 hover:text-teal-700">{a}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'history' && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm divide-y divide-slate-100">
          {history.length === 0 && <p className="p-6 text-sm text-slate-400 text-center">No report history yet.</p>}
          {history.map(h => (
            <div key={h.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm text-slate-800 truncate">{h.question || h.report_id}</p>
                <p className="text-xs text-slate-400">{new Date(h.created_at).toLocaleString()} · {h.report_id ?? '—'} · {h.outcome}{h.row_count != null ? ` · ${h.row_count} rows` : ''}</p>
              </div>
              {h.question && h.outcome !== 'blocked' && (
                <button onClick={() => run({ question: h.question }, h.question)} className="p-2 rounded-lg text-slate-400 hover:text-teal-600 hover:bg-teal-50" title="Run again"><Play size={15} /></button>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'saved' && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm divide-y divide-slate-100">
          {saved.length === 0 && <p className="p-6 text-sm text-slate-400 text-center">No saved reports. Run a report and press Save.</p>}
          {saved.map(s => (
            <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{s.name}</p>
                <p className="text-xs text-slate-400 truncate">{s.question || s.report_id}</p>
              </div>
              <div className="flex gap-1">
                <button onClick={async () => { setLoading(true); try { setResult(await api.reports.runSaved(s.id)); setTab('ask'); loadLists(); } catch (e: any) { setError(e.message); } finally { setLoading(false); } }}
                  className="p-2 rounded-lg text-slate-400 hover:text-teal-600 hover:bg-teal-50" title="Run (re-authorised)"><Play size={15} /></button>
                <button onClick={async () => { try { await api.reports.removeSaved(s.id); loadLists(); } catch (e: any) { setError(e.message); } }}
                  className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50" title="Delete"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
