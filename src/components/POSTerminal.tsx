import { useModules, useTerms } from '../lib/businessTypes';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Search, Plus, Minus, Trash2, Tag, ShoppingCart,
  Loader2, CheckCircle, Printer, Banknote, CreditCard, Shuffle,
  AlertCircle, ChevronDown, ChevronUp, Car, Award, ChevronRight, UserPlus,
} from 'lucide-react';
import ErrorBanner from './ErrorBanner';
import { api } from '../api/client';
import { formatCurrency } from '../lib/utils';
import { getCachedSettings } from '../lib/appSettings';
import { printInvoice, printThermalReceipt } from '../lib/invoicePdf';
import QuickAddCustomerModal from './QuickAddCustomerModal';

interface CartItem {
  key: string;
  name: string;
  qty: number;
  unitPrice: number;
  discount: number; // %
  tireId?: number;
  productId?: number;
  stock?: number;
}

interface CatalogItem {
  key: string;
  name: string;
  subtitle: string;
  price: number;
  stock?: number;
  tireId?: number;
  productId?: number;
}

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

export default function POSTerminal({ onClose, onCreated }: Props) {
  const s        = getCachedSettings();
  const TAX_RATE = Number(s.default_tax_rate || 15);

  // Data
  const [customers, setCustomers] = useState<any[]>([]);
  const [catalog,   setCatalog]   = useState<CatalogItem[]>([]);

  // Cart & order
  const [cart,       setCart]       = useState<CartItem[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [notes,      setNotes]      = useState('');

  // Search
  const [searchQuery,  setSearchQuery]  = useState('');
  const [searchOpen,   setSearchOpen]   = useState(false);
  const searchRef      = useRef<HTMLInputElement>(null);
  const searchBoxRef   = useRef<HTMLDivElement>(null);

  // Discount panel (F4)
  const [showDiscount,   setShowDiscount]   = useState(false);
  const [discountType,   setDiscountType]   = useState<'pct' | 'amt'>('pct');
  const [discountValue,  setDiscountValue]  = useState('');

  // Payment
  const [payMethod,   setPayMethod]   = useState<'cash' | 'card' | 'mixed'>('cash');
  const [cashGiven,   setCashGiven]   = useState('');
  const [cashAmount,  setCashAmount]  = useState('');
  const [cardAmount,  setCardAmount]  = useState('');

  // Vehicle lookup
  const modules = useModules();
  const terms   = useTerms();
  const [showVehicle,  setShowVehicle]  = useState(false);
  const [vehCats,      setVehCats]      = useState<string[]>([]);
  const [vehMakes,     setVehMakes]     = useState<string[]>([]);
  const [vehModels,    setVehModels]    = useState<string[]>([]);
  const [vehCat,       setVehCat]       = useState('');
  const [vehMake,      setVehMake]      = useState('');
  const [vehModel,     setVehModel]     = useState('');
  const [vehSearching, setVehSearching] = useState(false);
  const [vehResult,    setVehResult]    = useState<{ size: string; gtr: string | null } | null>(null);
  const [vehError,     setVehError]     = useState('');

  // Walk-in / quick-add customer
  const [showQuickAdd, setShowQuickAdd] = useState(false);

  // State
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState('');
  const [checkoutSale,  setCheckoutSale]  = useState<any>(null);

  // Load catalog
  useEffect(() => {
    api.customers.list().then(setCustomers).catch(() => {});
    Promise.all([api.inventory.list(), api.products.list()]).then(([tires, products]) => {
      const items: CatalogItem[] = [];
      (tires as any[]).filter(t => (t.status || 'active') !== 'inactive').forEach(t => items.push({
        key: `t:${t.id}`,
        name: [t.brand, t.model, t.size].map((p: string) => (p ?? '').trim()).filter(Boolean).join(' '),
        subtitle: `${terms.tyre ? (t.type || 'Tyre') : (t.sku || terms.item)} · Stock: ${t.stock}`,
        price: Number(t.sale_price || 0),
        stock: Number(t.stock || 0),
        tireId: t.id,
      }));
      (products as any[]).filter(p => p.is_active).forEach(p => items.push({
        key: `p:${p.id}`,
        name: p.name,
        subtitle: p.category || 'Product',
        price: Number(p.sale_price || 0),
        productId: p.id,
      }));
      setCatalog(items);
    }).catch(() => {});
  }, []);

  // Close search on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node))
        setSearchOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // Vehicle lookup: load categories when panel opens
  useEffect(() => {
    if (!showVehicle || vehCats.length > 0) return;
    api.fitments.categories().then(setVehCats).catch(() => {});
  }, [showVehicle, vehCats.length]);

  // Vehicle lookup: cascade makes
  useEffect(() => {
    setVehMake(''); setVehModel(''); setVehMakes([]); setVehModels([]); setVehResult(null);
    if (!showVehicle) return;
    api.fitments.makes(vehCat || undefined).then(setVehMakes).catch(() => {});
  }, [vehCat, showVehicle]);

  // Vehicle lookup: cascade models
  useEffect(() => {
    setVehModel(''); setVehModels([]); setVehResult(null);
    if (!vehMake) return;
    api.fitments.models(vehMake, vehCat || undefined).then(setVehModels).catch(() => {});
  }, [vehMake, vehCat]);

  const handleVehicleSearch = async () => {
    if (!vehMake) { setVehError('Select at least a make.'); return; }
    setVehError(''); setVehSearching(true); setVehResult(null);
    try {
      const res = await api.fitments.search({ make: vehMake, model: vehModel || undefined, category: vehCat || undefined });
      if (res.fitments.length === 0) { setVehError('No fitment found for this vehicle.'); return; }
      const first = res.fitments[0];
      setVehResult({ size: first.tire_size, gtr: first.gtr_pattern });
    } catch {
      setVehError('Lookup failed.');
    } finally {
      setVehSearching(false);
    }
  };

  const applyVehicleSize = (size: string) => {
    setSearchQuery(size);
    setSearchOpen(true);
    setShowVehicle(false);
    searchRef.current?.focus();
  };

  // ── Calculations ────────────────────────────────────────────────────────────
  const cartSubtotal = cart.reduce((s, c) => s + c.qty * c.unitPrice * (1 - c.discount / 100), 0);
  const discV        = parseFloat(discountValue) || 0;
  const orderDiscAmt = discountType === 'pct'
    ? cartSubtotal * discV / 100
    : Math.min(discV, cartSubtotal);
  const subtotal     = Math.max(0, cartSubtotal - orderDiscAmt);
  const tax          = subtotal * TAX_RATE / 100;
  const total        = subtotal + tax;

  const cashGivenNum = parseFloat(cashGiven) || 0;
  const change       = payMethod === 'cash' ? Math.max(0, cashGivenNum - total) : 0;
  const amountPaid   = payMethod === 'cash'
    ? (cashGivenNum >= total - 0.005 ? total : 0)
    : payMethod === 'card'
      ? total
      : (parseFloat(cashAmount) || 0) + (parseFloat(cardAmount) || 0);

  // ── Cart actions ────────────────────────────────────────────────────────────
  const addToCart = useCallback((item: CatalogItem) => {
    setCart(prev => {
      const existing = prev.findIndex(c => c.key === item.key);
      if (existing >= 0) {
        const next = [...prev];
        next[existing] = { ...next[existing], qty: next[existing].qty + 1 };
        return next;
      }
      return [...prev, {
        key: item.key, name: item.name,
        qty: 1, unitPrice: item.price, discount: 0,
        tireId: item.tireId, productId: item.productId, stock: item.stock,
      }];
    });
    setSearchQuery('');
    setSearchOpen(false);
  }, []);

  const updateQty = (key: string, delta: number) =>
    setCart(prev => prev.map(c => c.key === key
      ? { ...c, qty: Math.max(1, c.qty + delta) }
      : c));

  const setQty = (key: string, v: number) =>
    setCart(prev => prev.map(c => c.key === key ? { ...c, qty: Math.max(1, v) } : c));

  const setPrice = (key: string, v: number) =>
    setCart(prev => prev.map(c => c.key === key ? { ...c, unitPrice: Math.max(0, v) } : c));

  const setLineDis = (key: string, v: number) =>
    setCart(prev => prev.map(c => c.key === key ? { ...c, discount: Math.min(100, Math.max(0, v)) } : c));

  const removeItem = (key: string) => setCart(prev => prev.filter(c => c.key !== key));

  // ── Checkout ────────────────────────────────────────────────────────────────
  const handleCheckout = useCallback(async () => {
    if (!customerId) { setError('Select a customer first'); return; }
    if (cart.length === 0) { setError('Cart is empty'); return; }
    if (payMethod === 'mixed') {
      const mt = (parseFloat(cashAmount) || 0) + (parseFloat(cardAmount) || 0);
      if (mt < total - 0.005) {
        setError(`Mixed payment ${formatCurrency(mt)} is less than total ${formatCurrency(total)}`);
        return;
      }
    }

    const paid = payMethod === 'cash'
      ? (cashGivenNum >= total - 0.005 ? total : 0)
      : payMethod === 'card' ? total
      : amountPaid;

    setError(''); setLoading(true);
    try {
      const created = await api.sales.create({
        customer_id:    customerId === 'walkin' ? null : Number(customerId),
        date:           new Date().toISOString().split('T')[0],
        notes,
        tax_rate:       TAX_RATE,
        discount:       parseFloat(orderDiscAmt.toFixed(2)),
        payment_method: payMethod,
        amount_paid:    parseFloat(paid.toFixed(2)),
        cash_given:     payMethod === 'cash' ? cashGivenNum : undefined,
        cash_amount:    payMethod === 'mixed' ? parseFloat(cashAmount) || 0 : undefined,
        card_amount:    payMethod === 'mixed' ? parseFloat(cardAmount) || 0 : undefined,
        items: cart.map(c => ({
          tire_id:    c.tireId,
          product_id: c.productId,
          tire_name:  c.name,
          qty:        c.qty,
          unit_price: c.unitPrice,
          discount:   c.discount,
        })),
      });
      const fullSale = await api.sales.get(created.id);
      setCheckoutSale({
        ...fullSale,
        customer_name: customerId === 'walkin'
          ? 'Walk-in Customer'
          : customers.find(cu => cu.id === Number(customerId))?.name,
        cash_given:    payMethod === 'cash' ? cashGivenNum : undefined,
        change_due:    payMethod === 'cash' ? change : undefined,
      });
      onCreated();
    } catch (err: any) {
      setError(err.message || 'Checkout failed');
    } finally {
      setLoading(false);
    }
  }, [cart, customerId, payMethod, cashGiven, cashAmount, cardAmount, total, orderDiscAmt, notes, TAX_RATE, change, amountPaid, customers, onCreated]);

  // ── Hotkeys ─────────────────────────────────────────────────────────────────
  const handleCheckoutRef = useRef(handleCheckout);
  handleCheckoutRef.current = handleCheckout;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'F4') { e.preventDefault(); setShowDiscount(v => !v); }
      if (e.key === 'F8') { e.preventDefault(); handleCheckoutRef.current(); }
      if (e.key === 'Escape') { setSearchOpen(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ── Search results ───────────────────────────────────────────────────────────
  const q = searchQuery.toLowerCase().trim();
  const searchResults = q.length >= 1
    ? catalog.filter(c => c.name.toLowerCase().includes(q) || c.subtitle.toLowerCase().includes(q)).slice(0, 9)
    : catalog.slice(0, 6);

  // ── Success screen ──────────────────────────────────────────────────────────
  if (checkoutSale) {
    const custName = checkoutSale.customer_name || 'Customer';
    return (
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-8 text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle size={32} className="text-emerald-600" />
          </div>
          <h2 className="text-xl font-bold text-slate-900 mb-1">Sale Complete!</h2>
          <p className="text-sm text-slate-500 mb-1">{checkoutSale.invoice_no} · {custName}</p>
          <p className="text-2xl font-bold text-emerald-600 mb-2">{formatCurrency(checkoutSale.total)}</p>
          {checkoutSale.change_due > 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl px-4 py-2 mb-4">
              <p className="text-sm text-amber-700 font-semibold">Change due: {formatCurrency(checkoutSale.change_due)}</p>
            </div>
          )}
          <div className="space-y-2 mt-4">
            <button
              onClick={() => printInvoice(checkoutSale)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors"
            >
              <Printer size={15} /> Print A4 Invoice
            </button>
            <button
              onClick={() => printThermalReceipt(checkoutSale)}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
            >
              <Printer size={15} /> Print Receipt (Thermal)
            </button>
            <button
              onClick={onClose}
              className="w-full px-4 py-2.5 text-sm font-semibold text-slate-500 hover:text-slate-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Main POS layout ─────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-stretch justify-center">
      <div className="bg-white w-full max-w-6xl flex flex-col overflow-hidden lg:my-4 lg:rounded-2xl shadow-2xl">

        {/* ── Top bar ──────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 bg-slate-50 flex-shrink-0">
          <div className="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <ShoppingCart size={16} className="text-white" />
          </div>
          <h2 className="text-sm font-bold text-slate-900 flex-shrink-0">POS Terminal</h2>

          {/* Customer */}
          <div className="flex items-center gap-1.5 flex-1 max-w-xs">
            <select
              value={customerId}
              onChange={e => setCustomerId(e.target.value)}
              className="flex-1 min-w-0 text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-white"
            >
              <option value="">— Select customer —</option>
              <option value="walkin">Walk-in Customer</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button
              type="button"
              title="Save customer info"
              onClick={() => setShowQuickAdd(true)}
              className="flex-shrink-0 p-1.5 text-slate-400 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors border border-slate-200 hover:border-teal-300"
            >
              <UserPlus size={15} />
            </button>
          </div>

          <span className="hidden sm:block text-[11px] text-slate-400 ml-auto flex-shrink-0">
            F2 Search · F4 Discount · F8 Checkout
          </span>
          <button onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-lg transition-colors flex-shrink-0">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">

          {/* ── Left: Search + Cart ─────────────────────────────────────── */}
          <div className="flex flex-col flex-1 overflow-hidden border-r border-slate-100">

            {/* Search box */}
            <div className="px-4 py-3 border-b border-slate-100 flex-shrink-0" ref={searchBoxRef}>

              {/* Row 1: search input + "By Vehicle" button */}
              <div className="flex gap-2 items-center">
                <div className="relative flex-1">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    ref={searchRef}
                    value={searchQuery}
                    onChange={e => { setSearchQuery(e.target.value); setSearchOpen(true); }}
                    onFocus={() => setSearchOpen(true)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && searchResults.length > 0) { addToCart(searchResults[0]); }
                      if (e.key === 'Escape') setSearchOpen(false);
                    }}
                    placeholder={`Search ${terms.items.toLowerCase()} & services... (F2)`}
                    className="w-full text-sm border border-slate-200 rounded-xl pl-9 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
                  />
                  {/* Search dropdown — positioned relative to the input wrapper */}
                  {searchOpen && (
                    <div className="absolute top-full left-0 right-0 z-20 mt-1 bg-white border border-slate-200 rounded-xl shadow-2xl max-h-72 overflow-y-auto">
                      {searchResults.length === 0 ? (
                        <p className="text-sm text-slate-400 px-4 py-3">No results for "{searchQuery}"</p>
                      ) : searchResults.map(item => (
                        <button
                          key={item.key}
                          type="button"
                          onMouseDown={e => { e.preventDefault(); addToCart(item); }}
                          className="w-full text-left px-4 py-2.5 hover:bg-teal-50 transition-colors border-b border-slate-50 last:border-0 flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-900 truncate">{item.name}</p>
                            <p className="text-xs text-slate-400">{item.subtitle}</p>
                          </div>
                          <span className="text-sm font-bold text-teal-600 whitespace-nowrap flex-shrink-0">
                            {formatCurrency(item.price)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Find by Vehicle toggle */}
                {modules.tyreFitment && <button
                  type="button"
                  onClick={() => { setShowVehicle(v => !v); setVehResult(null); setVehError(''); }}
                  title="Find tyre by vehicle make/model"
                  className={`flex items-center gap-1.5 px-3 py-2.5 rounded-xl border text-xs font-semibold transition-all flex-shrink-0 ${
                    showVehicle
                      ? 'bg-red-600 border-red-600 text-white shadow-sm'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-red-300 hover:text-red-600'
                  }`}
                >
                  <Car size={14} />
                  <span className="hidden sm:inline">By Vehicle</span>
                </button>}
              </div>

              {/* Row 2 (conditional): Vehicle Lookup Panel */}
              {showVehicle && modules.tyreFitment && (
                <div className="mt-2 bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2.5">
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Find Tyre by Vehicle</p>

                  <div className="grid grid-cols-3 gap-2">
                    {/* Category */}
                    <div className="relative">
                      <select value={vehCat} onChange={e => setVehCat(e.target.value)}
                        className="w-full appearance-none text-xs border border-slate-200 rounded-lg py-2 pl-2.5 pr-6 bg-white focus:outline-none focus:ring-1 focus:ring-red-500">
                        <option value="">All Categories</option>
                        {vehCats.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    </div>
                    {/* Make */}
                    <div className="relative">
                      <select value={vehMake} onChange={e => setVehMake(e.target.value)}
                        disabled={vehMakes.length === 0}
                        className="w-full appearance-none text-xs border border-slate-200 rounded-lg py-2 pl-2.5 pr-6 bg-white focus:outline-none focus:ring-1 focus:ring-red-500 disabled:opacity-40">
                        <option value="">Select Make</option>
                        {vehMakes.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    </div>
                    {/* Model */}
                    <div className="relative">
                      <select value={vehModel} onChange={e => setVehModel(e.target.value)}
                        disabled={vehModels.length === 0}
                        className="w-full appearance-none text-xs border border-slate-200 rounded-lg py-2 pl-2.5 pr-6 bg-white focus:outline-none focus:ring-1 focus:ring-red-500 disabled:opacity-40">
                        <option value="">Any Model</option>
                        {vehModels.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <ChevronDown size={11} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" onClick={handleVehicleSearch}
                      disabled={vehSearching || !vehMake}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                      {vehSearching ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />}
                      Look Up
                    </button>

                    {vehError && (
                      <span className="text-xs text-red-500 flex items-center gap-1">
                        <AlertCircle size={11} /> {vehError}
                      </span>
                    )}

                    {vehResult && (
                      <>
                        <span className="inline-flex items-center px-2.5 py-1 rounded-lg bg-teal-50 border border-teal-200 text-teal-700 text-xs font-bold whitespace-nowrap">
                          {vehResult.size}
                        </span>
                        {vehResult.gtr && (
                          <span className="inline-flex items-center gap-1 text-xs text-red-700 font-semibold whitespace-nowrap">
                            <Award size={10} /> {vehResult.gtr}
                          </span>
                        )}
                        <button type="button" onClick={() => applyVehicleSize(vehResult!.size)}
                          className="ml-auto flex items-center gap-1 px-3 py-1.5 bg-teal-600 text-white text-xs font-bold rounded-lg hover:bg-teal-700 transition-colors">
                          Filter Inventory <ChevronRight size={10} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Cart table */}
            <div className="flex-1 overflow-y-auto">
              {cart.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-300 gap-3">
                  <ShoppingCart size={48} strokeWidth={1} />
                  <p className="text-sm font-medium">Cart is empty</p>
                  <p className="text-xs">Search and add items above</p>
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100 sticky top-0">
                      <th className="text-left text-xs font-semibold text-slate-400 px-4 py-2.5">Item</th>
                      <th className="text-center text-xs font-semibold text-slate-400 px-2 py-2.5 w-28">Qty</th>
                      <th className="text-right text-xs font-semibold text-slate-400 px-2 py-2.5 w-28 hidden sm:table-cell">Price</th>
                      <th className="text-center text-xs font-semibold text-slate-400 px-2 py-2.5 w-20 hidden md:table-cell">Disc%</th>
                      <th className="text-right text-xs font-semibold text-slate-400 px-4 py-2.5 w-28">Total</th>
                      <th className="w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {cart.map((item) => {
                      const lineTotal = item.qty * item.unitPrice * (1 - item.discount / 100);
                      const lowStock  = item.stock !== undefined && item.qty > item.stock;
                      return (
                        <tr key={item.key} className={`hover:bg-slate-50/50 ${lowStock ? 'bg-red-50/30' : ''}`}>
                          <td className="px-4 py-2">
                            <p className="font-medium text-slate-900 text-sm leading-tight">{item.name}</p>
                            {lowStock && (
                              <p className="text-[11px] text-red-500 flex items-center gap-1 mt-0.5">
                                <AlertCircle size={10} /> Only {item.stock} in stock
                              </p>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center justify-center gap-1">
                              <button type="button" onClick={() => updateQty(item.key, -1)}
                                className="w-6 h-6 rounded-md bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors">
                                <Minus size={10} />
                              </button>
                              <input
                                type="number" min={1} value={item.qty}
                                onChange={e => setQty(item.key, Number(e.target.value))}
                                className="w-12 text-center text-sm border border-slate-200 rounded-md py-0.5 focus:outline-none focus:ring-1 focus:ring-teal-500"
                              />
                              <button type="button" onClick={() => updateQty(item.key, 1)}
                                className="w-6 h-6 rounded-md bg-slate-100 hover:bg-slate-200 flex items-center justify-center transition-colors">
                                <Plus size={10} />
                              </button>
                            </div>
                          </td>
                          <td className="px-2 py-2 hidden sm:table-cell">
                            <input
                              type="number" min={0} step="0.01" value={item.unitPrice}
                              onChange={e => setPrice(item.key, Number(e.target.value))}
                              className="w-24 text-right text-sm border border-slate-200 rounded-md px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-teal-500"
                            />
                          </td>
                          <td className="px-2 py-2 hidden md:table-cell">
                            <input
                              type="number" min={0} max={100} step="0.5" value={item.discount}
                              onChange={e => setLineDis(item.key, Number(e.target.value))}
                              className="w-16 text-center text-sm border border-slate-200 rounded-md px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-teal-500"
                            />
                          </td>
                          <td className="px-4 py-2 text-right font-semibold text-slate-900 whitespace-nowrap">
                            {formatCurrency(lineTotal)}
                          </td>
                          <td className="pr-2 py-2">
                            <button type="button" onClick={() => removeItem(item.key)}
                              className="p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Notes */}
            <div className="px-4 py-2 border-t border-slate-100 flex-shrink-0">
              <input
                value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Notes (optional)..."
                className="w-full text-xs text-slate-600 bg-transparent focus:outline-none placeholder-slate-300"
              />
            </div>
          </div>

          {/* ── Right: Totals + Payment ──────────────────────────────────── */}
          <div className="w-72 lg:w-80 flex flex-col flex-shrink-0 overflow-y-auto">

            {/* Totals */}
            <div className="px-5 py-4 space-y-2 border-b border-slate-100">
              <div className="flex justify-between text-sm text-slate-600">
                <span>Subtotal ({cart.reduce((s, c) => s + c.qty, 0)} items)</span>
                <span className="font-medium">{formatCurrency(cartSubtotal)}</span>
              </div>

              {/* Discount row */}
              {orderDiscAmt > 0 && (
                <div className="flex justify-between text-sm text-emerald-600">
                  <span>Discount{discountType === 'pct' ? ` (${discV}%)` : ''}</span>
                  <span className="font-medium">−{formatCurrency(orderDiscAmt)}</span>
                </div>
              )}

              <div className="flex justify-between text-sm text-slate-600">
                <span>Tax ({TAX_RATE}%)</span>
                <span className="font-medium">{formatCurrency(tax)}</span>
              </div>

              <div className="flex justify-between text-base font-bold text-slate-900 pt-2 border-t border-slate-200">
                <span>TOTAL</span>
                <span className="text-teal-600">{formatCurrency(total)}</span>
              </div>
            </div>

            {/* Discount panel (F4) */}
            <div className="border-b border-slate-100 flex-shrink-0">
              <button
                type="button"
                onClick={() => setShowDiscount(v => !v)}
                className="w-full flex items-center justify-between px-5 py-3 text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Tag size={13} className="text-emerald-500" /> Discount (F4)
                </span>
                {showDiscount ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
              {showDiscount && (
                <div className="px-5 pb-4 space-y-2">
                  <div className="flex rounded-lg overflow-hidden border border-slate-200 text-xs">
                    <button
                      type="button"
                      onClick={() => setDiscountType('pct')}
                      className={`flex-1 py-1.5 font-semibold transition-colors ${discountType === 'pct' ? 'bg-emerald-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                    >
                      Percent (%)
                    </button>
                    <button
                      type="button"
                      onClick={() => setDiscountType('amt')}
                      className={`flex-1 py-1.5 font-semibold transition-colors ${discountType === 'amt' ? 'bg-emerald-500 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}
                    >
                      Amount
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={0} max={discountType === 'pct' ? 100 : undefined}
                      step={discountType === 'pct' ? '1' : '100'}
                      value={discountValue}
                      onChange={e => setDiscountValue(e.target.value)}
                      placeholder={discountType === 'pct' ? '0' : '0.00'}
                      className="flex-1 text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 text-right"
                    />
                    <span className="text-sm text-slate-500 w-6">{discountType === 'pct' ? '%' : 'Rs'}</span>
                  </div>
                  {orderDiscAmt > 0 && (
                    <p className="text-xs text-emerald-600 font-medium">
                      Saving {formatCurrency(orderDiscAmt)}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Payment method */}
            <div className="px-5 py-4 space-y-3 border-b border-slate-100 flex-shrink-0">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Payment Method</p>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { v: 'cash',  label: 'Cash',  Icon: Banknote },
                  { v: 'card',  label: 'Card',  Icon: CreditCard },
                  { v: 'mixed', label: 'Mixed', Icon: Shuffle },
                ].map(({ v, label, Icon }) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setPayMethod(v as any)}
                    className={`flex flex-col items-center gap-1 py-2.5 rounded-xl text-xs font-semibold border transition-all ${
                      payMethod === v
                        ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <Icon size={16} />
                    {label}
                  </button>
                ))}
              </div>

              {/* Cash: given + change */}
              {payMethod === 'cash' && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Cash Given</label>
                    <input
                      type="number" min={0} step="100"
                      value={cashGiven}
                      onChange={e => setCashGiven(e.target.value)}
                      placeholder={formatCurrency(total)}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 text-right font-mono"
                    />
                  </div>
                  {cashGivenNum > 0 && (
                    <div className="flex justify-between text-sm font-semibold">
                      <span className="text-slate-500">Change</span>
                      <span className={change > 0 ? 'text-emerald-600' : 'text-slate-400'}>
                        {formatCurrency(change)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Mixed: cash + card amounts */}
              {payMethod === 'mixed' && (
                <div className="space-y-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Cash Amount</label>
                    <input
                      type="number" min={0} step="100" value={cashAmount}
                      onChange={e => setCashAmount(e.target.value)}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 text-right font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Card Amount</label>
                    <input
                      type="number" min={0} step="100" value={cardAmount}
                      onChange={e => setCardAmount(e.target.value)}
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-teal-500 text-right font-mono"
                    />
                  </div>
                  {(() => {
                    const mixedTotal = (parseFloat(cashAmount) || 0) + (parseFloat(cardAmount) || 0);
                    const diff = mixedTotal - total;
                    return mixedTotal > 0 && (
                      <div className="flex justify-between text-xs font-semibold">
                        <span className="text-slate-500">Total entered</span>
                        <span className={diff < -0.005 ? 'text-red-500' : 'text-emerald-600'}>
                          {formatCurrency(mixedTotal)}{diff < -0.005 ? ` (short ${formatCurrency(-diff)})` : ''}
                        </span>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>

            {/* Error */}
            <ErrorBanner error={error} className="mx-5 mt-3" />

            {/* Checkout button */}
            <div className="px-5 py-4 mt-auto flex-shrink-0">
              <button
                type="button"
                onClick={handleCheckout}
                disabled={loading || cart.length === 0}
                className="w-full flex items-center justify-center gap-2 px-4 py-3.5 text-sm font-bold text-white bg-teal-600 rounded-xl hover:bg-teal-700 active:bg-teal-800 transition-colors disabled:opacity-50 shadow-md shadow-teal-200"
              >
                {loading
                  ? <><Loader2 size={16} className="animate-spin" /> Processing...</>
                  : <><ShoppingCart size={16} /> Checkout — {formatCurrency(total)} (F8)</>
                }
              </button>
              <button
                type="button"
                onClick={onClose}
                className="w-full mt-2 py-2 text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>

      {showQuickAdd && (
        <QuickAddCustomerModal
          onCreated={customer => {
            setCustomers(prev => [...prev, customer]);
            setCustomerId(String(customer.id));
            setShowQuickAdd(false);
          }}
          onClose={() => setShowQuickAdd(false)}
        />
      )}
    </div>
  );
}
