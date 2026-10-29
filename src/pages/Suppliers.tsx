import { useState } from 'react';
import { calcContactSummary, calcPaymentPct } from '../lib/calculations';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  Search, Plus, Phone, Mail, MapPin, Truck, RefreshCw, AlertCircle,
  Pencil, Trash2, FileSpreadsheet,
  ShoppingBag, CreditCard, Scale,
} from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency } from '../lib/utils';
import ConfirmDialog from '../components/ConfirmDialog';
import ExcelImportModal from '../components/ExcelImportModal';
import EmptyState from '../components/EmptyState';
import { usePagination } from '../lib/usePagination';
import Pagination from '../components/Pagination';
import { useFetch } from '../lib/useFetch';
import AddEditSupplierModal from '../components/AddEditSupplierModal';

export default function Suppliers() {
  const { data: suppliers, loading, refreshing, error, refresh: fetchSuppliers } = useFetch<any>(api.suppliers.list);
  const [search,         setSearch]         = useState('');
  const [modalSupplier,  setModalSupplier]  = useState<any | null | undefined>(null);
  const [deleteSupplier, setDeleteSupplier] = useState<any>(null);
  const deleteAction = useAsyncAction();
  const [showImport,     setShowImport]     = useState(false);

  const filtered = suppliers.filter(s =>
    (s.name  || '').toLowerCase().includes(search.toLowerCase()) ||
    (s.phone || '').includes(search) ||
    (s.code  || '').toLowerCase().includes(search.toLowerCase())
  );
  const { paged, paginationProps } = usePagination(filtered);

  const { totalInvoiced, totalPaid, totalBalance } = calcContactSummary(suppliers);

  const handleDelete = () => {
    if (!deleteSupplier) return;
    const supplier = deleteSupplier;
    setDeleteSupplier(null);
    deleteAction.execute(
      () => api.suppliers.delete(supplier.id),
      fetchSuppliers
    );
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">

      {/* ── Summary ────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
          <p className="text-xs text-slate-500 font-medium">Total Suppliers</p>
          <p className="text-xl sm:text-2xl font-bold text-slate-900 mt-1">{suppliers.length}</p>
          <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">Active accounts</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <ShoppingBag size={12} className="text-teal-500" />
            <p className="text-xs text-slate-500 font-medium">Total Purchased</p>
          </div>
          <p className="text-sm sm:text-xl font-bold text-teal-600 truncate">{formatCurrency(totalInvoiced)}</p>
          <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">All purchase orders</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <CreditCard size={12} className="text-emerald-500" />
            <p className="text-xs text-slate-500 font-medium">Total Paid Out</p>
          </div>
          <p className="text-sm sm:text-xl font-bold text-emerald-600 truncate">{formatCurrency(totalPaid)}</p>
          <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">Cash paid to suppliers</p>
        </div>
        <div className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
          <div className="flex items-center gap-1.5 mb-1">
            <Scale size={12} className="text-amber-500" />
            <p className="text-xs text-slate-500 font-medium">Total Payable</p>
          </div>
          <p className={`text-sm sm:text-xl font-bold truncate ${totalBalance > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {formatCurrency(Math.max(0, totalBalance))}
          </p>
          <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">Outstanding payable</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
        {/* Toolbar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 border-b border-slate-100">
          <h3 className="text-sm sm:text-base font-bold text-slate-900">Supplier Accounts</h3>
          <div className="flex items-center gap-2">
            <button onClick={fetchSuppliers} title="Refresh"
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
              <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <div className="relative flex-1 sm:flex-none">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name, code, phone..."
                className="pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 w-full sm:w-44" />
            </div>
            <button onClick={() => setShowImport(true)} title="Import from Excel"
              className="flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap">
              <FileSpreadsheet size={14} />
              <span className="hidden sm:inline">Import Excel</span>
            </button>
            <button onClick={() => setModalSupplier(undefined)} title="Add new supplier"
              className="flex items-center gap-1.5 bg-teal-600 text-white text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap">
              <Plus size={14} />
              <span className="hidden sm:inline">Add Supplier</span>
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
            {[1,2,3].map(i => <div key={i} className="h-44 bg-slate-100 rounded-xl animate-pulse" />)}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4 p-4 sm:p-5">
            {paged.map(s => {
              const invoiced  = Number(s.total_invoiced || 0);
              const paid      = Number(s.total_paid     || 0);
              const balance   = Number(s.balance_due    || 0);
              const paidPct   = calcPaymentPct(invoiced, paid);
              const isSettled = balance <= 0.005;

              return (
                <div key={s.id}
                  className="border border-slate-100 rounded-xl p-4 hover:shadow-md transition-shadow hover:border-teal-200 group relative bg-white"
                >
                  {/* Action buttons */}
                  <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => setModalSupplier(s)} title="Edit supplier"
                      className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => setDeleteSupplier(s)} title="Delete supplier"
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {/* Header */}
                  <div className="flex items-start gap-3 pr-14">
                    <div className="w-10 h-10 bg-teal-600 rounded-xl flex items-center justify-center flex-shrink-0">
                      <Truck size={16} className="text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-slate-900 truncate leading-tight">{s.name}</p>
                      <p className="text-[11px] text-slate-400 mt-0.5">{s.code}
                        {Number(s.po_count) > 0 && (
                          <span className="ml-1.5 text-slate-300">· {s.po_count} PO{Number(s.po_count) !== 1 ? 's' : ''}</span>
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
                    {s.phone   && <div className="flex items-center gap-2 text-xs text-slate-500"><Phone size={10} className="flex-shrink-0 text-slate-400" /><span className="truncate">{s.phone}</span></div>}
                    {s.email   && <div className="flex items-center gap-2 text-xs text-slate-500"><Mail size={10} className="flex-shrink-0 text-slate-400" /><span className="truncate">{s.email}</span></div>}
                    {s.address && <div className="flex items-center gap-2 text-xs text-slate-500"><MapPin size={10} className="flex-shrink-0 text-slate-400" /><span className="truncate">{s.address}</span></div>}
                  </div>

                  {/* Financial breakdown */}
                  <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-slate-500 font-medium">Purchased</span>
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
                message={suppliers.length === 0 ? 'No suppliers yet. Add your first supplier.' : 'No suppliers match your search.'}
                className="col-span-full"
              />
            )}
          </div>
        )}

        <Pagination {...paginationProps} position="bottom" />
      </div>

      {modalSupplier !== null && (
        <AddEditSupplierModal
          supplier={modalSupplier}
          onClose={() => setModalSupplier(null)}
          onSaved={fetchSuppliers}
        />
      )}

      {showImport && (
        <ExcelImportModal entity="suppliers" onClose={() => setShowImport(false)} onImported={fetchSuppliers} />
      )}

      {deleteSupplier && (
        <ConfirmDialog
          title="Delete Supplier"
          message={`Delete "${deleteSupplier.name}"? Suppliers with existing purchase orders cannot be deleted.`}
          confirmLabel="Delete Supplier"
          variant="danger"
          loading={deleteAction.loading}
          onConfirm={handleDelete}
          onCancel={() => setDeleteSupplier(null)}
        />
      )}
    </div>
  );
}
