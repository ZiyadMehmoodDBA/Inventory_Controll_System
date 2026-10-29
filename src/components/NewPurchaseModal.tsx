import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Loader2, CheckCircle } from 'lucide-react';
import { api } from '../api/client';
import ErrorBanner from './ErrorBanner';
import { formatCurrency } from '../lib/utils';
import ComboboxInput from './ComboboxInput';
import { useTerms } from '../lib/businessTypes';
import BatchFields, { batchPayload, batchProblem } from './BatchFields';
import { matchItem, joinName } from '../lib/itemMatch';

interface NewPurchaseModalProps {
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
  mode:           'product' | 'tire';
  // product mode
  item_key:       string;   // 'p:id' | 't:id' | ''
  item_name:      string;
  // tire mode
  tire_brand:     string;
  tire_model:     string;
  tire_size:      string;
  tire_pattern:   string;
  tire_load_index: string;
  // common
  qty:            number;
  unit_price:     number;
  batch_no?:      string;
  expiry_date?:   string;
  mfg_date?:      string;
  serials?:       string;
}

const EMPTY_ITEM: LineItem = {
  mode: 'product',
  item_key: '', item_name: '',
  tire_brand: '', tire_model: '', tire_size: '', tire_pattern: '', tire_load_index: '',
  qty: 1, unit_price: 0,
};

const EMPTY_SUGGESTIONS: Suggestions = { brands: [], models: [], sizes: [], patterns: [], load_indexes: [] };

export default function NewPurchaseModal({ onClose, onCreated }: NewPurchaseModalProps) {
  const terms = useTerms();
  const [suppliers,    setSuppliers]    = useState<any[]>([]);
  const [products,     setProducts]     = useState<any[]>([]);
  const [tires,        setTires]        = useState<any[]>([]);
  const [suggestions,  setSuggestions]  = useState<Suggestions>(EMPTY_SUGGESTIONS);
  const [supplierId,   setSupplierId]   = useState('');
  const [date,         setDate]         = useState(new Date().toISOString().split('T')[0]);
  const [status,       setStatus]       = useState('pending');
  const [notes,        setNotes]        = useState('');
  const [items,        setItems]        = useState<LineItem[]>([{ ...EMPTY_ITEM }]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [success,      setSuccess]      = useState(false);

  useEffect(() => {
    api.suppliers.list().then(setSuppliers).catch(() => {});
    api.products.list().then(d => setProducts(d.filter((p: any) => p.is_active))).catch(() => {});
    api.inventory.list().then((l: any[]) => setTires(l.filter(t => (t.status || 'active') === 'active') as any)).catch(() => {});
    api.lookups.tireSuggestions().then(setSuggestions).catch(() => {});
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

  // ── Item mode toggle ───────────────────────────────────────────────────────
  const setItemMode = (i: number, mode: 'product' | 'tire') => {
    setItems(prev => {
      const n = [...prev];
      n[i] = { ...EMPTY_ITEM, qty: n[i].qty, unit_price: n[i].unit_price, mode };
      return n;
    });
  };

  // ── Product mode item selection ────────────────────────────────────────────
  const updateItem = (i: number, field: keyof LineItem, value: string | number) => {
    setItems(prev => {
      const next = [...prev];
      if (field === 'item_key') {
        const v = value as string;
        if (v.startsWith('p:')) {
          const prod = products.find(p => String(p.id) === v.slice(2));
          next[i] = { ...next[i], item_key: v, item_name: prod?.name ?? '', unit_price: Number(prod?.cost_price ?? 0) };
        } else if (v.startsWith('t:')) {
          const tire = tires.find(t => String(t.id) === v.slice(2));
          next[i] = { ...next[i], item_key: v, item_name: tire ? `${tire.brand} ${tire.model} ${tire.size}` : '', unit_price: Number(tire?.cost_price ?? 0) };
        } else {
          next[i] = { ...next[i], item_key: '', item_name: '', unit_price: 0 };
        }
      } else {
        next[i] = { ...next[i], [field]: field === 'qty' || field === 'unit_price' ? Number(value) : value };
      }
      return next;
    });
  };

  // ── Tire spec update + auto-match ──────────────────────────────────────────
  const updateTireSpec = (i: number, field: string, val: string) => {
    setItems(prev => {
      const n    = [...prev];
      const item = { ...n[i] };

      if      (field === 'brand')      { item.tire_brand = val; if (terms.tyre) { item.tire_model = ''; item.tire_size = ''; } }
      else if (field === 'model')      { item.tire_model = val; if (terms.tyre) item.tire_size = ''; }
      else if (field === 'size')       { item.tire_size = val; }
      else if (field === 'pattern')    { item.tire_pattern = val; }
      else if (field === 'load_index') { item.tire_load_index = val; }

      // Auto-match against inventory (brand + size required; model optional filter)
      const match = matchItem(tires, { brand: item.tire_brand, model: item.tire_model, size: item.tire_size }, terms.tyre);

      if (match) {
        item.item_key   = `t:${match.id}`;
        item.item_name  = joinName(match.brand, match.model, match.size);
        item.unit_price = Number(match.cost_price ?? 0);
      } else {
        item.item_key  = 'free';
        item.item_name = joinName(item.tire_brand, item.tire_model, item.tire_size);
      }

      n[i] = item;
      return n;
    });
  };

  const addItem    = () => setItems(p => [...p, { ...EMPTY_ITEM }]);
  const removeItem = (i: number) => setItems(p => p.filter((_, idx) => idx !== i));

  const subtotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supplierId) return setError('Please select a supplier.');
    if (status === 'received') {
      for (const it of items) {
        const t = tires.find((x: any) => `t:${x.id}` === it.item_key);
        const p = batchProblem(t, it, it.qty, it.item_name || 'Item');
        if (p) return setError(p);
      }
    }
    const invalid = items.some(it =>
      it.mode === 'product'
        ? !it.item_key || it.qty < 1
        : (terms.tyre ? (!it.tire_brand.trim() || !it.tire_size.trim()) : !it.tire_model.trim()) || it.qty < 1
    );
    if (invalid) return setError(`Fill in all line items. ${terms.tyre ? `${terms.item} rows require at least ${terms.brand} and ${terms.size}.` : `${terms.item} rows need a ${terms.name.toLowerCase()}.`}`);
    setError('');
    setLoading(true);
    try {
      await api.purchases.create({
        supplier_id: Number(supplierId),
        date,
        status,
        notes,
        items: items.map(it => {
          if (it.mode === 'product') {
            const isProd = it.item_key.startsWith('p:');
            return {
              ...(isProd ? { product_id: Number(it.item_key.slice(2)) } : { tire_id: Number(it.item_key.slice(2)) }),
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
      setTimeout(() => { onCreated(); onClose(); }, 1000);
    } catch (err: any) {
      setError(err.message || 'Failed to create purchase order');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <h2 className="text-base font-bold text-slate-900">New Purchase Order</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
            <ErrorBanner error={error} />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Supplier <span className="text-red-500">*</span>
                </label>
                <select value={supplierId} onChange={e => setSupplierId(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  required>
                  <option value="">Select supplier...</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Date</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
            </div>

            {/* Line Items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-slate-700">
                  Line Items <span className="text-red-500">*</span>
                </label>
                <button type="button" onClick={addItem}
                  className="flex items-center gap-1 text-xs text-teal-600 hover:text-teal-700 font-semibold">
                  <Plus size={13} /> Add Item
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
                          onChange={e => updateItem(i, 'qty', e.target.value)}
                          className="w-16 text-sm border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500 text-center bg-white"
                          placeholder="1" />
                        <span className="text-xs text-slate-400 shrink-0">Cost</span>
                        <input type="number" min={0} step="0.01"
                          value={item.unit_price}
                          onChange={e => updateItem(i, 'unit_price', e.target.value)}
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

                    {/* Product mode: dropdown */}
                    {item.mode === 'product' && (
                      <select
                        value={item.item_key}
                        onChange={e => updateItem(i, 'item_key', e.target.value)}
                        className="w-full text-sm border border-slate-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
                        required>
                        <option value="">Select product or tire...</option>
                        {products.length > 0 && (
                          <optgroup label="── Products & Services ──">
                            {products.map(p => (
                              <option key={`p:${p.id}`} value={`p:${p.id}`}>
                                {p.name}{p.category ? ` (${p.category})` : ''}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {tires.length > 0 && (
                          <optgroup label={`── ${terms.items} (Inventory) ──`}>
                            {tires.map(t => (
                              <option key={`t:${t.id}`} value={`t:${t.id}`}>
                                {t.brand} {t.model} {t.size}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    )}

                    {/* Tire mode: cascading combobox fields */}
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
                              disabled={false}
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

                        {/* Match status indicator */}
                        {(item.tire_brand || item.tire_size) && (
                          <div className={`flex items-center gap-1.5 text-xs font-medium ${
                            item.item_key.startsWith('t:') ? 'text-emerald-600' : 'text-amber-600'
                          }`}>
                            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
                              item.item_key.startsWith('t:') ? 'bg-emerald-500' : 'bg-amber-400'
                            }`} />
                            {item.item_key.startsWith('t:')
                              ? `Matched inventory: ${item.item_name}`
                              : 'No inventory match — will save without stock link'
                            }
                          </div>
                        )}
                      </>
                    )}

                    <BatchFields tire={tires.find((x: any) => `t:${x.id}` === item.item_key)} value={item} qty={item.qty}
                      onChange={patch => setItems(p => p.map((it, idx) => idx === i ? { ...it, ...patch } : it))} />
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Status</label>
                <select value={status} onChange={e => setStatus(e.target.value)}
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50">
                  <option value="pending">Pending Delivery</option>
                  <option value="received">Received</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Notes</label>
                <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Optional notes..."
                  className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50" />
              </div>
            </div>

            <div className="bg-teal-50 rounded-xl p-4 border border-teal-100">
              <div className="flex justify-between text-base font-bold text-slate-900">
                <span>Total Amount</span>
                <span className="text-teal-600">{formatCurrency(subtotal)}</span>
              </div>
              {status === 'received' && (
                <p className="text-xs text-emerald-600 font-medium mt-1.5">
                  ✓ Matched stock will be updated upon saving
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 flex-shrink-0">
            <button type="button" onClick={onClose}
              className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading || success}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-60 min-w-36 justify-center">
              {loading  ? <><Loader2 size={15} className="animate-spin" /> Saving...</>
               : success ? <><CheckCircle size={15} /> Saved!</>
               : 'Create PO'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
