import { useState, useEffect, useCallback } from 'react';
import {
  Search, Plus, AlertTriangle, CheckCircle, Package,
  RefreshCw, Pencil, Trash2, FileSpreadsheet, Download, SlidersHorizontal, History, ClipboardCheck, Tags, MapPin, ArrowRightLeft, CalendarClock, BarChart3, Layers, RotateCw, PackagePlus, ShieldCheck, Building2, FlaskConical, TrendingDown, LayoutDashboard,
} from 'lucide-react';
import { api } from '../api/client';
import { formatCurrency } from '../lib/utils';
import AddEditTireModal from '../components/AddEditTireModal';
import StockAdjustModal from '../components/StockAdjustModal';
import StockHistoryModal from '../components/StockHistoryModal';
import ProductHistoryModal from '../components/ProductHistoryModal';
import StockApprovalsModal from '../components/StockApprovalsModal';
import CategoriesModal from '../components/CategoriesModal';
import LocationsModal from '../components/LocationsModal';
import ExpiryModal from '../components/ExpiryModal';
import InventoryReportsModal from '../components/InventoryReportsModal';
import InventoryInsightsModal from '../components/InventoryInsightsModal';
import { usePermissions } from '../lib/permissions';
import ErrorBoundary from '../components/ErrorBoundary';
import StockTransferModal from '../components/StockTransferModal';
import StockControlModal from '../components/StockControlModal';
import RotationValuationModal from '../components/RotationValuationModal';
import ReplenishmentModal from '../components/ReplenishmentModal';
import QualityModal from '../components/QualityModal';
import HazmatModal from '../components/HazmatModal';
import LossModal from '../components/LossModal';
import WarehouseModal from '../components/WarehouseModal';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
import ExcelImportModal from '../components/ExcelImportModal';
import CatalogImportModal from '../components/CatalogImportModal';
import { useModules, useTerms } from '../lib/businessTypes';
import { usePagination } from '../lib/usePagination';
import Pagination from '../components/Pagination';
import ErrorBanner from '../components/ErrorBanner';
import TableSkeleton from '../components/TableSkeleton';
import { useFetch } from '../lib/useFetch';
import { useAsyncAction } from '../lib/useAsyncAction';

export default function Inventory() {
  const { data: tires, loading, refreshing, error, refresh: fetchTires } = useFetch<any>(api.inventory.list);
  const deleteAction = useAsyncAction();

  const [search, setSearch]         = useState('');
  const [filterType, setFilterType] = useState('all');

  const [addModal, setAddModal]     = useState(false);
  const [editTire, setEditTire]     = useState<any>(null);
  const [deleteTire, setDeleteTire] = useState<any>(null);
  const [showImport, setShowImport]             = useState(false);
  const [showCatalogImport, setShowCatalogImport] = useState(false);
  const [adjustTire, setAdjustTire]   = useState<any>(null);
  const [historyTire, setHistoryTire] = useState<any>(null);
  const [changesTire, setChangesTire] = useState<any>(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterKind, setFilterKind]     = useState('all');
  const [exporting, setExporting]       = useState(false);
  const [showApprovals, setShowApprovals] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [showLocations, setShowLocations] = useState(false);
  const [showExpiry, setShowExpiry]       = useState(false);
  const [showReports, setShowReports]     = useState(false);
  const [showInsights, setShowInsights]   = useState(false);
  const [criticalCount, setCriticalCount] = useState(0);
  const [showRotation, setShowRotation]   = useState(false);
  const [showReplenish, setShowReplenish] = useState(false);
  const [showQuality, setShowQuality]     = useState(false);
  const [showHazmat, setShowHazmat]       = useState(false);
  const [showLosses, setShowLosses]       = useState(false);
  const [lossAlerts, setLossAlerts]       = useState(0);
  const [showWarehouse, setShowWarehouse] = useState(false);
  const [transitCount, setTransitCount]   = useState(0);
  const refreshTransit = useCallback(() => { api.inventory.warehouse.inTransit().then((t: any) => setTransitCount(t.count ?? 0)).catch(() => {}); }, []);
  useEffect(() => { refreshTransit(); }, [refreshTransit]);
  const refreshLosses = useCallback(() => { api.inventory.losses.alerts().then((a: any) => setLossAlerts(a.needs_attention ?? 0)).catch(() => {}); }, []);
  useEffect(() => { refreshLosses(); }, [refreshLosses]);
  const [hazmatAlerts, setHazmatAlerts]   = useState<number | null>(null);
  const refreshHazmat = useCallback(() => { api.inventory.hazmat.compliance().then((a: any) => setHazmatAlerts(a.needs_attention ?? 0)).catch(() => {}); }, []);
  useEffect(() => { refreshHazmat(); }, [refreshHazmat]);
  const [qualityAlerts, setQualityAlerts] = useState(0);
  const refreshQuality = useCallback(() => { api.inventory.quality.alerts().then((a: any) => setQualityAlerts(a.needs_attention ?? 0)).catch(() => {}); }, []);
  useEffect(() => { refreshQuality(); }, [refreshQuality]);
  const [showControl, setShowControl]     = useState(false);
  const [controlTire, setControlTire]     = useState<number | undefined>(undefined);
  const [transferFor, setTransferFor]     = useState<{ tireId?: number } | null>(null);
  const [locationCount, setLocationCount] = useState(1);
  const [pendingCount, setPendingCount]   = useState(0);
  // The API enforces every permission; these only decide which actions are offered.
  const { can, canAny, role } = usePermissions();
  const canApprove = can('stock.approve');
  const canEditItems = can('inventory.manage_items');
  const canDeleteItems = can('inventory.delete_items');
  const canAdjust = canAny('stock.adjust_request', 'stock.adjust_direct');
  const seesCost = can('inventory.view_cost');

  const loadPending = useCallback(() => {
    if (!canApprove) return;
    api.inventory.adjustments('pending').then(r => setPendingCount(r.length)).catch(() => {});
  }, [canApprove]);
  useEffect(() => { loadPending(); }, [loadPending]);
  useEffect(() => { api.inventory.insights.dashboard().then(d => setCriticalCount(d.exception_counts?.critical ?? 0)).catch(() => {}); }, [showInsights]);

  const refreshLocations = useCallback(() => {
    api.inventory.locations().then(ls => setLocationCount(ls.filter(l => l.is_active).length)).catch(() => {});
  }, []);
  useEffect(() => { refreshLocations(); }, [refreshLocations]);
  const modules = useModules();
  const terms   = useTerms();
  // Tyre shops group items by tyre type; every other business by category.
  const [catNames, setCatNames] = useState<Record<number, string>>({});
  useEffect(() => {
    if (terms.tyre) return;
    api.inventory.categories().then(cs => setCatNames(Object.fromEntries(cs.map(c => [c.id, c.name])))).catch(() => {});
  }, [terms.tyre, showCategories]);
  const groupOf = (t: any): string => terms.tyre ? (t.type || '') : (catNames[t.category_id] ?? '');

  const handleDelete = () => {
    if (!deleteTire) return;
    const tire = deleteTire;
    setDeleteTire(null);
    deleteAction.execute(
      () => api.inventory.delete(tire.id),
      fetchTires,
    );
  };

  const types    = ['all', ...Array.from(new Set(tires.map((t: any) => groupOf(t)).filter(Boolean)))];
  const q        = search.toLowerCase();
  const filtered = tires.filter((t: any) => {
    const matchSearch =
      (t.brand   || '').toLowerCase().includes(q) ||
      (t.model   || '').toLowerCase().includes(q) ||
      (t.size    || '').toLowerCase().includes(q) ||
      (t.pattern || '').toLowerCase().includes(q) ||
      (t.sku     || '').toLowerCase().includes(q) ||
      (t.barcode || '').toLowerCase().includes(q) ||
      (t.manufacturer || '').toLowerCase().includes(q);
    const matchType = filterType === 'all' || groupOf(t) === filterType;
    const matchStatus = filterStatus === 'all' || (t.status || 'active') === filterStatus;
    const matchKind = filterKind === 'all' || (t.item_type || 'finished_good') === filterKind;
    return matchSearch && matchType && matchStatus && matchKind;
  });
  const { paged, paginationProps } = usePagination(filtered);

  const totalValue = tires.reduce((s: number, t: any) => s + (Number(t.stock) * Number(t.cost_price)), 0);
  const totalItems = tires.reduce((s: number, t: any) => s + Number(t.stock), 0);
  const lowStock   = tires.filter((t: any) => Number(t.stock) <= Number(t.reorder_level)).length;

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        {[
          { label: 'Stock Value',  value: seesCost ? formatCurrency(totalValue) : '—', color: 'text-slate-900',
            help: 'Total inventory at cost price' },
          { label: 'Total Units',  value: `${totalItems} pcs`,        color: 'text-teal-600',
            help: 'Sum of all units in warehouse' },
          { label: 'Low Stock',    value: `${lowStock} SKUs`,
            color: lowStock > 0 ? 'text-red-600' : 'text-emerald-600',
            help: 'Items at or below reorder level' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl p-3 sm:p-4 border border-slate-100 shadow-sm">
            <p className="text-xs text-slate-500 font-medium truncate">{s.label}</p>
            <p className={`text-sm sm:text-xl font-bold mt-1 ${s.color} truncate`}>{s.value}</p>
            <p className="text-xs text-slate-400 mt-0.5 hidden sm:block truncate">{s.help}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
        {/* Toolbar */}
        <div className="flex flex-col gap-3 p-4 sm:p-5 border-b border-slate-100">
          <div className="flex items-center justify-between">
            <h3 className="text-sm sm:text-base font-bold text-slate-900">{terms.catalog}</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchTires}
                title="Refresh"
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
              </button>
              {canEditItems && modules.tyreCatalog && <button
                onClick={() => setShowCatalogImport(true)}
                title="Import from Tire Catalog"
                className="flex items-center gap-1.5 bg-emerald-50 text-emerald-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-emerald-100 transition-colors border border-emerald-200"
              >
                <Download size={14} />
                <span className="hidden sm:inline">Catalog Import</span>
              </button>}
              <button
                onClick={async () => { setExporting(true); try { const b = await api.inventory.exportCsv(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'products-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); URL.revokeObjectURL(a.href); } catch (e: any) { alert(e.message); } finally { setExporting(false); } }}
                disabled={exporting}
                title="Export products to CSV"
                className="flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors disabled:opacity-60"
              >
                <Download size={14} />
                <span className="hidden sm:inline">Export</span>
              </button>
              {canEditItems && (<button
                onClick={() => setShowImport(true)}
                title="Import from Excel"
                className="flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <FileSpreadsheet size={14} />
                <span className="hidden sm:inline">Import Excel</span>
              </button>)}
              <button
                onClick={() => { setControlTire(undefined); setShowControl(true); }}
                title="Stock position, reservations, in-transit transfers and counts"
                className="flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <Layers size={14} />
                <span className="hidden sm:inline">Stock Control</span>
              </button>
              <button
                onClick={() => setShowWarehouse(true)}
                title="Warehouses and locations: stock by branch, transfers, in-transit stock, counts and location access"
                className="relative flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <Building2 size={14} />
                <span className="hidden sm:inline">Warehouses</span>
                {transitCount > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold flex items-center justify-center">{transitCount > 99 ? '99+' : transitCount}</span>}
              </button>
              <button
                onClick={() => setShowLosses(true)}
                title="Waste, damage and obsolete stock: write-offs, aging, supplier returns and loss patterns"
                className="relative flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <TrendingDown size={14} />
                <span className="hidden sm:inline">Losses</span>
                {lossAlerts > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{lossAlerts > 99 ? '99+' : lossAlerts}</span>}
              </button>
              <button
                onClick={() => setShowHazmat(true)}
                title="Hazardous materials: classes, permitted locations, segregation, inspections and incidents"
                className="relative flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <FlaskConical size={14} />
                <span className="hidden sm:inline">Hazmat</span>
                {!!hazmatAlerts && <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{hazmatAlerts > 99 ? '99+' : hazmatAlerts}</span>}
              </button>
              <button
                onClick={() => setShowQuality(true)}
                title="Expiry, shelf life and quality: alerts, holds, recalls, inspections and disposals"
                className="relative flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <ShieldCheck size={14} />
                <span className="hidden sm:inline">Quality</span>
                {qualityAlerts > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{qualityAlerts > 99 ? '99+' : qualityAlerts}</span>}
              </button>
              {canAny('replenishment.view', 'replenishment.approve') && (<button
                onClick={() => setShowReplenish(true)}
                title="Replenishment: what to reorder, how much, and from which supplier"
                className="flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <PackagePlus size={14} />
                <span className="hidden sm:inline">Replenish</span>
              </button>)}
              <button
                onClick={() => setShowRotation(true)}
                title="Stock rotation policy, pick guide, stock age, expiry exposure and valuation policy"
                className="flex items-center gap-1.5 bg-slate-100 text-slate-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-200 transition-colors"
              >
                <RotateCw size={14} />
                <span className="hidden sm:inline">Rotation</span>
              </button>
              {can('reports.inventory') && (<button
                onClick={() => setShowInsights(true)}
                title="Exceptions that need a decision, key figures and the standard inventory reports"
                className="relative flex items-center gap-1.5 bg-indigo-600 text-white text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-indigo-700 transition-colors"
              >
                <LayoutDashboard size={14} />
                <span className="hidden sm:inline">Dashboard</span>
                {criticalCount > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center" aria-label={`${criticalCount} critical exceptions`}>{criticalCount}</span>}
              </button>)}
              {can('reports.valuation') && (<button
                onClick={() => setShowReports(true)}
                title="Stock value, reorder suggestions and margin"
                className="flex items-center gap-1.5 bg-white text-slate-600 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors border border-slate-200"
              >
                <BarChart3 size={14} />
                <span className="hidden sm:inline">Reports</span>
              </button>)}
              <button
                onClick={() => setShowExpiry(true)}
                title="Expired and soon-to-expire stock"
                className="flex items-center gap-1.5 bg-white text-slate-600 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors border border-slate-200"
              >
                <CalendarClock size={14} />
                <span className="hidden sm:inline">Expiry</span>
              </button>
              {locationCount > 1 && can('stock.transfer') && (
                <button
                  onClick={() => setTransferFor({})}
                  title="Transfer stock between locations"
                  className="flex items-center gap-1.5 bg-white text-slate-600 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors border border-slate-200"
                >
                  <ArrowRightLeft size={14} />
                  <span className="hidden sm:inline">Transfer</span>
                </button>
              )}
              {can('locations.manage') && (
                <button
                  onClick={() => setShowLocations(true)}
                  title="Manage stock locations"
                  className="flex items-center gap-1.5 bg-white text-slate-600 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors border border-slate-200"
                >
                  <MapPin size={14} />
                  <span className="hidden sm:inline">Locations</span>
                </button>
              )}
              {canEditItems && (
                <button
                  onClick={() => setShowCategories(true)}
                  title="Manage categories"
                  className="flex items-center gap-1.5 bg-white text-slate-600 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors border border-slate-200"
                >
                  <Tags size={14} />
                  <span className="hidden sm:inline">Categories</span>
                </button>
              )}
              {canApprove && (
                <button
                  onClick={() => setShowApprovals(true)}
                  title="Stock adjustment approvals"
                  className="relative flex items-center gap-1.5 bg-amber-50 text-amber-700 text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-amber-100 transition-colors border border-amber-200"
                >
                  <ClipboardCheck size={14} />
                  <span className="hidden sm:inline">Approvals</span>
                  {pendingCount > 0 && <span className="bg-amber-500 text-white text-[10px] font-bold rounded-full px-1.5">{pendingCount}</span>}
                </button>
              )}
              {canEditItems && (<button
                onClick={() => setAddModal(true)}
                title={`Add new ${terms.item.toLowerCase()}`}
                className="flex items-center gap-1.5 bg-teal-600 text-white text-xs sm:text-sm font-medium px-2.5 sm:px-3 py-2 rounded-lg hover:bg-teal-700 transition-colors"
              >
                <Plus size={14} />
                <span className="hidden sm:inline">{terms.addLabel}</span>
                <span className="sm:hidden">Add</span>
              </button>)}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search brand, model, size, SKU, or barcode…"
                className="pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 w-full"
              />
            </div>
            <select
              value={filterType} onChange={e => setFilterType(e.target.value)}
              title={`Filter by ${terms.tyre ? 'tyre type' : 'category'}`}
              className="text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 sm:px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 flex-shrink-0"
            >
              {types.map(t => <option key={t} value={t}>{t === 'all' ? (terms.tyre ? 'All Types' : 'All Categories') : t}</option>)}
            </select>
            <select value={filterKind} onChange={e => setFilterKind(e.target.value)} title="Filter by item type" className="hidden sm:block text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 sm:px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 flex-shrink-0">
              <option value="all">All item types</option><option value="finished_good">Finished goods</option><option value="raw_material">Raw material</option><option value="consumable">Consumable</option>
              <option value="packaging">Packaging</option><option value="component">Component</option><option value="spare_part">Spare part</option><option value="other">Other</option>
            </select>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} title="Filter by status" className="text-sm bg-slate-50 border border-slate-200 rounded-lg px-2 sm:px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 flex-shrink-0">
              <option value="all">Any status</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="discontinued">Discontinued</option>
            </select>
          </div>
        </div>

        {(error || deleteAction.error) && (
          <ErrorBanner error={error || deleteAction.error} className="mx-4 sm:mx-5 mt-4" />
        )}

        {loading && !error && <TableSkeleton rows={5} />}

        {!loading && <Pagination {...paginationProps} position="top" />}

        {!loading && (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100">
                    {[terms.brand, terms.tyre ? 'Model / Pattern' : terms.name, terms.tyre ? 'Size & Spec' : terms.size, terms.tyre ? 'Type' : 'Category','Stock','Cost','Sale Price','Margin','Status',''].map(h => (
                      <th key={h} className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-4 py-3 text-left last:w-16">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {paged.map((tire: any) => {
                    const isLow  = Number(tire.stock) <= Number(tire.reorder_level);
                    const costP  = Number(tire.cost_price);
                    const saleP  = Number(tire.sale_price);
                    const margin = costP > 0 ? ((saleP - costP) / costP * 100).toFixed(1) : '0.0';
                    const spec   = [tire.load_index, tire.speed_index].filter(Boolean).join('');

                    return (
                      <tr key={tire.id} className="hover:bg-slate-50/50 transition-colors group">
                        {/* Brand */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
                              <Package size={14} className="text-slate-500" />
                            </div>
                            <div>
                              <span className="text-sm font-semibold text-slate-900 whitespace-nowrap">{tire.brand}</span>
                              <p className="text-[11px] text-slate-400 font-mono leading-tight">{tire.sku}{tire.tracking && tire.tracking !== 'none' && <span className="ml-1.5 text-teal-700 font-sans font-semibold">{tire.tracking === 'serial' ? 'serial' : 'batch'}{tire.track_expiry ? ' · expiry' : ''}</span>}{tire.status && tire.status !== 'active' && <span className="ml-1.5 text-amber-600 font-sans font-semibold">{tire.status}</span>}{tire.min_stock != null && Number(tire.stock) < Number(tire.min_stock) && <span className="ml-1.5 text-red-600 font-sans font-semibold">below min</span>}{tire.max_stock != null && Number(tire.stock) > Number(tire.max_stock) && <span className="ml-1.5 text-blue-600 font-sans font-semibold">over max</span>}</p>
                            </div>
                          </div>
                        </td>

                        {/* Model + Pattern */}
                        <td className="px-4 py-3">
                          <p className="text-sm text-slate-800 font-medium leading-tight">{tire.model}</p>
                          {tire.pattern && (
                            <p className="text-xs text-slate-400 mt-0.5 leading-tight">{tire.pattern}</p>
                          )}
                        </td>

                        {/* Size + Load/Speed */}
                        <td className="px-4 py-3">
                          <span className="text-xs font-mono bg-slate-100 text-slate-700 px-2 py-0.5 rounded">{tire.size}</span>
                          {spec && (
                            <span className="ml-1 text-xs font-mono font-semibold text-slate-500">{spec}</span>
                          )}
                          {tire.dot && (
                            <p className="text-[10px] text-slate-400 mt-0.5 font-mono">DOT {tire.dot}</p>
                          )}
                        </td>

                        {/* Type */}
                        <td className="px-4 py-3">
                          <span className="text-xs font-medium bg-teal-50 text-teal-700 px-2 py-0.5 rounded-full whitespace-nowrap">{groupOf(tire) || '—'}</span>
                        </td>

                        {/* Stock */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-sm font-bold ${isLow ? 'text-red-600' : 'text-slate-900'}`}>{tire.stock}</span>
                            {Number(tire.available) !== Number(tire.stock) && <button type="button" onClick={() => { setControlTire(tire.id); setShowControl(true); }} title="Not all on hand is available: reserved, quarantined or expired stock. Click for the position." className="ml-1.5 text-[10px] font-semibold text-emerald-600 hover:underline">{tire.available} avail</button>}
                            {isLow && <AlertTriangle size={12} className="text-red-500" aria-label={`Reorder at ${tire.reorder_level}`} />}
                          </div>
                          <div className="w-16 h-1.5 bg-slate-100 rounded-full mt-1">
                            <div
                              className={`h-full rounded-full ${isLow ? 'bg-red-400' : 'bg-emerald-400'}`}
                              style={{ width: `${Math.min((Number(tire.stock) / 80) * 100, 100)}%` }}
                            />
                          </div>
                        </td>

                        {/* Cost */}
                        <td className="px-4 py-3 text-sm text-slate-500">{seesCost ? formatCurrency(costP) : '—'}</td>

                        {/* Sale Price */}
                        <td className="px-4 py-3 text-sm font-semibold text-slate-900">{formatCurrency(saleP)}</td>

                        {/* Margin */}
                        <td className="px-4 py-3">
                          <span className={`text-sm font-semibold ${Number(margin) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {seesCost ? `${Number(margin) >= 0 ? '+' : ''}${margin}%` : '—'}
                          </span>
                        </td>

                        {/* Status */}
                        <td className="px-4 py-3">
                          <span className={`flex items-center gap-1 text-xs font-semibold whitespace-nowrap ${isLow ? 'text-red-600' : 'text-emerald-600'}`}>
                            {isLow ? <AlertTriangle size={12} /> : <CheckCircle size={12} />}
                            {isLow ? 'Low Stock' : 'In Stock'}
                          </span>
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {canAdjust && (<button
                              onClick={() => setAdjustTire(tire)}
                              title="Adjust stock"
                              className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                            >
                              <SlidersHorizontal size={14} />
                            </button>)}
                            <button
                              onClick={() => setChangesTire(tire)}
                              title="Change history"
                              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                            >
                              <ClipboardCheck size={14} />
                            </button>
                            <button
                              onClick={() => setHistoryTire(tire)}
                              title="Stock history"
                              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                            >
                              <History size={14} />
                            </button>
                            {canEditItems && (<button
                              onClick={() => setEditTire(tire)}
                              title="Edit"
                              className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors"
                            >
                              <Pencil size={14} />
                            </button>)}
                            {canDeleteItems && (<button
                              onClick={() => setDeleteTire(tire)}
                              title="Delete"
                              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            >
                              <Trash2 size={14} />
                            </button>)}
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
              {paged.map((tire: any) => {
                const isLow  = Number(tire.stock) <= Number(tire.reorder_level);
                const costP  = Number(tire.cost_price);
                const saleP  = Number(tire.sale_price);
                const margin = costP > 0 ? ((saleP - costP) / costP * 100).toFixed(1) : '0.0';
                const spec   = [tire.load_index, tire.speed_index].filter(Boolean).join('');

                return (
                  <div key={tire.id} className="p-4 flex items-start gap-3">
                    <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Package size={16} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-bold text-slate-900 leading-tight">{tire.brand} {tire.model}</p>
                          {tire.pattern && (
                            <p className="text-xs text-slate-400 mt-0.5 leading-tight">{tire.pattern}</p>
                          )}
                          <p className="text-xs text-slate-500 mt-1 font-mono">
                            {tire.size}{spec ? ` ${spec}` : ''}
                            <span className="font-sans text-teal-600 ml-1.5">{groupOf(tire)}</span>
                          </p>
                          {tire.dot && (
                            <p className="text-[10px] text-slate-400 font-mono mt-0.5">DOT {tire.dot}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {canAdjust && (<button onClick={() => setAdjustTire(tire)} title="Adjust stock"
                            className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors">
                            <SlidersHorizontal size={13} />
                          </button>)}
                          <button onClick={() => setHistoryTire(tire)} title="Stock history"
                            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                            <History size={13} />
                          </button>
                          {canEditItems && (<button onClick={() => setEditTire(tire)} title="Edit"
                            className="p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors">
                            <Pencil size={13} />
                          </button>)}
                          {canDeleteItems && (<button onClick={() => setDeleteTire(tire)} title="Delete"
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                            <Trash2 size={13} />
                          </button>)}
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 mt-2.5">
                        <div>
                          <p className="text-xs text-slate-400">Stock</p>
                          <p className={`text-sm font-bold ${isLow ? 'text-red-600' : 'text-slate-900'}`}>{tire.stock}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-400">Sale Price</p>
                          <p className="text-sm font-semibold text-slate-900">{formatCurrency(saleP)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-400">Margin</p>
                          <p className={`text-sm font-semibold ${Number(margin) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {seesCost ? `${Number(margin) >= 0 ? '+' : ''}${margin}%` : '—'}
                          </p>
                        </div>
                      </div>
                      {isLow && (
                        <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-red-600">
                          <AlertTriangle size={11} /> Low stock — reorder at {tire.reorder_level}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {filtered.length === 0 && (
              <EmptyState
                icon={Package}
                message={tires.length === 0 ? `No ${terms.items.toLowerCase()} yet. Add your first ${terms.item.toLowerCase()}.` : 'No items match your search.'}
              />
            )}
          </>
        )}

        <Pagination {...paginationProps} position="bottom" />
        {lowStock > 0 && (
          <span className="px-4 pb-3 flex items-center gap-1 text-xs text-red-600 font-semibold">
            <AlertTriangle size={11} /> {lowStock} need reorder
          </span>
        )}
      </div>

      {showImport && (
        <ExcelImportModal
          entity="inventory"
          onClose={() => setShowImport(false)}
          onImported={fetchTires}
        />
      )}

      {showCatalogImport && modules.tyreCatalog && (
        <CatalogImportModal
          onClose={() => setShowCatalogImport(false)}
          onImported={fetchTires}
        />
      )}

      {(addModal || editTire) && (
        <AddEditTireModal
          tire={editTire ?? undefined}
          onClose={() => { setAddModal(false); setEditTire(null); }}
          onSaved={fetchTires}
        />
      )}

      {adjustTire && (
        <StockAdjustModal tire={adjustTire} onClose={() => setAdjustTire(null)} onDone={() => { fetchTires(); loadPending(); }} />
      )}
      {changesTire && <ProductHistoryModal tire={changesTire} onClose={() => setChangesTire(null)} />}
      {historyTire && <StockHistoryModal tire={historyTire} onClose={() => setHistoryTire(null)} />}
      {showControl && <ErrorBoundary label="Stock control" onClose={() => setShowControl(false)}><StockControlModal initialTireId={controlTire} onClose={() => setShowControl(false)} onChanged={fetchTires} /></ErrorBoundary>}
      {showReplenish && <ErrorBoundary label="Replenishment" onClose={() => setShowReplenish(false)}><ReplenishmentModal role={role} onClose={() => setShowReplenish(false)} onChanged={fetchTires} /></ErrorBoundary>}
      {showWarehouse && <ErrorBoundary label="Warehouses" onClose={() => { setShowWarehouse(false); refreshTransit(); }}><WarehouseModal role={role} onClose={() => { setShowWarehouse(false); refreshTransit(); }} onChanged={() => { fetchTires(); refreshTransit(); }} /></ErrorBoundary>}
      {showLosses && <ErrorBoundary label="Losses" onClose={() => { setShowLosses(false); refreshLosses(); }}><LossModal role={role} onClose={() => { setShowLosses(false); refreshLosses(); }} onChanged={() => { fetchTires(); refreshLosses(); }} /></ErrorBoundary>}
      {showHazmat && <ErrorBoundary label="Hazardous materials" onClose={() => { setShowHazmat(false); refreshHazmat(); }}><HazmatModal role={role} onClose={() => { setShowHazmat(false); refreshHazmat(); }} onChanged={() => { fetchTires(); refreshHazmat(); }} /></ErrorBoundary>}
      {showQuality && <ErrorBoundary label="Expiry and quality" onClose={() => { setShowQuality(false); refreshQuality(); }}><QualityModal role={role} onClose={() => { setShowQuality(false); refreshQuality(); }} onChanged={() => { fetchTires(); refreshQuality(); }} /></ErrorBoundary>}
      {showRotation && <ErrorBoundary label="Rotation and valuation" onClose={() => setShowRotation(false)}><RotationValuationModal role={role} onClose={() => setShowRotation(false)} onChanged={fetchTires} /></ErrorBoundary>}
      {showInsights && <ErrorBoundary label="Inventory dashboard" onClose={() => setShowInsights(false)}><InventoryInsightsModal role={role} onClose={() => setShowInsights(false)} onOpen={t => {
        setShowInsights(false);
        if (t === 'replenishment') setShowReplenish(true); else if (t === 'quality') setShowQuality(true); else if (t === 'losses') setShowLosses(true);
        else if (t === 'warehouse') setShowWarehouse(true); else if (t === 'approvals') setShowApprovals(true); else if (t === 'control') { setControlTire(undefined); setShowControl(true); }
      }} /></ErrorBoundary>}
      {showReports && <ErrorBoundary label="Inventory reports" onClose={() => setShowReports(false)}><InventoryReportsModal isAdmin={role === 'org_admin'} onClose={() => setShowReports(false)} /></ErrorBoundary>}
      {showExpiry && <ErrorBoundary label="The expiry report" onClose={() => setShowExpiry(false)}><ExpiryModal onClose={() => setShowExpiry(false)} /></ErrorBoundary>}
      {showLocations && <LocationsModal onClose={() => setShowLocations(false)} onChanged={refreshLocations} />}
      {transferFor && <StockTransferModal initialTireId={transferFor.tireId} onClose={() => setTransferFor(null)} onDone={() => { fetchTires(); refreshLocations(); }} />}
      {showCategories && <CategoriesModal onClose={() => setShowCategories(false)} onChanged={() => {}} />}
      {showApprovals && <StockApprovalsModal onClose={() => setShowApprovals(false)} onChanged={() => { fetchTires(); loadPending(); }} />}

      {deleteTire && (
        <ConfirmDialog
          title={`Delete ${terms.item}`}
          message={`Delete "${deleteTire.brand} ${deleteTire.model} ${deleteTire.size}"? This cannot be undone. Items used in existing sales or purchases cannot be deleted, and stock must be zero.`}
          confirmLabel="Delete SKU"
          variant="danger"
          loading={deleteAction.loading}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTire(null)}
        />
      )}
    </div>
  );
}
