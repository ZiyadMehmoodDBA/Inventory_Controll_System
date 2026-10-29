import { useEffect, useState } from 'react';
import { History, Loader2, X } from 'lucide-react';
import { api } from '../api/client';

interface Props { tire: { id: number; brand: string; model: string; size: string }; onClose: () => void }

const FIELD: Record<string, string> = {
  '(created)': 'Created', sku: 'SKU', barcode: 'Barcode', brand: 'Brand', model: 'Name', size: 'Size', description: 'Description', category_id: 'Category',
  uom: 'Base unit', purchase_uom: 'Purchase unit', sales_uom: 'Sales unit', item_type: 'Item type', manufacturer: 'Manufacturer', supplier_id: 'Preferred supplier',
  cost_price: 'Cost price', sale_price: 'Sale price', tax_class: 'Tax class', tax_rate: 'Tax rate %', min_stock: 'Minimum stock', max_stock: 'Maximum stock',
  reorder_level: 'Reorder point', reorder_qty: 'Reorder qty', tracking: 'Tracking', track_expiry: 'Expiry tracking', status: 'Status', shelf_life_days: 'Shelf life (days)',
  pack_size: 'Pack size', weight_kg: 'Weight (kg)', volume_l: 'Volume (l)', length_cm: 'Length (cm)', width_cm: 'Width (cm)', height_cm: 'Height (cm)',
  storage_requirements: 'Storage requirements', handling_instructions: 'Handling', safety_requirements: 'Safety', storage_conditions: 'Storage conditions', conversions: 'Unit conversions',
};

export default function ProductHistoryModal({ tire, onClose }: Props) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.inventory.history>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    api.inventory.history(tire.id).then(setRows).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [tire.id]);
  const name = [tire.brand, tire.model, tire.size].filter(Boolean).join(' ');

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2 min-w-0"><History size={16} className="text-teal-600" /><div className="min-w-0"><h2 className="font-bold text-slate-800 text-sm">Change history</h2><p className="text-xs text-slate-400 truncate">{name}</p></div></div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg"><X size={16} /></button>
        </div>
        <div className="overflow-auto p-5">
          {loading && <div className="flex justify-center py-8"><Loader2 className="animate-spin text-slate-400" size={20} /></div>}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {!loading && !error && rows.length === 0 && <p className="text-sm text-slate-400 text-center py-6">No recorded changes yet.</p>}
          {rows.length > 0 && (
            <table className="w-full text-xs">
              <thead><tr className="text-left text-slate-500 uppercase tracking-wider"><th className="pb-2 pr-3">When</th><th className="pb-2 pr-3">Field</th><th className="pb-2 pr-3">Change</th><th className="pb-2">By</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="py-2 pr-3 text-slate-500 whitespace-nowrap">{new Date(r.changed_at).toLocaleString()}</td>
                    <td className="py-2 pr-3 font-semibold text-slate-700">{FIELD[r.field] ?? r.field}</td>
                    <td className="py-2 pr-3 text-slate-600 break-words">
                      {r.field === '(created)' ? r.new_value : <><span className="text-slate-400">{r.old_value ?? '—'}</span> → <span className="font-medium text-slate-800">{r.new_value ?? '—'}</span></>}
                    </td>
                    <td className="py-2 text-slate-500">{r.user_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
