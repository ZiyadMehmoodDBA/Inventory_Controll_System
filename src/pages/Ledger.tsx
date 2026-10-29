import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, Truck, Search, RefreshCw, ArrowUpRight, ArrowDownLeft,
  TrendingUp, DollarSign, X,
  FileText, CreditCard, ReceiptText, Phone, Mail, MapPin,
} from 'lucide-react';
import ErrorBanner from '../components/ErrorBanner';
import { api } from '../api/client';
import { formatCurrency, formatDate } from '../lib/utils';
import LedgerPaymentModal from '../components/LedgerPaymentModal';
import { useAutoRefresh } from '../lib/useAutoRefresh';
import { calcPaymentPct } from '../lib/calculations';
import EmptyState from '../components/EmptyState';
import AccountStatementEmptyState from '../components/AccountStatementEmptyState';
import AccountListEmptyState from '../components/AccountListEmptyState';

type Tab = 'receivables' | 'payables';

interface LedgerEntity {
  id: number;
  code: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  total_invoiced?: number;
  total_purchased?: number;
  total_paid: number;
  balance: number;
  invoice_count?: number;
  po_count?: number;
  unpaid_count?: number;
  partial_count?: number;
  last_transaction?: string;
}

interface StatementEntry {
  entry_date: string;
  entry_type: string;
  reference_no: string;
  description: string;
  debit: number;
  credit: number;
  running_balance: number;
}

interface Statement {
  entity: LedgerEntity;
  entries: StatementEntry[];
  summary: {
    total_invoiced?: number;
    total_purchased?: number;
    total_paid: number;
    balance_due: number;
  };
}

export default function Ledger() {
  const [tab,           setTab]           = useState<Tab>('receivables');
  const [customers,     setCustomers]     = useState<LedgerEntity[]>([]);
  const [suppliers,     setSuppliers]     = useState<LedgerEntity[]>([]);
  const [summary,       setSummary]       = useState<any>(null);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [error,         setError]         = useState('');
  const [search,        setSearch]        = useState('');
  const [selected,      setSelected]      = useState<LedgerEntity | null>(null);
  const [statement,     setStatement]     = useState<Statement | null>(null);
  const [stmtLoading,   setStmtLoading]   = useState(false);
  const [showPayModal,  setShowPayModal]  = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const fetchAll = useCallback(async () => {
    setRefreshing(true); setError('');
    try {
      const [cust, supp, summ] = await Promise.all([
        api.ledger.customers(),
        api.ledger.suppliers(),
        api.ledger.summary(),
      ]);
      setCustomers(cust);
      setSuppliers(supp);
      setSummary(summ);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useAutoRefresh(fetchAll);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  const loadStatement = async (entity: LedgerEntity) => {
    setSelected(entity);
    setStatement(null);
    setStmtLoading(true);
    try {
      const data = tab === 'receivables'
        ? await api.ledger.customerStatement(entity.id)
        : await api.ledger.supplierStatement(entity.id);
      setStatement(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setStmtLoading(false);
    }
  };

  const handleTabChange = (newTab: Tab) => {
    setTab(newTab);
    setSelected(null);
    setStatement(null);
    setSearch('');
  };

  const entities = tab === 'receivables' ? customers : suppliers;
  const filtered = entities.filter(e =>
    e.name.toLowerCase().includes(search.toLowerCase()) ||
    e.code.toLowerCase().includes(search.toLowerCase())
  );

  const balanceLabel = tab === 'receivables' ? 'Receivable' : 'Payable';

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-5">

      {/* ── Summary Cards ─────────────────────────────────────────────────── */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-teal-50 rounded-xl flex items-center justify-center">
                <ArrowUpRight size={15} className="text-teal-600" />
              </div>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Receivable</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{formatCurrency(summary.total_receivable)}</p>
            <p className="text-xs text-slate-400 mt-0.5">{summary.unpaid_count} unpaid · {summary.partial_count} partial</p>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-red-50 rounded-xl flex items-center justify-center">
                <ArrowDownLeft size={15} className="text-red-500" />
              </div>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Payable</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{formatCurrency(summary.total_payable)}</p>
            <p className="text-xs text-slate-400 mt-0.5">To suppliers</p>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 bg-emerald-50 rounded-xl flex items-center justify-center">
                <TrendingUp size={15} className="text-emerald-600" />
              </div>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Collected</span>
            </div>
            <p className="text-xl font-bold text-slate-900">{formatCurrency(summary.total_collected)}</p>
            <p className="text-xs text-slate-400 mt-0.5">From customers</p>
          </div>
          <div className="bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${summary.net_position >= 0 ? 'bg-teal-50' : 'bg-amber-50'}`}>
                <DollarSign size={15} className={summary.net_position >= 0 ? 'text-teal-600' : 'text-amber-600'} />
              </div>
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Net Position</span>
            </div>
            <p className={`text-xl font-bold ${summary.net_position >= 0 ? 'text-teal-700' : 'text-amber-700'}`}>
              {formatCurrency(summary.net_position)}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">Collected − Paid out</p>
          </div>
        </div>
      )}

      <ErrorBanner error={error} />

      {/* ── Main Panel ─────────────────────────────────────────────────────── */}
      <div className="flex gap-4" style={{ minHeight: '520px' }}>

        {/* Entity List */}
        <div className={`bg-white rounded-2xl border border-slate-100 shadow-sm flex flex-col w-full lg:w-80 xl:w-96 lg:flex-shrink-0 ${selected ? 'hidden lg:flex' : ''}`}>
          {/* Tabs */}
          <div className="flex border-b border-slate-100 p-1.5 gap-1">
            <button
              onClick={() => handleTabChange('receivables')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                tab === 'receivables' ? 'bg-teal-500 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50'
              }`}
            >
              <Users size={13} /> Receivables
            </button>
            <button
              onClick={() => handleTabChange('payables')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                tab === 'payables' ? 'bg-teal-500 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50'
              }`}
            >
              <Truck size={13} /> Payables
            </button>
          </div>

          {/* Search + Refresh */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-50">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={searchRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={`Search ${tab === 'receivables' ? 'customers' : 'suppliers'}...`}
                className="pl-7 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-500 w-full"
              />
            </div>
            <button
              onClick={fetchAll}
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 space-y-2">
                {[1,2,3,4,5].map(i => <div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse" />)}
              </div>
            ) : filtered.length === 0 ? (
              <AccountListEmptyState accountType={tab === 'receivables' ? 'customer' : 'supplier'} search={search} onClearSearch={() => { setSearch(''); searchRef.current?.focus(); }} />
            ) : (
              <ul className="p-2 space-y-0.5">
                {filtered.map(entity => (
                  <li key={entity.id}>
                    <button
                      onClick={() => loadStatement(entity)}
                      className={`w-full text-left px-3 py-3 rounded-xl transition-colors group ${
                        selected?.id === entity.id
                          ? 'bg-teal-50 border border-teal-100'
                          : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                            Number(entity.balance) > 0
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}>
                            {entity.name.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900 truncate">{entity.name}</p>
                            <p className="text-[11px] text-slate-400 mt-0.5 truncate">{entity.code}</p>
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0 ml-2">
                          <p className={`text-xs font-bold ${Number(entity.balance) > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {formatCurrency(Number(entity.balance))}
                          </p>
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            {Number(entity.balance) > 0 ? balanceLabel : 'Settled'}
                          </p>
                        </div>
                      </div>
                      {Number(entity.balance) > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="flex-1 bg-slate-100 rounded-full h-1.5">
                            <div
                              className="bg-teal-500 h-1.5 rounded-full"
                              style={{
                                width: `${calcPaymentPct(Number(entity.total_invoiced || entity.total_purchased || 0), entity.total_paid)}%`
                              }}
                            />
                          </div>
                          <span className="text-[10px] text-slate-400 flex-shrink-0">
                            {calcPaymentPct(Number(entity.total_invoiced || entity.total_purchased || 0), entity.total_paid)}% paid
                          </span>
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-slate-50 px-3 py-2.5 text-[11px] text-slate-400">
            {filtered.length} {tab === 'receivables' ? 'customers' : 'suppliers'} ·{' '}
            {formatCurrency(filtered.reduce((s, e) => s + Number(e.balance), 0))} outstanding
          </div>
        </div>

        {/* Statement Panel */}
        {selected && (
          <div className="flex-1 bg-white rounded-2xl border border-slate-100 shadow-sm flex flex-col min-w-0">
            {/* Statement Header */}
            <div className="flex items-start justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-10 h-10 bg-teal-50 rounded-xl flex items-center justify-center text-teal-700 font-bold text-sm flex-shrink-0">
                  {selected.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold text-slate-900">{selected.name}</h3>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1">
                    {selected.phone && (
                      <span className="flex items-center gap-1 text-[11px] text-slate-400">
                        <Phone size={10} />{selected.phone}
                      </span>
                    )}
                    {selected.email && (
                      <span className="flex items-center gap-1 text-[11px] text-slate-400">
                        <Mail size={10} />{selected.email}
                      </span>
                    )}
                    {selected.address && (
                      <span className="flex items-center gap-1 text-[11px] text-slate-400">
                        <MapPin size={10} />{selected.address}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="text-right">
                  <p className="text-[10px] text-slate-400 uppercase font-semibold tracking-wide">Balance</p>
                  <p className={`text-lg font-bold ${Number(selected.balance) > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    {formatCurrency(Number(selected.balance))}
                  </p>
                </div>
                {statement && statement.summary.balance_due > 0.005 && (
                  <button
                    onClick={() => setShowPayModal(true)}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-white rounded-xl transition-colors ${
                      tab === 'receivables' ? 'bg-teal-600 hover:bg-teal-700' : 'bg-teal-600 hover:bg-teal-700'
                    }`}
                  >
                    <CreditCard size={13} />
                    <span className="hidden sm:inline">Record Payment</span>
                  </button>
                )}
                <button
                  onClick={() => { setSelected(null); setStatement(null); }}
                  className="lg:hidden p-2 hover:bg-slate-100 rounded-lg transition-colors"
                >
                  <X size={15} className="text-slate-500" />
                </button>
              </div>
            </div>

            {/* Statement Summary */}
            {statement && (
              <div className="grid grid-cols-3 gap-0 border-b border-slate-100">
                {tab === 'receivables' ? (
                  <>
                    <div className="px-4 py-3 border-r border-slate-100 text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Total Invoiced</p>
                      <p className="text-sm font-bold text-slate-900">{formatCurrency(statement.summary.total_invoiced || 0)}</p>
                    </div>
                    <div className="px-4 py-3 border-r border-slate-100 text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Total Paid</p>
                      <p className="text-sm font-bold text-emerald-600">{formatCurrency(statement.summary.total_paid)}</p>
                    </div>
                    <div className="px-4 py-3 text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Balance Due</p>
                      <p className={`text-sm font-bold ${statement.summary.balance_due > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {formatCurrency(statement.summary.balance_due)}
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="px-4 py-3 border-r border-slate-100 text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Total Purchased</p>
                      <p className="text-sm font-bold text-slate-900">{formatCurrency(statement.summary.total_purchased || 0)}</p>
                    </div>
                    <div className="px-4 py-3 border-r border-slate-100 text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Total Paid Out</p>
                      <p className="text-sm font-bold text-emerald-600">{formatCurrency(statement.summary.total_paid)}</p>
                    </div>
                    <div className="px-4 py-3 text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Balance Due</p>
                      <p className={`text-sm font-bold ${statement.summary.balance_due > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                        {formatCurrency(statement.summary.balance_due)}
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Statement Table */}
            <div className="flex-1 overflow-auto">
              {stmtLoading ? (
                <div className="p-4 space-y-2">
                  {[1,2,3,4,5].map(i => <div key={i} className="h-10 bg-slate-100 rounded-lg animate-pulse" />)}
                </div>
              ) : !statement ? null : statement.entries.length === 0 ? (
                <EmptyState
                  icon={ReceiptText}
                  message="No transactions yet"
                  subtitle={tab === 'receivables' ? 'Create a sale to see activity here.' : 'Create a purchase order to see activity here.'}
                  className="h-48 py-0"
                />
              ) : (
                <table className="w-full min-w-[600px]">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-4 py-2.5 text-left">Date</th>
                      <th className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-4 py-2.5 text-left">Type</th>
                      <th className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-4 py-2.5 text-left">Reference</th>
                      <th className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-4 py-2.5 text-left hidden md:table-cell">Description</th>
                      <th className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-4 py-2.5 text-right">Debit</th>
                      <th className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-4 py-2.5 text-right">Credit</th>
                      <th className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider px-4 py-2.5 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {/* Opening balance row */}
                    <tr className="bg-slate-50/60">
                      <td colSpan={6} className="px-4 py-2 text-[11px] font-semibold text-slate-400 italic">Opening Balance</td>
                      <td className="px-4 py-2 text-[11px] font-bold text-slate-500 text-right">PKR 0</td>
                    </tr>
                    {statement.entries.map((entry, i) => {
                      const isPayment  = entry.entry_type === 'Payment';
                      const isPurchase = entry.entry_type === 'Purchase';
                      return (
                        <tr key={i} className={`hover:bg-slate-50/50 transition-colors ${isPayment ? 'bg-emerald-50/30' : ''}`}>
                          <td className="px-4 py-2.5 text-xs text-slate-600 whitespace-nowrap">{formatDate(entry.entry_date)}</td>
                          <td className="px-4 py-2.5">
                            <span className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                              isPayment || entry.entry_type === 'purchase_payment'
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                                : isPurchase
                                  ? 'bg-purple-50 text-purple-700 border border-purple-100'
                                  : 'bg-teal-50 text-teal-700 border border-teal-100'
                            }`}>
                              {isPayment || entry.entry_type === 'purchase_payment'
                                ? <><CreditCard size={9} /> Payment</>
                                : isPurchase
                                  ? <><FileText size={9} /> Purchase</>
                                  : <><ReceiptText size={9} /> Invoice</>}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs font-semibold text-slate-700">{entry.reference_no}</td>
                          <td className="px-4 py-2.5 text-xs text-slate-500 hidden md:table-cell max-w-[180px] truncate">{entry.description}</td>
                          <td className="px-4 py-2.5 text-xs font-semibold text-right">
                            {Number(entry.debit) > 0
                              ? <span className="text-slate-800">{formatCurrency(Number(entry.debit))}</span>
                              : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-xs font-semibold text-right">
                            {Number(entry.credit) > 0
                              ? <span className="text-emerald-600">{formatCurrency(Number(entry.credit))}</span>
                              : <span className="text-slate-300">—</span>}
                          </td>
                          <td className={`px-4 py-2.5 text-xs font-bold text-right whitespace-nowrap ${
                            entry.running_balance > 0 ? 'text-amber-600' : 'text-emerald-600'
                          }`}>
                            {formatCurrency(Math.abs(entry.running_balance))}
                            {entry.running_balance > 0 ? ' Dr' : entry.running_balance < 0 ? ' Cr' : ''}
                          </td>
                        </tr>
                      );
                    })}
                    {/* Closing balance */}
                    <tr className="bg-slate-50 border-t-2 border-slate-200">
                      <td colSpan={4} className="px-4 py-3 text-xs font-bold text-slate-700">Closing Balance</td>
                      <td className="px-4 py-3 text-xs font-bold text-slate-900 text-right">
                        {formatCurrency(statement.entries.reduce((s, e) => s + Number(e.debit), 0))}
                      </td>
                      <td className="px-4 py-3 text-xs font-bold text-emerald-600 text-right">
                        {formatCurrency(statement.entries.reduce((s, e) => s + Number(e.credit), 0))}
                      </td>
                      <td className={`px-4 py-3 text-sm font-bold text-right ${
                        statement.summary.balance_due > 0 ? 'text-amber-600' : 'text-emerald-600'
                      }`}>
                        {formatCurrency(statement.summary.balance_due)}
                        {statement.summary.balance_due > 0 ? ' Dr' : statement.summary.balance_due < 0 ? ' Cr' : ''}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* Empty state when nothing selected */}
        {!selected && !loading && (
          <AccountStatementEmptyState
            accountType={tab === 'receivables' ? 'customer' : 'supplier'}
            overview={{
              receivable: summary?.total_receivable ?? null,
              payable: summary?.total_payable ?? null,
              openAccounts: entities.filter(e => Number(e.balance) > 0).length,
            }}
            onSelectAccount={() => searchRef.current?.focus()}
          />
        )}
      </div>

      {showPayModal && selected && (
        <LedgerPaymentModal
          entity={{ id: selected.id, name: selected.name, code: selected.code }}
          type={tab === 'receivables' ? 'customer' : 'supplier'}
          onClose={() => setShowPayModal(false)}
          onPaymentRecorded={() => {
            setShowPayModal(false);
            loadStatement(selected);
            fetchAll();
          }}
        />
      )}
    </div>
  );
}
