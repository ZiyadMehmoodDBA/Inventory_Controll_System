import { useEffect, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { api } from '../api/client';

interface Props { tireId: number | undefined; value?: string; onChange: (reservationId: string | undefined, qty?: number) => void }

// Optional: sell against a reservation made for this item, which uses up the hold so the reserved units can be issued.
export default function SaleReservationPicker({ tireId, value, onChange }: Props) {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    if (!tireId) { setRows([]); return; }
    let live = true;
    Promise.all([api.inventory.reservations('active'), api.inventory.locations()]).then(([rs, locs]) => {
      const def = locs.find(l => l.is_default)?.id;
      if (live) setRows(rs.filter(r => r.tire_id === tireId && !r.is_expired && (def == null || r.location_id === def)));
    }).catch(() => {});
    return () => { live = false; };
  }, [tireId]);
  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-2.5 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-700"><Bookmark size={12} /> Reserved for an order (optional)</p>
      <select value={value ?? ''} onChange={e => { const r = rows.find(x => String(x.id) === e.target.value); onChange(r ? String(r.id) : undefined, r?.qty); }}
        className="w-full text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-teal-500">
        <option value="">Not from a reservation</option>
        {rows.map(r => <option key={r.id} value={r.id}>{r.qty} reserved{r.reference ? ` for ${r.reference}` : ''}</option>)}
      </select>
    </div>
  );
}
