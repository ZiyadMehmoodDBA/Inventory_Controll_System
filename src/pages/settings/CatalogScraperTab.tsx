import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCw, Globe, Clock, Save, Play, Activity, Database, Search, ChevronLeft, ChevronRight, Trash2, CheckCircle, XCircle } from 'lucide-react';
import { api } from '../../api/client';
import ErrorBanner from '../../components/ErrorBanner';

const PAGE_SIZE = 20;

function statusBadge(s: string) {
  if (s === 'success') return 'bg-emerald-100 text-emerald-700';
  if (s === 'error')   return 'bg-red-100 text-red-700';
  if (s === 'running') return 'bg-teal-100 text-teal-700 animate-pulse';
  return 'bg-slate-100 text-slate-600';
}

function fmt(dt: string | null) {
  if (!dt) return '—';
  return new Date(dt).toLocaleString();
}

export default function CatalogScraperTab() {
  const [config, setConfig]           = useState<any>(null);
  const [configSaving, setConfigSaving] = useState(false);
  const [configSaved, setConfigSaved] = useState(false);
  const [configErr, setConfigErr]     = useState('');

  const [status, setStatus]           = useState<any>(null);
  const [statusErr, setStatusErr]     = useState('');

  const [entries, setEntries]         = useState<any[]>([]);
  const [entTotal, setEntTotal]       = useState(0);
  const [entPage, setEntPage]         = useState(1);
  const [entSearch, setEntSearch]     = useState('');
  const [entLoading, setEntLoading]   = useState(false);
  const [deletingId, setDeletingId]   = useState<number | null>(null);

  useEffect(() => {
    api.catalog.scraperConfig().then(setConfig).catch(e => setConfigErr(e.message));
  }, []);

  const loadStatus = useCallback(() => {
    api.catalog.scraperStatus().then(setStatus).catch(e => setStatusErr(e.message));
  }, []);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 5000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const loadEntries = useCallback(() => {
    setEntLoading(true);
    api.catalog.entries({ q: entSearch || undefined, page: entPage, limit: PAGE_SIZE })
      .then(r => { setEntries(r.entries); setEntTotal(r.total); })
      .catch(() => {})
      .finally(() => setEntLoading(false));
  }, [entSearch, entPage]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  const handleSaveConfig = async () => {
    if (!config) return;
    setConfigSaving(true); setConfigErr(''); setConfigSaved(false);
    try {
      const updated = await api.catalog.saveScraperConfig({ enabled: config.enabled, schedule: config.schedule });
      setConfig((prev: any) => prev ? { ...prev, ...updated } : prev);
      setConfigSaved(true);
      setTimeout(() => setConfigSaved(false), 3000);
    } catch (e: any) {
      setConfigErr(e.message);
    } finally {
      setConfigSaving(false);
    }
  };

  const handleRunNow = async () => {
    try { await api.catalog.runScraper(); loadStatus(); }
    catch (e: any) { setStatusErr(e.message); }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try { await api.catalog.deleteEntry(id); loadEntries(); }
    catch { /* ignore */ }
    finally { setDeletingId(null); }
  };

  const entryTotalPages = Math.max(1, Math.ceil(entTotal / PAGE_SIZE));
  const isJobRunning = config?.isRunning || status?.isRunning;

  return (
    <div className="space-y-8">

      {/* ── Config ── */}
      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-1.5">
          <Globe size={12} /> Online Catalog Source — GTR (General Tyre Pakistan)
        </p>
        <div className="bg-slate-50 border border-slate-100 rounded-2xl p-5 space-y-5">
          <ErrorBanner error={configErr} />
          {!config ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <Loader2 size={14} className="animate-spin" /> Loading config…
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-800">Enable Automatic Scraping</p>
                  <p className="text-xs text-slate-400 mt-0.5">Periodically fetches tire data from <span className="font-medium text-slate-600">gtr.com.pk</span> and updates the catalog</p>
                </div>
                <button
                  onClick={() => setConfig((c: any) => c ? { ...c, enabled: !c.enabled } : c)}
                  className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${config.enabled ? 'bg-teal-500' : 'bg-slate-200'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${config.enabled ? 'translate-x-5' : ''}`} />
                </button>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5 flex items-center gap-1.5">
                  <Clock size={12} /> Run Schedule
                </label>
                <select
                  value={config.schedule}
                  onChange={e => setConfig((c: any) => c ? { ...c, schedule: e.target.value } : c)}
                  disabled={!config.enabled}
                  className="w-full sm:w-72 text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {config.scheduleOptions.map((o: any) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <p className="text-xs text-slate-400 mt-1">Times are in Pakistan Standard Time (PKT, UTC+5)</p>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${isJobRunning ? 'bg-teal-100 text-teal-700 animate-pulse' : 'bg-slate-100 text-slate-500'}`}>
                  {isJobRunning ? '⟳ Running now' : '● Idle'}
                </span>
                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${(config.isScheduled || status?.isScheduled) ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-500'}`}>
                  {(config.isScheduled || status?.isScheduled) ? '✓ Scheduled' : '○ Not scheduled'}
                </span>
              </div>

              <div className="flex items-center gap-2 pt-1 flex-wrap">
                <button onClick={handleSaveConfig} disabled={configSaving}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-60 transition-colors">
                  {configSaving ? <><Loader2 size={13} className="animate-spin" /> Saving…</> : <><Save size={13} /> Save Schedule</>}
                </button>
                <button onClick={handleRunNow} disabled={isJobRunning}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-700 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-50 transition-colors">
                  <Play size={13} /> Run Now
                </button>
                {configSaved && (
                  <span className="flex items-center gap-1.5 text-sm text-emerald-600 font-medium">
                    <CheckCircle size={13} /> Saved
                  </span>
                )}
              </div>

              <div className="text-xs text-slate-400 border-t border-slate-200 pt-3">
                Source: <span className="font-medium text-slate-600">GTR.com.pk</span>
                &ensp;·&ensp;Brand: <span className="font-medium text-slate-600">General Tyre (Pakistan)</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Recent Logs ── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
            <Activity size={12} /> Recent Scrape Runs
          </p>
          <button onClick={loadStatus} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
            <RefreshCw size={13} />
          </button>
        </div>

        <ErrorBanner error={statusErr} className="mb-3" />

        {status && (
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <div className="bg-white border border-slate-100 rounded-xl px-4 py-2.5 text-center">
              <p className="text-xs text-slate-400">GTR Entries</p>
              <p className="text-lg font-bold text-slate-900">{(status.gtrCounts?.total || 0).toLocaleString()}</p>
            </div>
            <div className="bg-white border border-slate-100 rounded-xl px-4 py-2.5 text-center">
              <p className="text-xs text-slate-400">Models</p>
              <p className="text-lg font-bold text-slate-900">{(status.gtrCounts?.models || 0).toLocaleString()}</p>
            </div>
          </div>
        )}

        {!status ? (
          <div className="text-center py-6 text-slate-400 text-sm">
            <Loader2 size={18} className="animate-spin mx-auto mb-2" /> Loading logs…
          </div>
        ) : status.recentLogs.length === 0 ? (
          <div className="text-center py-6 text-slate-400 text-sm border border-slate-100 rounded-2xl bg-white">
            No scrape runs yet. Click <strong>Run Now</strong> to start.
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {['Status', 'Source', 'Triggered By', 'Started', 'Finished', 'Found', 'Added', 'Updated'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {status.recentLogs.map((log: any) => (
                  <tr key={log.id} className="hover:bg-slate-50/50">
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${statusBadge(log.status)}`}>{log.status}</span>
                    </td>
                    <td className="px-3 py-2 text-slate-600 max-w-[140px] truncate">{log.source}</td>
                    <td className="px-3 py-2 text-slate-400">{log.triggered_by}</td>
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmt(log.started_at)}</td>
                    <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmt(log.finished_at)}</td>
                    <td className="px-3 py-2 font-semibold text-slate-700 tabular-nums">{log.items_found ?? 0}</td>
                    <td className="px-3 py-2 font-semibold text-emerald-600 tabular-nums">{log.items_added ?? 0}</td>
                    <td className="px-3 py-2 font-semibold text-teal-600 tabular-nums">{log.items_updated ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {status.recentLogs.some((l: any) => l.error_msg) && (
              <div className="px-4 py-3 border-t border-slate-100 space-y-1.5">
                {status.recentLogs.filter((l: any) => l.error_msg).map((l: any) => (
                  <div key={l.id} className="flex items-start gap-2 text-xs text-red-600">
                    <XCircle size={11} className="flex-shrink-0 mt-0.5" />
                    <span><span className="font-medium">{fmt(l.started_at)}:</span> {l.error_msg}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Catalog Browser ── */}
      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Database size={12} /> Catalog Data ({entTotal.toLocaleString()} entries)
        </p>
        <div className="flex items-center gap-2 mb-3">
          <div className="relative flex-1 max-w-xs">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={entSearch}
              onChange={e => { setEntSearch(e.target.value); setEntPage(1); }}
              placeholder="Brand, model, size…"
              className="pl-8 pr-3 py-2 text-sm w-full bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>
          <button onClick={loadEntries} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
            <RefreshCw size={13} className={entLoading ? 'animate-spin' : ''} />
          </button>
        </div>

        <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
          {entLoading && entries.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">
              <Loader2 size={18} className="animate-spin mx-auto mb-2" /> Loading…
            </div>
          ) : entries.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">No catalog entries found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    {['Brand', 'Model', 'Size', 'Pattern', 'LI', 'SI', 'Type', ''].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {entries.map((e: any) => (
                    <tr key={e.id} className="hover:bg-slate-50/50 group">
                      <td className="px-3 py-2 font-medium text-slate-800">{e.brand}</td>
                      <td className="px-3 py-2 text-slate-700">{e.model}</td>
                      <td className="px-3 py-2 font-mono text-slate-700">{e.size}</td>
                      <td className="px-3 py-2 text-slate-500">{e.pattern || '—'}</td>
                      <td className="px-3 py-2 text-slate-500 tabular-nums">{e.load_index  || '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{e.speed_index || '—'}</td>
                      <td className="px-3 py-2 text-slate-500">{e.tire_type   || '—'}</td>
                      <td className="px-3 py-2 text-right opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => handleDelete(e.id)} disabled={deletingId === e.id}
                          className="p-1 text-slate-300 hover:text-red-500 transition-colors">
                          {deletingId === e.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {entryTotalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100">
              <button onClick={() => setEntPage(p => Math.max(1, p - 1))} disabled={entPage === 1}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-30 transition-colors">
                <ChevronLeft size={13} />
              </button>
              <span className="text-xs text-slate-500">
                Page <span className="font-semibold text-slate-700">{entPage}</span> of <span className="font-semibold text-slate-700">{entryTotalPages}</span>
                &ensp;·&ensp; {entTotal.toLocaleString()} entries
              </span>
              <button onClick={() => setEntPage(p => Math.min(entryTotalPages, p + 1))} disabled={entPage === entryTotalPages}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-30 transition-colors">
                <ChevronRight size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
