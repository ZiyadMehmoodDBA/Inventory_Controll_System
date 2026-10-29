import { SearchX, Users } from 'lucide-react';

interface Props {
  accountType: 'customer' | 'supplier';
  search: string;
  onClearSearch: () => void;
}

// Two distinct cases: the search matched nothing, or there are no accounts at all.
export default function AccountListEmptyState({ accountType, search, onClearSearch }: Props) {
  if (!search.trim()) {
    return (
      <div className="flex flex-col items-center justify-center text-center gap-1 h-48 px-6">
        <Users size={22} className="text-slate-300" />
        <p className="text-sm font-semibold text-slate-700">No {accountType}s yet</p>
        <p className="text-xs text-slate-400">Added {accountType}s will appear here.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center text-center gap-1 h-48 px-6">
      <SearchX size={22} className="text-slate-300" />
      <p className="text-sm font-semibold text-slate-700">No Accounts Found</p>
      <p className="text-xs text-slate-400">Try another name or account code.</p>
      <button onClick={onClearSearch} className="mt-2 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50">
        Clear search
      </button>
    </div>
  );
}
