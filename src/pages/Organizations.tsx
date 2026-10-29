import { useState, useEffect, useCallback } from 'react';
import {
  Building2, GitBranch, Plus, Edit2, Trash2, CheckCircle,
  Loader2, X, Phone, Mail, MapPin, Tag,
} from 'lucide-react';
import ErrorBanner from '../components/ErrorBanner';
import { api } from '../api/client';
import EmptyState from '../components/EmptyState';

interface Branch {
  id: number;
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  is_active: boolean;
}

interface OrgDetail {
  id: number;
  name: string;
  code: string;
  type: string;
  address: string;
  phone: string;
  email: string;
  currency: string;
  branches: Branch[];
}

interface BranchForm {
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
}

const emptyBranchForm: BranchForm = { name: '', code: '', address: '', phone: '', email: '' };

export default function Organizations() {
  const [org, setOrg]               = useState<OrgDetail | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [showBranchModal, setShowBranchModal] = useState(false);
  const [editBranch, setEditBranch] = useState<Branch | null>(null);
  const [branchForm, setBranchForm] = useState<BranchForm>(emptyBranchForm);
  const [saving, setSaving]         = useState(false);
  const [formError, setFormError]   = useState('');
  const [deleteId, setDeleteId]     = useState<number | null>(null);
  const [deleting, setDeleting]     = useState(false);
  const [toast, setToast]           = useState('');

  const orgId = parseInt(localStorage.getItem('orgId') || '1', 10);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.organizations.get(orgId);
      setOrg(data);
    } catch (e: any) {
      setError(e.message || 'Failed to load organization');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const openAdd = () => {
    setEditBranch(null);
    setBranchForm(emptyBranchForm);
    setFormError('');
    setShowBranchModal(true);
  };

  const openEdit = (b: Branch) => {
    setEditBranch(b);
    setBranchForm({ name: b.name, code: b.code, address: b.address || '', phone: b.phone || '', email: b.email || '' });
    setFormError('');
    setShowBranchModal(true);
  };

  const handleSave = async () => {
    if (!branchForm.name.trim()) { setFormError('Branch name is required'); return; }
    if (!branchForm.code.trim()) { setFormError('Branch code is required'); return; }
    setSaving(true);
    setFormError('');
    try {
      if (editBranch) {
        await api.branches.update(editBranch.id, branchForm);
        showToast('Branch updated');
      } else {
        await api.branches.create(branchForm);
        showToast('Branch created');
      }
      setShowBranchModal(false);
      load();
    } catch (e: any) {
      setFormError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    setDeleting(true);
    try {
      await api.branches.delete(id);
      showToast('Branch removed');
      setDeleteId(null);
      load();
    } catch (e: any) {
      setFormError(e.message || 'Delete failed');
      setDeleteId(null);
    } finally {
      setDeleting(false);
    }
  };

  const typeLabel = (t: string) =>
    ({ retail: 'Retail', wholesale: 'Wholesale', franchise: 'Franchise', distributor: 'Distributor' }[t] ?? t);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 size={24} className="animate-spin text-teal-500" />
    </div>
  );

  if (error) return (
    <div className="p-6">
      <ErrorBanner error={error} />
    </div>
  );

  if (!org) return null;

  const activeBranches = org.branches?.filter(b => b.is_active) ?? [];

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl">

      {/* Toast */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 bg-emerald-600 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg">
          <CheckCircle size={15} /> {toast}
        </div>
      )}

      {/* Org card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-teal-500 to-cyan-400" />
        <div className="p-5 sm:p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 bg-teal-50 rounded-2xl flex items-center justify-center flex-shrink-0 border border-teal-100">
              <Building2 size={22} className="text-teal-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-xl font-bold text-slate-900">{org.name}</h2>
                <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-teal-50 text-teal-700 border border-teal-100">
                  {org.code}
                </span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                <span className="flex items-center gap-1.5 text-xs text-slate-500">
                  <Tag size={12} /> {typeLabel(org.type)}
                </span>
                {org.phone && (
                  <span className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Phone size={12} /> {org.phone}
                  </span>
                )}
                {org.email && (
                  <span className="flex items-center gap-1.5 text-xs text-slate-500">
                    <Mail size={12} /> {org.email}
                  </span>
                )}
                {org.address && (
                  <span className="flex items-center gap-1.5 text-xs text-slate-500">
                    <MapPin size={12} /> {org.address}
                  </span>
                )}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-xs text-slate-400">Currency</p>
              <p className="text-sm font-bold text-slate-700">{org.currency || 'PKR'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Branches */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <GitBranch size={17} className="text-teal-600" />
            <h3 className="font-semibold text-slate-800">Branches</h3>
            <span className="text-xs text-slate-400 font-medium">({activeBranches.length} active)</span>
          </div>
          <button
            onClick={openAdd}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-xl transition-colors"
          >
            <Plus size={13} /> Add Branch
          </button>
        </div>

        {activeBranches.length === 0 ? (
          <EmptyState message="No branches found." />
        ) : (
          <div className="divide-y divide-slate-100">
            {activeBranches.map(b => (
              <div key={b.id} className="flex items-center gap-4 px-5 sm:px-6 py-4">
                <div className="w-9 h-9 bg-slate-50 rounded-xl flex items-center justify-center border border-slate-100 flex-shrink-0">
                  <GitBranch size={16} className="text-slate-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-slate-800 truncate">{b.name}</p>
                    <span className="px-1.5 py-0.5 text-[10px] font-bold rounded bg-slate-100 text-slate-500">{b.code}</span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 mt-0.5">
                    {b.phone && <span className="text-xs text-slate-400">{b.phone}</span>}
                    {b.address && <span className="text-xs text-slate-400 truncate">{b.address}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => openEdit(b)}
                    className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-teal-600 transition-colors"
                    title="Edit branch"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => setDeleteId(b.id)}
                    className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
                    title="Remove branch"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Branch modal */}
      {showBranchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="font-bold text-slate-800">{editBranch ? 'Edit Branch' : 'Add Branch'}</h3>
              <button onClick={() => setShowBranchModal(false)} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={16} />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {[
                { label: 'Branch Name *', key: 'name',    placeholder: 'Main Branch' },
                { label: 'Branch Code *', key: 'code',    placeholder: 'MAIN' },
                { label: 'Phone',         key: 'phone',   placeholder: '+92-300-0000000' },
                { label: 'Email',         key: 'email',   placeholder: 'branch@company.pk' },
                { label: 'Address',       key: 'address', placeholder: 'City, Area' },
              ].map(f => (
                <div key={f.key}>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">{f.label}</label>
                  <input
                    type="text"
                    placeholder={f.placeholder}
                    value={branchForm[f.key as keyof BranchForm]}
                    onChange={e => setBranchForm(p => ({ ...p, [f.key]: e.target.value }))}
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 bg-slate-50 focus:bg-white"
                  />
                </div>
              ))}

              <ErrorBanner error={formError} />
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-100 bg-slate-50">
              <button onClick={() => setShowBranchModal(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 hover:bg-teal-700 disabled:opacity-60 rounded-xl transition-colors"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                {editBranch ? 'Save Changes' : 'Create Branch'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center">
            <div className="w-12 h-12 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <Trash2 size={20} className="text-red-500" />
            </div>
            <h3 className="font-bold text-slate-800 mb-1">Remove Branch?</h3>
            <p className="text-sm text-slate-500 mb-5">This branch will be deactivated. You cannot remove the last active branch.</p>
            <div className="flex items-center justify-center gap-2">
              <button onClick={() => setDeleteId(null)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors">
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                disabled={deleting}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-60 rounded-xl transition-colors"
              >
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
