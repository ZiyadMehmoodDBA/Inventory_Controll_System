import { useState, useRef, useCallback } from 'react';
import { X, Download, Upload, FileSpreadsheet, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import ErrorBanner from './ErrorBanner';
import * as XLSX from 'xlsx';
import { api } from '../api/client';
import { useTerms, type Terms } from '../lib/businessTypes';

export type ImportEntity = 'customers' | 'suppliers' | 'inventory' | 'sales' | 'purchases';

interface Props {
  entity: ImportEntity;
  onClose: () => void;
  onImported: () => void;
}

interface ColDef { key: string; label: string; required?: boolean; example: string; }

interface EntityConfig {
  label: string;
  sheetName: string;
  refField?: string;
  columns: ColDef[];
}

const buildConfigs = (t: Terms): Record<ImportEntity, EntityConfig> => ({
  customers: {
    label: 'Customers', sheetName: 'Customers',
    columns: [
      { key: 'name',    label: 'name',    required: true, example: t.sample.customer },
      { key: 'phone',   label: 'phone',                   example: '+92-300-1234567' },
      { key: 'email',   label: 'email',                   example: 'contact@company.pk' },
      { key: 'address', label: 'address',                 example: 'Lahore, Punjab' },
    ],
  },
  suppliers: {
    label: 'Suppliers', sheetName: 'Suppliers',
    columns: [
      { key: 'name',    label: 'name',    required: true, example: t.sample.supplier },
      { key: 'phone',   label: 'phone',                   example: '+92-21-3456789' },
      { key: 'email',   label: 'email',                   example: 'supply@company.pk' },
      { key: 'address', label: 'address',                 example: 'Karachi, Sindh' },
    ],
  },
  inventory: {
    label: `${t.item} Inventory`, sheetName: 'Inventory',
    columns: t.tyre ? [
      { key: 'brand',         label: 'brand',         required: true, example: t.sample.brand },
      { key: 'model',         label: 'model',         required: true, example: t.sample.name },
      { key: 'size',          label: 'size',          required: true, example: t.sample.size },
      { key: 'type',          label: 'type',                          example: 'Passenger' },
      { key: 'sku',           label: 'sku',                           example: '' },
      { key: 'barcode',       label: 'barcode',                       example: '' },
      { key: 'cost_price',    label: 'cost_price',                    example: t.sample.unitCost },
      { key: 'sale_price',    label: 'sale_price',                    example: t.sample.unitPrice },
      { key: 'stock',         label: 'stock',                         example: '20' },
      { key: 'reorder_level', label: 'reorder_level',                 example: '5' },
      { key: 'item_type',     label: 'item_type',                     example: 'finished_good' },
      { key: 'category',      label: 'category',                      example: '' },
      { key: 'uom',           label: 'uom',                           example: 'pcs' },
      { key: 'manufacturer',  label: 'manufacturer',                  example: '' },
      { key: 'supplier',      label: 'supplier',                      example: '' },
      { key: 'min_stock',     label: 'min_stock',                     example: '' },
      { key: 'max_stock',     label: 'max_stock',                     example: '' },
      { key: 'reorder_qty',   label: 'reorder_qty',                   example: '' },
      { key: 'tax_class',     label: 'tax_class',                     example: '' },
      { key: 'tracking',      label: 'tracking',                      example: 'none' },
      { key: 'status',        label: 'status',                        example: 'active' },
    ] : [
      { key: 'name',          label: 'name',          required: true, example: t.sample.name },
      { key: 'brand',         label: 'brand',                         example: t.sample.brand },
      { key: 'size',          label: 'size',                          example: t.sample.size },
      { key: 'sku',           label: 'sku',                           example: '' },
      { key: 'barcode',       label: 'barcode',                       example: '' },
      { key: 'cost_price',    label: 'cost_price',                    example: t.sample.unitCost },
      { key: 'sale_price',    label: 'sale_price',                    example: t.sample.unitPrice },
      { key: 'stock',         label: 'stock',                         example: '20' },
      { key: 'reorder_level', label: 'reorder_level',                 example: '5' },
      { key: 'item_type',     label: 'item_type',                     example: 'finished_good' },
      { key: 'category',      label: 'category',                      example: '' },
      { key: 'uom',           label: 'uom',                           example: 'pcs' },
      { key: 'manufacturer',  label: 'manufacturer',                  example: '' },
      { key: 'supplier',      label: 'supplier',                      example: '' },
      { key: 'min_stock',     label: 'min_stock',                     example: '' },
      { key: 'max_stock',     label: 'max_stock',                     example: '' },
      { key: 'reorder_qty',   label: 'reorder_qty',                   example: '' },
      { key: 'tax_class',     label: 'tax_class',                     example: '' },
      { key: 'tracking',      label: 'tracking',                      example: 'none' },
      { key: 'status',        label: 'status',                        example: 'active' },
    ],
  },
  sales: {
    label: 'Sales / Invoices', sheetName: 'Sales', refField: 'invoice_ref',
    columns: [
      { key: 'invoice_ref',   label: 'invoice_ref',   required: true, example: 'INV-001' },
      { key: 'customer_name', label: 'customer_name', required: true, example: t.sample.customer },
      { key: 'date',          label: 'date',                          example: '2026-04-24' },
      { key: 'status',        label: 'status',                        example: 'pending' },
      { key: 'notes',         label: 'notes',                         example: 'Cash payment' },
      { key: 'tax_rate',      label: 'tax_rate',                      example: '0' },
      { key: 'item_name',     label: 'item_name',     required: true, example: t.sample.item },
      { key: 'qty',           label: 'qty',           required: true, example: '4' },
      { key: 'unit_price',    label: 'unit_price',    required: true, example: t.sample.unitPrice },
    ],
  },
  purchases: {
    label: 'Purchase Orders', sheetName: 'Purchases', refField: 'po_ref',
    columns: [
      { key: 'po_ref',        label: 'po_ref',        required: true, example: 'PO-001' },
      { key: 'supplier_name', label: 'supplier_name', required: true, example: t.sample.supplier },
      { key: 'date',          label: 'date',                          example: '2026-04-24' },
      { key: 'status',        label: 'status',                        example: 'pending' },
      { key: 'notes',         label: 'notes',                         example: '' },
      { key: 'item_name',     label: 'item_name',     required: true, example: t.sample.item },
      { key: 'qty',           label: 'qty',           required: true, example: '10' },
      { key: 'unit_price',    label: 'unit_price',    required: true, example: t.sample.unitCost },
    ],
  },
});

const ACCENT: Record<ImportEntity, { btn: string; text: string; light: string; border: string }> = {
  customers: { btn: 'bg-teal-600 hover:bg-teal-700',     text: 'text-teal-600',   light: 'bg-teal-50',   border: 'border-teal-200' },
  suppliers:  { btn: 'bg-teal-600 hover:bg-teal-700', text: 'text-teal-600', light: 'bg-teal-50', border: 'border-teal-200' },
  inventory:  { btn: 'bg-emerald-600 hover:bg-emerald-700', text: 'text-emerald-600', light: 'bg-emerald-50', border: 'border-emerald-200' },
  sales:      { btn: 'bg-teal-600 hover:bg-teal-700',     text: 'text-teal-600',   light: 'bg-teal-50',   border: 'border-teal-200' },
  purchases:  { btn: 'bg-teal-600 hover:bg-teal-700', text: 'text-teal-600', light: 'bg-teal-50', border: 'border-teal-200' },
};

type Step = 'select' | 'preview' | 'importing' | 'done';

interface ImportResult { inserted: number; errors: { row?: number; ref?: string; message: string }[] }

const toDateStr = (v: any): string => {
  if (!v) return new Date().toISOString().split('T')[0];
  if (v instanceof Date) return v.toISOString().split('T')[0];
  const d = new Date(v);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return String(v);
};

export default function ExcelImportModal({ entity, onClose, onImported }: Props) {
  const terms  = useTerms();
  const cfg    = buildConfigs(terms)[entity];
  const accent = ACCENT[entity];

  const [step,       setStep]       = useState<Step>('select');
  const [rows,       setRows]       = useState<any[]>([]);
  const [parseError, setParseError] = useState('');
  const [importing,  setImporting]  = useState(false);
  const [result,     setResult]     = useState<ImportResult | null>(null);
  const [dragging,   setDragging]   = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Template download ────────────────────────────────────────────────
  const downloadTemplate = () => {
    const headers = cfg.columns.map(c => c.label);
    const sample  = cfg.columns.map(c => c.example);
    const ws = XLSX.utils.aoa_to_sheet([headers, sample]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, cfg.sheetName);
    const buf  = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `${entity}_template.xlsx`; a.click();
    URL.revokeObjectURL(url);
  };

  // ── File parsing ─────────────────────────────────────────────────────
  const processFile = useCallback(async (file: File) => {
    setParseError('');
    try {
      const buf  = await file.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
      if (!data.length) { setParseError('The file is empty or has no data rows.'); return; }
      setRows(data);
      setStep('preview');
    } catch {
      setParseError('Could not read the file. Please use a valid .xlsx or .csv file.');
    }
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) processFile(f);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) processFile(f);
  };

  // ── Group rows for sales/purchases ───────────────────────────────────
  const buildPayload = () => {
    if (entity === 'sales') {
      const map = new Map<string, any>();
      for (const row of rows) {
        const ref = String(row.invoice_ref || '').trim();
        if (!ref) continue;
        if (!map.has(ref)) {
          map.set(ref, {
            invoice_ref:   ref,
            customer_name: String(row.customer_name || '').trim(),
            date:          toDateStr(row.date),
            status:        String(row.status || 'pending').trim(),
            notes:         String(row.notes  || '').trim(),
            tax_rate:      parseFloat(String(row.tax_rate || 0)) || 0,
            items: [],
          });
        }
        const item_name  = String(row.item_name  || '').trim();
        const qty        = Number(row.qty        || 1);
        const unit_price = parseFloat(String(row.unit_price || 0)) || 0;
        if (item_name) map.get(ref).items.push({ item_name, qty, unit_price });
      }
      return { invoices: Array.from(map.values()) };
    }
    if (entity === 'purchases') {
      const map = new Map<string, any>();
      for (const row of rows) {
        const ref = String(row.po_ref || '').trim();
        if (!ref) continue;
        if (!map.has(ref)) {
          map.set(ref, {
            po_ref:        ref,
            supplier_name: String(row.supplier_name || '').trim(),
            date:          toDateStr(row.date),
            status:        String(row.status || 'pending').trim(),
            notes:         String(row.notes  || '').trim(),
            items: [],
          });
        }
        const item_name  = String(row.item_name  || '').trim();
        const qty        = Number(row.qty        || 1);
        const unit_price = parseFloat(String(row.unit_price || 0)) || 0;
        if (item_name) map.get(ref).items.push({ item_name, qty, unit_price });
      }
      return { pos: Array.from(map.values()) };
    }
    if (entity === 'inventory' && !terms.tyre) {
      return { rows: rows.map(r => ({ ...r, model: String(r.name ?? r.model ?? '').trim() })) };
    }
    // Simple entities
    return { rows };
  };

  // ── Submit ───────────────────────────────────────────────────────────
  const handleImport = async () => {
    setImporting(true);
    try {
      const payload = buildPayload();
      let res: ImportResult;
      if      (entity === 'customers') res = await api.customers.bulk(payload);
      else if (entity === 'suppliers') res = await api.suppliers.bulk(payload);
      else if (entity === 'inventory') res = await api.inventory.bulk(payload);
      else if (entity === 'sales')     res = await api.sales.bulk(payload);
      else                             res = await api.purchases.bulk(payload);
      setResult(res);
      setStep('done');
      if (res.inserted > 0) onImported();
    } catch (err: any) {
      setParseError(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  // Preview columns (limit to first 5 for wide entities)
  const previewCols = cfg.columns.slice(0, 6).map(c => c.key);

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-2xl max-h-[92vh] sm:max-h-[88vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 flex-shrink-0">
          <div className="flex items-center gap-2">
            <FileSpreadsheet size={18} className={accent.text} />
            <h2 className="text-base font-bold text-slate-900">Import {cfg.label}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <X size={18} className="text-slate-500" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-5 space-y-5">

          {/* ── STEP: SELECT ─────────────────────────────────────────── */}
          {step === 'select' && (
            <>
              {/* Step 1 — Template */}
              <div className={`rounded-xl border ${accent.border} ${accent.light} p-4`}>
                <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-1">Step 1 — Download Template</p>
                <p className="text-xs text-slate-500 mb-3">
                  Download the Excel template, fill in your data, then upload it below.
                </p>
                <button onClick={downloadTemplate}
                  className={`flex items-center gap-2 text-sm font-semibold text-white ${accent.btn} px-4 py-2 rounded-lg transition-colors`}>
                  <Download size={14} /> Download Template (.xlsx)
                </button>
              </div>

              {/* Column guide */}
              <div>
                <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">Column Format</p>
                <div className="overflow-x-auto rounded-xl border border-slate-100">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-slate-600">Column</th>
                        <th className="text-left px-3 py-2 font-semibold text-slate-600">Required</th>
                        <th className="text-left px-3 py-2 font-semibold text-slate-600">Example</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {cfg.columns.map(col => (
                        <tr key={col.key}>
                          <td className="px-3 py-2 font-mono font-medium text-slate-800">{col.label}</td>
                          <td className="px-3 py-2">
                            {col.required
                              ? <span className="text-red-600 font-semibold">Yes</span>
                              : <span className="text-slate-400">No</span>}
                          </td>
                          <td className="px-3 py-2 text-slate-500">{col.example}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(entity === 'sales' || entity === 'purchases') && (
                  <p className="text-xs text-slate-500 mt-2 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                    Each row = one line item. Use the same{' '}
                    <span className="font-mono font-semibold">{entity === 'sales' ? 'invoice_ref' : 'po_ref'}</span>{' '}
                    for multiple rows to group them into one {entity === 'sales' ? 'invoice' : 'purchase order'}.
                    Customer / supplier must already exist in the system.
                  </p>
                )}
              </div>

              {/* Step 2 — Upload */}
              <div>
                <p className="text-xs font-bold text-slate-700 uppercase tracking-wide mb-2">Step 2 — Upload File</p>
                <ErrorBanner error={parseError} className="mb-3" />
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors
                    ${dragging ? `${accent.border} ${accent.light}` : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                >
                  <Upload size={28} className="mx-auto mb-2 text-slate-300" />
                  <p className="text-sm font-semibold text-slate-600">Click to upload or drag & drop</p>
                  <p className="text-xs text-slate-400 mt-1">Accepts .xlsx, .xls, .csv</p>
                </div>
                <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFileChange} />
              </div>
            </>
          )}

          {/* ── STEP: PREVIEW ────────────────────────────────────────── */}
          {step === 'preview' && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-slate-900">{rows.length} row{rows.length !== 1 ? 's' : ''} parsed</p>
                  {(entity === 'sales' || entity === 'purchases') && (() => {
                    const refKey = entity === 'sales' ? 'invoice_ref' : 'po_ref';
                    const groups = new Set(rows.map(r => r[refKey])).size;
                    return <p className="text-xs text-slate-500">{groups} {entity === 'sales' ? 'invoice' : 'PO'}{groups !== 1 ? 's' : ''} detected</p>;
                  })()}
                </div>
                <button onClick={() => { setStep('select'); setRows([]); }}
                  className="text-xs text-slate-500 hover:text-slate-700 underline">
                  Change file
                </button>
              </div>

              <ErrorBanner error={parseError} />

              {/* Preview table */}
              <div className="overflow-x-auto rounded-xl border border-slate-100">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-slate-500">#</th>
                      {previewCols.map(c => (
                        <th key={c} className="px-3 py-2 text-left font-semibold text-slate-500 font-mono">{c}</th>
                      ))}
                      {cfg.columns.length > 6 && <th className="px-3 py-2 text-slate-400">…</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {rows.slice(0, 8).map((row, i) => (
                      <tr key={i} className="hover:bg-slate-50/50">
                        <td className="px-3 py-2 text-slate-400">{i + 2}</td>
                        {previewCols.map(c => (
                          <td key={c} className="px-3 py-2 text-slate-700 max-w-[140px] truncate">
                            {row[c] instanceof Date ? toDateStr(row[c]) : String(row[c] ?? '')}
                          </td>
                        ))}
                        {cfg.columns.length > 6 && <td className="px-3 py-2 text-slate-300">…</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 8 && (
                  <p className="text-center text-xs text-slate-400 py-2">… and {rows.length - 8} more rows</p>
                )}
              </div>
            </>
          )}

          {/* ── STEP: IMPORTING ──────────────────────────────────────── */}
          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 size={32} className={`animate-spin ${accent.text}`} />
              <p className="text-sm font-semibold text-slate-700">Importing data…</p>
              <p className="text-xs text-slate-400">Please wait, processing {rows.length} rows</p>
            </div>
          )}

          {/* ── STEP: DONE ───────────────────────────────────────────── */}
          {step === 'done' && result && (
            <>
              <div className={`rounded-xl border p-4 flex items-start gap-3 ${result.inserted > 0 ? 'bg-emerald-50 border-emerald-100' : 'bg-slate-50 border-slate-100'}`}>
                <CheckCircle size={20} className={result.inserted > 0 ? 'text-emerald-600 flex-shrink-0 mt-0.5' : 'text-slate-400 flex-shrink-0 mt-0.5'} />
                <div>
                  <p className="text-sm font-bold text-slate-900">
                    {result.inserted} record{result.inserted !== 1 ? 's' : ''} imported successfully
                  </p>
                  {result.errors.length > 0 && (
                    <p className="text-xs text-slate-500 mt-0.5">{result.errors.length} row{result.errors.length !== 1 ? 's' : ''} skipped due to errors</p>
                  )}
                </div>
              </div>

              {result.errors.length > 0 && (
                <div>
                  <p className="text-xs font-bold text-slate-700 mb-2">Skipped rows</p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {result.errors.map((e, i) => (
                      <div key={i} className="flex items-start gap-2 bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-xs">
                        <AlertCircle size={13} className="text-red-500 flex-shrink-0 mt-0.5" />
                        <span className="text-red-700">
                          {e.ref ? <><span className="font-semibold">{e.ref}</span>: </> : <><span className="font-semibold">Row {e.row}</span>: </>}
                          {e.message}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 flex-shrink-0">
          {step === 'done' ? (
            <button onClick={onClose}
              className={`px-5 py-2.5 text-sm font-semibold text-white ${accent.btn} rounded-xl transition-colors`}>
              Done
            </button>
          ) : (
            <>
              <button onClick={onClose}
                className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">
                Cancel
              </button>
              {step === 'preview' && (
                <button
                  onClick={handleImport}
                  disabled={importing || rows.length === 0}
                  className={`flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white ${accent.btn} rounded-xl transition-colors disabled:opacity-60 min-w-32 justify-center`}
                >
                  {importing
                    ? <><Loader2 size={15} className="animate-spin" /> Importing…</>
                    : <><Upload size={15} /> Import {rows.length} rows</>}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
