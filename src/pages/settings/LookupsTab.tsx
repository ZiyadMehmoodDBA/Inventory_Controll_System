import { useState, useEffect } from 'react';
import { Plus, Pencil, Trash2, Loader2, CheckCircle, X, GripVertical } from 'lucide-react';
import { api } from '../../api/client';
import ErrorBanner from '../../components/ErrorBanner';

export default function LookupsTab() {
  const [types, setTypes]           = useState<any[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [newName, setNewName]       = useState('');
  const [adding, setAdding]         = useState(false);
  const [addError, setAddError]     = useState('');
  const [editId, setEditId]         = useState<number | null>(null);
  const [editName, setEditName]     = useState('');
  const [saving, setSaving]         = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState('');

  const load = () => {
    setLoadingList(true);
    api.lookups.tireTypes().then(setTypes).catch(() => {}).finally(() => setLoadingList(false));
  };

  useEffect(load, []);

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setAdding(true); setAddError('');
    try { await api.lookups.addTireType(name); setNewName(''); load(); }
    catch (err: any) { setAddError(err.message || 'Failed to add type'); }
    finally { setAdding(false); }
  };

  const startEdit = (t: any) => { setEditId(t.id); setEditName(t.name); setDeleteError(''); };

  const saveEdit = async (id: number) => {
    const name = editName.trim();
    if (!name) return;
    setSaving(id);
    try { await api.lookups.updateTireType(id, { name }); setEditId(null); load(); }
    catch (err: any) { setAddError(err.message || 'Failed to update'); }
    finally { setSaving(null); }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id); setDeleteError('');
    try { await api.lookups.deleteTireType(id); load(); }
    catch (err: any) { setDeleteError(err.message || 'Failed to delete'); }
    finally { setDeletingId(null); }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-bold text-slate-700 mb-1">Tire Types</p>
        <p className="text-xs text-slate-400 mb-4">
          These values appear in the "Tire Type" dropdown when adding or editing inventory items.
        </p>

        <div className="flex gap-2 mb-4">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAdd())}
            placeholder="New tire type name..."
            className="flex-1 text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
          />
          <button onClick={handleAdd} disabled={adding || !newName.trim()}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-50 transition-colors">
            {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Add
          </button>
        </div>

        <ErrorBanner error={addError} className="mb-3" />
        <ErrorBanner error={deleteError} className="mb-3" />

        {loadingList ? (
          <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-slate-400" /></div>
        ) : types.length === 0 ? (
          <div className="text-center py-8 text-slate-400 text-sm">No tire types yet</div>
        ) : (
          <div className="space-y-2">
            {types.map(t => (
              <div key={t.id}
                className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-3 py-2.5 group hover:border-slate-300 transition-colors">
                <GripVertical size={14} className="text-slate-300 flex-shrink-0" />

                {editId === t.id ? (
                  <>
                    <input
                      autoFocus value={editName} onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveEdit(t.id); if (e.key === 'Escape') setEditId(null); }}
                      className="flex-1 text-sm border border-teal-400 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                    <button onClick={() => saveEdit(t.id)} disabled={saving === t.id}
                      className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors">
                      {saving === t.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                    </button>
                    <button onClick={() => setEditId(null)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors">
                      <X size={13} />
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm font-medium text-slate-700">{t.name}</span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => startEdit(t)}
                        className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors" title="Rename">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => handleDelete(t.id)} disabled={deletingId === t.id}
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                        {deletingId === t.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
