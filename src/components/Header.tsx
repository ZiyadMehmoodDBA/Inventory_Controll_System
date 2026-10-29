import { Bell, Search, LogOut, ChevronDown, Menu, AlertCircle, Clock, ChevronRight, X, User, KeyRound } from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils';
import { usePermissions } from '../lib/permissions';

export interface AppNotification {
  id: string;
  title: string;
  subtitle: string;
  page: string;
  severity: 'warning' | 'error';
}

interface HeaderProps {
  title: string;
  subtitle?: string;
  user: { name: string; email: string; role: string };
  onLogout: () => void;
  onMenuToggle: () => void;
  onProfile?: () => void;
  onChangePassword?: () => void;
  notifications?: AppNotification[];
  onNavigate?: (page: string) => void;
}

const ROLE_LABELS: Record<string, string> = {
  org_admin:      'Organization Admin',
  branch_manager: 'Branch Manager',
  staff:          'Warehouse Staff',
  purchasing:     'Purchasing / Finance',
};

export default function Header({
  title, subtitle, user, onLogout, onMenuToggle,
  onProfile, onChangePassword,
  notifications = [], onNavigate,
}: HeaderProps) {
  const { roleName } = usePermissions();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const openNotif = () => { setNotifOpen(v => !v); setDropdownOpen(false); };
  const openUser  = () => { setDropdownOpen(v => !v); setNotifOpen(false); };

  return (
    <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 sm:py-3.5 flex items-center justify-between sticky top-0 z-40">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onMenuToggle}
          className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors lg:hidden flex-shrink-0"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-bold text-slate-900 truncate">{title}</h2>
          {subtitle && (
            <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">{subtitle}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        {/* Search — hidden on mobile */}
        <div className="relative hidden md:block">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search..."
            className="pl-9 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400 w-40 lg:w-48 transition-all focus:w-56 lg:focus:w-64"
          />
        </div>

        {/* Notifications */}
        <div className="relative">
          <button
            onClick={openNotif}
            className="relative p-2 text-slate-500 hover:bg-slate-100 rounded-xl transition-colors"
            aria-label="Notifications"
          >
            <Bell size={18} />
            {notifications.length > 0 ? (
              <span className="absolute top-1 right-1 min-w-[16px] h-4 bg-red-500 rounded-full ring-1 ring-white flex items-center justify-center text-[9px] font-bold text-white px-0.5 leading-none">
                {notifications.length > 9 ? '9+' : notifications.length}
              </span>
            ) : (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-teal-500 rounded-full ring-1 ring-white" />
            )}
          </button>

          {notifOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setNotifOpen(false)} />
              <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-xl border border-slate-100 z-20 overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-slate-900">Notifications</p>
                    {notifications.length > 0 && (
                      <span className="text-[10px] font-bold bg-red-50 text-red-600 border border-red-100 px-1.5 py-0.5 rounded-full leading-none">
                        {notifications.length}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setNotifOpen(false)}
                    className="p-1 text-slate-400 hover:text-slate-600 rounded-lg transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>

                {notifications.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <div className="w-10 h-10 bg-teal-50 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Bell size={18} className="text-teal-500" />
                    </div>
                    <p className="text-sm font-semibold text-slate-700">All caught up!</p>
                    <p className="text-xs text-slate-400 mt-0.5">No pending alerts right now</p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-50 max-h-72 overflow-y-auto">
                    {notifications.map(n => (
                      <button
                        key={n.id}
                        onClick={() => { setNotifOpen(false); onNavigate?.(n.page); }}
                        className="w-full flex items-start gap-3 px-4 py-3.5 hover:bg-slate-50 transition-colors text-left"
                      >
                        <div className={cn(
                          'mt-0.5 w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
                          n.severity === 'error' ? 'bg-red-50' : 'bg-amber-50',
                        )}>
                          {n.severity === 'error'
                            ? <AlertCircle size={15} className="text-red-500" />
                            : <Clock size={15} className="text-amber-500" />
                          }
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-semibold text-slate-900 leading-tight">{n.title}</p>
                          <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{n.subtitle}</p>
                        </div>
                        <ChevronRight size={14} className="text-slate-300 mt-1.5 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                <div className="px-4 py-2.5 border-t border-slate-50 bg-slate-50/50">
                  <p className="text-[11px] text-slate-400 text-center">Tap an alert to go to the page</p>
                </div>
              </div>
            </>
          )}
        </div>

        {/* User dropdown */}
        <div className="relative pl-2 sm:pl-3 border-l border-slate-200">
          <button
            onClick={openUser}
            className="flex items-center gap-1.5 sm:gap-2 hover:bg-slate-50 rounded-xl px-1.5 sm:px-2 py-1.5 transition-colors"
          >
            <div className="w-8 h-8 bg-teal-500 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ring-2 ring-teal-100">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-semibold text-slate-900 leading-none">{user.name.split(' ')[0]}</p>
              <p className="text-xs text-slate-400 mt-0.5">{roleName || ROLE_LABELS[user.role] || user.role}</p>
            </div>
            <ChevronDown size={14} className="text-slate-400 hidden sm:block" />
          </button>

          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />
              <div className="absolute right-0 top-full mt-2 w-52 bg-white rounded-xl shadow-xl border border-slate-100 z-20 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100">
                  <p className="text-sm font-bold text-slate-900">{user.name}</p>
                  <p className="text-xs text-slate-400 mt-0.5 truncate">{user.email}</p>
                  <span className="inline-block mt-1.5 text-xs font-semibold bg-teal-50 text-teal-700 border border-teal-100 px-2 py-0.5 rounded-full">
                    {roleName || ROLE_LABELS[user.role] || user.role}
                  </span>
                </div>
                <div className="p-1.5 space-y-0.5">
                  <button
                    onClick={() => { setDropdownOpen(false); onProfile?.(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-lg transition-colors font-medium"
                  >
                    <User size={15} className="text-slate-400" />
                    Profile
                  </button>
                  <button
                    onClick={() => { setDropdownOpen(false); onChangePassword?.(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-lg transition-colors font-medium"
                  >
                    <KeyRound size={15} className="text-slate-400" />
                    Change Password
                  </button>
                  <div className="h-px bg-slate-100 my-1" />
                  <button
                    onClick={() => { setDropdownOpen(false); onLogout(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors font-medium"
                  >
                    <LogOut size={15} />
                    Sign Out
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
