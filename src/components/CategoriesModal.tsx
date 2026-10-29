import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Pencil, Plus, Tags, Trash2, X } from 'lucide-react';
import { api } from '../api/client';

interface Cat { id: number; name: string; parent_id: number | null; item_count: number }
interface Props { onClose: () => void; onChanged: () => void }

export default function CategoriesModal({ onClose, onChanged }: Props) {
  const [cats, setCats]       = useState<Cat[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName]       = useState('');
  const [parent, setParent]   = useState('');
  const [editParent, setEditParent] = useState('');
  const [editId, setEditId]   = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    try { setCats(await api.inventory.categories()); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Top-level categories first, each followed by its sub-categories.
  const tops = cats.filter(c => !c.parent_id);
  const ordered: Cat[] = tops.flatMap(t => [t, ...cats.filter(c => c.parent_id === t.id)]);
  const orphans = cats.filter(c => c.parent_id && !tops.some(t => t.id === c.parent_id));
  const rows = [...ordered, ...orphans];

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); onChanged(); } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><Tags size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Item Categories</h3>
              <p className="text-xs text-slate-500">Group items for reporting and filtering.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>

        <form className="flex gap-2 px-5 pt-4" onSubmit={e => { e.preventDefault(); if (name.trim()) run(async () => { await api.inventory.createCategory(name.trim(), parent ? Number(parent) : null); setName(''); }); }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="New category name" maxLength={100}
            className="flex-1 text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
          <select value={parent} onChange={e => setParent(e.target.value)} title="Parent category" className="text-sm border border-slate-200 rounded-xl px-2 py-2 bg-slate-50 max-w-[8.5rem]">
            <option value="">Top level</option>
            {tops.map(t => <option key={t.id} value={t.id}>in {t.name}</option>)}
          </select>
          <button type="submit" disabled={!name.trim()} className="flex items-center gap-1 bg-teal-600 text-white text-sm font-medium px-3 rounded-xl hover:bg-teal-700 disabled:opacity-50"><Plus size={14} /> Add</button>
        </form>

        {error && <p className="mx-5 mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

        <div className="overflow-auto flex-1 divide-y divide-slate-100 mt-3">
          {loading && <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin text-slate-400" /></div>}
          {!loading && cats.length === 0 && <p className="py-8 text-center text-sm text-slate-400">No categories yet.</p>}
          {rows.map(c => (
            <div key={c.id} className={'flex items-center gap-2 py-2.5 pr-5 ' + (c.parent_id ? 'pl-10' : 'pl-5')}>
              {editId === c.id ? (
                <>
                  <input autoFocus value={editName} onChange={e => setEditName(e.target.value)} maxLength={100}
                    className="flex-1 text-sm border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-500" />
                  <select value={editParent} onChange={e => setEditParent(e.target.value)} title="Parent category" className="text-xs border border-slate-200 rounded-lg px-1 py-1 bg-white max-w-[7rem]">
                    <option value="">Top level</option>
                    {tops.filter(t => t.id !== c.id).map(t => <option key={t.id} value={t.id}>in {t.name}</option>)}
                  </select>
                  <button title="Save" onClick={() => run(async () => { await api.inventory.renameCategory(c.id, editName.trim(), editParent ? Number(editParent) : null); setEditId(null); })} className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg"><Check size={15} /></button>
                  <button title="Cancel" onClick={() => setEditId(null)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg"><X size={15} /></button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm text-slate-800">{c.parent_id ? <span className="text-slate-300 mr-1">↳</span> : null}{c.name}</span>
                  <span className="text-xs text-slate-400">{c.item_count} item{c.item_count === 1 ? '' : 's'}</span>
                  <button title="Rename" onClick={() => { setEditId(c.id); setEditName(c.name); setEditParent(c.parent_id ? String(c.parent_id) : ''); }} className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg"><Pencil size={13} /></button>
                  <button title="Delete" onClick={() => run(() => api.inventory.deleteCategory(c.id))} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"><Trash2 size={13} /></button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
