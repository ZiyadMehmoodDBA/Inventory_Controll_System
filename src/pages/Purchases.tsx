import { useState } from 'react';
import { calcPurchaseSummary } from '../lib/calculations';
import { useAsyncAction } from '../lib/useAsyncAction';
import { Plus, Search, Eye, RefreshCw, AlertCircle, Trash2, PackageCheck, XCircle, Loader2, FileSpreadsheet, CreditCard } from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency, formatDate } from '../lib/utils';
import GRNModal from '../components/GRNModal';
import { useFetch } from '../lib/useFetch';
import { usePagination } from '../lib/usePagination';
import Pagination from '../components/Pagination';
import POViewModal from '../components/POViewModal';
import ConfirmDialog from '../components/ConfirmDialog';
import ExcelImportModal from '../components/ExcelImportModal';
import PurchasePaymentModal from '../components/PurchasePaymentModal';
import EmptyState from '../components/EmptyState';

const statusColor: Record<string, string> = {
  received:  'bg-emerald-50 text-emerald-700 border border-emerald-100',
  pending:   'bg-amber-50  text-amber-700  border border-amber-100',
  cancelled: 'bg-red-50    text-red-700    border border-red-100',
};

export default function Purchases() {
  const { data: purchases, setData: setPurchases, loading, refreshing, error, setError, refresh: fetchPurchases } = useFetch<any>(api.purchases.list);
  const [search, setSearch]       = useState('');
  const [filter, setFilter]       = useState('all');
  const [showModal, setShowModal] = useState(false);
  const [viewPO, setViewPO]       = useState<any>(null);
  const [loadingId, setLoadingId] = useState<number | null>(null);

  const [paymentPO, setPaymentPO] = useState<any>(null);
  const [showImport, setShowImport] = useState(false);
  const [deletePO, setDeletePO]           = useState<any>(null);
  const deleteAction = useAsyncAction();
  const [receiveConfirm, setReceiveConfirm] = useState<any>(null);
  const [cancelConfirm, setCancelConfirm]   = useState<any>(null);
  const [actionLoading, setActionLoading]   = useState<number | null>(null);

  const handleView = async (id: number) => {
    setLoadingId(id);
    try { setViewPO(await api.purchases.get(id)); }
    catch (e: any) { setError(e.message); }
    finally { setLoadingId(null); }
  };

  const handleMarkReceived = async () => {
    if (!receiveConfirm) return;
    setActionLoading(receiveConfirm.id);
    setReceiveConfirm(null);
    try {
      await api.purchases.updateStatus(receiveConfirm.id, 'received');
      setPurchases(prev => prev.map(p => p.id === receiveConfirm.id ? { ...p, status: 'received' } : p));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancelPO = async () => {
    if (!cancelConfirm) return;
    setActionLoading(cancelConfirm.id);
    setCancelConfirm(null);
    try {
      await api.purchases.updateStatus(cancelConfirm.id, 'cancelled');
      setPurchases(prev => prev.map(p => p.id === cancelConfirm.id ? { ...p, status: 'cancelled' } : p));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = () => {
    if (!deletePO) return;
    const po = deletePO;
    setDeletePO(null);
    deleteAction.execute(
      () => api.purchases.delete(po.id),
      fetchPurchases
    );
  };

  const filtered = purchases.filter(p => {
    const matchSearch =
      (p.supplier_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (p.po_no || '').toLowerCase().includes(search.toLowerCase());
    const matchFilter = filter === 'all' || p.status === filter;
    return matchSearch && matchFilter;
  });
  const { paged, paginationProps } = usePagination(filtered);

  const { totalPurchased, totalPaid, totalOutstanding, pendingDelivery: pending } = calcPurchaseSummary(filtered);

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {[
          { label: 'Total Purchases',  value: formatCurrency(totalPurchased), color: 'text-slate-900',   help: `${filtered.length} orders` },
          { label: 'Total Paid Out',   value: formatCurrency(totalPaid),      color: 'text-emerald-600', help: 'Payments made' },
          { label: 'Outstanding',      value: formatCurrency(totalOutstanding), color: totalOutstanding > 0 ? 'text-amber-600' : 'text-emerald-600', help: 'Balance due to suppliers' },
          { label: 'Pending Delivery', value: formatCurrency(pending),        color: 'text-teal-600',  help: 'Awaiting receipt' },
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
            <h3 className="text-sm sm:text-base font-bold text-slate-900">Purchase Orders</h3>
            <div className="flex items-center gap-2">
              <button onClick={fetchPurchases} title="Refresh" className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
              </button>
              <button
                onClick={() => setShowImport(true)}
                title="Import purchase orders from Excel"
                className="flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <FileSpreadsheet size={14} />
                <span className="hidden sm:inline">Import Excel</span>
              </button>
              <button
                onClick={() => setShowModal(true)}
                title="Create a new purchase order"
                className="flex items-center gap-1.5 bg-teal-600 text-white text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-teal-700 transition-colors"
              >
                <Plus size={14} />
                <span className="hidden sm:inline">Receive Stock (GRN)</span>
                <span className="sm:hidden">New</span>
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search supplier or PO number..."
                className="pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 w-full"
              />
            </div>
            <select
              value={filter} onChange={e => setFilter(e.target.value)}
              title="Filter by delivery status"
              className="text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 sm:px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 flex-shrink-0"
            >
              <option value="all">All</option>
              <option value="received">Received</option>
              <option value="pending">Pending</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="mx-4 sm:mx-5 mt-4 flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            <AlertCircle size={15} className="flex-shrink-0" /><span>{error}</span>
          </div>
        )}

        {loading && !error && (
          <div className="p-4 space-y-2">
            {[1,2,3,4].map(i => <div key={i} className="h-12 bg-slate-100 rounded-lg animate-pulse" />)}
          </div>
        )}

        {!loading && <Pagination {...paginationProps} position="top" />}

        {!loading && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  {['PO Number', 'Date', 'Supplier', 'Total', 'Paid', 'Balance', 'Status', 'Actions'].map(h => (
                    <th key={h} className={`text-xs font-semibold text-slate-500 uppercase tracking-wider px-3 sm:px-4 py-3 text-left last:text-center ${
                      h === 'Paid' || h === 'Balance' ? 'hidden md:table-cell' : ''
                    }`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {paged.map(po => {
                  const paidAmt    = Number(po.amount_paid || 0);
                  const balanceDue = parseFloat((Number(po.total) - paidAmt).toFixed(2));
                  return (
                  <tr key={po.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-3 sm:px-4 py-3 sm:py-3.5">
                      <span className="text-xs sm:text-sm font-semibold text-teal-600">{po.po_no}</span>
                    </td>
                    <td className="px-3 sm:px-4 py-3 sm:py-3.5 text-xs sm:text-sm text-slate-600 hidden sm:table-cell whitespace-nowrap">{formatDate(po.date)}</td>
                    <td className="px-3 sm:px-4 py-3 sm:py-3.5 text-xs sm:text-sm font-medium text-slate-900 max-w-[130px] truncate">{po.supplier_name}</td>
                    <td className="px-3 sm:px-4 py-3 sm:py-3.5 text-xs sm:text-sm font-bold text-slate-900 whitespace-nowrap">{formatCurrency(po.total)}</td>
                    <td className="px-3 sm:px-4 py-3 sm:py-3.5 text-xs font-semibold text-emerald-600 whitespace-nowrap hidden md:table-cell">{formatCurrency(paidAmt)}</td>
                    <td className="px-3 sm:px-4 py-3 sm:py-3.5 text-xs font-semibold whitespace-nowrap hidden md:table-cell">
                      <span className={balanceDue > 0.005 ? 'text-amber-600' : 'text-emerald-600'}>
                        {formatCurrency(Math.max(0, balanceDue))}
                      </span>
                    </td>
                    <td className="px-3 sm:px-4 py-3 sm:py-3.5">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full capitalize ${statusColor[po.status] || ''}`}>
                        {po.status}
                      </span>
                    </td>
                    <td className="px-3 sm:px-4 py-3 sm:py-3.5">
                      <div className="flex items-center justify-center gap-0.5 sm:gap-1">
                        <button
                          onClick={() => handleView(po.id)}
                          disabled={loadingId === po.id}
                          title="View purchase order"
                          className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors disabled:opacity-40"
                        >
                          {loadingId === po.id ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
                        </button>

                        {/* Record Payment */}
                        {po.status !== 'cancelled' && balanceDue > 0.005 && (
                          <button
                            onClick={() => setPaymentPO(po)}
                            title="Record payment for this PO"
                            className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors"
                          >
                            <CreditCard size={14} />
                          </button>
                        )}

                        {/* Mark as Received (pending only) */}
                        {po.status === 'pending' && (
                          <button
                            onClick={() => setReceiveConfirm(po)}
                            disabled={actionLoading === po.id}
                            title="Mark as received — adds stock to inventory"
                            className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-40"
                          >
                            {actionLoading === po.id
                              ? <Loader2 size={14} className="animate-spin" />
                              : <PackageCheck size={14} />}
                          </button>
                        )}

                        {/* Cancel (pending only) */}
                        {po.status === 'pending' && (
                          <button
                            onClick={() => setCancelConfirm(po)}
                            disabled={actionLoading === po.id}
                            title="Cancel this purchase order"
                            className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors disabled:opacity-40 hidden sm:block"
                          >
                            <XCircle size={14} />
                          </button>
                        )}

                        <button
                          onClick={() => setDeletePO(po)}
                          title="Delete purchase order"
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <EmptyState message={purchases.length === 0 ? 'No purchase orders yet. Create your first PO.' : 'No records match your search.'} />
            )}
          </div>
        )}

        <Pagination {...paginationProps} position="bottom" />
      </div>

      {showImport && (
        <ExcelImportModal
          entity="purchases"
          onClose={() => setShowImport(false)}
          onImported={fetchPurchases}
        />
      )}
      {showModal && <GRNModal onClose={() => setShowModal(false)} onCreated={fetchPurchases} />}
      {viewPO    && <POViewModal po={viewPO} onClose={() => setViewPO(null)} />}
      {paymentPO && (
        <PurchasePaymentModal
          po={paymentPO}
          onClose={() => setPaymentPO(null)}
          onPaymentRecorded={(result) => {
            setPurchases(prev => prev.map(p =>
              p.id === result.payment?.purchase_id
                ? { ...p, amount_paid: result.new_amount_paid, status: result.new_status ?? p.status }
                : p
            ));
          }}
        />
      )}

      {receiveConfirm && (
        <ConfirmDialog
          title="Mark as Received"
          message={`Mark PO ${receiveConfirm.po_no} from ${receiveConfirm.supplier_name} as received? Stock quantities will be added to inventory.`}
          confirmLabel="Mark Received"
          variant="warning"
          onConfirm={handleMarkReceived}
          onCancel={() => setReceiveConfirm(null)}
        />
      )}

      {cancelConfirm && (
        <ConfirmDialog
          title="Cancel Purchase Order"
          message={`Cancel PO ${cancelConfirm.po_no}? If already received, stock will be reversed. This cannot be undone.`}
          confirmLabel="Cancel PO"
          variant="warning"
          onConfirm={handleCancelPO}
          onCancel={() => setCancelConfirm(null)}
        />
      )}

      {deletePO && (
        <ConfirmDialog
          title="Delete Purchase Order"
          message={`Delete PO ${deletePO.po_no}? If received, stock will be reversed. This cannot be undone.`}
          confirmLabel="Delete PO"
          variant="danger"
          loading={deleteAction.loading}
          onConfirm={handleDelete}
          onCancel={() => setDeletePO(null)}
        />
      )}
    </div>
  );
}
