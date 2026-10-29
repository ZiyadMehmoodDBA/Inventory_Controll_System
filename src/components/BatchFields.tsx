import { Layers } from 'lucide-react';

// Batch / lot / serial entry shared by the receipt forms. Only shown for items whose tracking is switched on.
export interface BatchValue { batch_no?: string; expiry_date?: string; mfg_date?: string; serials?: string }
export interface Trackable { tracking?: 'none' | 'batch' | 'serial'; track_expiry?: boolean | number; shelf_life_days?: number | null }

export const serialList = (v?: string) => (v ?? '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);

export const batchPayload = (v: BatchValue) => ({
  batch_no:    v.batch_no?.trim() || undefined,
  expiry_date: v.expiry_date || undefined,
  mfg_date:    v.mfg_date || undefined,
  serials:     serialList(v.serials).length ? serialList(v.serials) : undefined,
});

/** Returns a message when a tracked line is incomplete, otherwise null. */
export function batchProblem(tire: Trackable | undefined, v: BatchValue, qty: number, itemName: string): string | null {
  if (!tire || !tire.tracking || tire.tracking === 'none') return null;
  if (tire.tracking === 'serial') {
    const n = serialList(v.serials).length;
    if (n !== qty) return `${itemName}: enter ${qty} serial number${qty === 1 ? '' : 's'} (${n} entered).`;
    return null;
  }
  if (!v.batch_no?.trim()) return `${itemName}: enter a batch / lot number.`;
  if (tire.track_expiry && !v.expiry_date && !(v.mfg_date && tire.shelf_life_days)) return `${itemName}: enter an expiry date${tire.shelf_life_days ? ' or a manufacturing date' : ''}.`;
  return null;
}

interface Props { tire: Trackable | undefined; value: BatchValue; qty: number; onChange: (patch: BatchValue) => void }

export default function BatchFields({ tire, value, qty, onChange }: Props) {
  if (!tire || !tire.tracking || tire.tracking === 'none') return null;
  const field = 'text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-teal-500';
  const label = 'block text-[11px] font-semibold text-slate-500 mb-0.5';

  return (
    <div className="rounded-lg border border-teal-100 bg-teal-50/50 p-2.5 space-y-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-teal-700">
        <Layers size={12} /> {tire.tracking === 'serial' ? 'Serial numbers' : 'Batch / lot'}{tire.track_expiry ? ' · expiry tracked' : ''}
      </p>
      {tire.tracking === 'serial' ? (
        <div>
          <label className={label}>One per line or comma separated ({serialList(value.serials).length} of {qty})</label>
          <textarea rows={2} value={value.serials ?? ''} onChange={e => onChange({ serials: e.target.value })} className={`${field} w-full font-mono`} />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div>
            <label className={label}>Batch / lot no.</label>
            <input value={value.batch_no ?? ''} maxLength={60} onChange={e => onChange({ batch_no: e.target.value })} className={`${field} w-full`} />
          </div>
          <div>
            <label className={label}>Manufactured{tire.track_expiry && tire.shelf_life_days ? '' : ' (optional)'}</label>
            <input type="date" value={value.mfg_date ?? ''} max={new Date().toISOString().slice(0, 10)} onChange={e => onChange({ mfg_date: e.target.value })} className={`${field} w-full`} />
          </div>
          <div>
            <label className={label}>Expiry date{tire.track_expiry ? (tire.shelf_life_days ? ' (or from mfg)' : '') : ' (optional)'}</label>
            <input type="date" value={value.expiry_date ?? ''} onChange={e => onChange({ expiry_date: e.target.value })} className={`${field} w-full`} />
          </div>
        </div>
      )}
    </div>
  );
}
