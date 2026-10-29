import { useState } from 'react';
import {
  LayoutDashboard, ShoppingCart, Boxes, Users, MoreHorizontal,
  Package, FileText, Truck, BarChart2, Settings, LogOut, X, Car,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { useModules } from '../lib/businessTypes';

interface BottomNavProps {
  activePage: string;
  onNavigate: (page: string) => void;
  onLogout: () => void;
  counts?: Record<string, number>;
}


const primaryTabs = [
  { id: 'dashboard', label: 'Home',      icon: LayoutDashboard },
  { id: 'sales',     label: 'Sales',     icon: ShoppingCart },
  { id: 'inventory', label: 'Stock',     icon: Boxes },
  { id: 'customers', label: 'Customers', icon: Users },
];

const allMoreItems = [
  { id: 'purchases',   label: 'Purchases',     icon: Package },
  { id: 'invoices',    label: 'Invoices',      icon: FileText },
  { id: 'reports',     label: 'Reports',       icon: BarChart2 },
  { id: 'suppliers',   label: 'Suppliers',     icon: Truck },
  { id: 'tyreFitment', label: 'Tyre Fitment',  icon: Car },
  { id: 'settings',    label: 'Settings',      icon: Settings },
];

export default function BottomNav({ activePage, onNavigate, onLogout, counts = {} }: BottomNavProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const modules = useModules();
  const moreItems = allMoreItems.filter(i => i.id !== 'tyreFitment' || modules.tyreFitment);

  const isMoreActive = moreItems.some(item => item.id === activePage);
  const moreActivityCount = moreItems.reduce((sum, item) => sum + (counts[item.id] ?? 0), 0);

  const navigate = (page: string) => {
    onNavigate(page);
    setSheetOpen(false);
  };

  return (
    <>
      {/* Sheet backdrop */}
      {sheetOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 lg:hidden"
          onClick={() => setSheetOpen(false)}
        />
      )}

      {/* "More" bottom sheet */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-2xl z-50 lg:hidden transition-transform duration-300 ease-out',
          sheetOpen ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        {/* Pull handle */}
        <div className="relative flex items-center justify-between px-5 pt-5 pb-3">
          <div className="absolute top-2.5 left-1/2 -translate-x-1/2 w-10 h-1 bg-slate-200 rounded-full" />
          <p className="text-sm font-bold text-slate-800">More</p>
          <button
            onClick={() => setSheetOpen(false)}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X size={17} />
          </button>
        </div>

        <div className="px-4 pb-4 grid grid-cols-3 gap-2">
          {moreItems.map(item => {
            const Icon     = item.icon;
            const isActive = activePage === item.id;
            const count    = counts[item.id] ?? 0;
            return (
              <button
                key={item.id}
                onClick={() => navigate(item.id)}
                className={cn(
                  'flex flex-col items-center gap-1.5 p-3.5 rounded-xl transition-all',
                  isActive
                    ? 'bg-teal-50 text-teal-600'
                    : 'text-slate-500 hover:bg-slate-50 active:bg-slate-100',
                )}
              >
                <div className="relative">
                  <Icon size={21} className={isActive ? 'text-teal-600' : 'text-slate-400'} />
                  {count > 0 && (
                    <span className="absolute -top-1.5 -right-2 min-w-[14px] h-3.5 bg-amber-500 rounded-full text-[8px] font-bold text-white flex items-center justify-center px-0.5 ring-1 ring-white leading-none">
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-semibold">{item.label}</span>
              </button>
            );
          })}

          <button
            onClick={() => { setSheetOpen(false); onLogout(); }}
            className="flex flex-col items-center gap-1.5 p-3.5 rounded-xl text-red-500 hover:bg-red-50 active:bg-red-100 transition-all"
          >
            <LogOut size={21} />
            <span className="text-[11px] font-semibold">Sign Out</span>
          </button>
        </div>

        {/* iOS safe area */}
        <div style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} />
      </div>

      {/* ── Fixed bottom tab bar ── */}
      <nav
        className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 z-30 lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        <div className="flex items-stretch h-14">
          {primaryTabs.map(tab => {
            const Icon     = tab.icon;
            const isActive = activePage === tab.id;
            const count    = counts[tab.id] ?? 0;
            return (
              <button
                key={tab.id}
                onClick={() => onNavigate(tab.id)}
                className={cn(
                  'flex-1 flex flex-col items-center justify-center gap-0.5 relative transition-colors',
                  isActive ? 'text-teal-600' : 'text-slate-400 hover:text-slate-600',
                )}
              >
                {isActive && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-teal-500 rounded-b-full" />
                )}
                <div className="relative">
                  <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
                  {count > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[14px] h-3.5 bg-red-500 rounded-full text-[8px] font-bold text-white flex items-center justify-center px-0.5 ring-1 ring-white leading-none">
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-semibold leading-none">{tab.label}</span>
              </button>
            );
          })}

          {/* More button */}
          <button
            onClick={() => setSheetOpen(v => !v)}
            className={cn(
              'flex-1 flex flex-col items-center justify-center gap-0.5 relative transition-colors',
              isMoreActive || sheetOpen ? 'text-teal-600' : 'text-slate-400 hover:text-slate-600',
            )}
          >
            {(isMoreActive || sheetOpen) && (
              <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-teal-500 rounded-b-full" />
            )}
            <div className="relative">
              <MoreHorizontal size={20} strokeWidth={isMoreActive || sheetOpen ? 2.2 : 1.8} />
              {moreActivityCount > 0 && !sheetOpen && (
                <span className="absolute -top-1.5 -right-2.5 min-w-[14px] h-3.5 bg-amber-500 rounded-full text-[8px] font-bold text-white flex items-center justify-center px-0.5 ring-1 ring-white leading-none">
                  {moreActivityCount > 99 ? '99+' : moreActivityCount}
                </span>
              )}
            </div>
            <span className="text-[10px] font-semibold leading-none">More</span>
          </button>
        </div>
      </nav>
    </>
  );
}
