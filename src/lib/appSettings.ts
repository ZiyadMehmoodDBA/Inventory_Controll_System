export interface AppSettings {
  company_name:        string;
  company_tagline:     string;
  business_type:       string;
  company_address:     string;
  company_phone:       string;
  company_email:       string;
  invoice_prefix:      string;
  po_prefix:           string;
  default_tax_rate:    number;
  payment_due_days:    number;
  default_sale_status: string;
  currency:            string;
  announcement:        string;
  refresh_interval:    number;  // seconds; 0 = disabled
}

export const DEFAULT_SETTINGS: AppSettings = {
  company_name:        'TuneGEN',
  company_tagline:     'Billing & Inventory Control',
  business_type:       'general_store',
  company_address:     '123 Industrial Zone, Lahore, Pakistan',
  company_phone:       '+92-42-1234567',
  company_email:       'info@tunegen.pk',
  invoice_prefix:      'INV',
  po_prefix:           'PO',
  default_tax_rate:    15,
  payment_due_days:    30,
  default_sale_status: 'pending',
  currency:            'PKR',
  announcement:        '',
  refresh_interval:    60,
};

const CACHE_KEY = 'tunegen_settings_v1';
export const SETTINGS_EVENT = 'tunegen:settings';

/** Read settings from localStorage, falling back to defaults. */
export function getCachedSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Record<string, string>;
    return {
      company_name:        parsed.company_name        ?? DEFAULT_SETTINGS.company_name,
      company_tagline:     parsed.company_tagline     ?? DEFAULT_SETTINGS.company_tagline,
      business_type:       parsed.business_type       ?? DEFAULT_SETTINGS.business_type,
      company_address:     parsed.company_address     ?? DEFAULT_SETTINGS.company_address,
      company_phone:       parsed.company_phone       ?? DEFAULT_SETTINGS.company_phone,
      company_email:       parsed.company_email       ?? DEFAULT_SETTINGS.company_email,
      invoice_prefix:      parsed.invoice_prefix      ?? DEFAULT_SETTINGS.invoice_prefix,
      po_prefix:           parsed.po_prefix           ?? DEFAULT_SETTINGS.po_prefix,
      default_tax_rate:    Number(parsed.default_tax_rate    ?? DEFAULT_SETTINGS.default_tax_rate),
      payment_due_days:    Number(parsed.payment_due_days    ?? DEFAULT_SETTINGS.payment_due_days),
      default_sale_status: parsed.default_sale_status ?? DEFAULT_SETTINGS.default_sale_status,
      currency:            parsed.currency            ?? DEFAULT_SETTINGS.currency,
      announcement:        parsed.announcement        ?? DEFAULT_SETTINGS.announcement,
      refresh_interval:    Number(parsed.refresh_interval ?? DEFAULT_SETTINGS.refresh_interval),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist a raw key-value map from the server into localStorage. */
export function cacheSettingsMap(map: Record<string, string>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {}
  window.dispatchEvent(new Event(SETTINGS_EVENT));
}
