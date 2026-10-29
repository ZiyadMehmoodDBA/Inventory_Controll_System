import { useEffect, useRef, useState } from 'react';
import { getCachedSettings } from './appSettings';

/**
 * Calls `callback` on a repeating interval based on the `refresh_interval`
 * setting (in seconds). Ticks every second so callers can show a countdown.
 *
 * Returns `secondsLeft` — the number of seconds until the next refresh.
 * Returns 0 when auto-refresh is disabled.
 */
export function useAutoRefresh(callback: () => void): { secondsLeft: number } {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const [secondsLeft, setSecondsLeft] = useState(0);
  const counterRef = useRef(0);

  useEffect(() => {
    const interval = Number(getCachedSettings().refresh_interval) || 0;
    if (interval <= 0) return;

    counterRef.current = interval;
    setSecondsLeft(interval);

    const id = setInterval(() => {
      counterRef.current -= 1;
      setSecondsLeft(counterRef.current);

      if (counterRef.current <= 0) {
        callbackRef.current();
        counterRef.current = interval;
        setSecondsLeft(interval);
      }
    }, 1000);

    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { secondsLeft };
}
