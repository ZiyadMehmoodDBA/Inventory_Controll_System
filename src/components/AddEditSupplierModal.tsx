import { useState } from 'react';
import { X, Loader2, CheckCircle, Truck } from 'lucide-react';
import { api } from '../api/client';
import ErrorBanner from './ErrorBanner';

interface Props {
  supplier?: any;   // undefined → add mode, object → edit mode
  onClose: () => void;
  onSaved: () => void;
}

const FIELDS: { field: string; label: string; placeholder: string; required?: boolean }[] = [
  { field: 'name',    label: 'Company Name',   placeholder: 'Bridgestone Pakistan Ltd.', required: true },
  { field: 'phone',   label: 'Phone / Fax',    placeholder: '+92-21-3456789' },
  { field: 'email',   label: 'Email Address',  placeholder: 'supply@company.pk' },
  { field: 'address', label: 'City / Address', placeholder: 'Karachi, Sindh' },
];

function blank(s?: any) {
  return {
    name:    s?.name    ?? '',
    phone:   s?.phone   ?? '',
    email:   s?.email   ?? '',
    address: s?.address ?? '',
  };
}

export default function AddEditSupplierModal({ supplier, onClose, onSaved }: Props) {
  const isEdit = !!supplier;
  const [form, setForm]       = useState(blank(supplier));
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState(false);

  const set = (k: string, v: string) =>
    setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setError('Name is required.');

    setLoading(true);
    setError('');
    try {
      if (isEdit) await api.suppliers.update(supplier.id, form);
      else        await api.suppliers.create(form);
      setSuccess(true);
      setTimeout(() => { onSaved(); onClose(); }, 700);
    } catch (err: any) {
      setError(err.message || 'Failed to save supplier');
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-teal-50 rounded-xl flex items-center justify-center">
              <Truck size={16} className="text-teal-600" />
            </div>
            <h2 className="text-base font-bold text-slate-900">
              {isEdit ? 'Edit Supplier' : 'Add Supplier'}
            </h2>
          </div>
          <button onClick={onClose} disabled={loading}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <ErrorBanner error={error} />

          {FIELDS.map(({ field, label, placeholder, required = false }) => (
            <div key={field}>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                {label} {required && <span className="text-red-500">*</span>}
              </label>
              <input
                autoFocus={field === 'name'}
                value={(form as any)[field]}
                onChange={e => set(field, e.target.value)}
                placeholder={placeholder}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
              />
            </div>
          ))}

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} disabled={loading}
              className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={loading || success}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-60 min-w-36 justify-center">
              {loading  ? <><Loader2 size={15} className="animate-spin" /> Saving…</>
              : success ? <><CheckCircle size={15} /> Saved!</>
              : isEdit  ? 'Save Changes'
              : 'Add Supplier'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
