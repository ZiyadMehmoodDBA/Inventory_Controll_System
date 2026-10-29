import { useState, useCallback } from 'react';

export function useAsyncAction() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const execute = useCallback(async (fn: () => Promise<void>, onSuccess?: () => void) => {
    setLoading(true);
    setError('');
    try {
      await fn();
      onSuccess?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, error, setError, execute };
}
