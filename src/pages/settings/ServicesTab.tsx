import { useTerms } from '../../lib/businessTypes';
import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Loader2, CheckCircle, X } from 'lucide-react';
import { UserCheck, UserX } from 'lucide-react';
import { api } from '../../api/client';
import { formatCurrency } from '../../lib/utils';
import ErrorBanner from '../../components/ErrorBanner';

export default function ServicesTab() {
  const terms = useTerms();
  const [services, setServices]     = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [editingId, setEditingId]   = useState<number | null>(null);
  const [editValues, setEditValues] = useState<any>({});
  const [savingId, setSavingId]     = useState<number | null>(null);
  const [showForm, setShowForm]     = useState(false);
  const [newService, setNewService] = useState({ name: '', description: '', cost_price: '', sale_price: '', unit: 'job' });
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError]   = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    api.products.list()
      .then(all => setServices((all as any[]).filter(p => p.category === 'Service')))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const startEdit = (s: any) => {
    setEditingId(s.id);
    setEditValues({ name: s.name, description: s.description ?? '', cost_price: s.cost_price ?? '', sale_price: s.sale_price ?? '', unit: s.unit ?? 'job', is_active: s.is_active !== false });
  };

  const saveEdit = async (s: any) => {
    setSavingId(s.id);
    try {
      await api.products.update(s.id, { ...s, ...editValues, category: 'Service', cost_price: Number(editValues.cost_price) || 0, sale_price: Number(editValues.sale_price) || 0 });
      setEditingId(null); load();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save');
    } finally {
      setSavingId(null);
    }
  };

  const handleAdd = async () => {
    if (!newService.name.trim()) { setFormError('Name is required'); return; }
    setFormSaving(true); setFormError('');
    try {
      await api.products.create({ ...newService, category: 'Service', cost_price: Number(newService.cost_price) || 0, sale_price: Number(newService.sale_price) || 0, is_active: true });
      setNewService({ name: '', description: '', cost_price: '', sale_price: '', unit: 'job' });
      setShowForm(false); load();
    } catch (err: any) {
      setFormError(err.message || 'Failed to add service');
    } finally {
      setFormSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try { await api.products.delete(id); load(); }
    catch (err: any) { setFormError(err.message || 'Failed to delete'); }
    finally { setDeletingId(null); }
  };

  const toggleActive = async (s: any) => {
    setSavingId(s.id);
    try { await api.products.update(s.id, { ...s, is_active: !s.is_active }); load(); }
    catch { /* ignore */ }
    finally { setSavingId(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-slate-700">Services Price List</p>
          <p className="text-xs text-slate-400 mt-0.5">Manage services shown in POS and invoices. Inline-edit prices directly in the table.</p>
        </div>
        {!showForm && (
          <button onClick={() => { setShowForm(true); setFormError(''); }}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors">
            <Plus size={14} /> Add Service
          </button>
        )}
      </div>

      <ErrorBanner error={formError} />

      {showForm && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-slate-700">New Service</p>
            <button onClick={() => { setShowForm(false); setFormError(''); }} className="p-1 text-slate-400 hover:text-slate-700 rounded-lg"><X size={14} /></button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">Name <span className="text-red-500">*</span></label>
              <input value={newService.name} onChange={e => setNewService(s => ({ ...s, name: e.target.value }))} placeholder={`e.g. ${terms.serviceExample}`}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Unit</label>
              <input value={newService.unit} onChange={e => setNewService(s => ({ ...s, unit: e.target.value }))} placeholder="job"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">Description</label>
              <input value={newService.description} onChange={e => setNewService(s => ({ ...s, description: e.target.value }))} placeholder="Optional description"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Cost Price</label>
              <input type="number" min={0} value={newService.cost_price} onChange={e => setNewService(s => ({ ...s, cost_price: e.target.value }))} placeholder="0"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white" />
            </div>
          </div>
          <div className="flex items-end justify-between gap-3">
            <div className="flex-1 max-w-[200px]">
              <label className="block text-xs font-semibold text-slate-600 mb-1">Sale Price <span className="text-red-500">*</span></label>
              <input type="number" min={0} value={newService.sale_price} onChange={e => setNewService(s => ({ ...s, sale_price: e.target.value }))} placeholder="0"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white" />
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setShowForm(false); setFormError(''); }}
                className="px-3 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">Cancel</button>
              <button onClick={handleAdd} disabled={formSaving}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-60">
                {formSaving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                {formSaving ? 'Saving…' : 'Add Service'}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-slate-400" /></div>
      ) : services.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-sm">No services yet. Add your first service above.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {['Name / Description', 'Unit', 'Cost', 'Sale Price', 'Status', ''].map(h => (
                  <th key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-2.5 text-left last:text-center">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {services.map(s => {
                const isEditing = editingId === s.id;
                return (
                  <tr key={s.id} className={`hover:bg-slate-50/60 transition-colors group ${!s.is_active ? 'opacity-60' : ''}`}>
                    {isEditing ? (
                      <>
                        <td className="px-3 py-2">
                          <input value={editValues.name} onChange={e => setEditValues((v: any) => ({ ...v, name: e.target.value }))}
                            className="w-full text-xs border border-teal-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-teal-400" />
                          <input value={editValues.description} onChange={e => setEditValues((v: any) => ({ ...v, description: e.target.value }))}
                            placeholder="Description" className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1 mt-1 focus:outline-none" />
                        </td>
                        <td className="px-3 py-2">
                          <input value={editValues.unit} onChange={e => setEditValues((v: any) => ({ ...v, unit: e.target.value }))}
                            className="w-16 text-xs border border-slate-200 rounded-lg px-2 py-1 focus:outline-none" />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" min={0} value={editValues.cost_price} onChange={e => setEditValues((v: any) => ({ ...v, cost_price: e.target.value }))}
                            className="w-24 text-xs border border-slate-200 rounded-lg px-2 py-1 focus:outline-none" />
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" min={0} value={editValues.sale_price} onChange={e => setEditValues((v: any) => ({ ...v, sale_price: e.target.value }))}
                            className="w-24 text-xs border border-teal-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-teal-400 font-semibold" />
                        </td>
                        <td className="px-3 py-2">
                          <label className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={editValues.is_active}
                              onChange={e => setEditValues((v: any) => ({ ...v, is_active: e.target.checked }))}
                              className="accent-teal-600 w-3.5 h-3.5" />
                            <span className="text-xs text-slate-600">Active</span>
                          </label>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => saveEdit(s)} disabled={savingId === s.id}
                              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors" title="Save">
                              {savingId === s.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                            </button>
                            <button onClick={() => setEditingId(null)}
                              className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors" title="Cancel">
                              <X size={13} />
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2.5">
                          <div className="font-medium text-slate-900 text-xs">{s.name}</div>
                          {s.description && <div className="text-[11px] text-slate-400 truncate max-w-[200px]">{s.description}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-500">{s.unit}</td>
                        <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">{formatCurrency(Number(s.cost_price))}</td>
                        <td className="px-3 py-2.5 text-xs font-bold text-teal-700 whitespace-nowrap">{formatCurrency(Number(s.sale_price))}</td>
                        <td className="px-3 py-2.5">
                          <button onClick={() => toggleActive(s)} disabled={savingId === s.id}
                            title={s.is_active ? 'Deactivate' : 'Activate'}
                            className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
                              s.is_active ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                            }`}>
                            {savingId === s.id ? <Loader2 size={9} className="animate-spin" /> : s.is_active ? <UserCheck size={9} /> : <UserX size={9} />}
                            {s.is_active ? 'Active' : 'Inactive'}
                          </button>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => startEdit(s)} className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg" title="Edit">
                              <Pencil size={12} />
                            </button>
                            <button onClick={() => handleDelete(s.id)} disabled={deletingId === s.id}
                              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Delete">
                              {deletingId === s.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
