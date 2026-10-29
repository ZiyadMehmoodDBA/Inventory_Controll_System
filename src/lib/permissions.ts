import { useSyncExternalStore } from 'react';
import { api } from '../api/client';

// What the signed-in user may do, as reported by the API (GET /access/me). The screens use it to show or hide actions;
// the API enforces every permission itself, so hiding an action here is a convenience and never the protection.
interface Access { loaded: boolean; role: string; roleName: string; permissions: Set<string>; approvalLimit: number | null }
const EMPTY: Access = { loaded: false, role: '', roleName: '', permissions: new Set(), approvalLimit: null };
let state: Access = EMPTY;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export async function loadAccess(): Promise<void> {
  try {
    const me = await api.access.me();
    state = { loaded: true, role: me.role, roleName: me.role_name, permissions: new Set(me.permissions), approvalLimit: me.approval_limit };
  } catch {
    state = { ...EMPTY, loaded: true };
  }
  emit();
}
export function clearAccess() { state = EMPTY; emit(); }

export function usePermissions() {
  const s = useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state);
  // While the permissions are loading nothing is hidden, so a screen never flashes empty; the API still decides.
  const can = (code: string) => !s.loaded || s.role === 'org_admin' || s.permissions.has(code);
  const canAny = (...codes: string[]) => codes.some(can);
  return { ...s, can, canAny };
}
