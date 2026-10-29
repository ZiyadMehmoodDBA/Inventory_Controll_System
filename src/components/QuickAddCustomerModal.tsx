import { useState } from 'react';
import { X, UserPlus, Loader2, AlertCircle } from 'lucide-react';
import { api } from '../api/client';
import { cn } from '../lib/utils';

interface Props {
  /** Called with the newly-created customer record so the parent can select it */
  onCreated: (customer: { id: number; name: string; phone: string }) => void;
  /** Called when the user decides to stay as walk-in (Cancel / "Walk-in only") */
  onClose: () => void;
}

export default function QuickAddCustomerModal({ onCreated, onClose }: Props) {
  const [name,    setName]    = useState('');
  const [phone,   setPhone]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Full name is required'); return; }
    setError('');
    setLoading(true);
    try {
      const customer = await api.customers.create({ name: name.trim(), phone: phone.trim() }) as any;
      onCreated(customer);
    } catch (err: any) {
      setError(err.message || 'Failed to save customer');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-teal-500 rounded-lg flex items-center justify-center flex-shrink-0">
              <UserPlus size={14} className="text-white" />
            </div>
            <h3 className="text-sm font-bold text-slate-900">Save Customer Info</h3>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={16} className="text-slate-400" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-3.5">
          <p className="text-xs text-slate-500 leading-relaxed">
            Customer wants to share their details? Save them for future visits and loyalty tracking.
          </p>

          {error && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-700">
              <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Full Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); if (error) setError(''); }}
              placeholder="e.g. Muhammad Ahmed"
              autoFocus
              className={cn(
                'w-full text-sm border rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 bg-slate-50 focus:bg-white transition-all',
                error && !name.trim()
                  ? 'border-red-300 focus:ring-red-100 focus:border-red-400'
                  : 'border-slate-200 focus:ring-teal-100 focus:border-teal-400'
              )}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Phone <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+92-300-1234567"
              className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-100 focus:border-teal-400 bg-slate-50 focus:bg-white transition-all"
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
            >
              Walk-in only
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-teal-600 rounded-xl hover:bg-teal-700 active:bg-teal-800 transition-colors disabled:opacity-60"
            >
              {loading
                ? <><Loader2 size={14} className="animate-spin" /> Saving…</>
                : <><UserPlus size={14} /> Save &amp; Select</>
              }
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
