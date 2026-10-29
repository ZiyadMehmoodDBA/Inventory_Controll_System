import { useState, useEffect, useCallback, useRef } from 'react';
import { useAutoRefresh } from './useAutoRefresh';

export function useFetch<T>(apiFn: () => Promise<T[]>) {
  const [data, setData] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const hasLoaded = useRef(false);

  const refresh = useCallback(async () => {
    if (!hasLoaded.current) setLoading(true);
    setRefreshing(true);
    setError('');
    try {
      setData(await apiFn());
      hasLoaded.current = true;
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [apiFn]);

  useAutoRefresh(refresh);
  useEffect(() => { refresh(); }, [refresh]);

  return { data, setData, loading, refreshing, error, setError, refresh };
}
