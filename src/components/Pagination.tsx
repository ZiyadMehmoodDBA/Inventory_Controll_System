import { ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE_OPTIONS = [10, 50, 100, 1000];

export interface PaginationProps {
  page:        number;
  totalPages:  number;
  from:        number;
  to:          number;
  total:       number;
  pageSize:    number;
  onPage:      (p: number) => void;
  onPageSize:  (size: number) => void;
  position?:   'top' | 'bottom';
}

function getPages(page: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | null)[] = [1];
  if (page > 3)          pages.push(null);
  const lo = Math.max(2, page - 1);
  const hi = Math.min(total - 1, page + 1);
  for (let i = lo; i <= hi; i++) pages.push(i);
  if (page < total - 2)  pages.push(null);
  pages.push(total);
  return pages;
}

function PageNav({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  const pages = getPages(page, totalPages);
  return (
    <div className="flex items-center gap-0.5 flex-shrink-0">
      <button
        onClick={() => onPage(page - 1)}
        disabled={page === 1}
        aria-label="Previous page"
        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <ChevronLeft size={14} />
      </button>

      {pages.map((p, idx) =>
        p === null ? (
          <span key={`e${idx}`} className="w-6 text-center text-xs text-slate-400 select-none">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onPage(p)}
            className={`min-w-[28px] h-7 px-1 rounded-lg text-xs font-semibold transition-colors ${
              p === page
                ? 'bg-teal-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {p}
          </button>
        )
      )}

      <button
        onClick={() => onPage(page + 1)}
        disabled={page === totalPages}
        aria-label="Next page"
        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

export default function Pagination({
  page, totalPages, from, to, total,
  pageSize, onPage, onPageSize,
  position = 'bottom',
}: PaginationProps) {
  if (total === 0) return null;

  /* ── TOP bar: [Show X ▾ records] ............. [← pages →] ── */
  if (position === 'top') {
    return (
      <div className="flex items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-5 py-2.5 flex-wrap border-b border-slate-100 bg-slate-50/60">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-xs text-slate-500">Show</span>
          <select
            value={pageSize}
            onChange={e => onPageSize(Number(e.target.value))}
            className="text-xs font-medium border border-slate-200 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-teal-500 cursor-pointer text-slate-700"
          >
            {PAGE_SIZE_OPTIONS.map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="text-xs text-slate-400 hidden sm:inline">records</span>
        </div>

        <PageNav page={page} totalPages={totalPages} onPage={onPage} />
      </div>
    );
  }

  /* ── BOTTOM bar: [← pages →] ............. [Showing X–Y of Z] ── */
  return (
    <div className="flex items-center justify-between gap-x-4 gap-y-2 px-4 sm:px-5 py-2.5 flex-wrap border-t border-slate-100">
      <PageNav page={page} totalPages={totalPages} onPage={onPage} />

      <p className="text-xs text-slate-500 whitespace-nowrap ml-auto">
        Showing{' '}
        <span className="font-semibold text-slate-700">{from}–{to}</span>
        {' '}of{' '}
        <span className="font-semibold text-slate-700">{total}</span>
      </p>
    </div>
  );
}
