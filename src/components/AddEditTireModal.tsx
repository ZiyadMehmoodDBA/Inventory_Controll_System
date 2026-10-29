import { useState, useEffect } from 'react';
import { X, Loader2, CheckCircle, Package } from 'lucide-react';
import { api } from '../api/client';
import ProductMasterFields from './ProductMasterFields';
import ErrorBanner from './ErrorBanner';
import { formatCurrency } from '../lib/utils';
import { getCachedSettings } from '../lib/appSettings';
import ComboboxInput from './ComboboxInput';
import { useTerms } from '../lib/businessTypes';

interface Props {
  tire?: any;
  onClose: () => void;
  onSaved: () => void;
}

const SPEED_RATINGS = ['', 'N', 'P', 'Q', 'R', 'S', 'T', 'H', 'V', 'W', 'Y', 'ZR'];

export default function AddEditTireModal({ tire, onClose, onSaved }: Props) {
  const isEdit = !!tire;
  const terms  = useTerms();
  const currency = getCachedSettings().currency || 'PKR';
  const [tireTypes, setTireTypes] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<{
    brands: string[];
    models: { brand: string; model: string }[];
    sizes:  { brand: string; model: string; size: string }[];
    patterns:     string[];
    load_indexes: string[];
  }>({ brands: [], models: [], sizes: [], patterns: [], load_indexes: [] });

  useEffect(() => {
    if (terms.tyre) {
      api.lookups.tireTypes()
        .then(types => setTireTypes(types.map((t: any) => t.name)))
        .catch(() => setTireTypes(['Passenger', 'SUV', '4x4', 'LT', 'Performance', 'Motorcycle']));
    }
    api.lookups.tireSuggestions().then(setSuggestions).catch(() => {});
  }, [terms.tyre]);

  const [form, setForm] = useState({
    brand:         tire?.brand         ?? '',
    model:         tire?.model         ?? '',
    size:          tire?.size          ?? '',
    type:          tire?.type          ?? 'Passenger',
    pattern:       tire?.pattern       ?? '',
    load_index:    tire?.load_index    ?? '',
    speed_index:   tire?.speed_index   ?? '',
    dot:           tire?.dot           ?? '',
    stock:         tire?.stock         ?? 0,
    reorder_level: tire?.reorder_level ?? 10,
    cost_price:    tire?.cost_price    ?? 0,
    sale_price:    tire?.sale_price    ?? 0,
    sku:           tire?.sku           ?? '',
    barcode:       tire?.barcode       ?? '',
    category_id:   tire?.category_id   ?? '',
    uom:           tire?.uom           ?? 'pcs',
    tracking:      (tire?.tracking     ?? 'none') as 'none' | 'batch' | 'serial',
    track_expiry:  !!tire?.track_expiry,
    rotation_policy: (tire?.rotation_policy ?? '') as string,
    description:   tire?.description   ?? '',
    is_active:     tire?.is_active     ?? true,
    item_type:     tire?.item_type     ?? 'finished_good',
    status:        tire?.status        ?? 'active',
    manufacturer:  tire?.manufacturer  ?? '',
    supplier_id:   tire?.supplier_id   ?? '',
    purchase_uom:  tire?.purchase_uom  ?? '',
    sales_uom:     tire?.sales_uom     ?? '',
    pack_size:     tire?.pack_size     ?? '',
    length_cm:     tire?.length_cm     ?? '',
    width_cm:      tire?.width_cm      ?? '',
    height_cm:     tire?.height_cm     ?? '',
    weight_kg:     tire?.weight_kg     ?? '',
    volume_l:      tire?.volume_l      ?? '',
    tax_class:     tire?.tax_class     ?? '',
    tax_rate:      tire?.tax_rate      ?? '',
    min_stock:     tire?.min_stock     ?? '',
    max_stock:     tire?.max_stock     ?? '',
    reorder_qty:   tire?.reorder_qty   ?? '',
    reorder_mode:  (tire?.reorder_mode ?? '') as string,
    safety_stock:  tire?.safety_stock  ?? '',
    lead_time_days: tire?.lead_time_days ?? '',
    moq:           tire?.moq           ?? '',
    order_multiple: tire?.order_multiple ?? '',
    capacity_units: tire?.capacity_units ?? '',
    hazard_class_id:        tire?.hazard_class_id        ?? '',
    un_number:              tire?.un_number              ?? '',
    packing_group:          tire?.packing_group          ?? '',
    flash_point_c:          tire?.flash_point_c          ?? '',
    sds_ref:                tire?.sds_ref                ?? '',
    sds_date:               tire?.sds_date ? String(tire.sds_date).slice(0, 10) : '',
    ppe:                    tire?.ppe                    ?? '',
    emergency_info:         tire?.emergency_info         ?? '',
    storage_temp_min_c:     tire?.storage_temp_min_c     ?? '',
    storage_temp_max_c:     tire?.storage_temp_max_c     ?? '',
    hazard_inspection_days: tire?.hazard_inspection_days ?? '',
    quality_profile_id:       tire?.quality_profile_id       ?? '',
    near_expiry_days:         tire?.near_expiry_days         ?? '',
    inspection_interval_days: tire?.inspection_interval_days ?? '',
    min_remaining_days:       tire?.min_remaining_days       ?? '',
    require_mfg_date: (tire?.require_mfg_date == null ? '' : tire.require_mfg_date ? 'yes' : 'no') as string,
    shelf_life_days:       tire?.shelf_life_days       ?? '',
    storage_conditions:    tire?.storage_conditions    ?? '',
    storage_requirements:  tire?.storage_requirements  ?? '',
    handling_instructions: tire?.handling_instructions ?? '',
    safety_requirements:   tire?.safety_requirements   ?? '',
    conversions:   [] as { uom: string; factor: string | number }[],
  });
  // The list rows do not carry conversions; load them when editing.
  useEffect(() => {
    if (tire?.id) api.inventory.get(tire.id).then((t: any) => setForm(f => ({ ...f, conversions: (t.conversions ?? []).map((c: any) => ({ uom: c.uom, factor: c.factor })) }))).catch(() => {});
  }, [tire?.id]);
  const [categories, setCategories] = useState<{ id: number; name: string; parent_id?: number | null }[]>([]);
  useEffect(() => { api.inventory.categories().then(setCategories).catch(() => {}); }, []);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState(false);

  const set = (field: string, val: string | number | boolean) =>
    setForm(f => ({ ...f, [field]: val }));

  // Cascade-aware handlers: changing brand resets model+size; changing model resets size
  const setBrand = (val: string) => setForm(f => terms.tyre ? ({ ...f, brand: val, model: '', size: '' }) : ({ ...f, brand: val }));
  const setModel = (val: string) => setForm(f => terms.tyre ? ({ ...f, model: val, size: '' }) : ({ ...f, model: val }));

  // Derive combobox option lists client-side — cascade filter by brand/model
  const brandOptions = suggestions.brands;

  const modelOptions = (() => {
    const matched = suggestions.brands.find(b => b.toLowerCase() === form.brand.toLowerCase().trim());
    if (matched) {
      return suggestions.models
        .filter(m => m.brand.toLowerCase() === matched.toLowerCase())
        .map(m => m.model);
    }
    return [...new Set(suggestions.models.map(m => m.model))];
  })();

  const sizeOptions = (() => {
    const matchedBrand = suggestions.brands.find(b => b.toLowerCase() === form.brand.toLowerCase().trim());
    const matchedModel = matchedBrand
      ? suggestions.models.find(
          m => m.brand.toLowerCase() === matchedBrand.toLowerCase() &&
               m.model.toLowerCase() === form.model.toLowerCase().trim()
        )
      : undefined;
    if (matchedBrand && matchedModel) {
      return suggestions.sizes
        .filter(
          s => s.brand.toLowerCase() === matchedBrand.toLowerCase() &&
               s.model.toLowerCase() === matchedModel.model.toLowerCase()
        )
        .map(s => s.size);
    }
    return [...new Set(suggestions.sizes.map(s => s.size))];
  })();

  const costP  = Number(form.cost_price);
  const saleP  = Number(form.sale_price);
  const margin = costP > 0 ? (((saleP - costP) / costP) * 100).toFixed(1) : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (terms.tyre ? (!form.brand.trim() || !form.model.trim() || !form.size.trim()) : !form.model.trim()) {
      return setError(terms.tyre ? 'Brand, model, and size are required.' : `${terms.name} is required.`);
    }
    if (form.min_stock !== '' && form.max_stock !== '' && Number(form.min_stock) > Number(form.max_stock)) {
      return setError('Minimum stock cannot be greater than maximum stock.');
    }
    if (saleP > 0 && costP > saleP) {
      return setError('Sale price should not be less than cost price.');
    }
    setLoading(true);
    setError('');
    try {
      const payload = {
        brand:         form.brand.trim(),
        model:         form.model.trim(),
        size:          form.size.trim(),
        type:          terms.tyre ? form.type : null,
        pattern:       terms.tyre ? form.pattern.trim()    || null : null,
        load_index:    terms.tyre ? form.load_index.trim() || null : null,
        speed_index:   terms.tyre ? form.speed_index       || null : null,
        dot:           terms.tyre ? form.dot.trim()        || null : null,
        // Editing never sends stock: quantity changes go through Adjust Stock so they are logged.
        ...(isEdit ? {} : { stock: Number(form.stock) }),
        reorder_level: Number(form.reorder_level),
        cost_price:    costP,
        sale_price:    saleP,
        sku:           form.sku.trim()         || null,
        barcode:       form.barcode.trim()     || null,
        category_id:   form.category_id ? Number(form.category_id) : null,
        uom:           form.uom,
        tracking:      form.tracking,
        track_expiry:  form.tracking !== 'none' && form.track_expiry,
        rotation_policy: form.tracking !== 'none' && form.rotation_policy ? form.rotation_policy : null,
        description:   form.description.trim() || null,
        is_active:     form.status === 'active',
        item_type:     form.item_type,
        status:        form.status,
        manufacturer:  form.manufacturer.trim() || null,
        supplier_id:   form.supplier_id ? Number(form.supplier_id) : null,
        purchase_uom:  form.purchase_uom || null,
        sales_uom:     form.sales_uom || null,
        pack_size: form.pack_size, length_cm: form.length_cm, width_cm: form.width_cm, height_cm: form.height_cm, weight_kg: form.weight_kg, volume_l: form.volume_l,
        tax_class: form.tax_class || null, tax_rate: form.tax_rate,
        min_stock: form.min_stock, max_stock: form.max_stock, reorder_qty: form.reorder_qty,
        reorder_mode: form.reorder_mode || null, safety_stock: form.safety_stock, lead_time_days: form.lead_time_days, moq: form.moq, order_multiple: form.order_multiple, capacity_units: form.capacity_units,
        hazard_class_id: form.hazard_class_id, un_number: form.un_number, packing_group: form.packing_group, flash_point_c: form.flash_point_c, sds_ref: form.sds_ref, sds_date: form.sds_date,
        ppe: form.ppe, emergency_info: form.emergency_info, storage_temp_min_c: form.storage_temp_min_c, storage_temp_max_c: form.storage_temp_max_c, hazard_inspection_days: form.hazard_inspection_days,
        quality_profile_id: form.quality_profile_id, near_expiry_days: form.near_expiry_days, inspection_interval_days: form.inspection_interval_days, min_remaining_days: form.min_remaining_days, require_mfg_date: form.require_mfg_date || null,
        shelf_life_days: form.shelf_life_days, storage_conditions: form.storage_conditions, storage_requirements: form.storage_requirements,
        handling_instructions: form.handling_instructions, safety_requirements: form.safety_requirements,
        conversions: form.conversions.filter(c => c.uom || c.factor !== ''),
      };
      if (isEdit) {
        await api.inventory.update(tire.id, payload);
      } else {
        await api.inventory.create(payload);
      }
      setSuccess(true);
      setTimeout(() => { onSaved(); onClose(); }, 800);
    } catch (err: any) {
      setError(err.message || `Failed to save ${terms.item.toLowerCase()}`);
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4"
      onClick={e => { if (e.target === e.currentTarget && !loading) onClose(); }}
    >
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-2xl max-h-[94vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center">
              <Package size={15} className="text-emerald-600" />
            </div>
            <h2 className="text-base font-bold text-slate-900">
              {isEdit ? `Edit ${terms.item}` : `Add ${terms.item}`}
            </h2>
          </div>
          <button onClick={onClose} disabled={loading} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
            <ErrorBanner error={error} />

            {/* ── Identification ─────────────────────────────────── */}
            <fieldset>
              <legend className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                {terms.item} Identification
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {terms.brand} {terms.tyre && <span className="text-red-500">*</span>}
                  </label>
                  <ComboboxInput
                    value={form.brand}
                    onChange={setBrand}
                    options={brandOptions}
                    placeholder={`e.g. ${terms.sample.brand || terms.brand}`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {terms.name} <span className="text-red-500">*</span>
                  </label>
                  <ComboboxInput
                    value={form.model}
                    onChange={setModel}
                    options={modelOptions}
                    placeholder={`e.g. ${terms.sample.name}`}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {terms.size} {terms.tyre && <span className="text-red-500">*</span>}
                  </label>
                  <ComboboxInput
                    value={form.size}
                    onChange={val => set('size', val)}
                    options={sizeOptions}
                    placeholder={`e.g. ${terms.sample.size}`}
                    inputClassName="font-mono"
                  />
                  {terms.tyre && <p className="text-xs text-slate-400 mt-1">Width/Aspect R Rim</p>}
                </div>
              </div>
            </fieldset>

            {/* ── Technical Specs (tyre shops only) ───────────────── */}
            {terms.tyre && (
            <fieldset>
              <legend className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                Technical Specifications
              </legend>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Tread Pattern
                  </label>
                  <ComboboxInput
                    value={form.pattern}
                    onChange={val => set('pattern', val)}
                    options={suggestions.patterns}
                    placeholder="e.g. EfficientGrip, Alenza Sport"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Load Index
                  </label>
                  <ComboboxInput
                    value={form.load_index}
                    onChange={val => set('load_index', val)}
                    options={suggestions.load_indexes}
                    placeholder="e.g. 91"
                    inputClassName="text-center font-mono"
                    maxLength={3}
                  />
                  <p className="text-xs text-slate-400 mt-1">Max load rating</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Speed Index
                  </label>
                  <select
                    value={form.speed_index}
                    onChange={e => set('speed_index', e.target.value)}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 text-center font-mono"
                  >
                    {SPEED_RATINGS.map(r => (
                      <option key={r} value={r}>{r || '—'}</option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-400 mt-1">Max speed rating</p>
                </div>
              </div>

              <div className="mt-3">
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  DOT Code
                </label>
                <div className="flex items-center gap-3">
                  <input
                    value={form.dot}
                    onChange={e => set('dot', e.target.value.replace(/[^0-9A-Za-z\s]/g, '').toUpperCase())}
                    placeholder="e.g. 4521"
                    maxLength={20}
                    className="w-40 text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 font-mono tracking-widest"
                  />
                  <p className="text-xs text-slate-400 leading-snug">
                    Last 4 digits of DOT code.<br />
                    WWYY — e.g. <span className="font-mono">4521</span> = week 45, year 2021.
                  </p>
                </div>
              </div>
            </fieldset>
            )}

            {/* ── Category & Stock ───────────────────────────────── */}
            <fieldset>
              <legend className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                Category & Stock
              </legend>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {terms.tyre && <div className="sm:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tyre Type</label>
                  <select
                    value={form.type}
                    onChange={e => set('type', e.target.value)}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  >
                    {tireTypes.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">{isEdit ? 'Stock (units)' : 'Opening stock (units)'}</label>
                  <input
                    type="number" min={0}
                    disabled={isEdit}
                    value={form.stock}
                    onChange={e => set('stock', e.target.value)}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 text-center"
                  />
                  <p className="text-xs text-slate-400 mt-1">{isEdit ? 'Use Adjust Stock to change it' : 'Recorded as an opening-stock movement'}</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Reorder At</label>
                  <input
                    type="number" min={0}
                    value={form.reorder_level}
                    onChange={e => set('reorder_level', e.target.value)}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 text-center"
                  />
                  <p className="text-xs text-slate-400 mt-1">Low-stock alert level</p>
                </div>
              </div>
            </fieldset>

            {/* ── Item master ────────────────────────────────────── */}
            <fieldset className="space-y-3">
              <legend className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Item details</legend>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">SKU</label>
                  <input value={form.sku} onChange={e => set('sku', e.target.value)} maxLength={60} placeholder={isEdit ? '' : 'Auto-generated if blank'}
                    className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Barcode</label>
                  <input value={form.barcode} onChange={e => set('barcode', e.target.value)} maxLength={60} className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Category</label>
                  <select value={form.category_id} onChange={e => set('category_id', e.target.value)} className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50">
                    <option value="">Uncategorised</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.parent_id ? (categories.find(p => p.id === c.parent_id)?.name ?? '') + ' › ' + c.name : c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Unit of measure</label>
                  <select value={form.uom} onChange={e => set('uom', e.target.value)} className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50">
                    {['pcs','set','pair','dozen','box','carton','pack','pallet','roll','bag','bottle','can','drum','sheet','kit','kg','g','lb','oz','l','ml','gal','m','cm','mm','ft','in','sqm','sqft','cbm','hour','unit'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Description</label>
                <textarea value={form.description} onChange={e => set('description', e.target.value)} rows={2} maxLength={500} className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 resize-none" />
              </div>
              <div className="rounded-xl border border-slate-200 p-3 space-y-2 bg-slate-50/60">
                <label className="block text-xs font-semibold text-slate-700">Stock tracking</label>
                <select value={form.tracking} onChange={e => set('tracking', e.target.value)}
                  disabled={isEdit && form.tracking !== 'none' && Number(tire?.stock) !== 0}
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white disabled:opacity-60">
                  <option value="none">None — count quantity only</option>
                  <option value="batch">By batch / lot</option>
                  <option value="serial">By serial number (one unit each)</option>
                </select>
                {form.tracking !== 'none' && (
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                    <input type="checkbox" checked={!!form.track_expiry} onChange={e => set('track_expiry', e.target.checked)} className="rounded border-slate-300 text-teal-600 focus:ring-teal-500" />
                    Has an expiry date (sells earliest-expiring first, blocks expired stock)
                  </label>
                )}
                {form.tracking !== 'none' && (
                  <label className="block text-xs font-medium text-slate-700">Which units go out first
                    <select value={form.rotation_policy} onChange={e => set('rotation_policy', e.target.value)}
                      className="mt-1 w-full text-sm border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white">
                      <option value="">Use category / company default</option>
                      <option value="fefo">FEFO — earliest expiry first</option>
                      <option value="fifo">FIFO — oldest received first</option>
                      <option value="smallest_first">Smallest batch first</option>
                      <option value="manual">Manual — choose the batch when selling</option>
                    </select>
                    <span className="block text-[11px] font-normal text-slate-500 mt-0.5">Picking order only. How stock is valued is a separate company setting.</span>
                  </label>
                )}
                <p className="text-[11px] text-slate-500">
                  {form.tracking === 'none' ? 'Turn this on for goods that expire, come in lots, or need to be traced by serial number.'
                    : isEdit && Number(tire?.stock) !== 0 && tire?.tracking && tire.tracking !== 'none' ? 'Adjust stock to zero before changing how this item is tracked.'
                    : 'Receipts will ask for ' + (form.tracking === 'serial' ? 'serial numbers' : 'a batch number') + '. Existing stock is kept in a LEGACY batch.'}
                </p>
              </div>
              <ProductMasterFields form={form as any} set={set as any} />
            </fieldset>

            {/* ── Pricing ────────────────────────────────────────── */}
            <fieldset>
              <legend className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">
                Pricing ({currency})
              </legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Cost Price</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium">{currency}</span>
                    <input
                      type="number" min={0} step="0.01"
                      value={form.cost_price}
                      onChange={e => set('cost_price', e.target.value)}
                      className="w-full text-sm border border-slate-200 rounded-xl pl-10 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                    />
                  </div>
                  <p className="text-xs text-slate-400 mt-1">Your purchase cost per unit</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Sale Price</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 font-medium">{currency}</span>
                    <input
                      type="number" min={0} step="0.01"
                      value={form.sale_price}
                      onChange={e => set('sale_price', e.target.value)}
                      className="w-full text-sm border border-slate-200 rounded-xl pl-10 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                    />
                  </div>
                  <p className="text-xs text-slate-400 mt-1">Default price on invoices</p>
                </div>
              </div>
            </fieldset>

            {/* Live margin preview */}
            {costP > 0 && saleP > 0 && (
              <div className={`rounded-xl p-3 flex items-center justify-between border ${
                Number(margin) >= 0 ? 'bg-emerald-50 border-emerald-100' : 'bg-red-50 border-red-100'
              }`}>
                <div>
                  <p className="text-xs font-semibold text-slate-600">Calculated Margin</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {formatCurrency(costP)} cost → {formatCurrency(saleP)} sale
                  </p>
                </div>
                <span className={`text-lg font-bold ${Number(margin) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                  {Number(margin) >= 0 ? '+' : ''}{margin}%
                </span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 flex-shrink-0">
            <button
              type="button" onClick={onClose} disabled={loading}
              className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit" disabled={loading || success}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-60 min-w-32 justify-center"
            >
              {loading  ? <><Loader2 size={15} className="animate-spin" /> Saving…</>
              : success ? <><CheckCircle size={15} /> Saved!</>
              : isEdit  ? 'Update SKU'
              : 'Add SKU'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
