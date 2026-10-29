import { useState } from 'react';
import { calcContactSummary, calcPaymentPct } from '../lib/calculations';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  Search, Plus, Phone, Mail, MapPin, RefreshCw, AlertCircle,
  TrendingUp, CreditCard, Scale, FileSpreadsheet, Car,
  Pencil, Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency } from '../lib/utils';
import ConfirmDialog from '../components/ConfirmDialog';
import ExcelImportModal from '../components/ExcelImportModal';
import { usePagination } from '../lib/usePagination';
import Pagination from '../components/Pagination';
import AddEditCustomerModal from '../components/AddEditCustomerModal';
import { useFetch } from '../lib/useFetch';
import EmptyState from '../components/EmptyState';

export default function Customers() {
  const { data: customers, loading, refreshing, error, refresh: fetchCustomers } = useFetch<any>(api.customers.list);
  const [search,         setSearch]         = useState('');
  // null = closed, undefined = add mode, object = edit mode
  const [modalCustomer,  setModalCustomer]  = useState<any | null | undefined>(null);
  const [deleteCustomer, setDeleteCustomer] = useState<any>(null);
  const deleteAction = useAsyncAction();
  const [showImport,     setShowImport]     = useState(false);

  const q = search.toLowerCase();
  const filtered = customers.filter(c =>
    (c.name          || '').toLowerCase().includes(q) ||
    (c.phone         || '').includes(search) ||
    (c.code          || '').toLowerCase().includes(q) ||
    (c.email         || '').toLowerCase().includes(q) ||
    (c.vehicle_plate || '').toLowerCase().includes(q) ||
    (c.vehicle_make  || '').toLowerCase().includes(q) ||
    (c.vehicle_model || '').toLowerCase().includes(q)
  );
  const { paged, paginationProps } = usePagination(filtered);

  const { totalInvoiced, totalPaid, totalBalance } = calcContactSummary(customers);

  const handleDelete = () => {
    if (!deleteCustomer) return;
    const customer = deleteCustomer;
    setDeleteCustomer(null);
    deleteAction.execute(
      () => api.customers.delete(customer.id),
      fetchCustomers
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">

      {/* ── Summary ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
          <p className="text-xs text-slate-500 font-medium">Total Customers</p>
          <p className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">{customers.length}</p>
          <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">Registered accounts</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <TrendingUp size={12} className="text-teal-500" />
            <p className="text-xs text-slate-500 font-medium">Total Invoiced</p>
          </div>
          <p className="text-sm sm:text-xl font-bold text-teal-600 truncate">{formatCurrency(totalInvoiced)}</p>
          <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">All sales issued</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <CreditCard size={12} className="text-emerald-500" />
            <p className="text-xs text-slate-500 font-medium">Total Collected</p>
          </div>
          <p className="text-sm sm:text-xl font-bold text-emerald-600 truncate">{formatCurrency(totalPaid)}</p>
          <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">Cash received</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <Scale size={12} className="text-amber-500" />
            <p className="text-xs text-slate-500 font-medium">Total Outstanding</p>
          </div>
          <p className={`text-sm sm:text-xl font-bold truncate ${totalBalance > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {formatCurrency(Math.max(0, totalBalance))}
          </p>
          <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">Receivable balance</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 border-b border-slate-100">
          <h3 className="text-sm sm:text-base font-bold text-slate-900">Customer Accounts</h3>
          <div className="flex items-center gap-2">
            <button onClick={fetchCustomers} title="Refresh"
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <div className="relative flex-1 sm:flex-none">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Name, phone, plate..."
                className="pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 w-full sm:w-52"
              />
            </div>
            <button onClick={() => setShowImport(true)} title="Import from Excel"
              className="flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap">
              <FileSpreadsheet size={14} />
              <span className="hidden sm:inline">Import Excel</span>
            </button>
            <button onClick={() => setModalCustomer(undefined)}
              className="flex items-center gap-1.5 bg-teal-600 text-white text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap">
              <Plus size={14} />
              <span className="hidden sm:inline">Add Customer</span>
              <span className="sm:hidden">Add</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-4 sm:mx-5 mt-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            <AlertCircle size={15} className="flex-shrink-0" /><span>{error}</span>
          </div>
        )}

        {!loading && <Pagination {...paginationProps} position="top" />}

        {/* Grid */}
        {loading && !error ? (
          <div className="p-4 sm:p-5 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {[1, 2, 3].map(i => <div key={i} className="h-52 bg-slate-100 rounded-xl animate-pulse" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 p-4 sm:p-5">
            {paged.map(c => {
              const invoiced  = Number(c.total_invoiced || 0);
              const paid      = Number(c.total_paid     || 0);
              const balance   = Number(c.balance_due    || 0);
              const paidPct   = calcPaymentPct(invoiced, paid);
              const isSettled = balance <= 0.005;

              const vehicleParts = [
                c.vehicle_year,
                c.vehicle_make,
                c.vehicle_model,
              ].filter(Boolean).join(' ');
              const hasVehicle = c.vehicle_plate || vehicleParts;

              return (
                <div key={c.id}
                  className="border border-slate-100 rounded-xl p-4 hover:shadow-md transition-shadow hover:border-teal-200 group relative bg-white"
                >
                  {/* Action buttons */}
                  <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setModalCustomer(c)} title="Edit customer"
                      className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => setDeleteCustomer(c)} title="Delete customer"
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {/* Header */}
                  <div className="flex items-start gap-3 pr-14">
                    <div className="w-10 h-10 bg-teal-600 rounded-xl flex items-center justify-center flex-shrink-0 text-white font-bold text-sm">
                      {(c.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate leading-tight">{c.name}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{c.code}
                        {Number(c.invoice_count) > 0 && (
                          <span className="ml-1.5 text-slate-300">· {c.invoice_count} invoice{Number(c.invoice_count) !== 1 ? 's' : ''}</span>
                        )}
                      </p>
                    </div>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                      isSettled
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                        : 'bg-amber-50 text-amber-700 border border-amber-100'
                    }`}>
                      {isSettled ? 'Settled' : 'Balance Due'}
                    </span>
                  </div>

                  {/* Contact */}
                  <div className="mt-2.5 space-y-1">
                    {c.phone   && <div className="flex items-center gap-2 text-xs text-slate-500"><Phone  size={10} className="flex-shrink-0 text-slate-400" /><span className="truncate font-mono">{c.phone}</span></div>}
                    {c.email   && <div className="flex items-center gap-2 text-xs text-slate-500"><Mail   size={10} className="flex-shrink-0 text-slate-400" /><span className="truncate">{c.email}</span></div>}
                    {c.address && <div className="flex items-center gap-2 text-xs text-slate-500"><MapPin size={10} className="flex-shrink-0 text-slate-400" /><span className="truncate">{c.address}</span></div>}
                  </div>

                  {/* Vehicle chip */}
                  {hasVehicle && (
                    <div className="mt-2 flex items-center gap-1.5 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5">
                      <Car size={11} className="text-slate-400 flex-shrink-0" />
                      <span className="text-[11px] text-slate-600 truncate">
                        {c.vehicle_plate && (
                          <span className="font-mono font-semibold">{c.vehicle_plate}</span>
                        )}
                        {c.vehicle_plate && vehicleParts && (
                          <span className="text-slate-300 mx-1">·</span>
                        )}
                        {vehicleParts}
                      </span>
                    </div>
                  )}

                  {/* Financial breakdown */}
                  <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 font-medium">Invoiced</span>
                      <span className="text-xs font-bold text-slate-800">{formatCurrency(invoiced)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 font-medium">Paid</span>
                      <span className="text-xs font-semibold text-emerald-600">{formatCurrency(paid)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-700">Balance</span>
                      <span className={`text-xs font-bold ${isSettled ? 'text-emerald-600' : 'text-amber-600'}`}>
                        {formatCurrency(Math.max(0, balance))}
                      </span>
                    </div>
                  </div>

                  {/* Payment progress */}
                  <div className="mt-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] text-slate-400">Payment progress</span>
                      <span className="text-[10px] font-semibold text-slate-500">{paidPct}%</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-1.5">
                      <div
                        className={`h-1.5 rounded-full transition-all ${isSettled ? 'bg-emerald-500' : paidPct >= 50 ? 'bg-teal-500' : 'bg-amber-400'}`}
                        style={{ width: `${paidPct}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}

            {filtered.length === 0 && !loading && (
              <EmptyState
                message={customers.length === 0 ? 'No customers yet. Add your first customer.' : 'No customers match your search.'}
                className="col-span-full"
              />
            )}
          </div>
        )}

        <Pagination {...paginationProps} position="bottom" />
      </div>

      {/* Add / Edit modal */}
      {modalCustomer !== null && (
        <AddEditCustomerModal
          customer={modalCustomer}
          onClose={() => setModalCustomer(null)}
          onSaved={fetchCustomers}
        />
      )}

      {showImport && (
        <ExcelImportModal entity="customers" onClose={() => setShowImport(false)} onImported={fetchCustomers} />
      )}

      {deleteCustomer && (
        <ConfirmDialog
          title="Delete Customer"
          message={`Delete "${deleteCustomer.name}"? Customers with existing sales cannot be deleted.`}
          confirmLabel="Delete Customer"
          variant="danger"
          loading={deleteAction.loading}
          onConfirm={handleDelete}
          onCancel={() => setDeleteCustomer(null)}
        />
      )}
    </div>
  );
}
