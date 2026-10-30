import {
  LayoutDashboard, ShoppingCart, Package, FileText, Users, Truck, BarChart2, Settings, Boxes, BookOpen, Building2, Wrench, ClipboardList, Car, Sparkles,
} from 'lucide-react';
import type { ModuleFlags } from './businessTypes';

// The one list of screens. The sidebar, the mobile bottom bar and the router in App all derive from it, so a screen can never be in one menu
// and missing from (or unreachable in) another. Who may see an entry is decided here and only here; the API still enforces access itself.
export interface NavEntry {
  id: string;
  label: string;
  group: string;                          // sidebar section
  icon: React.ElementType;
  adminOnly?: boolean;                    // organisation administrators only
  module?: keyof ModuleFlags;             // only when the business type enables this module
  anyPermission?: string[];               // visible when the user holds at least one of these
  mobileTab?: string;                     // short label when this entry is one of the four bottom-bar tabs
  footer?: boolean;                       // sidebar footer (below the sections) instead of a section
}

export const NAV: NavEntry[] = [
  { id: 'dashboard',     label: 'Dashboard',    group: 'ANALYTICS',    icon: LayoutDashboard, mobileTab: 'Home' },
  { id: 'reports',       label: 'Reports',      group: 'ANALYTICS',    icon: BarChart2 },
  { id: 'aiReports',     label: 'AI Reports',   group: 'ANALYTICS',    icon: Sparkles },
  { id: 'sales',         label: 'Sales',        group: 'OPERATIONS',   icon: ShoppingCart, mobileTab: 'Sales' },
  { id: 'purchases',     label: 'Purchases',    group: 'OPERATIONS',   icon: Package, anyPermission: ['purchases.view', 'purchases.manage', 'stock.receive'] },
  { id: 'invoices',      label: 'Invoices',     group: 'OPERATIONS',   icon: FileText },
  { id: 'inventory',     label: 'Inventory',    group: 'INVENTORY',    icon: Boxes, anyPermission: ['inventory.view'], mobileTab: 'Stock' },
  { id: 'services',      label: 'Services',     group: 'INVENTORY',    icon: Wrench },
  { id: 'ledger',        label: 'Ledger',       group: 'FINANCE',      icon: BookOpen },
  { id: 'customers',     label: 'Customers',    group: 'MANAGEMENT',   icon: Users, mobileTab: 'Customers' },
  { id: 'suppliers',     label: 'Suppliers',    group: 'MANAGEMENT',   icon: Truck },
  { id: 'organizations', label: 'Organization', group: 'MANAGEMENT',   icon: Building2, adminOnly: true },
  { id: 'auditlog',      label: 'Audit Log',    group: 'MANAGEMENT',   icon: ClipboardList, adminOnly: true },
  { id: 'tyreFitment',   label: 'Tyre Fitment', group: 'FITMENT GUIDE', icon: Car, module: 'tyreFitment' },
  { id: 'settings',      label: 'Settings',     group: 'SYSTEM',       icon: Settings, adminOnly: true, footer: true },
];

export interface NavContext { isAdmin: boolean; modules: ModuleFlags; canAny: (...codes: string[]) => boolean }

/** Ids of the screens this user can open right now. */
export function visibleIds(ctx: NavContext): Set<string> {
  return new Set(NAV.filter(e =>
    (!e.adminOnly || ctx.isAdmin) &&
    (!e.module || ctx.modules[e.module]) &&
    (!e.anyPermission || ctx.canAny(...e.anyPermission)),
  ).map(e => e.id));
}
