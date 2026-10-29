import { useState, useEffect, useCallback } from 'react';
import { Loader2, RefreshCw, Activity, Cpu, Server, CheckCircle, HardDrive, Database, Monitor } from 'lucide-react';
import { api } from '../../api/client';
import ErrorBanner from '../../components/ErrorBanner';

function formatUptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(s % 60)}s`;
}

function roleBadge(role: string) {
  if (role === 'org_admin')      return 'bg-purple-50 text-purple-700 border border-purple-100';
  if (role === 'branch_manager') return 'bg-teal-50 text-teal-700 border border-teal-100';
  return 'bg-slate-100 text-slate-600 border border-slate-200';
}

function roleLabel(role: string) {
  if (role === 'org_admin')      return 'Admin';
  if (role === 'branch_manager') return 'Manager';
  return 'Staff';
}

function StatCard({ icon: Icon, color, label, value, sub }: {
  icon: React.ElementType; color: string; label: string; value: string | number; sub?: string;
}) {
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-4 flex items-start gap-3">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{label}</p>
        <p className="text-lg font-bold text-slate-900 leading-tight mt-0.5">{value}</p>
        {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function SystemInfoTab() {
  const [info, setInfo]           = useState<any>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetchInfo = useCallback(() => {
    setLoading(true); setError('');
    api.settings.systemInfo()
      .then(d => { setInfo(d); setLastFetch(new Date()); })
      .catch(err => setError(err.message || 'Failed to load system info'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchInfo();
    const id = setInterval(fetchInfo, 30_000);
    return () => clearInterval(id);
  }, [fetchInfo]);

  if (loading && !info) {
    return <div className="flex justify-center py-12"><Loader2 size={22} className="animate-spin text-slate-400" /></div>;
  }

  if (error) return <ErrorBanner error={error} />;
  if (!info) return null;

  const { server, database, sessions } = info;
  const memPct = server.memory_used_mb > 0
    ? Math.round((server.memory_heap_mb / server.memory_used_mb) * 100)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-slate-700">System Information</p>
          <p className="text-xs text-slate-400 mt-0.5">
            Live server, database, and session data · refreshes every 30s
            {lastFetch && ` · last updated ${lastFetch.toLocaleTimeString()}`}
          </p>
        </div>
        <button onClick={fetchInfo} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors disabled:opacity-50">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Monitor size={12} /> Server
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={Activity} color="bg-emerald-100 text-emerald-600" label="Uptime" value={formatUptime(server.uptime_seconds)} sub="since last restart" />
          <StatCard icon={Cpu} color="bg-teal-100 text-teal-600" label="Memory Used" value={`${server.memory_used_mb} MB`} sub={`heap: ${server.memory_heap_mb} MB (${memPct}%)`} />
          <StatCard icon={Server} color="bg-teal-100 text-teal-600" label="Node.js" value={server.node_version} sub={server.platform} />
          <StatCard icon={CheckCircle} color="bg-teal-100 text-teal-600" label="Status" value="Online" sub={new Date(server.timestamp).toLocaleTimeString()} />
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Database size={12} /> Database (TuneGENDB)
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-white border border-slate-100 rounded-2xl p-4 space-y-3">
            <p className="text-xs font-bold text-slate-600 flex items-center gap-1.5">
              <HardDrive size={12} className="text-slate-400" /> Storage
            </p>
            <div className="space-y-2">
              {[
                { label: 'Data files', value: database.data_mb, color: 'bg-teal-500' },
                { label: 'Log files',  value: database.log_mb,  color: 'bg-slate-300' },
              ].map(row => (
                <div key={row.label}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-500">{row.label}</span>
                    <span className="font-semibold text-slate-700">{row.value} MB</span>
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${row.color}`}
                      style={{ width: `${Math.min(100, (row.value / (database.total_mb || 1)) * 100)}%` }} />
                  </div>
                </div>
              ))}
              <div className="flex justify-between text-xs pt-1 border-t border-slate-100 mt-2">
                <span className="font-bold text-slate-600">Total</span>
                <span className="font-bold text-slate-900">{database.total_mb} MB</span>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-100 rounded-2xl p-4">
            <p className="text-xs font-bold text-slate-600 mb-3">Record Counts</p>
            <div className="space-y-2">
              {[
                { label: 'Tire SKUs',       value: database.counts.tire_skus },
                { label: 'Sales Invoices',  value: database.counts.total_sales },
                { label: 'Purchase Orders', value: database.counts.total_purchases },
                { label: 'Customers',       value: database.counts.customers },
                { label: 'Users',           value: database.counts.users_count },
                { label: 'Catalog Entries', value: database.counts.catalog_entries },
              ].map(row => (
                <div key={row.label} className="flex justify-between items-center text-xs py-0.5">
                  <span className="text-slate-500">{row.label}</span>
                  <span className="font-bold text-slate-900 tabular-nums">{(row.value ?? 0).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Activity size={12} /> Active Sessions
          <span className={`ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${sessions.active_count > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
            {sessions.active_count} online
          </span>
        </p>
        {sessions.active_count === 0 ? (
          <div className="text-center py-6 text-slate-400 text-sm border border-slate-100 rounded-2xl bg-white">
            No active sessions at the moment
          </div>
        ) : (
          <div className="bg-white border border-slate-100 rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {['User', 'Email', 'Role', 'Last Active'].map(h => (
                    <th key={h} className="text-xs font-semibold text-slate-400 uppercase tracking-wider px-4 py-3 text-left">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {sessions.users.map((u: any, i: number) => (
                  <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 bg-teal-500 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">
                          {u.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-xs font-semibold text-slate-900">{u.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{u.email}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${roleBadge(u.role)}`}>
                        {roleLabel(u.role)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-400 tabular-nums">{new Date(u.last_active).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
