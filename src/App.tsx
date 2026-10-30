import { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import Header, { type AppNotification } from './components/Header';
import Dashboard from './pages/Dashboard';
import Sales from './pages/Sales';
import Purchases from './pages/Purchases';
import Invoices from './pages/Invoices';
import Inventory from './pages/Inventory';
import Customers from './pages/Customers';
import Suppliers from './pages/Suppliers';
import Reports from './pages/Reports';
import AIReports from './pages/AIReports';
import Settings from './pages/Settings';
import AuditLog from './pages/AuditLog';
import Auth from './pages/Auth';
import Ledger from './pages/Ledger';
import Organizations from './pages/Organizations';
import Services from './pages/Services';
import TyreFitment from './pages/TyreFitment';
import BottomNav from './components/BottomNav';
import NewsBanner from './components/NewsBanner';
import Profile from './pages/Profile';
import ChangePasswordModal from './components/ChangePasswordModal';
import DemoBanner from './components/DemoBanner';
import { api, registerLogoutCallback } from './api/client';
import { setTokens, setAccessToken, clearTokens, getRefreshToken } from './lib/auth';
import { getCachedSettings } from './lib/appSettings';
import { useModules, useTerms } from './lib/businessTypes';
import { loadAccess, clearAccess, usePermissions } from './lib/permissions';
import { visibleIds } from './lib/navigation';
import { useAutoRefresh } from './lib/useAutoRefresh';
import { SETTINGS_CACHE_KEY, SETTINGS_EVENT } from './lib/appSettings';

export interface AuthUser {
  name: string;
  email: string;
  role: string;
  organization_id: number;
  branch_id: number | null;
  organization?: { name: string; code: string; currency: string };
  branches?: { id: number; name: string; code: string }[];
}

interface LoginPayload extends AuthUser {
  accessToken: string;
  refreshToken: string;
  rememberMe?: boolean;
}

const allPages: Record<string, { title: string; subtitle: string; component: React.ComponentType }> = {
  dashboard:     { title: 'Dashboard',            subtitle: 'Welcome back',                                   component: Dashboard },
  sales:         { title: 'Sales',                subtitle: 'Manage customer sales and invoices',             component: Sales },
  purchases:     { title: 'Purchases',            subtitle: 'Track supplier orders and deliveries',           component: Purchases },
  invoices:      { title: 'Invoices',             subtitle: 'View and print professional invoices',           component: Invoices },
  inventory:     { title: 'Inventory',            subtitle: 'Monitor tire stock levels',                      component: Inventory },
  services:      { title: 'Services',             subtitle: 'Fitting, balancing, alignment and other services', component: Services },
  customers:     { title: 'Customers',            subtitle: 'Manage customer relationships',                  component: Customers },
  suppliers:     { title: 'Suppliers',            subtitle: 'Manage supplier accounts',                       component: Suppliers },
  ledger:        { title: 'Financial Ledger',     subtitle: 'Banking-style accounts receivable & payable',   component: Ledger },
  organizations: { title: 'Organizations',         subtitle: 'Manage organizations and branches',             component: Organizations },
  reports:       { title: 'Reports & Analytics',   subtitle: 'Business performance insights',                 component: Reports },
  aiReports:     { title: 'AI Reports',            subtitle: 'Ask business questions in plain language',      component: AIReports },
  tyreFitment:   { title: 'Tyre Fitment Guide',    subtitle: 'Pakistan-market OEM tyre sizes by vehicle',    component: TyreFitment },
  settings:      { title: 'Settings',              subtitle: 'Application configuration',                     component: Settings },
  auditlog:      { title: 'Audit Log',             subtitle: 'Track all changes across sales, inventory & products', component: AuditLog },
};

export default function App() {
  const modules = useModules();
  const terms   = useTerms();
  const access  = usePermissions();
  const [user, setUser]           = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activePage, setActivePage]   = useState('dashboard');
  const [counts, setCounts]           = useState<Record<string, number>>({});
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  // Register logout callback so the API client can force logout on 401
  useEffect(() => {
    registerLogoutCallback(() => {
      setUser(null);
      clearTokens();
    });
  }, []);

  // Attempt silent session restore from stored refresh token
  useEffect(() => {
    const stored = getRefreshToken(); // checks sessionStorage first, then localStorage
    if (!stored) { setAuthLoading(false); return; }

    api.auth.refresh()
      .then(({ accessToken, user: u }: { accessToken: string; user: AuthUser }) => {
        setAccessToken(accessToken);
        const branchId = u.branch_id ?? Number(localStorage.getItem('branchId') ?? 1);
        localStorage.setItem('orgId',    String(u.organization_id || 1));
        localStorage.setItem('branchId', String(branchId));
        setUser(u);
      })
      .catch(() => {
        clearTokens();
      })
      .finally(() => setAuthLoading(false));
  }, []);

  // What this user may do comes from the API (live), not from the login token.
  useEffect(() => {
    if (!user) { clearAccess(); return; }
    loadAccess();
    const again = () => { if (document.visibilityState === 'visible') loadAccess(); };
    const id = setInterval(again, 60000);
    window.addEventListener('focus', again);
    return () => { clearInterval(id); window.removeEventListener('focus', again); };
  }, [user]);

  // Warm settings cache once user is authenticated, then sync document.title
  useEffect(() => {
    if (!user) return;
    api.settings.get()
      .then(s => { document.title = s.company_name || 'TuneGEN'; })
      .catch(() => {});
  }, [user]);

  // Today's activity counts and alerts. Refreshed when the user changes screen or branch and on the auto-refresh interval.
  const [branchEpoch, setBranchEpoch] = useState(0);
  const loadCounts = useCallback(() => {
    if (!user) { setCounts({}); setNotifications([]); return; }
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    Promise.all([api.sales.list(), api.purchases.list().catch(() => [] as any[])])
      .then(([salesData, purchasesData]) => {
        const todaySales     = (salesData     as any[]).filter(s => s.date?.slice(0, 10) === today).length;
        const todayPurchases = (purchasesData as any[]).filter(p => p.date?.slice(0, 10) === today).length;
        setCounts({ sales: todaySales, purchases: todayPurchases, invoices: todaySales });

        const notifs: AppNotification[] = [];
        const overdueCount = (salesData as any[]).filter(s => s.status === 'overdue').length;
        if (overdueCount > 0) notifs.push({
          id: 'overdue-sales',
          title: `${overdueCount} Overdue Invoice${overdueCount !== 1 ? 's' : ''}`,
          subtitle: 'Payment overdue — action required',
          page: 'sales',
          severity: 'error',
        });
        const pendingCount = (purchasesData as any[]).filter(p => p.status === 'pending').length;
        if (pendingCount > 0) notifs.push({
          id: 'pending-purchases',
          title: `${pendingCount} Pending Order${pendingCount !== 1 ? 's' : ''}`,
          subtitle: 'Awaiting delivery confirmation',
          page: 'purchases',
          severity: 'warning',
        });
        setNotifications(notifs);
      })
      .catch(() => {});
  }, [user]);
  useEffect(() => { loadCounts(); }, [loadCounts, activePage, branchEpoch]);
  useAutoRefresh(loadCounts);

  const [showProfile,        setShowProfile]        = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [sidebarCollapsed,   setSidebarCollapsed]   = useState(false);
  const [mobileSidebarOpen,  setMobileSidebarOpen]  = useState(false);
  const [isMobile,           setIsMobile]           = useState(window.innerWidth < 1024);

  useEffect(() => {
    const handler = () => {
      const mobile = window.innerWidth < 1024;
      setIsMobile(mobile);
      if (!mobile) setMobileSidebarOpen(false);
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  useEffect(() => {
    if (window.innerWidth < 1280 && window.innerWidth >= 1024) {
      setSidebarCollapsed(true);
    }
  }, []);

  const handleAuth = (payload: LoginPayload) => {
    setTokens(payload.accessToken, payload.refreshToken, payload.rememberMe ?? false);
    const branchId = payload.branch_id ?? payload.branches?.[0]?.id ?? 1;
    localStorage.setItem('orgId',    String(payload.organization_id || 1));
    localStorage.setItem('branchId', String(branchId));
    const { accessToken: _at, refreshToken: _rt, rememberMe: _rm, ...userFields } = payload;
    setUser(userFields);
  };

  const handleLogout = async () => {
    try { await api.auth.logout(); } catch { /* the session ends locally either way */ }
    clearTokens();
    // Nothing of this session may leak into the next sign-in (another user or organisation on the same browser)
    try { localStorage.removeItem(SETTINGS_CACHE_KEY); localStorage.removeItem('orgId'); localStorage.removeItem('branchId'); } catch { /* storage unavailable */ }
    window.dispatchEvent(new Event(SETTINGS_EVENT));
    clearAccess();
    setShowProfile(false);
    setShowChangePassword(false);
    setActivePage('dashboard');
    setMobileSidebarOpen(false);
    setUser(null);
  };

  const branches = user?.branches ?? [];
  const branchId = Number(localStorage.getItem('branchId') || user?.branch_id || branches[0]?.id || 1);
  const handleBranchChange = (id: number) => {
    localStorage.setItem('branchId', String(id));
    setBranchEpoch(e => e + 1);          // every screen remounts and loads the new branch
  };

  const isAdmin = (access.loaded && access.role ? access.role : user?.role) === 'org_admin';
  const allowed = visibleIds({ isAdmin, modules, canAny: access.canAny });
  useEffect(() => {
    if (user && !allowed.has(activePage)) setActivePage('dashboard');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, activePage, [...allowed].join()]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f0f4f7]">
        <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return <Auth onAuth={handleAuth} />;

  const pages = Object.fromEntries(Object.entries(allPages)
    .filter(([id]) => allowed.has(id))
    .map(([id, p]) => [id, id === 'inventory' ? { ...p, subtitle: terms.inventorySubtitle } : id === 'services' ? { ...p, subtitle: terms.servicesSubtitle } : p]));
  const page  = pages[activePage] ?? pages.dashboard;
  const PageComponent = page.component;
  const title = activePage === 'dashboard' ? `Welcome back, ${(user.name ?? '').split(' ')[0] || user.email}` : page.title;

  const sidebarWidth = isMobile ? 0 : sidebarCollapsed ? 72 : 256;

  const handleNavigate = (p: string) => {
    // Prevent navigation to pages the user can't access
    if (!pages[p]) return;
    setShowProfile(false);
    setActivePage(p);
    setMobileSidebarOpen(false);
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#f0f4f7]">
      <Sidebar
        activePage={activePage}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        onCollapsedChange={setSidebarCollapsed}
        user={user}
        onLogout={handleLogout}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
        counts={counts}
        visible={allowed}
      />

      <div
        className="flex-1 flex flex-col overflow-hidden transition-all duration-300"
        style={{ marginLeft: sidebarWidth }}
      >
        {user?.role === 'demo' && <DemoBanner onExit={handleLogout} />}
        <NewsBanner message={getCachedSettings().announcement} />
        <Header
          title={showProfile ? 'My Profile' : title}
          subtitle={showProfile ? 'Manage your personal information and security' : page.subtitle}
          user={user}
          onLogout={handleLogout}
          onMenuToggle={() => setMobileSidebarOpen(v => !v)}
          onProfile={() => setShowProfile(true)}
          onChangePassword={() => setShowChangePassword(true)}
          notifications={notifications}
          onNavigate={handleNavigate}
          branches={isAdmin ? branches : []}
          branchId={branchId}
          onBranchChange={handleBranchChange}
        />
        <main className="flex-1 overflow-y-auto pb-14 lg:pb-0">
          {showProfile ? (
            <Profile
              onBack={() => setShowProfile(false)}
              onUpdated={name => setUser(u => u ? { ...u, name } : u)}
            />
          ) : (
            <PageComponent key={`${activePage}:${branchEpoch}`} />
          )}
        </main>
      </div>

      <BottomNav activePage={activePage} onNavigate={handleNavigate} onLogout={handleLogout} counts={counts} visible={allowed} />

      {showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}
    </div>
  );
}
