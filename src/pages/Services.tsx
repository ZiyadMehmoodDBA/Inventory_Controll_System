import { useTerms } from '../lib/businessTypes';
import { getCachedSettings } from '../lib/appSettings';
import { useState } from 'react';
import {
  Wrench, Plus, Search, Pencil, Trash2, RefreshCw,
  CheckCircle, XCircle, Loader2,
} from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency } from '../lib/utils';
import AddEditServiceModal from '../components/AddEditServiceModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { usePagination } from '../lib/usePagination';
import Pagination from '../components/Pagination';
import EmptyState from '../components/EmptyState';
import ErrorBanner from '../components/ErrorBanner';
import TableSkeleton from '../components/TableSkeleton';
import { useFetch } from '../lib/useFetch';
import { useAsyncAction } from '../lib/useAsyncAction';

const svc = (name: string, sale_price: number, cost_price: number, description: string, unit = 'job') =>
  ({ name, sale_price, cost_price, description, category: 'Service', unit, is_active: true });

const TYRE_SEEDS = [
  svc('Tyre Fitting', 300, 100, 'Mount and fit tyre to wheel rim'),
  svc('Wheel Balancing', 250, 80, 'Dynamic wheel balancing with weights'),
  svc('Wheel Alignment', 1500, 500, '4-wheel laser alignment'),
  svc('Puncture Repair', 200, 50, 'Tubeless puncture plug and patch repair'),
  svc('Valve Replacement', 100, 30, 'Replace tyre valve stem'),
];
const AUTO_SEEDS = [
  svc('Oil Change', 800, 300, 'Engine oil and filter change'),
  svc('Car Wash', 500, 150, 'Exterior and interior wash'),
  svc('Battery Replacement', 300, 100, 'Remove and fit a new battery'),
  svc('Vehicle Inspection', 1000, 300, 'Multi-point inspection and report'),
];
const GENERAL_SEEDS = [
  svc('Home Delivery', 200, 100, 'Delivery to the customer address', 'order'),
  svc('Gift Wrapping', 100, 30, 'Wrapping and a gift card', 'item'),
  svc('Installation', 500, 200, 'On-site installation', 'job'),
];
const seedsFor = (type: string, tyre: boolean) =>
  tyre ? TYRE_SEEDS : type === 'auto_workshop' || type === 'auto_parts' ? AUTO_SEEDS : GENERAL_SEEDS;

const servicesFn = () => api.products.list().then((all: any[]) => all.filter(p => p.category === 'Service'));

export default function Services() {
  const terms = useTerms();
  const seeds = seedsFor(getCachedSettings().business_type, terms.tyre);
  const { data: services, loading, refreshing, error, setError, refresh: fetchServices } = useFetch<any>(servicesFn);
  const deleteAction = useAsyncAction();

  const [search, setSearch]         = useState('');
  const [addModal, setAddModal]     = useState(false);
  const [editSvc, setEditSvc]       = useState<any>(null);
  const [deleteSvc, setDeleteSvc]   = useState<any>(null);
  const [seeding, setSeeding]       = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const handleDelete = () => {
    if (!deleteSvc) return;
    const svc = deleteSvc;
    setDeleteSvc(null);
    deleteAction.execute(() => api.products.delete(svc.id), fetchServices);
  };

  const toggleActive = async (svc: any) => {
    setTogglingId(svc.id);
    try {
      await api.products.update(svc.id, { ...svc, is_active: !svc.is_active });
      fetchServices();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setTogglingId(null);
    }
  };

  const seedDefaults = async () => {
    setSeeding(true);
    try {
      for (const s of seeds) await api.products.create(s);
      fetchServices();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSeeding(false);
    }
  };

  const q        = search.toLowerCase();
  const filtered = services.filter(s =>
    (s.name        || '').toLowerCase().includes(q) ||
    (s.description || '').toLowerCase().includes(q)
  );
  const { paged, paginationProps } = usePagination(filtered);

  const activeCount   = services.filter(s => s.is_active).length;
  const inactiveCount = services.length - activeCount;
  const avgPrice      = services.length
    ? services.reduce((sum, s) => sum + Number(s.sale_price), 0) / services.length
    : 0;

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        {[
          { label: 'Active',    value: `${activeCount}`,         color: 'text-teal-600',  help: 'Available on invoices' },
          { label: 'Inactive',  value: `${inactiveCount}`,       color: inactiveCount > 0 ? 'text-amber-500' : 'text-slate-400', help: 'Hidden from invoices' },
          { label: 'Avg Price', value: formatCurrency(avgPrice), color: 'text-slate-900', help: 'Average sale price' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
            <p className="text-xs text-slate-500 font-medium truncate">{s.label}</p>
            <p className={`text-sm sm:text-xl font-bold mt-1 ${s.color} truncate`}>{s.value}</p>
            <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">{s.help}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100">

        {/* Toolbar */}
        <div className="flex flex-col gap-3 p-4 sm:p-5 border-b border-slate-100">
          <div className="flex items-center justify-between">
            <h3 className="text-sm sm:text-base font-bold text-slate-900">Services Catalog</h3>
            <div className="flex items-center gap-2">
              <button onClick={fetchServices} title="Refresh"
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => setAddModal(true)}
                className="flex items-center gap-1.5 bg-teal-600 text-white text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-teal-700 transition-colors">
                <Plus size={14} />
                <span className="hidden sm:inline">Add Service</span>
                <span className="sm:hidden">Add</span>
              </button>
            </div>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search services…"
              className="pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 w-full"
            />
          </div>
        </div>

        {(error || deleteAction.error) && (
          <ErrorBanner error={error || deleteAction.error} className="mx-4 sm:mx-5 mt-4" />
        )}

        {loading && <TableSkeleton rows={5} rowHeight="h-14" />}

        {!loading && <Pagination {...paginationProps} position="top" />}

        {!loading && (
          <>
            {services.length === 0 && !error && (
              <div className="py-12 text-center px-6">
                <div className="w-14 h-14 bg-teal-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <Wrench size={24} className="text-teal-400" />
                </div>
                <p className="text-sm font-semibold text-slate-700 mb-1">No services yet</p>
                <p className="text-xs text-slate-400 mb-6">
                  Add fitting, balancing, alignment and other services — they appear as line items on invoices.
                </p>
                <button
                  onClick={seedDefaults}
                  disabled={seeding}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-60 transition-colors"
                >
                  {seeding ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                  {seeding ? 'Adding defaults…' : 'Add default services'}
                </button>
                <p className="text-xs text-slate-400 mt-3">
                  Adds: Tire Fitting · Balancing · Alignment · Puncture Repair · Valve Replacement
                </p>
              </div>
            )}

            {services.length > 0 && (
              <>
                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-100">
                        {['Service', 'Sale Price', 'Cost', 'Margin', 'Status', ''].map(h => (
                          <th key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3 text-left last:w-20">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {paged.map(svc => {
                        const saleP  = Number(svc.sale_price);
                        const costP  = Number(svc.cost_price);
                        const margin = costP > 0 ? ((saleP - costP) / costP * 100).toFixed(1) : null;
                        const isToggling = togglingId === svc.id;

                        return (
                          <tr key={svc.id} className="hover:bg-slate-50/50 transition-colors group">
                            <td className="px-4 py-3.5">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 bg-teal-50 rounded-lg flex items-center justify-center flex-shrink-0">
                                  <Wrench size={14} className="text-teal-500" />
                                </div>
                                <div>
                                  <p className="text-sm font-semibold text-slate-900 leading-tight">{svc.name}</p>
                                  {svc.description && (
                                    <p className="text-xs text-slate-400 mt-0.5 leading-tight max-w-xs truncate">{svc.description}</p>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3.5">
                              <span className="text-sm font-bold text-slate-900">{formatCurrency(saleP)}</span>
                              <span className="ml-1 text-xs text-slate-400">/ job</span>
                            </td>
                            <td className="px-4 py-3.5 text-sm text-slate-500">
                              {costP > 0 ? formatCurrency(costP) : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="px-4 py-3.5">
                              {margin !== null ? (
                                <span className={`text-sm font-semibold ${Number(margin) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {Number(margin) >= 0 ? '+' : ''}{margin}%
                                </span>
                              ) : (
                                <span className="text-slate-300 text-sm">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3.5">
                              <button
                                onClick={() => toggleActive(svc)}
                                disabled={isToggling}
                                title={svc.is_active ? 'Click to deactivate' : 'Click to activate'}
                                className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${
                                  svc.is_active
                                    ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                                }`}
                              >
                                {isToggling
                                  ? <Loader2 size={11} className="animate-spin" />
                                  : svc.is_active ? <CheckCircle size={11} /> : <XCircle size={11} />}
                                {svc.is_active ? 'Active' : 'Inactive'}
                              </button>
                            </td>
                            <td className="px-4 py-3.5">
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={() => setEditSvc(svc)} title="Edit"
                                  className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors">
                                  <Pencil size={14} />
                                </button>
                                <button onClick={() => setDeleteSvc(svc)} title="Delete"
                                  className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="md:hidden divide-y divide-slate-50">
                  {paged.map(svc => {
                    const saleP  = Number(svc.sale_price);
                    const costP  = Number(svc.cost_price);
                    const margin = costP > 0 ? ((saleP - costP) / costP * 100).toFixed(1) : null;

                    return (
                      <div key={svc.id} className="p-4 flex items-start gap-3">
                        <div className="w-10 h-10 bg-teal-50 rounded-lg flex items-center justify-center flex-shrink-0">
                          <Wrench size={16} className="text-teal-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-slate-900 leading-tight">{svc.name}</p>
                              {svc.description && (
                                <p className="text-xs text-slate-400 mt-0.5 leading-tight truncate">{svc.description}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button onClick={() => setEditSvc(svc)} title="Edit"
                                className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors">
                                <Pencil size={13} />
                              </button>
                              <button onClick={() => setDeleteSvc(svc)} title="Delete"
                                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                          <div className="flex items-center gap-3 mt-2">
                            <div>
                              <p className="text-xs text-slate-400">Price</p>
                              <p className="text-sm font-bold text-slate-900">{formatCurrency(saleP)}</p>
                            </div>
                            {costP > 0 && (
                              <div>
                                <p className="text-xs text-slate-400">Cost</p>
                                <p className="text-sm text-slate-600">{formatCurrency(costP)}</p>
                              </div>
                            )}
                            {margin !== null && (
                              <div>
                                <p className="text-xs text-slate-400">Margin</p>
                                <p className={`text-sm font-semibold ${Number(margin) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                  {Number(margin) >= 0 ? '+' : ''}{margin}%
                                </p>
                              </div>
                            )}
                            <button
                              onClick={() => toggleActive(svc)}
                              disabled={togglingId === svc.id}
                              className={`ml-auto flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${
                                svc.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              {togglingId === svc.id
                                ? <Loader2 size={10} className="animate-spin" />
                                : svc.is_active ? <CheckCircle size={10} /> : <XCircle size={10} />}
                              {svc.is_active ? 'Active' : 'Inactive'}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {filtered.length === 0 && (
                  <EmptyState icon={Wrench} message="No services match your search." />
                )}
              </>
            )}
          </>
        )}

        <Pagination {...paginationProps} position="bottom" />
        {inactiveCount > 0 && (
          <span className="px-4 pb-3 text-xs text-amber-600 font-medium">{inactiveCount} inactive</span>
        )}
      </div>

      {(addModal || editSvc) && (
        <AddEditServiceModal
          service={editSvc ?? undefined}
          onClose={() => { setAddModal(false); setEditSvc(null); }}
          onSaved={fetchServices}
        />
      )}

      {deleteSvc && (
        <ConfirmDialog
          title="Delete Service"
          message={`Delete "${deleteSvc.name}"? This cannot be undone. Services used in existing sales or purchases cannot be deleted.`}
          confirmLabel="Delete Service"
          variant="danger"
          loading={deleteAction.loading}
          onConfirm={handleDelete}
          onCancel={() => setDeleteSvc(null)}
        />
      )}
    </div>
  );
}
