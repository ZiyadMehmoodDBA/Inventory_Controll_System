import { useEffect, useRef } from 'react';

/**
 * Closes a popup on a press anywhere outside `ref`'s element, or on Escape.
 * Listens on the document, so it also works for areas a full-screen backdrop cannot cover (the sidebar and bottom bar sit above the header).
 */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const press = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) close.current(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current(); };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', press, true); document.removeEventListener('keydown', key); };
  }, [open]);

  return ref;
}
