import { cacheSettingsMap } from '../lib/appSettings';
import { getAccessToken, getRefreshToken, setAccessToken, clearTokens } from '../lib/auth';
import type { Sale, Purchase, Customer, Supplier, TireSku, Payment, User, Branch, Organization } from '../types/models';

// Registered by App.tsx so the client can trigger logout without a circular dep
let _onLogout: (() => void) | null = null;
export function registerLogoutCallback(fn: () => void) { _onLogout = fn; }

// Deduplicates concurrent refresh calls so only one hits the server
let _refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) throw new Error('No refresh token');

    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) throw new Error('Refresh failed');
    const { accessToken } = await res.json();
    setAccessToken(accessToken);
    return accessToken;
  })().finally(() => { _refreshPromise = null; });

  return _refreshPromise;
}

function orgHeaders(): Record<string, string> {
  return {
    'X-Org-ID':    localStorage.getItem('orgId')    || '1',
    'X-Branch-ID': localStorage.getItem('branchId') || '1',
  };
}

async function request<T>(path: string, options?: RequestInit, isRetry = false): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...orgHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`/api${path}`, { ...options, headers: { ...headers, ...(options?.headers as Record<string, string> | undefined) } });

  if (res.status === 401 && !isRetry) {
    const body = await res.json().catch(() => ({}));
    if (body.code === 'TOKEN_EXPIRED') {
      try {
        await refreshAccessToken();
        return request<T>(path, options, true);
      } catch {
        clearTokens();
        _onLogout?.();
        throw new Error('Session expired. Please sign in again.');
      }
    }
    clearTokens();
    _onLogout?.();
    throw new Error('Authentication required');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  // An empty body means the API is unreachable (the dev proxy answers with an empty error).
  const text = await res.text();
  if (!text) throw new Error('Cannot reach the API server. Make sure it is running (npm start).');
  return JSON.parse(text);
}

const qs = (o: Record<string, string | number | undefined | null>) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v)); const s = p.toString(); return s ? '?' + s : ''; };

export const api = {
  auth: {
    login: (data: { email: string; password: string; rememberMe?: boolean }) =>
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(new Error(e.error)))),

    forgotPassword: (email: string) =>
      fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }).then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(new Error(e.error)))),

    resetPassword: (resetToken: string, newPassword: string) =>
      fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetToken, newPassword }),
      }).then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(new Error(e.error)))),

    google: (credential: string) =>
      fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      }).then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(new Error(e.error)))),

    demo: () =>
      fetch('/api/auth/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(new Error(e.error)))),

    register: (data: any) =>
      fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(r => r.ok ? r.json() : r.json().then((e: any) => Promise.reject(new Error(e.error)))),

    refresh: () => {
      const refreshToken = getRefreshToken();
      return fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).then(r => r.ok ? r.json() : Promise.reject(new Error('Refresh failed')));
    },

    logout: () => {
      const refreshToken = getRefreshToken();
      return fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      }).catch(() => {});
    },
  },
  reports: {
    definitions: ()                  => request<any>('/reports/definitions'),
    ask:         (body: { question?: string; spec?: any }) => request<any>('/reports/ask', { method: 'POST', body: JSON.stringify(body) }),
    history:     ()                  => request<any[]>('/reports/history'),
    saved:       ()                  => request<any[]>('/reports/saved'),
    save:        (data: { name: string; spec: any; question?: string }) => request<{ id: number }>('/reports/saved', { method: 'POST', body: JSON.stringify(data) }),
    removeSaved: (id: number)        => request<any>(`/reports/saved/${id}`, { method: 'DELETE' }),
    runSaved:    (id: number)        => request<any>(`/reports/saved/${id}/run`, { method: 'POST' }),
    // CSV export re-runs the report server-side under the caller's permissions.
    exportCsv: async (spec: any): Promise<Blob> => {
      const res = await fetch(`/api/reports/${encodeURIComponent(spec.reportId)}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...orgHeaders(), Authorization: `Bearer ${getAccessToken() ?? ''}` },
        body: JSON.stringify({ spec }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'Export failed');
      return res.blob();
    },
  },
  organizations: {
    list:   ()                      => request<Organization[]>('/organizations'),
    get:    (id: number)            => request<any>(`/organizations/${id}`),
    create: (data: any)             => request<any>('/organizations', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) => request<any>(`/organizations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  },
  branches: {
    list:   ()                      => request<Branch[]>('/branches'),
    get:    (id: number)            => request<any>(`/branches/${id}`),
    create: (data: any)             => request<any>('/branches', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) => request<any>(`/branches/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: number)            => request<any>(`/branches/${id}`, { method: 'DELETE' }),
  },
  customers: {
    list:   ()                      => request<Customer[]>('/customers'),
    get:    (id: number)            => request<Customer>(`/customers/${id}`),
    create: (data: any)             => request<Customer>('/customers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) => request<Customer>(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: number)            => request<any>(`/customers/${id}`, { method: 'DELETE' }),
    bulk:   (data: any)             => request<any>('/customers/bulk', { method: 'POST', body: JSON.stringify(data) }),
  },
  suppliers: {
    list:   ()                      => request<Supplier[]>('/suppliers'),
    get:    (id: number)            => request<Supplier>(`/suppliers/${id}`),
    create: (data: any)             => request<Supplier>('/suppliers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) => request<Supplier>(`/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: number)            => request<any>(`/suppliers/${id}`, { method: 'DELETE' }),
    bulk:   (data: any)             => request<any>('/suppliers/bulk', { method: 'POST', body: JSON.stringify(data) }),
  },
  inventory: {
    list:   ()                      => request<TireSku[]>('/inventory'),
    get:    (id: number)            => request<TireSku>(`/inventory/${id}`),
    create: (data: any)             => request<TireSku>('/inventory', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) => request<TireSku>(`/inventory/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: number)            => request<any>(`/inventory/${id}`, { method: 'DELETE' }),
    meta:    ()                     => request<{ uoms: string[]; item_types: { value: string; label: string }[]; statuses: string[]; tax_classes: string[] }>('/inventory/meta'),
    history: (id: number)           => request<{ id: number; field: string; old_value: string | null; new_value: string | null; user_name: string | null; changed_at: string }[]>(`/inventory/${id}/history`),
    setStatus: (id: number, status: string) => request<any>(`/inventory/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    exportCsv: async () => {
      const res = await fetch('/api/inventory/export', { headers: { ...orgHeaders(), ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}) } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
      return res.blob();
    },
    bulk:           (data: any)             => request<any>('/inventory/bulk', { method: 'POST', body: JSON.stringify(data) }),
    categories:       ()                    => request<{ id: number; name: string; parent_id: number | null; item_count: number }[]>('/inventory/categories'),
    createCategory:   (name: string, parent_id?: number | null) => request<any>('/inventory/categories', { method: 'POST', body: JSON.stringify({ name, parent_id: parent_id || undefined }) }),
    renameCategory:   (id: number, name: string, parent_id?: number | null) => request<any>(`/inventory/categories/${id}`, { method: 'PUT', body: JSON.stringify(parent_id === undefined ? { name } : { name, parent_id }) }),
    deleteCategory:   (id: number)          => request<any>(`/inventory/categories/${id}`, { method: 'DELETE' }),
    lookup:           (code: string)        => request<TireSku>(`/inventory/lookup?code=${encodeURIComponent(code)}`),
    locations:        ()                    => request<{ id: number; name: string; code: string; is_default: boolean; is_active: boolean; kind: string; units: number; items: number }[]>('/inventory/locations'),
    createLocation:   (name: string, code?: string, kind?: string) => request<any>('/inventory/locations', { method: 'POST', body: JSON.stringify({ name, code, kind }) }),
    updateLocation:   (id: number, data: { name?: string; is_active?: boolean; is_default?: boolean; kind?: string }) => request<any>(`/inventory/locations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    stockByLocation:  (q: { tire_id?: number; location_id?: number }) => {
      const p = new URLSearchParams();
      Object.entries(q).forEach(([k, v]) => { if (v !== undefined) p.set(k, String(v)); });
      return request<{ tire_id: number; location_id: number; location_name: string; is_default: boolean; qty: number }[]>(`/inventory/stock-by-location?${p}`);
    },
    batches:          (q: { tire_id?: number; location_id?: number; in_stock?: boolean }) => {
      const p = new URLSearchParams();
      if (q.tire_id) p.set('tire_id', String(q.tire_id));
      if (q.location_id) p.set('location_id', String(q.location_id));
      if (q.in_stock === false) p.set('in_stock', '0');
      return request<{ batch_id: number; tire_id: number; batch_no: string; expiry_date: string | null; is_legacy: boolean; location_id: number; location_name: string; qty: number; days_to_expiry: number | null }[]>(`/inventory/batches?${p}`);
    },
    valuationMethod:  ()                    => request<{ method: string; label: string; options: { value: string; label: string; description?: string; needs_ack?: boolean }[]; history?: { old_method: string | null; new_method: string; note: string | null; changed_at: string; user_name: string | null }[] }>('/inventory/valuation-method'),
    setValuationMethod: (method: string, o: { acknowledge_legal?: boolean; note?: string } = {}) => request<{ method: string }>('/inventory/valuation-method', { method: 'PUT', body: JSON.stringify({ method, ...o }) }),
    replenishmentPlan: (budget?: number)    => request<any>(`/inventory/replenishment/plan${budget ? '?budget=' + budget : ''}`),
    replenishmentSettings: ()               => request<any>('/inventory/replenishment/settings'),
    setReplenishmentSettings: (b: Record<string, unknown>) => request<any>('/inventory/replenishment/settings', { method: 'PUT', body: JSON.stringify(b) }),
    setReplenishmentParams: (id: number, b: Record<string, unknown>) => request<any>(`/inventory/replenishment/params/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
    replenishmentSuppliers: ()              => request<any[]>('/inventory/replenishment/suppliers'),
    setSupplierReplenishment: (id: number, b: Record<string, unknown>) => request<any>(`/inventory/replenishment/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
    replenishmentIncoming: ()               => request<any>('/inventory/replenishment/incoming'),
    requirements:     ()                    => request<any[]>('/inventory/replenishment/requirements'),
    addRequirement:   (b: { tire_id: number; qty: number; needed_by: string; note?: string }) => request<any>('/inventory/replenishment/requirements', { method: 'POST', body: JSON.stringify(b) }),
    closeRequirement: (id: number)          => request<any>(`/inventory/replenishment/requirements/${id}/close`, { method: 'POST' }),
    seasonality:      ()                    => request<any>('/inventory/replenishment/seasonality'),
    setItemSeasonality: (id: number, factors: number[] | null) => request<any>(`/inventory/replenishment/params/${id}`, { method: 'PUT', body: JSON.stringify({ seasonality: factors }) }),
    setCategorySeasonality: (id: number, factors: number[] | null) => request<any>(`/inventory/replenishment/category-seasonality/${id}`, { method: 'PUT', body: JSON.stringify({ factors }) }),
    approveReplenishment: (orders: { supplier_id: number; note?: string; lines: { tire_id: number; qty: number; reason?: string }[] }[], budget?: number) =>
      request<{ orders: { purchase_id: number; po_no: string; supplier_name: string; units: number; total: number; expected_date: string }[] }>('/inventory/replenishment/orders', { method: 'POST', body: JSON.stringify({ orders, budget }) }),
    replenishmentApprovals: ()              => request<any[]>('/inventory/replenishment/approvals'),
    rotation:         ()                    => request<any>('/inventory/rotation'),
    setRotation:      (scope: 'company' | 'category' | 'item', id: number | null, policy: string | null) => request<any>('/inventory/rotation', { method: 'PUT', body: JSON.stringify({ scope, id, policy }) }),
    pickSuggestion:   (tireId: number, qty = 1, locationId?: number) => request<any>(`/inventory/pick-suggestion?tire_id=${tireId}&qty=${qty}${locationId ? '&location_id=' + locationId : ''}`),
    stockAge:         ()                    => request<any>('/inventory/stock-age'),
    expiryExposure:   (days = 90)           => request<any>(`/inventory/expiry-exposure?days=${days}`),
    insights: {
      dashboard:    (scope?: 'org')         => request<any>('/inventory/insights/dashboard' + qs({ scope })),
      reports:      ()                      => request<any[]>('/inventory/insights/reports'),
      kpis:         (p: { days?: number; scope?: 'org' } = {}) => request<any>('/inventory/insights/kpis' + qs(p)),
      saveKpiTargets: (b: { targets?: Record<string, number | null>; carrying_cost_rate?: number | null }) => request<any>('/inventory/insights/kpis/targets', { method: 'PUT', body: JSON.stringify(b) }),
      report:       (id: string, p: Record<string, string | number | undefined | null> = {}) => request<any>(`/inventory/insights/reports/${id}` + qs(p)),
      downloadCsv:  async (id: string, p: Record<string, string | number | undefined | null> = {}) => {
        const token = getAccessToken();
        const res = await fetch(`/api/inventory/insights/reports/${id}/export` + qs(p), { headers: { ...orgHeaders(), ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
        if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error || 'Export failed'); }
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a'); a.href = url; a.download = `${id}-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      },
    },
    warehouse: {
      list:         ()                      => request<any[]>('/inventory/warehouses'),
      create:       (b: { name: string; code?: string; address?: string }) => request<any>('/inventory/warehouses', { method: 'POST', body: JSON.stringify(b) }),
      update:       (id: number, b: Record<string, unknown>) => request<any>(`/inventory/warehouses/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
      assign:       (locationId: number, warehouseId: number | null) => request<any>(`/inventory/locations/${locationId}/warehouse`, { method: 'PUT', body: JSON.stringify({ warehouse_id: warehouseId }) }),
      access:       (locationId: number)    => request<any>(`/inventory/locations/${locationId}/access`),
      setAccess:    (locationId: number, users: { user_id: number; can_issue: boolean; can_receive: boolean; can_count: boolean }[]) =>
        request<any>(`/inventory/locations/${locationId}/access`, { method: 'PUT', body: JSON.stringify({ users }) }),
      network:      (q = '')                => request<any>('/inventory/warehouse/network' + qs({ q })),
      locationStock: (id: number)           => request<any>(`/inventory/warehouse/locations/${id}/stock`),
      destinations: ()                      => request<any[]>('/inventory/warehouse/destinations'),
      inTransit:    ()                      => request<any>('/inventory/warehouse/in-transit'),
      transfers:    (r: Record<string, string | number | undefined> = {}) => request<any[]>('/inventory/warehouse/transfers' + qs(r)),
      transfer:     (id: number)            => request<any>(`/inventory/warehouse/transfers/${id}`),
      counts:       ()                      => request<any[]>('/inventory/warehouse/counts'),
      send:         (b: { from_location_id: number; to_location_id: number; items: { tire_id: number; qty: number }[]; notes?: string; in_transit?: boolean; expected_at?: string; carrier?: string; reference?: string }) =>
        request<any>('/inventory/transfers', { method: 'POST', body: JSON.stringify(b) }),
      receive:      (id: number, b: { lines?: { tire_id: number; qty_received: number }[]; note?: string; short_action?: 'return' | 'write_off' } = {}) =>
        request<any>(`/inventory/transfers/${id}/receive`, { method: 'POST', body: JSON.stringify(b) }),
      cancel:       (id: number, note?: string) => request<any>(`/inventory/transfers/${id}/cancel`, { method: 'POST', body: JSON.stringify({ note }) }),
    },
    losses: {
      meta:         ()                      => request<any>('/inventory/losses/meta'),
      setSettings:  (b: Record<string, unknown>) => request<any>('/inventory/losses/settings', { method: 'PUT', body: JSON.stringify(b) }),
      summary:      (r: { from?: string; to?: string } = {}) => request<any>('/inventory/losses/summary' + qs(r)),
      register:     (r: Record<string, string | number | undefined> = {}) => request<any>('/inventory/losses/register' + qs(r)),
      breakdown:    (by: string, r: { from?: string; to?: string } = {}) => request<any>('/inventory/losses/breakdown' + qs({ by, ...r })),
      obsolescence: (cls = '')              => request<any>('/inventory/losses/obsolescence' + qs({ class: cls })),
      setLifecycle: (id: number, status: string | null, note?: string) => request<any>(`/inventory/losses/items/${id}/lifecycle`, { method: 'PUT', body: JSON.stringify({ status, note }) }),
      patterns:     (days?: number)         => request<any>('/inventory/losses/patterns' + qs({ days })),
      actions:      (status?: string)       => request<any[]>('/inventory/losses/actions' + qs({ status })),
      saveAction:   (b: Record<string, unknown>) => request<any>('/inventory/losses/actions', { method: 'POST', body: JSON.stringify(b) }),
      closeAction:  (id: number, status: string, resolution?: string) => request<any>(`/inventory/losses/actions/${id}`, { method: 'PUT', body: JSON.stringify({ status, resolution }) }),
      returns:      (status?: string)       => request<any>('/inventory/losses/returns' + qs({ status })),
      createReturn: (b: Record<string, unknown>) => request<any>('/inventory/losses/returns', { method: 'POST', body: JSON.stringify(b) }),
      creditReturn: (id: number, b: { amount: number; reference?: string; final?: boolean; note?: string }) => request<any>(`/inventory/losses/returns/${id}/credit`, { method: 'POST', body: JSON.stringify(b) }),
      alerts:       ()                      => request<any>('/inventory/losses/alerts'),
    },
    hazmat: {
      meta:         ()                      => request<any>('/inventory/hazmat/meta'),
      setSettings:  (b: Record<string, unknown>) => request<any>('/inventory/hazmat/settings', { method: 'PUT', body: JSON.stringify(b) }),
      compliance:   ()                      => request<any>('/inventory/hazmat/compliance'),
      classes:      ()                      => request<{ classes: any[]; incompatibilities: any[] }>('/inventory/hazmat/classes'),
      saveClass:    (id: number | null, b: Record<string, unknown>) => request<any>(id ? `/inventory/hazmat/classes/${id}` : '/inventory/hazmat/classes', { method: id ? 'PUT' : 'POST', body: JSON.stringify(b) }),
      deleteClass:  (id: number)            => request<any>(`/inventory/hazmat/classes/${id}`, { method: 'DELETE' }),
      seedClasses:  ()                      => request<any>('/inventory/hazmat/classes/seed-standard', { method: 'POST' }),
      setIncompatible: (class_a: number, class_b: number, incompatible: boolean, reason?: string) => request<any>('/inventory/hazmat/incompatibilities', { method: 'PUT', body: JSON.stringify({ class_a, class_b, incompatible, reason }) }),
      locations:    ()                      => request<any[]>('/inventory/hazmat/locations'),
      saveLocation: (id: number, b: Record<string, unknown>) => request<any>(`/inventory/hazmat/locations/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
      items:        ()                      => request<any[]>('/inventory/hazmat/items'),
      hold:         (id: number, hold: boolean, reason: string) => request<any>(`/inventory/hazmat/items/${id}/hold`, { method: 'PUT', body: JSON.stringify({ hold, reason }) }),
      check:        (b: Record<string, unknown>) => request<any>('/inventory/hazmat/check', { method: 'POST', body: JSON.stringify(b) }),
      inspections:  (subject?: string)      => request<any[]>('/inventory/hazmat/inspections' + (subject ? '?subject=' + subject : '')),
      inspect:      (b: Record<string, unknown>) => request<any>('/inventory/hazmat/inspections', { method: 'POST', body: JSON.stringify(b) }),
      incidents:    (status?: string)       => request<any[]>('/inventory/hazmat/incidents' + (status ? '?status=' + status : '')),
      reportIncident: (b: Record<string, unknown>) => request<any>('/inventory/hazmat/incidents', { method: 'POST', body: JSON.stringify(b) }),
      closeIncident: (id: number, resolution: string) => request<any>(`/inventory/hazmat/incidents/${id}/close`, { method: 'POST', body: JSON.stringify({ resolution }) }),
    },
    quality: {
      meta:         ()                      => request<any>('/inventory/quality/meta'),
      alerts:       ()                      => request<any>('/inventory/quality/alerts'),
      batches:      (qs = '')               => request<any[]>('/inventory/quality/batches' + qs),
      batch:        (id: number)            => request<any>(`/inventory/quality/batches/${id}`),
      setStatus:    (id: number, status: string, reason: string) => request<any>(`/inventory/quality/batches/${id}/status`, { method: 'POST', body: JSON.stringify({ status, reason }) }),
      inspect:      (id: number, result: 'pass' | 'fail', notes?: string) => request<any>(`/inventory/quality/batches/${id}/inspections`, { method: 'POST', body: JSON.stringify({ result, notes }) }),
      dispose:      (id: number, b: Record<string, unknown>) => request<any>(`/inventory/quality/batches/${id}/dispose`, { method: 'POST', body: JSON.stringify(b) }),
      disposals:    (days = 365)            => request<any>(`/inventory/quality/disposals?days=${days}`),
      customerReturn: (b: Record<string, unknown>) => request<any>('/inventory/quality/returns', { method: 'POST', body: JSON.stringify(b) }),
      recalls:      (status?: string)       => request<any[]>('/inventory/quality/recalls' + (status ? '?status=' + status : '')),
      recall:       (id: number)            => request<any>(`/inventory/quality/recalls/${id}`),
      openRecall:   (b: Record<string, unknown>) => request<any>('/inventory/quality/recalls', { method: 'POST', body: JSON.stringify(b) }),
      closeRecall:  (id: number, note: string, resolutions: { batch_id: number; disposition: string }[]) => request<any>(`/inventory/quality/recalls/${id}/close`, { method: 'POST', body: JSON.stringify({ note, resolutions }) }),
      rules:        ()                      => request<any>('/inventory/quality/rules'),
      setRules:     (b: Record<string, unknown>) => request<any>('/inventory/quality/rules', { method: 'PUT', body: JSON.stringify(b) }),
      profiles:     ()                      => request<any[]>('/inventory/quality/profiles'),
      saveProfile:  (id: number | null, b: Record<string, unknown>) => request<any>(id ? `/inventory/quality/profiles/${id}` : '/inventory/quality/profiles', { method: id ? 'PUT' : 'POST', body: JSON.stringify(b) }),
      deleteProfile: (id: number)           => request<any>(`/inventory/quality/profiles/${id}`, { method: 'DELETE' }),
      assign:       (scope: 'item' | 'category', id: number, profile_id: number | null) => request<any>('/inventory/quality/assign', { method: 'PUT', body: JSON.stringify({ scope, id, profile_id }) }),
    },
    valuationAdjustments: ()                => request<any[]>('/inventory/valuation-adjustments'),
    valuationAdjustment: (id: number)       => request<any>(`/inventory/valuation-adjustments/${id}`),
    adjustValuation:  (b: { tire_id: number; new_unit_cost: number; reason: string }) => request<any>('/inventory/valuation-adjustments', { method: 'POST', body: JSON.stringify(b) }),
    valuationSnapshots: ()                  => request<any[]>('/inventory/valuation-snapshots'),
    valuationSnapshot: (id: number)         => request<any>(`/inventory/valuation-snapshots/${id}`),
    takeValuationSnapshot: (note?: string)  => request<any>('/inventory/valuation-snapshots', { method: 'POST', body: JSON.stringify({ note }) }),
    report:           (kind: 'valuation' | 'reorder' | 'margin') =>
      request<any>(`/inventory/${kind === 'reorder' ? 'replenishment' : kind}`),
    trace:            (q: string)           => request<{ q: string; matches: any[] }>(`/inventory/trace?q=${encodeURIComponent(q)}`),
    expiry:           (days = 30)           => request<{ days: number; expired: any[]; expiring: any[]; expired_units: number; expiring_units: number }>(`/inventory/expiry?days=${days}`),
    transfers:        ()                    => request<any[]>('/inventory/transfers'),
    receiveTransfer:  (id: number)          => request<any>(`/inventory/transfers/${id}/receive`, { method: 'POST' }),
    cancelTransfer:   (id: number)          => request<any>(`/inventory/transfers/${id}/cancel`, { method: 'POST' }),
    position:         (q = '')              => request<{ items: any[]; totals: Record<string, number> }>(`/inventory/position${q ? '?q=' + encodeURIComponent(q) : ''}`),
    positionOf:       (id: number)          => request<any>(`/inventory/position/${id}`),
    reservations:     (status = 'active')   => request<any[]>(`/inventory/reservations?status=${status}`),
    reserve:          (data: { tire_id: number; qty: number; location_id?: number; reference?: string; notes?: string; expires_at?: string }) => request<any>('/inventory/reservations', { method: 'POST', body: JSON.stringify(data) }),
    releaseReservation: (id: number)        => request<any>(`/inventory/reservations/${id}/release`, { method: 'POST' }),
    counts:           ()                    => request<any[]>('/inventory/counts'),
    count:            (id: number)          => request<any>(`/inventory/counts/${id}`),
    startCount:       (data: { location_id?: number; category_id?: number; notes?: string }) => request<any>('/inventory/counts', { method: 'POST', body: JSON.stringify(data) }),
    saveCountLines:   (id: number, body: { lines?: { id: number; counted_qty: number | null }[]; add?: { tire_id: number; batch_id?: number; counted_qty: number } }) => request<any>(`/inventory/counts/${id}/lines`, { method: 'PUT', body: JSON.stringify(body) }),
    completeCount:    (id: number)          => request<any>(`/inventory/counts/${id}/complete`, { method: 'POST' }),
    cancelCount:      (id: number)          => request<any>(`/inventory/counts/${id}/cancel`, { method: 'POST' }),
    transfer:         (data: { from_location_id: number; to_location_id: number; items: { tire_id: number; qty: number }[]; notes?: string; in_transit?: boolean }, idempotencyKey?: string) =>
      request<{ id: number; transferNo: string }>('/inventory/transfers', { method: 'POST', body: JSON.stringify(data), headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined }),
    adjustmentReasons: ()                   => request<{ code: string; label: string; direction: 'in' | 'out' | 'any' }[]>('/inventory/adjustments/reasons'),
    adjust:         (data: { tire_id: number; qty_change: number; reason_code: string; notes?: string; location_id?: number; batch_id?: number; batch_no?: string; expiry_date?: string }) =>
      request<{ id: number; status: 'approved' | 'pending' }>('/inventory/adjustments', { method: 'POST', body: JSON.stringify(data) }),
    adjustments:    (status?: string)       => request<any[]>(`/inventory/adjustments${status ? `?status=${status}` : ''}`),
    decideAdjustment: (id: number, approve: boolean, note?: string) =>
      request<any>(`/inventory/adjustments/${id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: JSON.stringify({ note }) }),
    movements:      (q: { tire_id?: number; limit?: number; before?: number }) => {
      const p = new URLSearchParams();
      Object.entries(q).forEach(([k, v]) => { if (v !== undefined) p.set(k, String(v)); });
      return request<any[]>(`/inventory/movements?${p}`);
    },
    catalogBrands:  ()                      => request<string[]>('/inventory/catalog-brands'),
    importFromCatalog: (brands?: string[])  => request<{ inserted: number }>('/inventory/import-catalog', {
      method: 'POST',
      body: JSON.stringify({ brands }),
    }),
  },
  sales: {
    list:         ()             => request<Sale[]>('/sales'),
    listFiltered: (params?: { from?: string; to?: string }) => {
      const qs = new URLSearchParams();
      if (params?.from) qs.set('from', params.from);
      if (params?.to)   qs.set('to',   params.to);
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<Sale[]>(`/sales${suffix}`);
    },
    get:          (id: number)   => request<Sale>(`/sales/${id}`),
    create:       (data: any)    => request<Sale>('/sales', { method: 'POST', body: JSON.stringify(data) }),
    updateStatus: (id: number, status: string) =>
      request<any>(`/sales/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    void:         (id: number)   => request<any>(`/sales/${id}/void`, { method: 'POST' }),
    delete:       (id: number)   => request<any>(`/sales/${id}`, { method: 'DELETE' }),
    bulk:         (data: any)    => request<any>('/sales/bulk', { method: 'POST', body: JSON.stringify(data) }),
    byTireType:   ()             => request<{ tire_type: string; item_count: number; revenue: number }[]>('/sales/by-tire-type'),
    dashboardStats: ()           => request<any>('/sales/stats/dashboard'),
  },
  purchases: {
    list:         ()             => request<Purchase[]>('/purchases'),
    get:          (id: number)   => request<Purchase>(`/purchases/${id}`),
    create:       (data: any)    => request<Purchase>('/purchases', { method: 'POST', body: JSON.stringify(data) }),
    updateStatus: (id: number, status: string) =>
      request<any>(`/purchases/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    delete:       (id: number)   => request<any>(`/purchases/${id}`, { method: 'DELETE' }),
    bulk:         (data: any)    => request<any>('/purchases/bulk', { method: 'POST', body: JSON.stringify(data) }),
  },
  settings: {
    get: async (): Promise<Record<string, string>> => {
      const data = await request<Record<string, string>>('/settings');
      cacheSettingsMap(data);
      return data;
    },
    update: async (data: Record<string, string>): Promise<Record<string, string>> => {
      const result = await request<Record<string, string>>('/settings', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      cacheSettingsMap(result);
      return result;
    },
    systemInfo: () => request<{
      server: {
        uptime_seconds: number;
        node_version:   string;
        platform:       string;
        memory_used_mb: number;
        memory_heap_mb: number;
        timestamp:      string;
      };
      database: {
        data_mb:  number;
        log_mb:   number;
        total_mb: number;
        counts: {
          tire_skus:        number;
          total_sales:      number;
          total_purchases:  number;
          customers:        number;
          users_count:      number;
          catalog_entries:  number;
        };
      };
      sessions: {
        active_count: number;
        users: { name: string; email: string; role: string; last_active: string }[];
      };
    }>('/settings/system-info'),
  },
  products: {
    list:   ()                      => request<any[]>('/products'),
    create: (data: any)             => request<any>('/products', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: any) => request<any>(`/products/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: number)            => request<any>(`/products/${id}`, { method: 'DELETE' }),
  },
  lookups: {
    tireTypes:      ()                      => request<any[]>('/lookups/tire-types'),
    addTireType:    (name: string)          => request<any>('/lookups/tire-types', { method: 'POST', body: JSON.stringify({ name }) }),
    updateTireType: (id: number, data: any) => request<any>(`/lookups/tire-types/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    deleteTireType: (id: number)            => request<any>(`/lookups/tire-types/${id}`, { method: 'DELETE' }),
    tireSuggestions: () => request<{
      brands:       string[];
      models:       { brand: string; model: string }[];
      sizes:        { brand: string; model: string; size: string }[];
      patterns:     string[];
      load_indexes: string[];
    }>('/lookups/tire-suggestions'),
  },
  payments: {
    recordSalePayment:      (data: any)          => request<any>('/payments/sale', { method: 'POST', body: JSON.stringify(data) }),
    getSalePayments:        (saleId: number)      => request<Payment[]>(`/payments/sale/${saleId}`),
    deleteSalePayment:      (id: number)          => request<any>(`/payments/sale/${id}`, { method: 'DELETE' }),
    recordPurchasePayment:  (data: any)          => request<any>('/payments/purchase', { method: 'POST', body: JSON.stringify(data) }),
    getPurchasePayments:    (purchaseId: number)  => request<Payment[]>(`/payments/purchase/${purchaseId}`),
    deletePurchasePayment:  (id: number)          => request<any>(`/payments/purchase/${id}`, { method: 'DELETE' }),
  },
  users: {
    list:      ()                       => request<User[]>('/users'),
    create:    (data: any)              => request<any>('/users', { method: 'POST', body: JSON.stringify(data) }),
    update:    (id: number, data: any)  => request<any>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    setStatus: (id: number, active: boolean) =>
      request<any>(`/users/${id}/status`, { method: 'PATCH', body: JSON.stringify({ is_active: active }) }),
    resetPassword: (id: number, password: string) =>
      request<any>(`/users/${id}/password`, { method: 'PATCH', body: JSON.stringify({ password }) }),
  },
  access: {
    me:          ()                       => request<{ role: string; role_name: string; permissions: string[]; approval_limit: number | null }>('/access/me'),
    catalogue:   ()                       => request<{ permissions: { code: string; group: string; label: string; description: string; sensitive: boolean }[]; base_roles: { key: string; name: string }[] }>('/access/permissions'),
    roles:       ()                       => request<any[]>('/access/roles'),
    createRole:  (b: any)                 => request<any>('/access/roles', { method: 'POST', body: JSON.stringify(b) }),
    updateRole:  (id: number, b: any)     => request<any>(`/access/roles/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
    resetRole:   (id: number)             => request<any>(`/access/roles/${id}/reset`, { method: 'POST', body: '{}' }),
    deleteRole:  (id: number)             => request<any>(`/access/roles/${id}`, { method: 'DELETE' }),
    policy:      ()                       => request<{ restricted_reasons: string[]; reasons: { code: string; label: string }[] }>('/access/policy'),
    savePolicy:  (restricted_reasons: string[]) => request<any>('/access/policy', { method: 'PUT', body: JSON.stringify({ restricted_reasons }) }),
  },
  profile: {
    get: () => request<any>('/profile'),
    update: (data: {
      name: string; first_name?: string; last_name?: string; phone?: string;
      address?: string; job_title?: string; department?: string; date_of_birth?: string;
      emergency_contact_name?: string; emergency_contact_phone?: string; emergency_contact_relation?: string;
    }) => request<any>('/profile', { method: 'PUT', body: JSON.stringify(data) }),
    changePassword: (data: { currentPassword: string; newPassword: string }) =>
      request<{ success: boolean; refreshToken: string }>('/profile/change-password', {
        method: 'POST', body: JSON.stringify(data),
      }),
  },
  catalog: {
    stats:         () => request<{ total_entries: number; total_brands: number; total_models: number; gtr_entries: number }>('/catalog/stats'),
    scraperConfig: () => request<{
      enabled: boolean; schedule: string; isRunning: boolean; isScheduled: boolean;
      scheduleOptions: { value: string; label: string }[];
    }>('/catalog/scraper/config'),
    saveScraperConfig: (data: { enabled: boolean; schedule: string }) =>
      request<{ success: boolean; enabled: boolean; schedule: string; isRunning: boolean; isScheduled: boolean }>(
        '/catalog/scraper/config', { method: 'POST', body: JSON.stringify(data) },
      ),
    runScraper:    () => request<{ success: boolean; message: string }>('/catalog/scraper/run', { method: 'POST' }),
    scraperStatus: () => request<{
      isRunning: boolean; isScheduled: boolean;
      recentLogs: {
        id: number; source: string; status: string;
        started_at: string; finished_at: string | null;
        items_found: number; items_added: number; items_updated: number;
        error_msg: string | null; triggered_by: string;
      }[];
      gtrCounts: { total: number; brands: number; models: number };
    }>('/catalog/scraper/status'),
    entries: (params?: { q?: string; brand?: string; model?: string; size?: string; page?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.q)     qs.set('q',     params.q);
      if (params?.brand) qs.set('brand', params.brand);
      if (params?.model) qs.set('model', params.model);
      if (params?.size)  qs.set('size',  params.size);
      if (params?.page)  qs.set('page',  String(params.page));
      if (params?.limit) qs.set('limit', String(params.limit));
      return request<{ entries: any[]; total: number; page: number; pageSize: number }>(
        `/catalog/entries${qs.toString() ? '?' + qs : ''}`,
      );
    },
    deleteEntry: (id: number) => request<{ success: boolean }>(`/catalog/entries/${id}`, { method: 'DELETE' }),
  },
  fitments: {
    categories: () => request<string[]>('/fitments/categories'),
    makes:  (category?: string) => {
      const qs = category ? `?category=${encodeURIComponent(category)}` : '';
      return request<string[]>(`/fitments/makes${qs}`);
    },
    models: (make: string, category?: string) => {
      const qs = new URLSearchParams({ make });
      if (category) qs.set('category', category);
      return request<string[]>(`/fitments/models?${qs}`);
    },
    search: (params: { make?: string; model?: string; category?: string }) => {
      const qs = new URLSearchParams();
      if (params.make)     qs.set('make',     params.make);
      if (params.model)    qs.set('model',    params.model);
      if (params.category) qs.set('category', params.category);
      return request<{
        fitments: {
          id: number;
          category: string;
          make: string;
          model: string;
          year_from: number | null;
          year_to: number | null;
          tire_size: string;
          gtr_pattern: string | null;
          position: 'Front' | 'Rear' | null;
        }[];
        catalogMatches: Record<string, {
          id: number; brand: string; tire_model: string; size: string;
          pattern: string | null; load_index: string | null;
          speed_index: string | null; tire_type: string | null;
        }[]>;
      }>(`/fitments/search?${qs}`);
    },
  },
  audit: {
    list: (params?: { entity?: string; action?: string; from?: string; to?: string; page?: number; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params?.entity) qs.set('entity', params.entity);
      if (params?.action) qs.set('action', params.action);
      if (params?.from)   qs.set('from',   params.from);
      if (params?.to)     qs.set('to',     params.to);
      if (params?.page)   qs.set('page',   String(params.page));
      if (params?.limit)  qs.set('limit',  String(params.limit));
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<{ logs: any[]; total: number; page: number; limit: number }>(`/audit${suffix}`);
    },
  },
  ledger: {
    summary:           ()           => request<any>('/ledger/summary'),
    customers:         ()           => request<any[]>('/ledger/customers'),
    suppliers:         ()           => request<any[]>('/ledger/suppliers'),
    customerStatement: (id: number) => request<any>(`/ledger/customer/${id}/statement`),
    supplierStatement: (id: number) => request<any>(`/ledger/supplier/${id}/statement`),
    unpaidInvoices:    (id: number) => request<any[]>(`/ledger/customer/${id}/unpaid-invoices`),
    unpaidPOs:         (id: number) => request<any[]>(`/ledger/supplier/${id}/unpaid-pos`),
  },
};
