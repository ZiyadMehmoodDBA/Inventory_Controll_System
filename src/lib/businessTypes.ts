import { useSyncExternalStore } from 'react';
import { getCachedSettings, SETTINGS_EVENT } from './appSettings';

// Keep ids in step with server/utils/businessTypes.js (the server enforces modules).
export const BUSINESS_TYPES = [
  { id: 'general_store',      label: 'General Store' },
  { id: 'tyre_shop',          label: 'Tyre & Wheel Shop' },
  { id: 'auto_parts',         label: 'Auto Parts & Accessories' },
  { id: 'auto_workshop',      label: 'Auto Workshop / Service Center' },
  { id: 'grocery',            label: 'Grocery / Supermarket' },
  { id: 'pharmacy',           label: 'Pharmacy / Medical Store' },
  { id: 'perfumes_cosmetics', label: 'Perfumes & Cosmetics' },
  { id: 'clothing',           label: 'Clothing & Fashion' },
  { id: 'electronics',        label: 'Electronics & Mobile' },
  { id: 'hardware',           label: 'Hardware & Building Materials' },
  { id: 'restaurant',         label: 'Restaurant / Café / Bakery' },
  { id: 'stationery',         label: 'Stationery & Books' },
  { id: 'wholesale',          label: 'Wholesale & Distribution' },
  { id: 'manufacturing',      label: 'Manufacturing' },
  { id: 'other',              label: 'Other' },
] as const;

export const DEFAULT_BUSINESS_TYPE = 'general_store';

export interface ModuleFlags {
  tyreFitment: boolean;   // Tyre Fitment Guide + "By Vehicle" lookup in POS
  tyreCatalog: boolean;   // Tire catalog import + GTR catalog scraper
}

export function modulesFor(type: string): ModuleFlags {
  const tyre = type === 'tyre_shop';
  return { tyreFitment: tyre, tyreCatalog: tyre };
}

const subscribe = (cb: () => void) => {
  window.addEventListener(SETTINGS_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => { window.removeEventListener(SETTINGS_EVENT, cb); window.removeEventListener('storage', cb); };
};

/** Enabled optional modules for the current organisation; updates when settings change. */
export function useModules(): ModuleFlags {
  const type = useSyncExternalStore(subscribe, () => getCachedSettings().business_type, () => DEFAULT_BUSINESS_TYPE);
  return modulesFor(type);
}

/** Wording and field set for stock items, per business type. */
export interface Terms {
  tyre: boolean;          // show tyre-only fields (pattern, load/speed index, DOT, tyre types)
  item: string;           // "Tyre", "Medicine", "Product"
  items: string;
  brand: string;          // label for the brand field
  name: string;           // label for the model/name field
  size: string;           // label for the size field ("Size", "Strength", "Pack size")
  sizeRequired: boolean;
  groupBy: string;        // dashboard breakdown label: "Tyre Type" or "Category"
  stockMode: string;      // line-item toggle label: "Tyre", "Medicine", "Stock item"
  addLabel: string;       // button: "Add Tyre", "Add Medicine"
  catalog: string;        // inventory page title
  inventorySubtitle: string;
  servicesSubtitle: string;
  serviceExample: string; // placeholder for a new service name
  announceExample: string;
  sample: { item: string; brand: string; name: string; size: string; unitCost: string; unitPrice: string; customer: string; supplier: string };
}

const GENERIC_SAMPLE = { item: 'Sample Item 500ml', brand: 'Acme', name: 'Sample Item', size: '500ml', unitCost: '120', unitPrice: '200', customer: 'Ahmed Traders', supplier: 'Acme Distributors' };

const TERMS: Record<string, Partial<Terms> & { item: string; items: string }> = {
  tyre_shop:          { item: 'Tyre', items: 'Tyres', name: 'Model', size: 'Size', sizeRequired: true, groupBy: 'Tyre Type', catalog: 'Tyre SKU Catalog',
                        sample: { item: 'Bridgestone Ecopia EP150 195/65R15', brand: 'Bridgestone', name: 'Ecopia EP150', size: '195/65R15', unitCost: '8500', unitPrice: '12000', customer: 'Ahmed Transport Co.', supplier: 'Bridgestone Pakistan Ltd.' } },
  auto_parts:         { item: 'Part', items: 'Parts', name: 'Part name', size: 'Fitment / Spec', sample: { ...GENERIC_SAMPLE, item: 'Bosch Oil Filter 0451', brand: 'Bosch', name: 'Oil Filter 0451', size: 'Corolla 2014', supplier: 'Bosch Distributors' } },
  auto_workshop:      { item: 'Part', items: 'Parts', name: 'Part name', size: 'Spec', sample: { ...GENERIC_SAMPLE, item: 'Engine Oil 5W-30 4L', brand: 'Castrol', name: 'Engine Oil 5W-30', size: '4L' } },
  pharmacy:           { item: 'Medicine', items: 'Medicines', brand: 'Manufacturer', name: 'Medicine name', size: 'Strength / Pack', sample: { ...GENERIC_SAMPLE, item: 'Panadol 500mg 20 tabs', brand: 'GSK', name: 'Panadol', size: '500mg 20 tabs', supplier: 'Medico Distributors', customer: 'Walk-in Patient' } },
  grocery:            { item: 'Product', items: 'Products', name: 'Product name', size: 'Pack size', sample: { ...GENERIC_SAMPLE, item: 'Basmati Rice 5kg', brand: 'Guard', name: 'Basmati Rice', size: '5kg' } },
  perfumes_cosmetics: { item: 'Product', items: 'Products', name: 'Product name', size: 'Volume', sample: { ...GENERIC_SAMPLE, item: 'Dior Sauvage 100ml', brand: 'Dior', name: 'Sauvage', size: '100ml', unitCost: '14000', unitPrice: '21000' } },
  clothing:           { item: 'Item', items: 'Items', name: 'Style / Name', size: 'Size / Colour', sample: { ...GENERIC_SAMPLE, item: 'Slim Fit Shirt M Blue', brand: 'Outfitters', name: 'Slim Fit Shirt', size: 'M Blue' } },
  electronics:        { item: 'Product', items: 'Products', name: 'Model', size: 'Variant', sample: { ...GENERIC_SAMPLE, item: 'Samsung Galaxy A15 128GB', brand: 'Samsung', name: 'Galaxy A15', size: '128GB', unitCost: '42000', unitPrice: '48000' } },
  hardware:           { item: 'Material', items: 'Materials', name: 'Item name', size: 'Size / Grade', sample: { ...GENERIC_SAMPLE, item: 'Portland Cement 50kg', brand: 'Lucky', name: 'Portland Cement', size: '50kg' } },
  restaurant:         { item: 'Menu Item', items: 'Menu Items', name: 'Item name', size: 'Portion', sample: { ...GENERIC_SAMPLE, item: 'Chicken Karahi Full', brand: '', name: 'Chicken Karahi', size: 'Full' } },
  stationery:         { item: 'Item', items: 'Items', name: 'Item name', size: 'Size / Pack', sample: { ...GENERIC_SAMPLE, item: 'A4 Paper Ream 80gsm', brand: 'Double A', name: 'A4 Paper', size: '80gsm Ream' } },
  wholesale:          { item: 'Product', items: 'Products', name: 'Product name', size: 'Pack / Carton' },
  manufacturing:      { item: 'Material', items: 'Materials', name: 'Item name', size: 'Spec' },
};

export function termsFor(type: string): Terms {
  const t = TERMS[type] ?? { item: 'Item', items: 'Items' };
  const tyre = type === 'tyre_shop';
  const item = t.item;
  return {
    tyre, item, items: t.items,
    brand: t.brand ?? 'Brand', name: t.name ?? 'Item name', size: t.size ?? 'Size / Variant',
    sizeRequired: t.sizeRequired ?? false,
    groupBy: t.groupBy ?? 'Category',
    stockMode: tyre ? 'Tyre' : (item === 'Product' || item === 'Item' ? 'Stock item' : item),
    addLabel: `Add ${item}`,
    catalog: t.catalog ?? `${item} Catalog`,
    inventorySubtitle: `Monitor ${item.toLowerCase()} stock levels`,
    servicesSubtitle: tyre || type === 'auto_workshop' || type === 'auto_parts' ? 'Fitting, balancing, alignment and other services' : 'Services you sell alongside your products',
    serviceExample: tyre ? 'Tyre Fitting' : type === 'auto_workshop' || type === 'auto_parts' ? 'Oil Change' : type === 'pharmacy' ? 'Home Delivery' : type === 'clothing' ? 'Alterations' : type === 'electronics' ? 'Screen Repair' : 'Delivery Charge',
    announceExample: tyre ? 'New tyre brands now in stock' : `New ${t.items.toLowerCase()} now in stock`,
    sample: t.sample ?? GENERIC_SAMPLE,
  };
}

export function useTerms(): Terms {
  const type = useSyncExternalStore(subscribe, () => getCachedSettings().business_type, () => DEFAULT_BUSINESS_TYPE);
  return termsFor(type);
}
