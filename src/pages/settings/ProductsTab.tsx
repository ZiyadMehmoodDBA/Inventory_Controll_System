import { useTerms } from '../../lib/businessTypes';
import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Loader2, CheckCircle, X, AlertCircle } from 'lucide-react';
import { api } from '../../api/client';
import { formatCurrency } from '../../lib/utils';
import ErrorBanner from '../../components/ErrorBanner';

const EMPTY_PRODUCT = {
  code: '', name: '', description: '', category: '', unit: 'pcs',
  cost_price: '', sale_price: '', is_active: true,
};

export default function ProductsTab() {
  const terms = useTerms();
  const [products, setProducts]       = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [showForm, setShowForm]       = useState(false);
  const [editId, setEditId]           = useState<number | null>(null);
  const [form, setForm]               = useState({ ...EMPTY_PRODUCT });
  const [saving, setSaving]           = useState(false);
  const [formError, setFormError]     = useState('');
  const [deletingId, setDeletingId]   = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const load = () => {
    setLoadingList(true);
    api.products.list()
      .then(setProducts)
      .catch(() => {})
      .finally(() => setLoadingList(false));
  };

  useEffect(load, []);

  const setF = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const openAdd = () => {
    setForm({ ...EMPTY_PRODUCT }); setEditId(null); setFormError(''); setShowForm(true);
  };

  const openEdit = (p: any) => {
    setForm({
      code: p.code ?? '', name: p.name ?? '', description: p.description ?? '',
      category: p.category ?? '', unit: p.unit ?? 'pcs',
      cost_price: p.cost_price ?? '', sale_price: p.sale_price ?? '',
      is_active: p.is_active !== false,
    });
    setEditId(p.id); setFormError(''); setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditId(null); };

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError('Name is required.'); return; }
    setSaving(true); setFormError('');
    try {
      const payload = { ...form, cost_price: Number(form.cost_price) || 0, sale_price: Number(form.sale_price) || 0 };
      if (editId) await api.products.update(editId, payload);
      else        await api.products.create(payload);
      closeForm(); load();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save product');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id); setDeleteError('');
    try { await api.products.delete(id); load(); }
    catch (err: any) { setDeleteError(err.message || 'Failed to delete'); }
    finally { setDeletingId(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-slate-700">Products / Goods Catalog</p>
          <p className="text-xs text-slate-400 mt-0.5">Services, accessories, and other items available on invoices, sales, and purchase orders.</p>
        </div>
        {!showForm && (
          <button onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors">
            <Plus size={14} /> Add Product
          </button>
        )}
      </div>

      {showForm && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-bold text-slate-700">{editId ? 'Edit Product' : 'New Product'}</p>
            <button onClick={closeForm} className="p-1 text-slate-400 hover:text-slate-700 rounded-lg"><X size={15} /></button>
          </div>

          {formError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">
              <AlertCircle size={13} /> {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Code</label>
              <input value={form.code} onChange={e => setF('code', e.target.value)} placeholder="e.g. SVC-BAL"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-600 mb-1">Name <span className="text-red-500">*</span></label>
              <input value={form.name} onChange={e => setF('name', e.target.value)} placeholder={`e.g. ${terms.serviceExample}`}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Category</label>
              <input value={form.category} onChange={e => setF('category', e.target.value)} placeholder="e.g. Service"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Unit</label>
              <input value={form.unit} onChange={e => setF('unit', e.target.value)} placeholder="pcs / hr / set"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
            </div>
            <div className="flex items-end pb-0.5">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={form.is_active as boolean}
                  onChange={e => setF('is_active', e.target.checked)}
                  className="w-4 h-4 rounded accent-blue-600" />
                <span className="text-sm font-medium text-slate-700">Active</span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Cost Price</label>
              <input type="number" min={0} step="0.01" value={form.cost_price} onChange={e => setF('cost_price', e.target.value)} placeholder="0.00"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Sale Price</label>
              <input type="number" min={0} step="0.01" value={form.sale_price} onChange={e => setF('sale_price', e.target.value)} placeholder="0.00"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Description</label>
            <input value={form.description} onChange={e => setF('description', e.target.value)} placeholder="Optional description..."
              className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white" />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={closeForm}
              className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">Cancel</button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-60 transition-colors min-w-24 justify-center">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
              {saving ? 'Saving...' : editId ? 'Update' : 'Add Product'}
            </button>
          </div>
        </div>
      )}

      <ErrorBanner error={deleteError} />

      {loadingList ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-slate-400" /></div>
      ) : products.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-sm">No products yet. Add your first product above.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {['Code', 'Name', 'Category', 'Unit', 'Cost', 'Sale', 'Status', ''].map(h => (
                  <th key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-2.5 text-left last:text-center">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {products.map(p => (
                <tr key={p.id} className="hover:bg-slate-50/60 transition-colors group">
                  <td className="px-3 py-2.5 text-xs font-mono text-slate-500">{p.code || '—'}</td>
                  <td className="px-3 py-2.5 font-medium text-slate-900 max-w-[160px]">
                    <div className="truncate">{p.name}</div>
                    {p.description && <div className="text-xs text-slate-400 truncate">{p.description}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{p.category || '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-600">{p.unit}</td>
                  <td className="px-3 py-2.5 text-xs text-slate-700 whitespace-nowrap">{formatCurrency(Number(p.cost_price))}</td>
                  <td className="px-3 py-2.5 text-xs font-semibold text-slate-900 whitespace-nowrap">{formatCurrency(Number(p.sale_price))}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${p.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {p.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => openEdit(p)}
                        className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors" title="Edit">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => handleDelete(p.id)} disabled={deletingId === p.id}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                        {deletingId === p.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
