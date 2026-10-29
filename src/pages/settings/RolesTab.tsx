import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, Loader2, Lock, Plus, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import ErrorBanner from '../../components/ErrorBanner';
import { loadAccess } from '../../lib/permissions';

interface Perm { code: string; group: string; label: string; description: string; sensitive: boolean }
interface Role { id: number; name: string; base_role: string; description: string | null; permissions: string[]; approval_limit: number | null; is_builtin: boolean; locked: boolean; users: number }
const field = 'w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white';
const btn = 'flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-xl disabled:opacity-60';

// Roles and permissions: who may do what. The API enforces every permission; this screen only edits the definitions.
export default function RolesTab() {
  const [perms, setPerms] = useState<Perm[]>([]);
  const [bases, setBases] = useState<{ key: string; name: string }[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [reasons, setReasons] = useState<{ code: string; label: string }[]>([]);
  const [restricted, setRestricted] = useState<string[]>([]);
  const [sel, setSel] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState({ name: '', description: '', base_role: 'staff', permissions: [] as string[], approval_limit: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [matrix, setMatrix] = useState(false);

  const load = async (keep?: number) => {
    try {
      const [c, r, p] = await Promise.all([api.access.catalogue(), api.access.roles(), api.access.policy()]);
      setPerms(c.permissions); setBases(c.base_roles); setRoles(r); setReasons(p.reasons); setRestricted(p.restricted_reasons);
      if (keep !== undefined) pick(keep, r);
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: number | 'new', list: Role[] = roles) => {
    setError(''); setNote(''); setSel(id);
    if (id === 'new') { setDraft({ name: '', description: '', base_role: 'staff', permissions: [], approval_limit: '' }); return; }
    const r = list.find(x => x.id === id);
    if (r) setDraft({ name: r.name, description: r.description ?? '', base_role: r.base_role, permissions: [...r.permissions], approval_limit: r.approval_limit == null ? '' : String(r.approval_limit) });
  };
  const role = typeof sel === 'number' ? roles.find(r => r.id === sel) : undefined;
  const locked = !!role?.locked;
  const groups = useMemo(() => { const g = new Map<string, Perm[]>(); for (const p of perms) g.set(p.group, [...(g.get(p.group) ?? []), p]); return [...g.entries()]; }, [perms]);
  const toggle = (code: string) => setDraft(d => ({ ...d, permissions: d.permissions.includes(code) ? d.permissions.filter(c => c !== code) : [...d.permissions, code] }));

  const run = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key); setError(''); setNote('');
    try { const out = await fn(); setNote(ok); await loadAccess(); return out; } catch (e: any) { setError(e.message); return null; } finally { setBusy(''); }
  };
  const save = async () => {
    const body = { name: draft.name, description: draft.description, permissions: draft.permissions, approval_limit: draft.approval_limit === '' ? null : Number(draft.approval_limit) };
    if (sel === 'new') {
      const out = await run('save', () => api.access.createRole({ ...body, base_role: draft.base_role }), 'Role created.');
      if (out) await load(out.id);
    } else if (role) {
      const out = await run('save', () => api.access.updateRole(role.id, body), 'Role saved. It applies to its users immediately.');
      if (out) await load(role.id);
    }
  };
  const reset = async () => { if (role && window.confirm(`Restore ${role.name} to its default permissions?`)) { const out = await run('reset', () => api.access.resetRole(role.id), 'Restored to defaults.'); if (out) await load(role.id); } };
  const remove = async () => { if (role && window.confirm(`Delete the role ${role.name}?`)) { const out = await run('delete', () => api.access.deleteRole(role.id), 'Role deleted.'); if (out) { setSel(null); await load(); } } };
  const saveRestricted = async () => { await run('policy', () => api.access.savePolicy(restricted), 'Restricted reasons saved.'); };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm font-bold text-slate-700">Roles &amp; permissions</p>
        <p className="text-xs text-slate-400 mt-0.5">Decide what each role can do. Every permission is enforced by the server; hiding a button is only a convenience. A change applies to the role&apos;s users straight away.</p>
      </div>
      <ErrorBanner error={error} />
      {note && <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-center gap-1.5" role="status"><CheckCircle size={12} />{note}</p>}

      <div className="grid md:grid-cols-[260px_1fr] gap-4">
        <div className="space-y-2" aria-label="Roles">
          {roles.map(r => (
            <button key={r.id} onClick={() => pick(r.id)} className={`w-full text-left border rounded-xl px-3 py-2.5 transition-colors ${sel === r.id ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
              <p className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">{r.name}{r.locked && <Lock size={11} className="text-slate-400" />}</p>
              <p className="text-[11px] text-slate-500">{r.is_builtin ? 'Built-in' : 'Custom'} · {r.users} user(s) · {r.permissions.length} permission(s){r.approval_limit != null ? ` · limit ${r.approval_limit.toLocaleString()}` : ''}</p>
            </button>
          ))}
          <button onClick={() => pick('new')} className={`${btn} w-full justify-center text-teal-700 bg-white border border-dashed border-teal-300 hover:bg-teal-50`}><Plus size={14} />New custom role</button>
          <button onClick={() => setMatrix(m => !m)} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-800 py-1">{matrix ? 'Hide' : 'Show'} role comparison</button>
        </div>

        <div>
          {sel === null && <p className="text-sm text-slate-400 py-10 text-center">Choose a role to see and change what it can do.</p>}
          {sel !== null && (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-4">
              <p className="text-sm font-bold text-slate-700 flex items-center gap-2"><ShieldCheck size={15} className="text-teal-500" />{sel === 'new' ? 'New custom role' : role?.name}</p>
              {locked && <p className="text-xs text-slate-500">The administrator role always has every permission, so nobody can lock the organisation out. It cannot be changed.</p>}
              {role && <p className="text-xs text-slate-500">{role.description}</p>}
              {(sel === 'new' || (role && !role.is_builtin)) && (
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="text-xs font-semibold text-slate-600">Role name<input aria-label="Role name" value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} className={`${field} mt-1`} placeholder="e.g. Night shift supervisor" /></label>
                  <label className="text-xs font-semibold text-slate-600">Works like<select aria-label="Base role" disabled={sel !== 'new'} value={draft.base_role} onChange={e => setDraft(d => ({ ...d, base_role: e.target.value }))} className={`${field} mt-1`}>
                    {bases.filter(b => b.key !== 'org_admin').map(b => <option key={b.key} value={b.key}>{b.name}</option>)}</select></label>
                  <label className="text-xs font-semibold text-slate-600 sm:col-span-2">Description<input value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} className={`${field} mt-1`} /></label>
                </div>
              )}
              {sel === 'new' && <p className="text-[11px] text-slate-500">&quot;Works like&quot; sets how the role behaves in places that predate permissions (a manager can see the whole branch, staff can only use locations they are given). Tick the permissions below.</p>}

              <div className="space-y-3">
                {groups.map(([g, list]) => (
                  <fieldset key={g} className="bg-white border border-slate-200 rounded-xl p-3">
                    <legend className="text-xs font-bold text-slate-700 px-1">{g}</legend>
                    <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1.5">
                      {list.map(p => (
                        <label key={p.code} className="flex items-start gap-2 text-xs text-slate-700" title={p.description}>
                          <input type="checkbox" className="mt-0.5" disabled={locked} checked={locked || draft.permissions.includes(p.code)} onChange={() => toggle(p.code)} aria-label={p.label} />
                          <span><span className="font-medium">{p.label}</span>{p.sensitive && <span className="ml-1 text-[10px] font-bold text-amber-600">SENSITIVE</span>}<span className="block text-[11px] text-slate-400 leading-snug">{p.description}</span></span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>

              {!locked && (
                <label className="block text-xs font-semibold text-slate-600">Approval limit (value of one adjustment)
                  <input aria-label="Approval limit" type="number" min={0} value={draft.approval_limit} onChange={e => setDraft(d => ({ ...d, approval_limit: e.target.value }))} className={`${field} mt-1 max-w-xs`} placeholder="No limit" />
                  <span className="block text-[11px] font-normal text-slate-400 mt-1">The most this role may post or approve in one adjustment, at item cost. Anything above needs a higher authority. Leave empty for no limit.</span>
                </label>
              )}

              {!locked && (
                <div className="flex flex-wrap justify-end gap-2">
                  {role && !role.is_builtin && <button onClick={remove} disabled={!!busy} className={`${btn} text-red-600 bg-white border border-red-200 hover:bg-red-50`}><Trash2 size={13} />Delete</button>}
                  {role?.is_builtin && <button onClick={reset} disabled={!!busy} className={`${btn} text-slate-600 bg-white border border-slate-200 hover:bg-slate-50`}><RotateCcw size={13} />Restore defaults</button>}
                  <button onClick={save} disabled={!!busy} className={`${btn} text-white bg-teal-600 hover:bg-teal-700 min-w-28 justify-center`}>{busy === 'save' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}{sel === 'new' ? 'Create role' : 'Save role'}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {matrix && (
        <div className="overflow-auto border border-slate-200 rounded-xl">
          <table className="w-full text-xs">
            <thead className="bg-slate-50"><tr><th className="text-left px-3 py-2">Permission</th>{roles.map(r => <th key={r.id} className="px-2 py-2 text-center font-semibold">{r.name}</th>)}</tr></thead>
            <tbody>{perms.map(p => (
              <tr key={p.code} className="border-t border-slate-100"><td className="px-3 py-1.5">{p.label}</td>{roles.map(r => <td key={r.id} className="text-center">{r.permissions.includes(p.code) ? <span className="text-emerald-600 font-bold" aria-label="allowed">✓</span> : <span className="text-slate-300">–</span>}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
        <div>
          <p className="text-sm font-bold text-slate-700">Restricted adjustments</p>
          <p className="text-xs text-slate-400">These reasons can only be posted or approved by a role with &quot;approve restricted adjustments&quot; (administrators by default). Everyone else raises a request that waits for that authority.</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1.5">
          {reasons.map(r => (
            <label key={r.code} className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={restricted.includes(r.code)} onChange={() => setRestricted(l => (l.includes(r.code) ? l.filter(c => c !== r.code) : [...l, r.code]))} aria-label={`Restrict ${r.label}`} />{r.label}
            </label>
          ))}
        </div>
        <div className="flex justify-end"><button onClick={saveRestricted} disabled={!!busy} className={`${btn} text-white bg-teal-600 hover:bg-teal-700`}>{busy === 'policy' ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}Save restricted reasons</button></div>
      </div>
    </div>
  );
}
