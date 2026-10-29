import { useState } from 'react';
import { X, Loader2, CheckCircle, User, Car } from 'lucide-react';
import { api } from '../api/client';
import ErrorBanner from './ErrorBanner';

interface Props {
  customer?: any;   // undefined → add mode
  onClose: () => void;
  onSaved: () => void;
}

const THIS_YEAR = new Date().getFullYear();

function blank(c?: any) {
  return {
    name:          c?.name          ?? '',
    phone:         c?.phone         ?? '',
    email:         c?.email         ?? '',
    address:       c?.address       ?? '',
    vehicle_plate: c?.vehicle_plate ?? '',
    vehicle_make:  c?.vehicle_make  ?? '',
    vehicle_model: c?.vehicle_model ?? '',
    vehicle_year:  c?.vehicle_year  ? String(c.vehicle_year) : '',
  };
}

export default function AddEditCustomerModal({ customer, onClose, onSaved }: Props) {
  const isEdit = !!customer;
  const [form, setForm]     = useState(blank(customer));
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState('');
  const [success, setSuccess] = useState(false);

  const set = (k: string, v: string) =>
    setForm(f => ({ ...f, [k]: v }));

  const hasVehicle = form.vehicle_plate || form.vehicle_make ||
                     form.vehicle_model || form.vehicle_year;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim())  return setError('Name is required.');
    if (!form.phone.trim()) return setError('Phone number is required.');

    const yr = form.vehicle_year ? Number(form.vehicle_year) : null;
    if (form.vehicle_year && (yr! < 1950 || yr! > THIS_YEAR + 1)) {
      return setError(`Vehicle year must be between 1950 and ${THIS_YEAR + 1}.`);
    }

    setLoading(true);
    setError('');
    try {
      const payload = {
        name:          form.name.trim(),
        phone:         form.phone.trim(),
        email:         form.email.trim(),
        address:       form.address.trim(),
        vehicle_plate: form.vehicle_plate.trim().toUpperCase() || null,
        vehicle_make:  form.vehicle_make.trim()  || null,
        vehicle_model: form.vehicle_model.trim() || null,
        vehicle_year:  yr,
      };
      if (isEdit) await api.customers.update(customer.id, payload);
      else        await api.customers.create(payload);
      setSuccess(true);
      setTimeout(() => { onSaved(); onClose(); }, 700);
    } catch (err: any) {
      setError(err.message || 'Failed to save customer');
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={e => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-lg max-h-[94vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-teal-100 rounded-lg flex items-center justify-center">
              <User size={15} className="text-teal-600" />
            </div>
            <h2 className="text-base font-bold text-slate-900">
              {isEdit ? 'Edit Customer' : 'New Customer'}
            </h2>
          </div>
          <button onClick={onClose} disabled={loading}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">

            <ErrorBanner error={error} />

            {/* ── Identity ──────────────────────────────────────── */}
            <fieldset>
              <legend className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                Customer
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Full Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    autoFocus
                    value={form.name}
                    onChange={e => set('name', e.target.value)}
                    placeholder="e.g. Ahmed Hassan"
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Phone <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={e => set('phone', e.target.value)}
                    placeholder="+92-300-1234567"
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 font-mono"
                  />
                  <p className="text-xs text-slate-400 mt-1">Must be unique — used to identify the customer</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={e => set('email', e.target.value)}
                    placeholder="ahmed@company.pk"
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Address</label>
                  <input
                    value={form.address}
                    onChange={e => set('address', e.target.value)}
                    placeholder="City, area or full address"
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  />
                </div>
              </div>
            </fieldset>

            {/* ── Vehicle ───────────────────────────────────────── */}
            <fieldset>
              <legend className="flex items-center gap-2 text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                <Car size={11} />
                Vehicle <span className="normal-case font-medium text-slate-300">(optional)</span>
              </legend>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Plate Number
                  </label>
                  <input
                    value={form.vehicle_plate}
                    onChange={e => set('vehicle_plate', e.target.value.toUpperCase())}
                    placeholder="e.g. LEA-1234"
                    maxLength={12}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 font-mono uppercase tracking-widest"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Year</label>
                  <input
                    type="number"
                    min={1950}
                    max={THIS_YEAR + 1}
                    value={form.vehicle_year}
                    onChange={e => set('vehicle_year', e.target.value)}
                    placeholder={String(THIS_YEAR)}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 text-center"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Make</label>
                  <input
                    value={form.vehicle_make}
                    onChange={e => set('vehicle_make', e.target.value)}
                    placeholder="e.g. Toyota"
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Model</label>
                  <input
                    value={form.vehicle_model}
                    onChange={e => set('vehicle_model', e.target.value)}
                    placeholder="e.g. Corolla"
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  />
                </div>
              </div>

              {/* Live vehicle preview */}
              {hasVehicle && (
                <div className="mt-3 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5">
                  <Car size={14} className="text-slate-400 flex-shrink-0" />
                  <span className="text-sm text-slate-700">
                    {[
                      form.vehicle_plate && (
                        <span key="plate" className="font-mono font-semibold">{form.vehicle_plate}</span>
                      ),
                      [form.vehicle_year, form.vehicle_make, form.vehicle_model]
                        .filter(Boolean).join(' '),
                    ].filter(Boolean).reduce<React.ReactNode[]>((acc, item, i) => {
                      if (i > 0) acc.push(<span key={`sep-${i}`} className="text-slate-300 mx-1">·</span>);
                      acc.push(item as React.ReactNode);
                      return acc;
                    }, [])}
                  </span>
                </div>
              )}
            </fieldset>

          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 flex-shrink-0">
            <button type="button" onClick={onClose} disabled={loading}
              className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={loading || success}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-60 min-w-36 justify-center">
              {loading  ? <><Loader2 size={15} className="animate-spin" /> Saving…</>
              : success ? <><CheckCircle size={15} /> Saved!</>
              : isEdit  ? 'Save Changes'
              : 'Add Customer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
