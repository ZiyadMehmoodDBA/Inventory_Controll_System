import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { api } from '../api/client';

export interface SalePick { batch_id?: string; serials?: string[] }
interface Tracked { id: number; tracking?: 'none' | 'batch' | 'serial' }
interface BatchRow { batch_id: number; batch_no: string; expiry_date: string | null; location_id: number; qty: number; days_to_expiry: number | null; quality_status?: string }
interface Props { tire: Tracked | undefined; value: SalePick; onChange: (pick: SalePick, qty?: number) => void }

// Optional choice of batch / serial numbers on a sale line. Left alone, tracked items sell earliest-expiring first.
// Sales draw from the branch's default location, so only batches held there are offered.
export default function SaleBatchPicker({ tire, value, onChange }: Props) {
  const tracked = !!tire && !!tire.tracking && tire.tracking !== 'none';
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [error, setError] = useState('');
  const [policy, setPolicy] = useState<{ policy: string; label: string } | null>(null);

  useEffect(() => {
    if (!tracked || !tire) { setRows([]); return; }
    let live = true;
    Promise.all([api.inventory.locations(), api.inventory.batches({ tire_id: tire.id })]).then(([locs, batches]) => {
      if (!live) return;
      const def = locs.find(l => l.is_default)?.id;
      setRows(batches.filter(b => b.qty > 0 && (def == null || b.location_id === def)));
    }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [tracked, tire?.id]);

  useEffect(() => {
    if (!tracked || !tire) { setPolicy(null); return; }
    let live = true;
    api.inventory.pickSuggestion(tire.id, 1).then(r => { if (live) setPolicy({ policy: r.policy, label: r.policy_label }); }).catch(() => {});
    return () => { live = false; };
  }, [tracked, tire?.id]);

  if (!tracked || !tire) return null;
  const manual = policy?.policy === 'manual';
  const expired = (b: BatchRow) => (b.days_to_expiry != null && b.days_to_expiry < 0) || (!!b.quality_status && b.quality_status !== 'released');
  const flag = (b: BatchRow) => (b.quality_status && b.quality_status !== 'released' ? ` (${b.quality_status === 'on_hold' ? 'ON HOLD' : b.quality_status.toUpperCase()})` : b.days_to_expiry != null && b.days_to_expiry < 0 ? ' (EXPIRED)' : '');
  const picked = value.serials ?? [];

  return (
    <div className="rounded-lg border border-teal-100 bg-teal-50/50 p-2.5 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-teal-700">
        <Layers size={12} /> {tire.tracking === 'serial' ? 'Serial numbers (optional — pick which units to sell)' : manual ? 'Batch (required — this item is set to manual picking)' : 'Batch (optional — default follows the rotation policy)'}
      </p>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
      {tire.tracking === 'batch' ? (
        <select value={value.batch_id ?? ''} onChange={e => onChange({ batch_id: e.target.value || undefined })}
          className="w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-teal-500">
          <option value="">{manual ? 'Choose a batch…' : `Automatic — ${policy?.label ?? 'earliest expiry first'}`}</option>
          {rows.map(b => (
            <option key={b.batch_id} value={b.batch_id} disabled={expired(b)}>
              {b.batch_no} · {b.qty} available{b.expiry_date ? ` · exp ${String(b.expiry_date).slice(0, 10)}` : ''}{flag(b)}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-24 overflow-auto">
          {rows.map(b => {
            const on = picked.includes(b.batch_no);
            return (
              <button type="button" key={b.batch_id} disabled={expired(b)}
                onClick={() => { const next = on ? picked.filter(x => x !== b.batch_no) : [...picked, b.batch_no]; onChange({ serials: next.length ? next : undefined }, next.length || undefined); }}
                className={`text-xs font-mono px-2 py-1 rounded-lg border ${on ? 'bg-teal-600 text-white border-teal-600' : 'bg-white text-slate-600 border-slate-200 hover:border-teal-400'} disabled:opacity-40`}>
                {b.batch_no}
              </button>
            );
          })}
          {!rows.length && <span className="text-[11px] text-slate-400">No serial numbers in stock at the selling location.</span>}
        </div>
      )}
    </div>
  );
}
