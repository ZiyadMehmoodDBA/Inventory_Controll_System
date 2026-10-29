import { useEffect, useState } from 'react';
import { History, Loader2, X } from 'lucide-react';
import { api } from '../api/client';

interface Props {
  tire: { id: number; brand: string; model: string; size: string };
  onClose: () => void;
}

const LABEL: Record<string, string> = {
  sale: 'Sale', sale_voided: 'Sale voided', sale_deleted: 'Sale deleted', grn_received: 'Goods received',
  grn_cancelled: 'Receipt cancelled', purchase_deleted: 'Purchase deleted', adjustment: 'Adjustment',
  opening_stock: 'Opening stock', opening_balance: 'Opening balance',
  transfer_out: 'Transfer out', transfer_in: 'Transfer in',
};

export default function StockHistoryModal({ tire, onClose }: Props) {
  const [rows, setRows]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore]       = useState(false);
  const [error, setError]     = useState('');
  const [balances, setBalances] = useState<{ location_id: number; location_name: string; qty: number }[]>([]);
  useEffect(() => { api.inventory.stockByLocation({ tire_id: tire.id }).then(setBalances).catch(() => {}); }, [tire.id]);

  const load = async (before?: number) => {
    setLoading(true);
    try {
      const page = await api.inventory.movements({ tire_id: tire.id, limit: 50, before });
      setRows(prev => before ? [...prev, ...page] : page);
      setMore(page.length === 50);
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [tire.id]);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center"><History size={18} className="text-slate-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Stock History</h3>
              <p className="text-xs text-slate-500">{tire.brand} {tire.model} {tire.size}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>

        {balances.length > 1 && (
          <div className="flex flex-wrap gap-2 px-5 py-3 border-b border-slate-100 bg-slate-50/60">
            {balances.map(b => (
              <span key={b.location_id} className="text-xs bg-white border border-slate-200 rounded-full px-3 py-1 text-slate-600">
                {b.location_name}: <b className="text-slate-900">{b.qty}</b>
              </span>
            ))}
          </div>
        )}

        <div className="overflow-auto flex-1">
          {error && <p className="m-4 text-xs text-red-600">{error}</p>}
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase sticky top-0">
              <tr>
                {['When', 'Type', 'Location', 'Batch', 'Reference', 'Change', 'Before → After', 'By'].map(h => <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(m => (
                <tr key={m.id} title={m.notes || ''}>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500">{new Date(m.created_at).toLocaleString()}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-700">{LABEL[m.reason] ?? m.reason}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500">{m.location_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500">{m.batch_no ? <>{m.batch_no}{m.expiry_date ? <span className="text-slate-400"> · {String(m.expiry_date).slice(0, 10)}</span> : null}</> : '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500">{m.reference || '—'}</td>
                  <td className={`px-3 py-2 font-semibold tabular-nums ${m.qty_change < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{m.qty_change > 0 ? `+${m.qty_change}` : m.qty_change}</td>
                  <td className="px-3 py-2 tabular-nums text-slate-600">{m.qty_before ?? '—'} → {m.qty_after ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{m.user_name || '—'}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-400">No movements recorded yet.</td></tr>}
            </tbody>
          </table>
          {loading && <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin text-slate-400" /></div>}
          {more && !loading && (
            <div className="flex justify-center py-3">
              <button onClick={() => load(rows[rows.length - 1]?.id)} className="text-xs font-medium text-teal-600 hover:underline">Load older movements</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
