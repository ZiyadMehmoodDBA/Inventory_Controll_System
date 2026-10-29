import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, MapPin, Pencil, Plus, Star, X } from 'lucide-react';
import { api } from '../api/client';

interface Loc { id: number; name: string; code: string; is_default: boolean; is_active: boolean; kind: string; units: number; items: number }
const KIND_LABEL: Record<string, string> = { normal: 'Normal (available)', quarantine: 'Quarantine (restricted)', damaged: 'Damaged (restricted)' };
interface Props { onClose: () => void; onChanged: () => void }

export default function LocationsModal({ onClose, onChanged }: Props) {
  const [locs, setLocs]       = useState<Loc[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName]       = useState('');
  const [code, setCode]       = useState('');
  const [kind, setKind]       = useState('normal');
  const [editId, setEditId]   = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError]     = useState('');

  const load = useCallback(async () => {
    try { setLocs(await api.inventory.locations()); }
    catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); onChanged(); } catch (e: any) { setError(e.message); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between p-5 pb-3 border-b border-slate-100">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center"><MapPin size={18} className="text-teal-600" /></div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">Stock Locations</h3>
              <p className="text-xs text-slate-500">Warehouses, shelves or stores in this branch. Sales draw from the default location.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg text-slate-400"><X size={16} /></button>
        </div>

        <form className="flex gap-2 px-5 pt-4" onSubmit={e => { e.preventDefault(); if (name.trim()) run(async () => { await api.inventory.createLocation(name.trim(), code.trim() || undefined, kind); setName(''); setCode(''); setKind('normal'); }); }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="New location name" maxLength={100}
            className="flex-1 min-w-0 text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
          <input value={code} onChange={e => setCode(e.target.value)} placeholder="Code" maxLength={30}
            className="w-24 text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 uppercase" />
          <select value={kind} onChange={e => setKind(e.target.value)} title="Location type" className="w-28 text-xs border border-slate-200 rounded-xl px-2 py-2 bg-slate-50">
            <option value="normal">Normal</option><option value="quarantine">Quarantine</option><option value="damaged">Damaged</option>
          </select>
          <button type="submit" disabled={!name.trim()} className="flex items-center gap-1 bg-teal-600 text-white text-sm font-medium px-3 rounded-xl hover:bg-teal-700 disabled:opacity-50"><Plus size={14} /> Add</button>
        </form>

        {error && <p className="mx-5 mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

        <div className="overflow-auto flex-1 divide-y divide-slate-100 mt-3">
          {loading && <div className="flex justify-center py-6"><Loader2 size={18} className="animate-spin text-slate-400" /></div>}
          {locs.map(l => (
            <div key={l.id} className={`flex items-center gap-2 px-5 py-3 ${l.is_active ? '' : 'opacity-60'}`}>
              {editId === l.id ? (
                <>
                  <input autoFocus value={editName} onChange={e => setEditName(e.target.value)} maxLength={100}
                    className="flex-1 text-sm border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-teal-500" />
                  <button title="Save" onClick={() => run(async () => { await api.inventory.updateLocation(l.id, { name: editName.trim() }); setEditId(null); })} className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg"><Check size={15} /></button>
                  <button title="Cancel" onClick={() => setEditId(null)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg"><X size={15} /></button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">
                      {l.name} <span className="font-mono text-[11px] text-slate-400 font-normal">{l.code}</span>
                      {l.is_default && <span className="ml-2 text-[10px] font-bold text-teal-700 bg-teal-50 rounded-full px-2 py-0.5 align-middle">DEFAULT</span>}
                      {!l.is_active && <span className="ml-2 text-[10px] font-bold text-slate-500 bg-slate-100 rounded-full px-2 py-0.5 align-middle">INACTIVE</span>}
                      {l.kind !== 'normal' && <span className="ml-2 text-[10px] font-bold text-amber-700 bg-amber-50 rounded-full px-2 py-0.5 align-middle uppercase">{l.kind}</span>}
                    </p>
                    <p className="text-xs text-slate-500">{l.units} unit{l.units === 1 ? '' : 's'} · {l.items} item{l.items === 1 ? '' : 's'}</p>
                  </div>
                  {!l.is_default && (
                    <select value={l.kind} onChange={e => run(() => api.inventory.updateLocation(l.id, { kind: e.target.value }))} title="Location type — restricted stock is on hand but never available" className="text-[11px] border border-slate-200 rounded-lg px-1 py-1 bg-white max-w-[6.5rem]">
                      {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v.split(' ')[0]}</option>)}
                    </select>
                  )}
                  {!l.is_default && l.is_active && l.kind === 'normal' && (
                    <button title="Make default (sales location)" onClick={() => run(() => api.inventory.updateLocation(l.id, { is_default: true }))} className="p-1.5 text-slate-400 hover:text-amber-500 hover:bg-amber-50 rounded-lg"><Star size={14} /></button>
                  )}
                  <button title="Rename" onClick={() => { setEditId(l.id); setEditName(l.name); }} className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg"><Pencil size={13} /></button>
                  <button onClick={() => run(() => api.inventory.updateLocation(l.id, { is_active: !l.is_active }))}
                    className="text-xs font-medium text-slate-500 hover:text-slate-800 px-2 py-1 rounded-lg hover:bg-slate-100">{l.is_active ? 'Deactivate' : 'Activate'}</button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
