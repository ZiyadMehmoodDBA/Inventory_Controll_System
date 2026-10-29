import { useState, useEffect } from 'react';
import { X, Download, CheckSquare, Square, Loader2, CheckCircle, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../api/client';

interface Props {
  onClose: () => void;
  onImported: () => void;
}

const PAKISTAN_BRANDS = new Set([
  'General Tyre (Pakistan)',
  'Servis Tyres',
  'Ghauri Tyres',
  'Vitara',
]);

export default function CatalogImportModal({ onClose, onImported }: Props) {
  const [brands, setBrands]           = useState<string[]>([]);
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [loading, setLoading]         = useState(true);
  const [importing, setImporting]     = useState(false);
  const [result, setResult]           = useState<{ inserted: number } | null>(null);
  const [error, setError]             = useState('');
  const [showPakistan, setShowPakistan] = useState(true);
  const [showIntl, setShowIntl]         = useState(true);

  useEffect(() => {
    api.inventory.catalogBrands()
      .then(b => { setBrands(b); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, []);

  const pkBrands   = brands.filter(b => PAKISTAN_BRANDS.has(b));
  const intlBrands = brands.filter(b => !PAKISTAN_BRANDS.has(b));

  const toggle = (brand: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(brand)) next.delete(brand); else next.add(brand);
      return next;
    });
  };

  const selectGroup = (list: string[], on: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      list.forEach(b => on ? next.add(b) : next.delete(b));
      return next;
    });
  };

  const allSelected   = brands.length > 0 && selected.size === brands.length;
  const noneSelected  = selected.size === 0;

  const handleImport = async () => {
    setImporting(true); setError('');
    try {
      const brandsToImport = selected.size === brands.length ? undefined : Array.from(selected);
      const res = await api.inventory.importFromCatalog(brandsToImport);
      setResult(res);
      onImported();
    } catch (e: any) {
      setError(e.message);
      setImporting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center">
              <Download size={15} className="text-emerald-600" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Import from Tire Catalog</h2>
              <p className="text-xs text-slate-400">Add tire SKUs to inventory (price &amp; stock set to 0)</p>
            </div>
          </div>
          <button onClick={onClose} disabled={importing}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        {/* Body */}
        {result ? (
          <div className="px-5 py-10 flex flex-col items-center gap-3 text-center">
            <div className="w-14 h-14 bg-emerald-100 rounded-full flex items-center justify-center">
              <CheckCircle size={28} className="text-emerald-500" />
            </div>
            <p className="text-base font-bold text-slate-900">Import Complete</p>
            <p className="text-sm text-slate-500 max-w-xs">
              {result.inserted === 0
                ? 'All selected SKUs were already in your inventory — nothing new to add.'
                : `${result.inserted} tire SKU${result.inserted !== 1 ? 's' : ''} added to inventory. Set prices in the Inventory page.`
              }
            </p>
            <button onClick={onClose}
              className="mt-2 px-6 py-2.5 bg-teal-600 text-white text-sm font-semibold rounded-xl hover:bg-teal-700 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Info banner */}
            <div className="mx-5 mt-4 flex items-start gap-2.5 bg-amber-50 rounded-xl px-3.5 py-3 border border-amber-100 flex-shrink-0">
              <AlertCircle size={14} className="text-amber-500 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-700 leading-relaxed">
                Only SKUs that don't already exist in your inventory will be added.
                Existing tires are never overwritten.
              </p>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={24} className="animate-spin text-slate-400" />
              </div>
            ) : error ? (
              <div className="mx-5 mt-4 bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            ) : (
              <>
                {/* Select all + count */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-50 flex-shrink-0">
                  <button
                    onClick={() => allSelected ? setSelected(new Set()) : setSelected(new Set(brands))}
                    className="flex items-center gap-2 text-sm font-medium text-slate-700 hover:text-slate-900"
                  >
                    {allSelected
                      ? <CheckSquare size={16} className="text-emerald-600" />
                      : <Square size={16} className="text-slate-400" />
                    }
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                  <span className="text-xs text-slate-400">
                    {selected.size} of {brands.length} brands selected
                  </span>
                </div>

                {/* Brand list */}
                <div className="overflow-y-auto flex-1 px-5 py-3 space-y-4">

                  {/* Pakistan Brands */}
                  {pkBrands.length > 0 && (
                    <div>
                      <button
                        onClick={() => setShowPakistan(v => !v)}
                        className="flex items-center justify-between w-full mb-2"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                            Pakistan Local Brands
                          </span>
                          <span className="text-[10px] bg-green-100 text-green-700 border border-green-200 px-1.5 py-0.5 rounded-full font-semibold">
                            Local
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={e => { e.stopPropagation(); selectGroup(pkBrands, !pkBrands.every(b => selected.has(b))); }}
                            className="text-[11px] text-emerald-600 hover:underline font-medium"
                          >
                            {pkBrands.every(b => selected.has(b)) ? 'Deselect group' : 'Select group'}
                          </button>
                          {showPakistan ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
                        </div>
                      </button>
                      {showPakistan && (
                        <div className="space-y-1">
                          {pkBrands.map(brand => (
                            <BrandRow key={brand} brand={brand} checked={selected.has(brand)} onToggle={() => toggle(brand)} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* International Brands */}
                  <div>
                    <button
                      onClick={() => setShowIntl(v => !v)}
                      className="flex items-center justify-between w-full mb-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">
                          International Brands
                        </span>
                        <span className="text-[10px] bg-teal-100 text-teal-700 border border-teal-200 px-1.5 py-0.5 rounded-full font-semibold">
                          Global
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={e => { e.stopPropagation(); selectGroup(intlBrands, !intlBrands.every(b => selected.has(b))); }}
                          className="text-[11px] text-emerald-600 hover:underline font-medium"
                        >
                          {intlBrands.every(b => selected.has(b)) ? 'Deselect group' : 'Select group'}
                        </button>
                        {showIntl ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
                      </div>
                    </button>
                    {showIntl && (
                      <div className="space-y-1">
                        {intlBrands.map(brand => (
                          <BrandRow key={brand} brand={brand} checked={selected.has(brand)} onToggle={() => toggle(brand)} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Footer */}
            {!loading && !error && (
              <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 flex-shrink-0">
                <button onClick={onClose} disabled={importing}
                  className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors disabled:opacity-50">
                  Cancel
                </button>
                <button
                  onClick={handleImport}
                  disabled={importing || noneSelected}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-600 rounded-xl hover:bg-teal-700 transition-colors disabled:opacity-50 min-w-36 justify-center"
                >
                  {importing
                    ? <><Loader2 size={15} className="animate-spin" /> Importing...</>
                    : <><Download size={15} /> Import {selected.size > 0 ? selected.size : ''} Brand{selected.size !== 1 ? 's' : ''}</>
                  }
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function BrandRow({ brand, checked, onToggle }: { brand: string; checked: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-slate-50 transition-colors text-left"
    >
      {checked
        ? <CheckSquare size={16} className="text-emerald-600 flex-shrink-0" />
        : <Square size={16} className="text-slate-300 flex-shrink-0" />
      }
      <span className="text-sm text-slate-800 font-medium">{brand}</span>
    </button>
  );
}
