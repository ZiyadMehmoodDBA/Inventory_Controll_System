import {
  LayoutDashboard, ShoppingCart, Package, FileText,
  Users, Truck, BarChart2, Settings, ChevronLeft,
  ChevronRight, Boxes, TrendingUp, LogOut, X, BookOpen, Building2, Wrench, ClipboardList, Car, Sparkles,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { usePermissions } from '../lib/permissions';
import { getCachedSettings } from '../lib/appSettings';
import { useModules } from '../lib/businessTypes';

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    label: 'ANALYTICS',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'reports',   label: 'Reports',   icon: BarChart2 },
      { id: 'aiReports', label: 'AI Reports', icon: Sparkles },
    ],
  },
  {
    label: 'OPERATIONS',
    items: [
      { id: 'sales',     label: 'Sales',     icon: ShoppingCart },
      { id: 'purchases', label: 'Purchases', icon: Package },
      { id: 'invoices',  label: 'Invoices',  icon: FileText },
    ],
  },
  {
    label: 'INVENTORY',
    items: [
      { id: 'inventory', label: 'Inventory', icon: Boxes  },
      { id: 'services',  label: 'Services',  icon: Wrench },
    ],
  },
  {
    label: 'FINANCE',
    items: [
      { id: 'ledger', label: 'Ledger', icon: BookOpen },
    ],
  },
  {
    label: 'MANAGEMENT',
    items: [
      { id: 'customers',     label: 'Customers',     icon: Users },
      { id: 'suppliers',     label: 'Suppliers',     icon: Truck },
      { id: 'organizations', label: 'Organization',  icon: Building2 },
      { id: 'auditlog',      label: 'Audit Log',     icon: ClipboardList },
    ],
  },
  {
    label: 'FITMENT GUIDE',
    items: [
      { id: 'tyreFitment', label: 'Tyre Fitment', icon: Car },
    ],
  },
];

interface SidebarProps {
  activePage: string;
  onNavigate: (page: string) => void;
  collapsed: boolean;
  onCollapsedChange: (val: boolean) => void;
  user: { name: string; email: string; role: string };
  onLogout: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  counts?: Record<string, number>;
  adminOnlyPages?: Set<string>;
}

export default function Sidebar({
  activePage, onNavigate, collapsed, onCollapsedChange,
  user, onLogout, mobileOpen, onMobileClose, counts = {}, adminOnlyPages = new Set(),
}: SidebarProps) {
  const { roleName } = usePermissions();
  const isAdmin = user.role === 'org_admin';
  const modules = useModules();
  const visibleGroups = navGroups
    .map(group => ({
      ...group,
      items: group.items.filter(item => (!adminOnlyPages.has(item.id) || isAdmin) && (item.id !== 'tyreFitment' || modules.tyreFitment)),
    }))
    .filter(group => group.items.length > 0);
  const desktopWidth = collapsed ? 'lg:w-[72px]' : 'lg:w-64';

  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={onMobileClose}
        />
      )}

      <aside
        className={cn(
          'fixed left-0 top-0 h-full bg-white border-r border-slate-200 flex flex-col z-50 shadow-lg transition-all duration-300 ease-in-out',
          'w-64',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          'lg:translate-x-0',
          desktopWidth
        )}
      >
        {/* Logo */}
        <div className={cn(
          'flex items-center gap-3 px-4 py-4 border-b border-slate-100',
          collapsed && 'lg:justify-center lg:px-0'
        )}>
          <div className="flex-shrink-0 w-9 h-9 bg-teal-500 rounded-xl flex items-center justify-center shadow-sm">
            <TrendingUp size={18} className="text-white" />
          </div>
          <div className={cn(collapsed && 'lg:hidden')}>
            <h1 className="text-base font-bold text-slate-900 leading-tight">{getCachedSettings().company_name}</h1>
            <p className="text-[11px] text-slate-400 font-medium">{getCachedSettings().company_tagline}</p>
          </div>
          <button
            onClick={onMobileClose}
            className="ml-auto p-1 text-slate-400 hover:text-slate-700 lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        {/* User profile */}
        <div className={cn(
          'flex items-center gap-2.5 px-4 py-3 border-b border-slate-100 bg-slate-50/60',
          collapsed && 'lg:justify-center lg:px-2 lg:py-3'
        )}>
          <div className="w-9 h-9 bg-teal-500 rounded-full flex items-center justify-center flex-shrink-0 text-white text-sm font-bold shadow-sm ring-2 ring-teal-200">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className={cn('flex-1 min-w-0', collapsed && 'lg:hidden')}>
            <p className="text-[13px] font-semibold text-slate-900 truncate leading-tight">{user.name}</p>
            <p className="text-[11px] text-slate-400 mt-0.5 truncate">{roleName || user.role}</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-2 overflow-y-auto">
          <ul className="px-3">
            {visibleGroups.map((group, gi) => (
              <li key={group.label} className={gi > 0 ? 'mt-1' : ''}>
                {/* Section label */}
                <p className={cn(
                  'text-[10px] font-bold text-slate-400 uppercase tracking-widest px-2 pt-4 pb-1.5 select-none',
                  collapsed && 'lg:hidden'
                )}>
                  {group.label}
                </p>
                {/* Divider in collapsed mode */}
                {collapsed && (
                  <div className="hidden lg:block border-t border-slate-100 my-2 mx-1" />
                )}
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = activePage === item.id;
                    const count = counts[item.id] ?? 0;
                    return (
                      <li key={item.id}>
                        <button
                          onClick={() => onNavigate(item.id)}
                          title={collapsed ? item.label : undefined}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-150 group relative cursor-pointer',
                            isActive
                              ? 'bg-teal-500 text-white shadow-sm shadow-teal-200'
                              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                            collapsed && 'lg:justify-center lg:px-0 lg:py-3'
                          )}
                        >
                          {/* Icon with collapsed dot indicator */}
                          <div className="relative flex-shrink-0">
                            <Icon
                              size={17}
                              className={cn(
                                'transition-colors',
                                isActive ? 'text-white' : 'text-slate-400 group-hover:text-slate-600'
                              )}
                            />
                            {count > 0 && (
                              <span className={cn(
                                'absolute -top-1 -right-1 w-2 h-2 bg-amber-500 rounded-full ring-1',
                                isActive ? 'ring-teal-500' : 'ring-white',
                                collapsed ? 'hidden lg:block' : 'hidden',
                              )} />
                            )}
                          </div>

                          <span className={cn('flex-1 text-left', collapsed && 'lg:hidden')}>
                            {item.label}
                          </span>

                          {/* Expanded badge */}
                          {count > 0 && (
                            <span className={cn(
                              'text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none',
                              isActive
                                ? 'bg-white/25 text-white'
                                : 'bg-amber-50 text-amber-600 border border-amber-100',
                              collapsed && 'lg:hidden',
                            )}>
                              {count > 99 ? '99+' : count}
                            </span>
                          )}

                          {/* Tooltip */}
                          {collapsed && (
                            <span className="absolute left-full ml-3 bg-slate-800 text-white text-xs px-2.5 py-1.5 rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-xl z-50 hidden lg:block">
                              {item.label}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-100 p-3 space-y-0.5">
          {isAdmin && <button
            onClick={() => onNavigate('settings')}
            title={collapsed ? 'Settings' : undefined}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all group relative cursor-pointer',
              collapsed && 'lg:justify-center lg:px-0 lg:py-3',
              activePage === 'settings'
                ? 'bg-teal-500 text-white shadow-sm shadow-teal-200'
                : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
            )}
          >
            <Settings
              size={17}
              className={cn(
                'flex-shrink-0',
                activePage === 'settings'
                  ? 'text-white'
                  : 'text-slate-400 group-hover:text-slate-600'
              )}
            />
            <span className={cn(collapsed && 'lg:hidden')}>Settings</span>
            {collapsed && (
              <span className="absolute left-full ml-3 bg-slate-800 text-white text-xs px-2.5 py-1.5 rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-xl z-50 hidden lg:block">
                Settings
              </span>
            )}
          </button>}

          <button
            onClick={onLogout}
            title={collapsed ? 'Sign Out' : undefined}
            className={cn(
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium text-slate-600 hover:bg-red-50 hover:text-red-600 transition-all group relative cursor-pointer',
              collapsed && 'lg:justify-center lg:px-0 lg:py-3'
            )}
          >
            <LogOut size={17} className="flex-shrink-0 text-slate-400 group-hover:text-red-500 transition-colors" />
            <span className={cn(collapsed && 'lg:hidden')}>Sign Out</span>
            {collapsed && (
              <span className="absolute left-full ml-3 bg-slate-800 text-white text-xs px-2.5 py-1.5 rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity shadow-xl z-50 hidden lg:block">
                Sign Out
              </span>
            )}
          </button>

          {/* Collapse toggle — desktop only */}
          <button
            onClick={() => onCollapsedChange(!collapsed)}
            className={cn(
              'hidden lg:flex w-full items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-all',
              collapsed && 'justify-center px-0'
            )}
          >
            {collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
