import { useState, useEffect, useRef } from 'react';
import { X, Plus, Trash2, Loader2, CheckCircle, Package, Search } from 'lucide-react';
import { api } from '../api/client';
import ErrorBanner from './ErrorBanner';
import { formatCurrency } from '../lib/utils';
import ComboboxInput from './ComboboxInput';
import { useTerms } from '../lib/businessTypes';
import BatchFields, { batchPayload, batchProblem } from './BatchFields';
import { matchItem, joinName } from '../lib/itemMatch';

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface Suggestions {
  brands:       string[];
  models:       { brand: string; model: string }[];
  sizes:        { brand: string; model: string; size: string }[];
  patterns:     string[];
  load_indexes: string[];
}

interface LineItem {
  mode:            'product' | 'tire';
  // product mode
  item_key:        string;   // 'p:id' | 't:id' | ''
  item_name:       string;
  // tire mode
  tire_brand:      string;
  tire_model:      string;
  tire_size:       string;
  tire_pattern:    string;
  tire_load_index: string;
  // common
  qty:             number;
  unit_price:      number;
  batch_no?:       string;
  expiry_date?:    string;
  mfg_date?:       string;
  serials?:        string;
  stock?:          number;   // current inventory stock (for display)
}

interface CatalogItem {
  key:        string;
  name:       string;
  subtitle:   string;
  costPrice:  number;
  stock?:     number;
  tireId?:    number;
  productId?: number;
}

const EMPTY_ITEM: LineItem = {
  mode: 'product',
  item_key: '', item_name: '',
  tire_brand: '', tire_model: '', tire_size: '', tire_pattern: '', tire_load_index: '',
  qty: 1, unit_price: 0,
};

const EMPTY_SUGGESTIONS: Suggestions = { brands: [], models: [], sizes: [], patterns: [], load_indexes: [] };

export default function GRNModal({ onClose, onCreated }: Props) {
  const terms = useTerms();
  const [suppliers,   setSuppliers]   = useState<any[]>([]);
  const [catalog,     setCatalog]     = useState<CatalogItem[]>([]);
  const [tiresRaw,    setTiresRaw]    = useState<any[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestions>(EMPTY_SUGGESTIONS);
  const [supplierId,  setSupplierId]  = useState('');
  const [date,        setDate]        = useState(new Date().toISOString().split('T')[0]);
  const [refNo,       setRefNo]       = useState('');
  const [notes,       setNotes]       = useState('');
  const [items,       setItems]       = useState<LineItem[]>([{ ...EMPTY_ITEM }]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [success,     setSuccess]     = useState(false);

  // Per-row search state (product mode only)
  const [rowSearch, setRowSearch] = useState<Record<number, string>>({});
  const [rowOpen,   setRowOpen]   = useState<Record<number, boolean>>({});
  const searchRefs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    api.suppliers.list().then(setSuppliers).catch(() => {});
    api.lookups.tireSuggestions().then(setSuggestions).catch(() => {});
    Promise.all([api.inventory.list(), api.products.list()]).then(([allTires, products]) => {
      const tires = (allTires as any[]).filter(t => (t.status || 'active') === 'active');
      setTiresRaw(tires as any);
      const built: CatalogItem[] = [];
      tires.forEach((t: any) => built.push({
        key:       `t:${t.id}`,
        name:      `${t.brand} ${t.model} ${t.size}`,
        subtitle:  `${terms.tyre ? (t.type || 'Tyre') : (t.sku || terms.item)} · Stock: ${t.stock}`,
        costPrice: Number(t.cost_price || 0),
        stock:     Number(t.stock || 0),
        tireId:    t.id,
      }));
      products.filter((p: any) => p.is_active && p.category !== 'Service').forEach((p: any) => built.push({
        key:       `p:${p.id}`,
        name:      p.name,
        subtitle:  p.category || 'Product',
        costPrice: Number(p.cost_price || 0),
        productId: p.id,
      }));
      setCatalog(built);
    }).catch(() => {});
  }, []);

  // Click-outside to close product-search dropdowns
  useEffect(() => {
    const handler = () => setRowOpen({});
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  // ── Cascade option derivations ─────────────────────────────────────────────
  const brandOptions = suggestions.brands;

  const getModelOptions = (brand: string): string[] => {
    const b = brand.trim().toLowerCase();
    if (!b) return [...new Set(suggestions.models.map(m => m.model))];
    const matched = suggestions.brands.find(sb => sb.toLowerCase() === b);
    if (matched)
      return suggestions.models
        .filter(m => m.brand.toLowerCase() === matched.toLowerCase())
        .map(m => m.model);
    return [...new Set(suggestions.models.map(m => m.model))];
  };

  const getSizeOptions = (brand: string, model: string): string[] => {
    const b  = brand.trim().toLowerCase();
    const mo = model.trim().toLowerCase();
    if (!b) return [...new Set(suggestions.sizes.map(s => s.size))];
    let filtered = suggestions.sizes.filter(s => s.brand.toLowerCase() === b);
    if (mo) filtered = filtered.filter(s => s.model.toLowerCase() === mo);
    return [...new Set(filtered.map(s => s.size))];
  };

  // ── Mode toggle per row ────────────────────────────────────────────────────
  const setItemMode = (i: number, mode: 'product' | 'tire') => {
    setItems(prev => {
      const n = [...prev];
      n[i] = { ...EMPTY_ITEM, qty: n[i].qty, unit_price: n[i].unit_price, mode };
      return n;
    });
    setRowSearch(p => ({ ...p, [i]: '' }));
    setRowOpen(p => ({ ...p, [i]: false }));
  };

  // ── Product mode: catalog search selection ────────────────────────────────
  const selectCatalogItem = (rowIdx: number, cat: CatalogItem) => {
    setItems(prev => {
      const next = [...prev];
      next[rowIdx] = {
        ...next[rowIdx],
        item_key:   cat.key,
        item_name:  cat.name,
        unit_price: cat.costPrice,
        stock:      cat.stock,
        // clear tire fields
        tire_brand: '', tire_model: '', tire_size: '', tire_pattern: '', tire_load_index: '',
      };
      return next;
    });
    setRowSearch(p => ({ ...p, [rowIdx]: cat.name }));
    setRowOpen(p => ({ ...p, [rowIdx]: false }));
  };

  const getRowResults = (i: number) => {
    const q = (rowSearch[i] || '').toLowerCase().trim();
    if (!q) return catalog.slice(0, 6);
    return catalog.filter(c =>
      c.name.toLowerCase().includes(q) || c.subtitle.toLowerCase().includes(q)
    ).slice(0, 8);
  };

  // ── Tire mode: spec update + auto-match ───────────────────────────────────
  const updateTireSpec = (i: number, field: string, val: string) => {
    setItems(prev => {
      const n    = [...prev];
      const item = { ...n[i] };

      if      (field === 'brand')      { item.tire_brand = val; if (terms.tyre) { item.tire_model = ''; item.tire_size = ''; } }
      else if (field === 'model')      { item.tire_model = val; if (terms.tyre) item.tire_size = ''; }
      else if (field === 'size')       { item.tire_size = val; }
      else if (field === 'pattern')    { item.tire_pattern = val; }
      else if (field === 'load_index') { item.tire_load_index = val; }

      // Auto-match against raw inventory tires (brand + size required; model optional filter)
      const match = matchItem(tiresRaw, { brand: item.tire_brand, model: item.tire_model, size: item.tire_size }, terms.tyre);

      if (match) {
        item.item_key   = `t:${match.id}`;
        item.item_name  = joinName(match.brand, match.model, match.size);
        item.unit_price = Number(match.cost_price ?? 0);
        item.stock      = Number(match.stock ?? 0);
      } else {
        item.item_key  = 'free';
        item.item_name = joinName(item.tire_brand, item.tire_model, item.tire_size);
        item.stock     = undefined;
      }

      n[i] = item;
      return n;
    });
  };

  // ── Common row operations ──────────────────────────────────────────────────
  const addItem = () => setItems(p => [...p, { ...EMPTY_ITEM }]);

  const removeItem = (i: number) => {
    setItems(p => p.filter((_, idx) => idx !== i));
    setRowSearch(p => { const n = { ...p }; delete n[i]; return n; });
    setRowOpen(p => { const n = { ...p }; delete n[i]; return n; });
  };

  const updateQty   = (i: number, v: number) =>
    setItems(p => p.map((it, idx) => idx === i ? { ...it, qty: Math.max(1, v) } : it));
  const updatePrice = (i: number, v: number) =>
    setItems(p => p.map((it, idx) => idx === i ? { ...it, unit_price: Math.max(0, v) } : it));

  const subtotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supplierId) return setError('Please select a supplier.');
    for (const it of items) {
      const t = tiresRaw.find((x: any) => `t:${x.id}` === it.item_key);
      const p = batchProblem(t, it, it.qty, it.item_name || 'Item');
      if (p) return setError(p);
    }
    const invalid = items.some(it =>
      it.mode === 'product'
        ? !it.item_key || it.qty < 1
        : (terms.tyre ? (!it.tire_brand.trim() || !it.tire_size.trim()) : !it.tire_model.trim()) || it.qty < 1
    );
    if (invalid) return setError(`Fill in all items. ${terms.tyre ? `${terms.item} rows require at least ${terms.brand} and ${terms.size}.` : `${terms.item} rows need a ${terms.name.toLowerCase()}.`}`);
    setError(''); setLoading(true);
    try {
      await api.purchases.create({
        supplier_id: Number(supplierId),
        date,
        status: 'received',
        notes: [refNo ? `Ref: ${refNo}` : '', notes].filter(Boolean).join(' — '),
        reference_no: refNo || undefined,
        items: items.map(it => {
          if (it.mode === 'product') {
            const isProd = it.item_key.startsWith('p:');
            return {
              ...(isProd ? { product_id: Number(it.item_key.slice(2)) }
                         : { tire_id:    Number(it.item_key.slice(2)) }),
              tire_name:  it.item_name,
              qty:        it.qty,
              unit_price: it.unit_price,
            ...batchPayload(it),
            };
          }
          const tireId = it.item_key.startsWith('t:') ? Number(it.item_key.slice(2)) : null;
          const tireName = [it.tire_brand, it.tire_model, it.tire_size, it.tire_pattern, it.tire_load_index]
            .filter(Boolean).join(' ');
          return {
            ...(tireId ? { tire_id: tireId } : {}),
            tire_name:  tireName,
            qty:        it.qty,
            unit_price: it.unit_price,
            ...batchPayload(it),
          };
        }),
      });
      setSuccess(true);
      setTimeout(() => { onCreated(); onClose(); }, 900);
    } catch (err: any) {
      setError(err.message || 'Failed to receive stock');
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
            <div className="w-8 h-8 bg-teal-100 rounded-lg flex items-center justify-center">
              <Package size={15} className="text-teal-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Receive Stock — GRN</h2>
              <p className="text-xs text-slate-400">Stock updated immediately on save</p>
            </div>
          </div>
          <button onClick={onClose} disabled={loading}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">

            <ErrorBanner error={error} />

            {/* Header fields */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Supplier <span className="text-red-500">*</span>
                </label>
                <select value={supplierId} onChange={e => setSupplierId(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50">
                  <option value="">Select supplier...</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Date</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Reference / GRN #</label>
                <input value={refNo} onChange={e => setRefNo(e.target.value)} placeholder="e.g. GRN-001"
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
            </div>

            {/* Line Items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-slate-700">
                  Items Received <span className="text-red-500">*</span>
                </label>
                <button type="button" onClick={addItem}
                  className="flex items-center gap-1 text-xs text-teal-600 hover:text-teal-700 font-semibold">
                  <Plus size={13} /> Add Row
                </button>
              </div>

              <div className="space-y-3">
                {items.map((item, i) => (
                  <div key={i} className="rounded-xl border border-slate-200 bg-slate-50/40 p-3 space-y-2.5">

                    {/* Top row: mode toggle + qty + price + delete */}
                    <div className="flex items-center gap-2">
                      {/* Mode toggle */}
                      <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-semibold shrink-0 bg-white">
                        <button type="button" onClick={() => setItemMode(i, 'product')}
                          className={`px-2.5 py-1.5 transition-colors ${item.mode === 'product' ? 'bg-teal-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
                          Product
                        </button>
                        <button type="button" onClick={() => setItemMode(i, 'tire')}
                          className={`px-2.5 py-1.5 transition-colors ${item.mode === 'tire' ? 'bg-teal-600 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
                          {terms.stockMode}
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5 flex-1">
                        <span className="text-xs text-slate-400 shrink-0">Qty</span>
                        <input type="number" min={1}
                          value={item.qty}
                          onChange={e => updateQty(i, Number(e.target.value))}
                          className="w-16 text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500 text-center bg-white"
                          placeholder="1" />
                        <span className="text-xs text-slate-400 shrink-0">Cost</span>
                        <input type="number" min={0} step="0.01"
                          value={item.unit_price}
                          onChange={e => updatePrice(i, Number(e.target.value))}
                          className="flex-1 min-w-0 text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500 text-right bg-white"
                          placeholder="0.00" />
                      </div>

                      <div className="shrink-0">
                        {items.length > 1 && (
                          <button type="button" onClick={() => removeItem(i)}
                            className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                            <Trash2 size={13} />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* ── Product mode: catalog search box ── */}
                    {item.mode === 'product' && (
                      <div className="relative" onClick={e => e.stopPropagation()}>
                        <div className="relative">
                          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                          <input
                            ref={el => { searchRefs.current[i] = el; }}
                            value={rowSearch[i] ?? item.item_name}
                            onChange={e => {
                              setRowSearch(p => ({ ...p, [i]: e.target.value }));
                              setRowOpen(p => ({ ...p, [i]: true }));
                              if (!e.target.value) {
                                setItems(p => p.map((it, idx) => idx === i ? { ...it, item_key: '', item_name: '' } : it));
                              }
                            }}
                            onFocus={() => setRowOpen(p => ({ ...p, [i]: true }))}
                            placeholder={`Search ${terms.items.toLowerCase()} or product...`}
                            className="w-full text-sm border border-slate-200 rounded-lg pl-7 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                          />
                        </div>
                        {rowOpen[i] && (
                          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-xl z-30 max-h-52 overflow-y-auto">
                            {getRowResults(i).length === 0 ? (
                              <p className="text-xs text-slate-400 px-3 py-2">No results</p>
                            ) : getRowResults(i).map(cat => (
                              <button
                                key={cat.key}
                                type="button"
                                onMouseDown={e => { e.preventDefault(); selectCatalogItem(i, cat); }}
                                className="w-full text-left px-3 py-2 hover:bg-teal-50 transition-colors"
                              >
                                <div className="text-sm font-medium text-slate-800">{cat.name}</div>
                                <div className="text-xs text-slate-400">{cat.subtitle} · {formatCurrency(cat.costPrice)}</div>
                              </button>
                            ))}
                          </div>
                        )}
                        {/* Stock preview for matched product-mode tire */}
                        {item.stock !== undefined && item.item_key.startsWith('t:') && (
                          <p className="text-[11px] text-slate-400 mt-1 ml-1">
                            Current stock: {item.stock} → will become {item.stock + item.qty}
                          </p>
                        )}
                      </div>
                    )}

                    {/* ── Tire mode: cascading combobox fields ── */}
                    {item.mode === 'tire' && (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">
                              {terms.brand} {terms.tyre && <span className="text-red-500">*</span>}
                            </label>
                            <ComboboxInput
                              value={item.tire_brand}
                              onChange={v => updateTireSpec(i, 'brand', v)}
                              options={brandOptions}
                              placeholder={`e.g. ${terms.sample.brand || terms.brand}`}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">
                              {terms.name} {terms.tyre ? <span className="text-slate-400">(opt)</span> : <span className="text-red-500">*</span>}
                            </label>
                            <ComboboxInput
                              value={item.tire_model}
                              onChange={v => updateTireSpec(i, 'model', v)}
                              options={getModelOptions(item.tire_brand)}
                              placeholder={`e.g. ${terms.sample.name}`}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">
                              {terms.size} {terms.tyre ? <span className="text-red-500">*</span> : <span className="text-slate-400">(opt)</span>}
                            </label>
                            <ComboboxInput
                              value={item.tire_size}
                              onChange={v => updateTireSpec(i, 'size', v)}
                              options={getSizeOptions(item.tire_brand, item.tire_model)}
                              placeholder={`e.g. ${terms.sample.size}`}
                            />
                          </div>
                        </div>

                        {terms.tyre && (

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">
                              Tread Pattern <span className="text-slate-400">(opt)</span>
                            </label>
                            <ComboboxInput
                              value={item.tire_pattern}
                              onChange={v => updateTireSpec(i, 'pattern', v)}
                              options={suggestions.patterns}
                              placeholder="e.g. Energy Saver"
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-slate-500 mb-1">
                              Load Index <span className="text-slate-400">(opt)</span>
                            </label>
                            <ComboboxInput
                              value={item.tire_load_index}
                              onChange={v => updateTireSpec(i, 'load_index', v)}
                              options={suggestions.load_indexes}
                              placeholder="e.g. 91W"
                            />
                          </div>
                        </div>

                        )}

                        {/* Match / stock indicator */}
                        {(item.tire_brand || item.tire_size) && (
                          <div className={`flex items-center gap-1.5 text-xs font-medium ${
                            item.item_key.startsWith('t:') ? 'text-emerald-600' : 'text-amber-600'
                          }`}>
                            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                              item.item_key.startsWith('t:') ? 'bg-emerald-500' : 'bg-amber-400'
                            }`} />
                            {item.item_key.startsWith('t:')
                              ? `Matched: ${item.item_name} — stock ${item.stock} → ${(item.stock ?? 0) + item.qty}`
                              : 'No inventory match — stock will not be updated. Add this SKU in Inventory first.'
                            }
                          </div>
                        )}
                      </>
                    )}

                    <BatchFields tire={tiresRaw.find((x: any) => `t:${x.id}` === item.item_key)} value={item} qty={item.qty}
                      onChange={patch => setItems(p => p.map((it, idx) => idx === i ? { ...it, ...patch } : it))} />
                  </div>
                ))}
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">Notes</label>
              <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes..."
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
            </div>

            {/* Total */}
            <div className="bg-teal-50 border border-teal-100 rounded-xl px-4 py-3 flex items-center justify-between">
              <div>
                <p className="text-xs text-teal-600 font-medium">Total Goods Value</p>
                <p className="text-xs text-emerald-600 mt-0.5">✓ Matched stock will be added to inventory on save</p>
              </div>
              <p className="text-xl font-bold text-teal-700">{formatCurrency(subtotal)}</p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 flex-shrink-0">
            <button type="button" onClick={onClose} disabled={loading}
              className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button type="submit" disabled={loading || success}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-60 min-w-40 justify-center">
              {loading  ? <><Loader2 size={15} className="animate-spin" /> Saving...</>
              : success ? <><CheckCircle size={15} /> Stock Received!</>
              : 'Receive Stock'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
