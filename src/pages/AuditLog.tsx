import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ClipboardList, RefreshCw, ChevronDown, ChevronRight,
  Plus, Pencil, Trash2, RotateCcw, Filter,
} from 'lucide-react';
import ErrorBanner from '../components/ErrorBanner';
import { api } from '../api/client';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import EmptyState from '../components/EmptyState';

// ── helpers ───────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatFull(dateStr: string) {
  return new Date(dateStr).toLocaleString();
}

const ACTION_STYLES: Record<string, string> = {
  CREATE: 'bg-emerald-50 text-emerald-700 border border-emerald-100',
  UPDATE: 'bg-teal-50    text-teal-700    border border-teal-100',
  DELETE: 'bg-red-50     text-red-700     border border-red-100',
};

const ENTITY_STYLES: Record<string, string> = {
  sales:     'bg-purple-50 text-purple-700',
  inventory: 'bg-teal-50   text-teal-700',
  products:  'bg-amber-50  text-amber-700',
};

const ACTION_ICON: Record<string, React.ElementType> = {
  CREATE: Plus,
  UPDATE: Pencil,
  DELETE: Trash2,
};

function ActionBadge({ action }: { action: string }) {
  const Icon = ACTION_ICON[action] ?? RotateCcw;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wide ${ACTION_STYLES[action] ?? 'bg-slate-100 text-slate-600'}`}>
      <Icon size={10} /> {action}
    </span>
  );
}

function EntityBadge({ entity }: { entity: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold capitalize ${ENTITY_STYLES[entity] ?? 'bg-slate-100 text-slate-600'}`}>
      {entity}
    </span>
  );
}

// ── Diff view ─────────────────────────────────────────────────────────────────

function DiffPanel({ action, beforeJson, afterJson }: {
  action: string; beforeJson: string | null; afterJson: string | null;
}) {
  const before = beforeJson ? (() => { try { return JSON.parse(beforeJson); } catch { return null; } })() : null;
  const after  = afterJson  ? (() => { try { return JSON.parse(afterJson);  } catch { return null; } })() : null;

  if (!before && !after) return <p className="text-xs text-slate-400 px-4 pb-3">No change data captured.</p>;

  if (action === 'CREATE' && after) {
    return (
      <div className="px-4 pb-3">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Created Record</p>
        <FieldTable obj={after} highlightClass="bg-emerald-50 text-emerald-800" />
      </div>
    );
  }

  if (action === 'DELETE' && before) {
    return (
      <div className="px-4 pb-3">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Deleted Record</p>
        <FieldTable obj={before} highlightClass="bg-red-50 text-red-800" />
      </div>
    );
  }

  // UPDATE — show only changed fields
  if (before && after) {
    const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
    const changedKeys = allKeys.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    const unchanged   = allKeys.filter(k => JSON.stringify(before[k]) === JSON.stringify(after[k]));

    return (
      <div className="px-4 pb-3 space-y-3">
        {changedKeys.length > 0 && (
          <div>
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Changed Fields</p>
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="text-left px-3 py-1.5 text-slate-500 font-semibold w-1/4">Field</th>
                    <th className="text-left px-3 py-1.5 text-red-600 font-semibold w-[37.5%]">Before</th>
                    <th className="text-left px-3 py-1.5 text-emerald-600 font-semibold w-[37.5%]">After</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {changedKeys.map(k => (
                    <tr key={k}>
                      <td className="px-3 py-1.5 font-mono text-slate-600">{k}</td>
                      <td className="px-3 py-1.5 bg-red-50/60 text-red-800 font-mono break-all">
                        {before[k] == null ? <span className="text-slate-400 italic">null</span> : String(before[k])}
                      </td>
                      <td className="px-3 py-1.5 bg-emerald-50/60 text-emerald-800 font-mono break-all">
                        {after[k]  == null ? <span className="text-slate-400 italic">null</span> : String(after[k])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {unchanged.length > 0 && (
          <details className="group">
            <summary className="text-[10px] font-bold text-slate-400 uppercase tracking-wider cursor-pointer list-none flex items-center gap-1 select-none">
              <ChevronRight size={11} className="group-open:rotate-90 transition-transform" />
              {unchanged.length} Unchanged Field{unchanged.length !== 1 ? 's' : ''}
            </summary>
            <div className="mt-1.5">
              <FieldTable obj={Object.fromEntries(unchanged.map(k => [k, after[k]]))} highlightClass="" />
            </div>
          </details>
        )}
      </div>
    );
  }

  return null;
}

function FieldTable({ obj, highlightClass }: { obj: Record<string, any>; highlightClass: string }) {
  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-slate-100">
          {Object.entries(obj).map(([k, v]) => (
            <tr key={k} className={highlightClass || 'hover:bg-slate-50'}>
              <td className="px-3 py-1.5 font-mono text-slate-500 w-1/3">{k}</td>
              <td className="px-3 py-1.5 font-mono break-all text-slate-800">
                {v == null ? <span className="text-slate-400 italic">null</span> : String(v)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function AuditLog() {
  const [logs,    setLogs]    = useState<any[]>([]);
  const [total,   setTotal]   = useState(0);
  const [page,    setPage]    = useState(1);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoaded = useRef(false);
  const [error,   setError]   = useState('');

  // Filters
  const [entity,   setEntity]   = useState('');
  const [action,   setAction]   = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');

  // Applied filters (only update when Apply is clicked)
  const [appliedFilters, setAppliedFilters] = useState({ entity: '', action: '', from: '', to: '' });

  const [expandedId, setExpandedId] = useState<number | null>(null);

  const LIMIT = 50;

  const fetchLogs = useCallback(async (p = 1) => {
    if (!hasLoaded.current) setLoading(true);
    setRefreshing(true);
    setError('');
    try {
      const result = await api.audit.list({
        entity: appliedFilters.entity || undefined,
        action: appliedFilters.action || undefined,
        from:   appliedFilters.from   || undefined,
        to:     appliedFilters.to     || undefined,
        page: p, limit: LIMIT,
      });
      setLogs(result.logs);
      setTotal(result.total);
      setPage(p);
      hasLoaded.current = true;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [appliedFilters]);

  useAutoRefresh(() => fetchLogs(page));
  useEffect(() => { fetchLogs(1); }, [fetchLogs]);

  const applyFilters = () => {
    setAppliedFilters({ entity, action, from: dateFrom, to: dateTo });
    setExpandedId(null);
  };

  const clearFilters = () => {
    setEntity(''); setAction(''); setDateFrom(''); setDateTo('');
    setAppliedFilters({ entity: '', action: '', from: '', to: '' });
    setExpandedId(null);
  };

  const totalPages = Math.max(1, Math.ceil(total / LIMIT));
  const hasFilters = appliedFilters.entity || appliedFilters.action || appliedFilters.from || appliedFilters.to;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ClipboardList size={20} className="text-teal-500" />
            Audit Log
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">
            Every create, update, and delete on sales, inventory, and products
          </p>
        </div>
        <button
          onClick={() => fetchLogs(page)}
          disabled={loading}
          className="p-2 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors"
          title="Refresh"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Filter bar */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100">
          <Filter size={14} className="text-slate-400" />
          <span className="text-sm font-semibold text-slate-700">Filters</span>
          {hasFilters && (
            <button onClick={clearFilters} className="ml-auto text-xs text-slate-400 hover:text-slate-600 underline">
              Clear all
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3 px-4 py-3">
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">Entity</label>
            <select value={entity} onChange={e => setEntity(e.target.value)}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-slate-50 min-w-[130px]">
              <option value="">All Entities</option>
              <option value="sales">Sales</option>
              <option value="inventory">Inventory</option>
              <option value="products">Products</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">Action</label>
            <select value={action} onChange={e => setAction(e.target.value)}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-slate-50 min-w-[130px]">
              <option value="">All Actions</option>
              <option value="CREATE">Create</option>
              <option value="UPDATE">Update</option>
              <option value="DELETE">Delete</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">From</label>
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-slate-50" />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1">To</label>
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-slate-50" />
          </div>
          <button onClick={applyFilters}
            className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors">
            Apply
          </button>
        </div>
      </div>

      {/* Error */}
      <ErrorBanner error={error} />

      {/* Table */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Summary bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 bg-slate-50/60">
          <p className="text-sm text-slate-500">
            {loading ? 'Loading…' : `${total.toLocaleString()} entr${total === 1 ? 'y' : 'ies'}`}
            {hasFilters && <span className="text-teal-600 font-medium"> (filtered)</span>}
          </p>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button onClick={() => fetchLogs(page - 1)} disabled={page <= 1 || loading}
                className="px-2.5 py-1 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors">
                ← Prev
              </button>
              <span className="px-2 text-xs text-slate-500">{page} / {totalPages}</span>
              <button onClick={() => fetchLogs(page + 1)} disabled={page >= totalPages || loading}
                className="px-2.5 py-1 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors">
                Next →
              </button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-7 h-7 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : logs.length === 0 ? (
          <EmptyState icon={ClipboardList} message="No audit entries found" />
        ) : (
          <div className="divide-y divide-slate-100">
            {logs.map(log => {
              const isExpanded = expandedId === log.id;
              return (
                <div key={log.id} className="group">
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                    className="w-full text-left"
                  >
                    <div className="flex items-start gap-3 px-5 py-3 hover:bg-slate-50/70 transition-colors">
                      {/* Expand icon */}
                      <div className="mt-0.5 flex-shrink-0">
                        {isExpanded
                          ? <ChevronDown size={14} className="text-teal-500" />
                          : <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500" />}
                      </div>

                      {/* Time */}
                      <div className="w-20 flex-shrink-0">
                        <p className="text-xs font-medium text-slate-700">{timeAgo(log.created_at)}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5" title={formatFull(log.created_at)}>
                          {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>

                      {/* User */}
                      <div className="w-28 flex-shrink-0 hidden sm:block">
                        <p className="text-xs font-semibold text-slate-800 truncate">{log.user_name}</p>
                        {log.user_id && (
                          <p className="text-[10px] text-slate-400">UID {log.user_id}</p>
                        )}
                      </div>

                      {/* Action + Entity */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <ActionBadge action={log.action} />
                        <EntityBadge entity={log.entity} />
                      </div>

                      {/* Summary */}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-slate-700 truncate">
                          <AuditSummary log={log} />
                        </p>
                      </div>

                      {/* ID */}
                      <div className="hidden md:block text-[10px] text-slate-400 flex-shrink-0 tabular-nums">
                        #{log.entity_id ?? '—'}
                      </div>
                    </div>
                  </button>

                  {/* Expanded diff */}
                  {isExpanded && (
                    <div className="bg-slate-50/50 border-t border-slate-100 pb-1">
                      <div className="px-5 pt-2 pb-1 flex items-center gap-2 text-[10px] text-slate-400 font-bold uppercase tracking-wider">
                        <span>Changes</span>
                        <span className="text-slate-300">·</span>
                        <span>{formatFull(log.created_at)}</span>
                      </div>
                      <DiffPanel
                        action={log.action}
                        beforeJson={log.before_json}
                        afterJson={log.after_json}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Bottom pagination */}
        {!loading && totalPages > 1 && (
          <div className="flex justify-center gap-2 px-5 py-4 border-t border-slate-100">
            <button onClick={() => fetchLogs(1)} disabled={page <= 1}
              className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40">
              First
            </button>
            <button onClick={() => fetchLogs(page - 1)} disabled={page <= 1}
              className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40">
              ← Prev
            </button>
            <span className="px-3 py-1.5 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg">
              Page {page} of {totalPages}
            </span>
            <button onClick={() => fetchLogs(page + 1)} disabled={page >= totalPages}
              className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40">
              Next →
            </button>
            <button onClick={() => fetchLogs(totalPages)} disabled={page >= totalPages}
              className="px-3 py-1.5 text-xs font-semibold text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-40">
              Last
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── AuditSummary — human-readable one-liner for each log row ──────────────────

function AuditSummary({ log }: { log: any }) {
  const tryParse = (s: string | null) => {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  };

  const after  = tryParse(log.after_json);
  const before = tryParse(log.before_json);
  const data   = after || before;

  switch (log.entity) {
    case 'sales':
      if (log.action === 'CREATE') return <>{data?.invoice_no ?? `Invoice #${log.entity_id}`} — {data?.status}</>;
      if (log.action === 'UPDATE') return <>
        {data?.invoice_no ?? `Invoice #${log.entity_id}`}
        {before?.status && after?.status && before.status !== after.status
          ? `: ${before.status} → ${after.status}` : ''}
      </>;
      if (log.action === 'DELETE') return <>{before?.invoice_no ?? `Invoice #${log.entity_id}`} deleted</>;
      break;
    case 'inventory':
      if (log.action === 'CREATE') return <>{data?.brand} {data?.model} {data?.size} — {data?.stock} units</>;
      if (log.action === 'UPDATE') return <>{data?.brand} {data?.model} {data?.size}</>;
      if (log.action === 'DELETE') return <>{before?.brand} {before?.model} {before?.size} deleted</>;
      break;
    case 'products':
      if (log.action === 'CREATE') return <>{data?.name} ({data?.category})</>;
      if (log.action === 'UPDATE') return <>{data?.name}</>;
      if (log.action === 'DELETE') return <>{before?.name} deleted</>;
      break;
  }

  return <>{log.entity} #{log.entity_id}</>;
}
