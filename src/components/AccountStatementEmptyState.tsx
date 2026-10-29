import { BookOpen, Search } from 'lucide-react';
import { formatCurrency } from '../lib/utils';

export interface AccountOverview {
  receivable?: number | null;
  payable?: number | null;
  openAccounts: number;
}

interface Props {
  accountType: 'customer' | 'supplier';
  overview: AccountOverview;
  onSelectAccount: () => void;
}

// Shown in the statement panel while no account is selected. Figures come from the
// ledger summary API; a figure that is unavailable is omitted rather than invented.
export default function AccountStatementEmptyState({ accountType, overview, onSelectAccount }: Props) {
  const noun = accountType === 'customer' ? 'customer' : 'supplier';
  const stats = [
    { label: 'Outstanding receivables', value: overview.receivable != null ? formatCurrency(overview.receivable) : null },
    { label: 'Outstanding payables', value: overview.payable != null ? formatCurrency(overview.payable) : null },
    { label: `${accountType === 'customer' ? 'Customers' : 'Suppliers'} with a balance`, value: String(overview.openAccounts) },
  ].filter(s => s.value !== null);

  return (
    <div className="hidden lg:flex flex-1 min-w-0 bg-white rounded-2xl border border-slate-100 shadow-sm items-center justify-center p-6 xl:p-10">
      <div className="w-full max-w-xl text-center rounded-2xl bg-slate-50/70 border border-slate-100 px-6 py-10 xl:px-10">
        <div className="mx-auto w-16 h-16 rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center">
          <BookOpen className="w-8 h-8 text-teal-500" />
        </div>
        <h3 className="mt-5 text-lg font-bold text-slate-900">Select an Account</h3>
        <p className="mt-1.5 text-sm text-slate-500 max-w-sm mx-auto">
          Choose a {noun} to view outstanding balances, transactions, payments, and account history.
        </p>
        <button
          onClick={onSelectAccount}
          className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-teal-500 text-white text-sm font-semibold hover:bg-teal-600 transition-colors"
        >
          <Search size={14} /> Select an Account
        </button>

        {stats.length > 0 && (
          <div className={`mt-8 grid gap-3 ${stats.length === 3 ? 'grid-cols-3' : stats.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {stats.map(s => (
              <div key={s.label} className="rounded-xl bg-white border border-slate-100 px-3 py-3">
                <p className="text-base font-bold text-slate-900 truncate">{s.value}</p>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-tight">{s.label}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
