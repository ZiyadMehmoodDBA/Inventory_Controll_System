import { useTerms } from '../lib/businessTypes';
import { useState } from 'react';
import { X, Loader2, CheckCircle, Wrench } from 'lucide-react';
import { api } from '../api/client';
import ErrorBanner from './ErrorBanner';
import { formatCurrency } from '../lib/utils';
import { getCachedSettings } from '../lib/appSettings';

interface Props {
  service?: any;
  onClose: () => void;
  onSaved: () => void;
}

export default function AddEditServiceModal({ service, onClose, onSaved }: Props) {
  const terms = useTerms();
  const isEdit   = !!service;
  const currency = getCachedSettings().currency || 'PKR';

  const [form, setForm] = useState({
    name:        service?.name        ?? '',
    description: service?.description ?? '',
    sale_price:  String(service?.sale_price  ?? ''),
    cost_price:  String(service?.cost_price  ?? ''),
    is_active:   service?.is_active   !== false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState(false);

  const set = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  const saleP  = Number(form.sale_price);
  const costP  = Number(form.cost_price);
  const margin = costP > 0 && saleP > 0
    ? (((saleP - costP) / costP) * 100).toFixed(1)
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim())    return setError('Service name is required.');
    if (!(saleP > 0))         return setError('Sale price must be greater than zero.');
    setLoading(true);
    setError('');
    try {
      const payload = {
        name:        form.name.trim(),
        description: form.description.trim(),
        category:    'Service',
        unit:        'job',
        cost_price:  costP,
        sale_price:  saleP,
        is_active:   form.is_active,
        code:        service?.code ?? null,
      };
      if (isEdit) await api.products.update(service.id, payload);
      else        await api.products.create(payload);
      setSuccess(true);
      setTimeout(() => { onSaved(); onClose(); }, 700);
    } catch (err: any) {
      setError(err.message || 'Failed to save service');
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={e => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-md max-h-[90vh] flex flex-col">

        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-teal-100 rounded-lg flex items-center justify-center">
              <Wrench size={15} className="text-teal-600" />
            </div>
            <h2 className="text-base font-bold text-slate-900">
              {isEdit ? 'Edit Service' : 'Add Service'}
            </h2>
          </div>
          <button onClick={onClose} disabled={loading}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">

            <ErrorBanner error={error} />

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Service Name <span className="text-red-500">*</span>
              </label>
              <input
                autoFocus
                value={form.name}
                onChange={e => set('name', e.target.value)}
                placeholder={`e.g. ${terms.serviceExample}`}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Description</label>
              <textarea
                value={form.description}
                onChange={e => set('description', e.target.value)}
                placeholder="What's included in this service?"
                rows={2}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 resize-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Sale Price <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium pointer-events-none">
                    {currency}
                  </span>
                  <input
                    type="number" min={0} step="0.01"
                    value={form.sale_price}
                    onChange={e => set('sale_price', e.target.value)}
                    placeholder="0.00"
                    className="w-full text-sm border border-slate-200 rounded-xl pl-10 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1">Charged to customer</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Cost Price</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium pointer-events-none">
                    {currency}
                  </span>
                  <input
                    type="number" min={0} step="0.01"
                    value={form.cost_price}
                    onChange={e => set('cost_price', e.target.value)}
                    placeholder="0.00"
                    className="w-full text-sm border border-slate-200 rounded-xl pl-10 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  />
                </div>
                <p className="text-xs text-slate-400 mt-1">Internal labour cost</p>
              </div>
            </div>

            {/* Live margin */}
            {margin !== null && (
              <div className={`rounded-xl p-3 flex items-center justify-between border ${
                Number(margin) >= 0 ? 'bg-teal-50 border-teal-100' : 'bg-red-50 border-red-100'
              }`}>
                <div>
                  <p className="text-xs font-semibold text-slate-600">Service Margin</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {formatCurrency(costP)} cost → {formatCurrency(saleP)} price
                  </p>
                </div>
                <span className={`text-lg font-bold ${Number(margin) >= 0 ? 'text-teal-700' : 'text-red-600'}`}>
                  {Number(margin) >= 0 ? '+' : ''}{margin}%
                </span>
              </div>
            )}

            {/* Active toggle */}
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-semibold text-slate-700">Active</p>
                <p className="text-xs text-slate-400 mt-0.5">Active services appear in invoice line items</p>
              </div>
              <button
                type="button"
                onClick={() => set('is_active', !form.is_active)}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1 ${
                  form.is_active ? 'bg-teal-500' : 'bg-slate-200'
                }`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  form.is_active ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
            </div>

          </div>

          <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 flex-shrink-0">
            <button type="button" onClick={onClose} disabled={loading}
              className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={loading || success}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-60 min-w-32 justify-center">
              {loading  ? <><Loader2 size={15} className="animate-spin" /> Saving…</>
              : success ? <><CheckCircle size={15} /> Saved!</>
              : isEdit  ? 'Update Service'
              : 'Add Service'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
