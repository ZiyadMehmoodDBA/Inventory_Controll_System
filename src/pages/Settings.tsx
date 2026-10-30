import { useState, useEffect } from 'react';
import {
  Building2, FileText, Tag, Save, Loader2, CheckCircle, AlertCircle,
  Package, Wrench, Users, Server, Globe, ShieldCheck, DatabaseBackup,
} from 'lucide-react';
import { api } from '../api/client';

import CompanyTab      from './settings/CompanyTab';
import DefaultsTab     from './settings/DefaultsTab';
import ProductsTab     from './settings/ProductsTab';
import LookupsTab      from './settings/LookupsTab';
import ServicesTab     from './settings/ServicesTab';
import UsersTab        from './settings/UsersTab';
import RolesTab        from './settings/RolesTab';
import SystemInfoTab   from './settings/SystemInfoTab';
import BackupsTab      from './settings/BackupsTab';
import CatalogScraperTab from './settings/CatalogScraperTab';
import { useModules, useTerms } from '../lib/businessTypes';
import { usePermissions } from '../lib/permissions';

type Tab = 'company' | 'defaults' | 'products' | 'lookups' | 'services' | 'users' | 'roles' | 'system' | 'catalog' | 'backups';

const ALL_TABS: { id: Tab; label: string; icon: React.ElementType; adminOnly?: boolean; platformOnly?: boolean }[] = [
  { id: 'company',  label: 'Company Profile',       icon: Building2 },
  { id: 'defaults', label: 'Invoice & PO Defaults',  icon: FileText },
  { id: 'products', label: 'Products',               icon: Package  },
  { id: 'lookups',  label: 'Lookup Tables',          icon: Tag      },
  { id: 'services', label: 'Services',               icon: Wrench   },
  { id: 'users',    label: 'Users',                  icon: Users    },
  { id: 'roles',    label: 'Roles & permissions',    icon: ShieldCheck },
  { id: 'catalog',  label: 'Catalog Scraper',        icon: Globe,   adminOnly: true },
  { id: 'system',   label: 'System',                 icon: Server,  adminOnly: true },
  { id: 'backups',  label: 'Backups',                icon: DatabaseBackup, platformOnly: true },
];

const AUTO_SAVE_TABS: Tab[] = ['lookups', 'products', 'services', 'users', 'roles', 'system', 'catalog', 'backups'];

function getCurrentUserRole(): string | null {
  try {
    const token = localStorage.getItem('tunegen_at');
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.role ?? null;
  } catch { return null; }
}

export default function Settings() {
  const isAdmin = getCurrentUserRole() === 'org_admin';
  const modules = useModules();
  const terms   = useTerms();
  const { platformAdmin } = usePermissions();
  const TABS    = ALL_TABS.filter(t => (!t.adminOnly || isAdmin) && (!t.platformOnly || platformAdmin) && (t.id !== 'catalog' || modules.tyreCatalog) && (t.id !== 'lookups' || terms.tyre));

  const [tab, setTab]           = useState<Tab>('company');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loaded, setLoaded]     = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saved, setSaved]       = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => {
    api.settings.get()
      .then(data => { setSettings(data); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSaved(false); setSaveError('');
  };

  const handleSave = async () => {
    setSaving(true); setSaveError(''); setSaved(false);
    try {
      const updated = await api.settings.update(settings);
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setSaveError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={24} className="animate-spin text-slate-400" />
      </div>
    );
  }

  const isAutoSaveTab = AUTO_SAVE_TABS.includes(tab);

  return (
    <div className="px-3 sm:px-4 pt-3 pb-4 mx-auto max-w-6xl">
      <div className="mb-2.5">
        <h1 className="text-xl font-bold text-slate-900">Settings</h1>
        <p className="text-sm text-slate-400 mt-0.5">Configure company details, invoice defaults, products catalog, and lookup tables</p>
      </div>

      {/* Tab bar */}
      <div className="flex flex-wrap gap-1 bg-slate-100 rounded-2xl p-1 mb-3 w-full min-w-0" data-testid="settings-tabs">
        {TABS.map(t => {
          const Icon   = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-auto min-w-0 items-center justify-center gap-1 px-2 lg:px-2.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
                active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon size={14} className="flex-shrink-0" />
              <span className="hidden sm:inline">{t.label}</span>
              <span className="sm:hidden">{t.label.split(' ')[0]}</span>
            </button>
          );
        })}
      </div>

      {/* Card */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-6 py-5">
          {tab === 'company'  && <CompanyTab  settings={settings} onChange={handleChange} />}
          {tab === 'defaults' && <DefaultsTab settings={settings} onChange={handleChange} />}
          {tab === 'products' && <ProductsTab />}
          {tab === 'lookups'  && <LookupsTab />}
          {tab === 'services' && <ServicesTab />}
          {tab === 'users'    && <UsersTab />}
          {tab === 'roles'    && <RolesTab />}
          {tab === 'catalog'  && isAdmin && modules.tyreCatalog && <CatalogScraperTab />}
          {tab === 'system'   && isAdmin && <SystemInfoTab />}
          {tab === 'backups'  && platformAdmin && <BackupsTab />}
        </div>

        {!isAutoSaveTab && (
          <div className="flex items-center justify-between gap-3 px-6 py-4 bg-slate-50 border-t border-slate-100">
            {saveError ? (
              <span className="flex items-center gap-2 text-sm text-red-600 font-medium">
                <AlertCircle size={14} /> {saveError}
              </span>
            ) : saved ? (
              <span className="flex items-center gap-2 text-sm text-emerald-600 font-medium">
                <CheckCircle size={14} /> Settings saved successfully
              </span>
            ) : (
              <span className="text-xs text-slate-400">Changes are saved to the database and take effect immediately</span>
            )}
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 disabled:opacity-60 transition-colors min-w-28 justify-center flex-shrink-0"
            >
              {saving
                ? <><Loader2 size={14} className="animate-spin" /> Saving...</>
                : <><Save size={14} /> Save Changes</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
