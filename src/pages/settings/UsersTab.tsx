import { useState, useEffect } from 'react';
import { Plus, Pencil, Loader2, CheckCircle, X, ShieldCheck, Eye, EyeOff, UserCheck, UserX } from 'lucide-react';
import { api } from '../../api/client';
import ErrorBanner from '../../components/ErrorBanner';

const ROLES = [
  { value: 'org_admin',      label: 'Admin',          color: 'bg-purple-50 text-purple-700 border border-purple-100' },
  { value: 'branch_manager', label: 'Branch Manager', color: 'bg-teal-50 text-teal-700 border border-teal-100' },
  { value: 'staff',          label: 'Staff',          color: 'bg-slate-100 text-slate-600 border border-slate-200' },
  { value: 'purchasing',     label: 'Purchasing',     color: 'bg-amber-50 text-amber-700 border border-amber-100' },
];

const EMPTY_USER = { name: '', email: '', phone: '', password: '', role: '', branch_id: '' };   // role = id of an access role

function getCurrentUserId(): number | null {
  try {
    const token = localStorage.getItem('tunegen_at');
    if (!token) return null;
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.userId ?? null;
  } catch { return null; }
}

export default function UsersTab() {
  const currentUserId = getCurrentUserId();

  const [users, setUsers]         = useState<any[]>([]);
  const [branches, setBranches]   = useState<any[]>([]);
  const [roles, setRoles]         = useState<any[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showForm, setShowForm]   = useState(false);
  const [editUser, setEditUser]   = useState<any>(null);
  const [form, setForm]           = useState({ ...EMPTY_USER });
  const [showPw, setShowPw]       = useState(false);
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState('');
  const [togglingId, setTogglingId] = useState<number | null>(null);
  const [resetPwId, setResetPwId] = useState<number | null>(null);
  const [newPw, setNewPw]         = useState('');
  const [resetSaving, setResetSaving] = useState(false);
  const [resetError, setResetError]   = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([api.users.list(), api.branches.list(), api.access.roles()])
      .then(([u, b, r]) => { setUsers(u); setBranches(b); setRoles(r); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const setF = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const openAdd = () => {
    const dflt = roles.find((r: any) => r.base_role === 'staff' && r.is_builtin);
    setForm({ ...EMPTY_USER, role: dflt ? String(dflt.id) : '' }); setEditUser(null); setFormError(''); setShowPw(false); setShowForm(true);
  };

  const openEdit = (u: any) => {
    const current = roles.find((r: any) => (u.access_role_id ? r.id === u.access_role_id : r.is_builtin && r.base_role === u.role));
    setForm({ name: u.name ?? '', email: u.email ?? '', phone: u.phone ?? '', password: '', role: current ? String(current.id) : '', branch_id: u.branch_id ?? '' });
    setEditUser(u); setFormError(''); setShowPw(false); setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditUser(null); setFormError(''); };

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError('Name is required'); return; }
    if (!form.email.includes('@')) { setFormError('Valid email required'); return; }
    if (!editUser && (!form.password || form.password.length < 8)) { setFormError('Password must be at least 8 characters'); return; }
    setSaving(true); setFormError('');
    try {
      if (!form.role) { setFormError('Choose a role'); setSaving(false); return; }
      const payload = { name: form.name, phone: form.phone, access_role_id: Number(form.role), branch_id: form.branch_id ? Number(form.branch_id) : null };
      if (editUser) await api.users.update(editUser.id, payload);
      else          await api.users.create({ ...payload, email: form.email, password: form.password });
      closeForm(); load();
    } catch (err: any) {
      setFormError(err.message || 'Failed to save user');
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (u: any) => {
    setTogglingId(u.id);
    try { await api.users.setStatus(u.id, !u.is_active); load(); }
    catch { /* ignore */ }
    finally { setTogglingId(null); }
  };

  const handleResetPassword = async (userId: number) => {
    if (!newPw || newPw.length < 8) { setResetError('Password must be at least 8 characters'); return; }
    setResetSaving(true); setResetError('');
    try { await api.users.resetPassword(userId, newPw); setResetPwId(null); setNewPw(''); }
    catch (err: any) { setResetError(err.message || 'Failed to reset password'); }
    finally { setResetSaving(false); }
  };

  const roleInfo = (role: string) => ROLES.find(r => r.value === role) ?? { label: role, color: 'bg-slate-100 text-slate-600 border border-slate-200' };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-slate-700">User Management</p>
          <p className="text-xs text-slate-400 mt-0.5">Add staff accounts, assign roles and branches, activate or deactivate access.</p>
        </div>
        {!showForm && (
          <button onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors">
            <Plus size={14} /> Add User
          </button>
        )}
      </div>

      {showForm && (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-slate-700 flex items-center gap-2">
              <ShieldCheck size={15} className="text-teal-500" />
              {editUser ? 'Edit User' : 'New User Account'}
            </p>
            <button onClick={closeForm} className="p-1 text-slate-400 hover:text-slate-700 rounded-lg"><X size={14} /></button>
          </div>

          <ErrorBanner error={formError} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Full Name <span className="text-red-500">*</span></label>
              <input value={form.name} onChange={e => setF('name', e.target.value)} placeholder="Muhammad Ahmed"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Email {!editUser && <span className="text-red-500">*</span>}</label>
              <input value={form.email} onChange={e => setF('email', e.target.value)} placeholder="ahmed@company.pk"
                disabled={!!editUser} type="email"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white disabled:bg-slate-100 disabled:text-slate-400" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Phone</label>
              <input value={form.phone} onChange={e => setF('phone', e.target.value)} placeholder="+92-300-1234567"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white" />
            </div>
            {!editUser && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Password <span className="text-red-500">*</span></label>
                <div className="relative">
                  <input value={form.password} onChange={e => setF('password', e.target.value)} placeholder="Min 8 characters"
                    type={showPw ? 'text' : 'password'}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 pr-9 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white" />
                  <button type="button" onClick={() => setShowPw(v => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Role <span className="text-red-500">*</span></label>
              <select value={form.role} onChange={e => setF('role', e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white">
                {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}{r.is_builtin ? '' : ' (custom)'}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Branch</label>
              <select value={form.branch_id} onChange={e => setF('branch_id', e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-400 bg-white">
                <option value="">All branches (org-wide)</option>
                {branches.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={closeForm}
              className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">Cancel</button>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-60 min-w-24 justify-center">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />}
              {saving ? 'Saving…' : editUser ? 'Update User' : 'Create User'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-slate-400" /></div>
      ) : users.length === 0 ? (
        <div className="text-center py-10 text-slate-400 text-sm">No users found.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {['Name', 'Email', 'Role', 'Branch', 'Status', ''].map(h => (
                  <th key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 py-2.5 text-left last:text-center">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.map((u: any) => {
                const ri = roleInfo(u.role);
                const isSelf = u.id === currentUserId;
                return (
                  <tr key={u.id} className={`hover:bg-slate-50/60 transition-colors group ${!u.is_active ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-teal-500 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                          {(u.name ?? '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-slate-900">{u.name}</p>
                          {u.phone && <p className="text-[10px] text-slate-400">{u.phone}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 max-w-[160px]">
                      <span className="truncate block">{u.email}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${ri.color}`}>{u.role_name ?? ri.label}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-500">{u.branch_name ?? <span className="text-slate-300">All</span>}</td>
                    <td className="px-3 py-2.5">
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${u.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        {u.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={() => openEdit(u)} title="Edit"
                          className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg">
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => { setResetPwId(u.id); setNewPw(''); setResetError(''); }} title="Reset password"
                          className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg">
                          <ShieldCheck size={12} />
                        </button>
                        {!isSelf && (
                          <button onClick={() => toggleStatus(u)} disabled={togglingId === u.id}
                            title={u.is_active ? 'Deactivate' : 'Activate'}
                            className={`p-1.5 rounded-lg transition-colors ${u.is_active ? 'text-slate-400 hover:text-red-600 hover:bg-red-50' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'}`}>
                            {togglingId === u.id ? <Loader2 size={12} className="animate-spin" /> : u.is_active ? <UserX size={12} /> : <UserCheck size={12} />}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {resetPwId !== null && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <ShieldCheck size={15} className="text-amber-500" /> Reset Password
              </h3>
              <button onClick={() => { setResetPwId(null); setNewPw(''); setResetError(''); }}
                className="p-1 text-slate-400 hover:text-slate-700 rounded-lg"><X size={14} /></button>
            </div>
            <p className="text-xs text-slate-500">
              Set a new password for <strong>{users.find((u: any) => u.id === resetPwId)?.name}</strong>.
            </p>
            <ErrorBanner error={resetError} />
            <div className="relative">
              <input value={newPw} onChange={e => setNewPw(e.target.value)} type={showPw ? 'text' : 'password'}
                placeholder="New password (min 8 characters)"
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 pr-9 focus:outline-none focus:ring-2 focus:ring-amber-400" />
              <button type="button" onClick={() => setShowPw(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setResetPwId(null); setNewPw(''); setResetError(''); }}
                className="px-4 py-2 text-sm font-semibold text-slate-600 bg-white border border-slate-200 rounded-xl hover:bg-slate-50">Cancel</button>
              <button onClick={() => handleResetPassword(resetPwId!)} disabled={resetSaving}
                className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-amber-500 rounded-xl hover:bg-amber-600 disabled:opacity-60">
                {resetSaving ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                {resetSaving ? 'Saving…' : 'Reset Password'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
