import { useState } from 'react';

const DEFAULT_PAGE_SIZE = 10;

export function usePagination<T>(items: T[], defaultPageSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage]                     = useState(1);
  const [pageSize, setPageSizeState]        = useState(defaultPageSize);

  const setPageSize = (size: number) => {
    setPageSizeState(size);
    setPage(1); // jump to first page whenever page size changes
  };

  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage   = Math.min(page, totalPages);
  const start      = (safePage - 1) * pageSize;
  const from       = items.length === 0 ? 0 : start + 1;
  const to         = Math.min(start + pageSize, items.length);

  return {
    paged: items.slice(start, start + pageSize),
    paginationProps: {
      page:       safePage,
      totalPages,
      from,
      to,
      total:      items.length,
      pageSize,
      onPage:     setPage,
      onPageSize: setPageSize,
    },
  };
}
