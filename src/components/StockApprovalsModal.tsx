import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCheck, Loader2, X, XCircle } from 'lucide-react';
import { api } from '../api/client';

interface Props { onClose: () => void; onChanged: () => void }

export default function StockApprovalsModal({ onClose, onChanged }: Props) {
  const [rows, setRows]     = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError]   = useState('');

  const load = useCallback(async () => {
    try { setRows(await api.inventory.adjustments('pending')); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const decide = async (id: number, approve: boolean) => {
    setBusyId(id); setError('');
    try { await api.inventory.decideAdjustment(id, approve); await load(); onChanged(); }
    catch (e: any) { setError(e.message); } finally { setBusyId(null); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center"><ClipboardCheck size={18} className="text-amber-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Stock Adjustment Approvals</h3>
              <p className="text-xs text-slate-500">You cannot approve your own requests.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>
        <div className="overflow-auto flex-1 divide-y divide-slate-100">
          {error && <p className="m-4 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
          {loading && <div className="flex justify-center py-8"><Loader2 size={18} className="animate-spin text-slate-400" /></div>}
          {!loading && rows.length === 0 && <p className="py-10 text-center text-sm text-slate-400">No adjustments are waiting for approval.</p>}
          {rows.map(a => (
            <div key={a.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900 truncate">{a.item_name}</p>
                <p className="text-xs text-slate-500">
                  <b className={a.qty_change < 0 ? 'text-red-600' : 'text-emerald-600'}>{a.qty_change > 0 ? `+${a.qty_change}` : a.qty_change}</b>
                  {' · '}{a.reason_code.replace(/_/g, ' ')}{a.location_name ? ` · ${a.location_name}` : ''} · by {a.requested_by_name || `user ${a.requested_by}`} · {new Date(a.requested_at).toLocaleString()}
                </p>
                {a.notes && <p className="text-xs text-slate-400 truncate">{a.notes}</p>}
              </div>
              <div className="flex gap-1 flex-shrink-0">
                <button disabled={busyId === a.id} onClick={() => decide(a.id, true)} title="Approve"
                  className="p-2 rounded-lg text-emerald-600 hover:bg-emerald-50 disabled:opacity-50"><CheckCircle2 size={18} /></button>
                <button disabled={busyId === a.id} onClick={() => decide(a.id, false)} title="Reject"
                  className="p-2 rounded-lg text-red-500 hover:bg-red-50 disabled:opacity-50"><XCircle size={18} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
