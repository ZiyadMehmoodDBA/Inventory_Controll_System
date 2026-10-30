import { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import {
  Loader2, Play, Square, Trash2, Eye, Pencil, EyeOff, Undo2, Download, PackagePlus, X, Save, ExternalLink, SlidersHorizontal, RotateCcw, Search, Image as ImageIcon, ChevronDown, ChevronRight,
} from 'lucide-react';
import { api } from '../../api/client';
import { BUSINESS_TYPES, useModules } from '../../lib/businessTypes';
import { getCachedSettings } from '../../lib/appSettings';
import ErrorBanner from '../../components/ErrorBanner';
import ConfirmDialog from '../../components/ConfirmDialog';
import { Field } from './shared';
import CatalogScraperTab from './CatalogScraperTab';

const CORE = ['name', 'brand', 'sku', 'barcode', 'oem', 'category', 'subcategory', 'price', 'wholesale_price', 'unit', 'pack_size', 'image_url', 'description'];
const inputCls = 'w-full px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-400 bg-white';
const STATUS: Record<string, { label: string; cls: string }> = {
  pending:   { label: 'Pending',   cls: 'bg-amber-50 text-amber-700 border-amber-100' },
  validated: { label: 'Validated', cls: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
  duplicate: { label: 'Duplicate', cls: 'bg-red-50 text-red-700 border-red-100' },
  ignored:   { label: 'Ignored',   cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  imported:  { label: 'Imported',  cls: 'bg-teal-50 text-teal-700 border-teal-100' },
};
const JOB_STATUS: Record<string, string> = { queued: 'Queued', running: 'Running', done: 'Finished', failed: 'Failed', cancelled: 'Stopped' };
const label = (id: string) => BUSINESS_TYPES.find(t => t.id === id)?.label ?? id;
const when = (iso?: string | null) => (iso ? new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z').toLocaleString() : '');
const money = (n: any, cur?: string | null) => (n === null || n === undefined ? '—' : `${cur ? cur + ' ' : ''}${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const safeUrl = (u?: string | null) => (u && /^https?:\/\//i.test(u) ? u : undefined);

function Badge({ s }: { s: string }) {
  const b = STATUS[s] ?? STATUS.pending;
  return <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border ${b.cls}`}>{b.label}</span>;
}

// ── profile editor ──────────────────────────────────────────────────────────
function ProfileModal({ type, profile, onClose, onSaved }: { type: string; profile: any; onClose: () => void; onSaved: (p: any) => void }) {
  const [keywords, setKeywords] = useState((profile.keywords as string[]).join(', '));
  const [cats, setCats]         = useState((profile.categories as any[]).map(c => `${c.name}${c.match.length ? ': ' + c.match.join(', ') : ''}`).join('\n'));
  const [required, setRequired] = useState<string[]>(profile.fields.filter((f: any) => f.required).map((f: any) => f.key));
  const [pages, setPages]       = useState(String(profile.max_pages));
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const split = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const categories = cats.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [n, m] = l.split(':'); return { name: n.trim(), match: split(m ?? '') }; });
      onSaved(await api.catalogue.saveProfile(type, { keywords: split(keywords), categories, required, max_pages: Number(pages) || 3 }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const reset = async () => { setBusy(true); try { onSaved(await api.catalogue.resetProfile(type)); } catch (e: any) { setError(e.message); setBusy(false); } };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-label="Edit catalogue profile" className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-base font-bold text-slate-900">Catalogue profile: {label(type)}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <ErrorBanner error={error} />
          <Field label="Search keywords" help="Comma separated. When set, only products that mention at least one are kept."><input aria-label="Profile keywords" className={inputCls} value={keywords} onChange={e => setKeywords(e.target.value)} /></Field>
          <Field label="Categories" help="One per line. Optionally add words after a colon: products containing them are filed in that category.">
            <textarea aria-label="Profile categories" rows={6} className={`${inputCls} font-mono text-xs`} value={cats} onChange={e => setCats(e.target.value)} />
          </Field>
          <div>
            <p className="block text-xs font-semibold text-slate-700 mb-1.5">Required attributes</p>
            <p className="text-xs text-slate-400 mb-2">A record missing one stays Pending until you fill it in.</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {profile.fields.map((f: any) => (
                <label key={f.key} className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={required.includes(f.key)} onChange={e => setRequired(r => (e.target.checked ? [...r, f.key] : r.filter(k => k !== f.key)))} /> {f.label}
                </label>
              ))}
            </div>
          </div>
          <Field label="Pages to read per scrape (1-10)"><input aria-label="Profile max pages" type="number" min={1} max={10} className={inputCls} value={pages} onChange={e => setPages(e.target.value)} /></Field>
        </div>
        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
          <button onClick={reset} disabled={busy || !profile.customised} className="flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40"><RotateCcw size={14} /> Reset to defaults</button>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
            <button onClick={save} disabled={busy} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-500 hover:bg-teal-600 disabled:opacity-50 rounded-xl">{busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save profile</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── preview / edit ──────────────────────────────────────────────────────────
function RecordModal({ id, mode, profile, onClose, onSaved }: { id: number; mode: 'preview' | 'edit'; profile: any; onClose: () => void; onSaved: () => void }) {
  const [rec, setRec]     = useState<any>(null);
  const [form, setForm]   = useState<any>({});
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.catalogue.record(id).then(r => {
      setRec(r);
      setForm(Object.fromEntries(CORE.map(k => [k, r[k] ?? ''])));
      setAttrs(r.attributes || {});
    }).catch((e: any) => setError(e.message));
  }, [id]);
  const attrFields = (profile?.fields || []).filter((f: any) => !CORE.includes(f.key));
  // the identifying fields are always editable (a duplicate is fixed by changing SKU or barcode), whatever the profile lists
  const ALWAYS: Record<string, string> = { name: 'Product name', brand: 'Brand', sku: 'SKU / Part number', barcode: 'Barcode / GTIN', category: 'Category', price: 'Retail price' };
  const coreFields = CORE.filter(k => k !== 'image_url' && (k in ALWAYS || (profile?.fields || []).some((f: any) => f.key === k)))
    .map(k => { const f = (profile?.fields || []).find((x: any) => x.key === k); return { key: k, label: f?.label ?? ALWAYS[k], required: !!f?.required }; });

  const save = async () => {
    setBusy(true); setError('');
    try {
      const body: any = { ...form, attributes: attrs };
      for (const k of ['price', 'wholesale_price']) body[k] = form[k] === '' ? null : form[k];
      for (const k of CORE) if (k !== 'price' && k !== 'wholesale_price' && body[k] === '') body[k] = k === 'name' ? '' : null;
      await api.catalogue.editRecord(id, body);
      onSaved();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div role="dialog" aria-label={mode === 'edit' ? 'Edit product' : 'Preview product'} className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-base font-bold text-slate-900">{mode === 'edit' ? 'Edit product' : 'Preview product'}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg"><X size={16} /></button>
        </div>
        {!rec ? <div className="p-10 flex justify-center">{error ? <ErrorBanner error={error} /> : <Loader2 className="animate-spin text-slate-400" />}</div> : (
          <div className="px-5 py-4 space-y-4">
            <ErrorBanner error={error} />
            <div className="flex items-center gap-2 flex-wrap text-xs text-slate-500">
              <Badge s={rec.status} />
              {rec.duplicate_reason && <span className="text-red-600 font-medium">{rec.duplicate_reason}</span>}
              {rec.issues.length > 0 && <span className="text-amber-700">{rec.issues.join('; ')}</span>}
            </div>
            {mode === 'preview' ? (
              <>
                <div className="flex gap-4">
                  {safeUrl(rec.image_url) ? <img src={safeUrl(rec.image_url)} alt="" referrerPolicy="no-referrer" className="w-28 h-28 object-contain rounded-xl border border-slate-100 bg-slate-50 flex-shrink-0" /> : <div className="w-28 h-28 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-300"><ImageIcon size={28} /></div>}
                  <div className="min-w-0">
                    <p className="text-lg font-bold text-slate-900">{rec.name}</p>
                    <p className="text-sm text-slate-500">{[rec.brand, rec.category, rec.subcategory].filter(Boolean).join(' · ')}</p>
                    <p className="text-base font-semibold text-slate-800 mt-1">{money(rec.price, rec.currency)}{rec.wholesale_price !== null && <span className="text-xs font-normal text-slate-400 ml-2">wholesale {money(rec.wholesale_price)}</span>}</p>
                    {safeUrl(rec.source_url) && <a href={safeUrl(rec.source_url)} target="_blank" rel="noopener noreferrer nofollow" className="text-xs text-teal-600 hover:underline inline-flex items-center gap-1 mt-1">Open source page <ExternalLink size={11} /></a>}
                  </div>
                </div>
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  {[['SKU', rec.sku], ['Barcode', rec.barcode], ['OEM number', rec.oem], ['Unit', rec.unit], ['Package size', rec.pack_size], ...attrFields.map((f: any) => [f.label, rec.attributes[f.key]])].filter(([, v]) => v).map(([k, v]) => (
                    <div key={k as string} className="flex gap-2"><dt className="text-slate-400 w-36 flex-shrink-0">{k}</dt><dd className="text-slate-800 break-words min-w-0">{v}</dd></div>
                  ))}
                </dl>
                {rec.description && <p className="text-sm text-slate-600 bg-slate-50 rounded-xl p-3">{rec.description}</p>}
                <p className="text-xs text-slate-400">Extracted {when(rec.extracted_at)} from {rec.raw?.via ?? 'the page'}. Raw data is kept unchanged for traceability.</p>
                {rec.raw?.data && <details className="text-xs"><summary className="cursor-pointer text-slate-500 font-semibold">Raw extraction</summary><pre className="mt-2 bg-slate-900 text-slate-100 rounded-xl p-3 overflow-auto max-h-60 whitespace-pre-wrap break-words">{JSON.stringify(rec.raw.data, null, 2)}</pre></details>}
              </>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {coreFields.map((f: any) => (
                  <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
                    {f.key === 'description'
                      ? <textarea aria-label={f.label} rows={3} className={inputCls} value={form[f.key] ?? ''} onChange={e => setForm((x: any) => ({ ...x, [f.key]: e.target.value }))} />
                      : <input aria-label={f.label} className={inputCls} value={form[f.key] ?? ''} onChange={e => setForm((x: any) => ({ ...x, [f.key]: e.target.value }))} />}
                  </Field>
                ))}
                {attrFields.map((f: any) => (
                  <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
                    <input aria-label={f.label} className={inputCls} value={attrs[f.key] ?? ''} onChange={e => setAttrs(a => ({ ...a, [f.key]: e.target.value }))} />
                  </Field>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl">{mode === 'edit' ? 'Cancel' : 'Close'}</button>
          {mode === 'edit' && rec && <button onClick={save} disabled={busy} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-500 hover:bg-teal-600 disabled:opacity-50 rounded-xl">{busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save changes</button>}
        </div>
      </div>
    </div>
  );
}

// ── main ────────────────────────────────────────────────────────────────────
export default function CatalogueScraperTab() {
  const modules = useModules();
  const orgType = getCachedSettings().business_type || 'general_store';
  const [type, setType]         = useState<string>(orgType);
  const [profile, setProfile]   = useState<any>(null);
  const [name, setName]         = useState('');
  const [url, setUrl]           = useState('');
  const [keywords, setKeywords] = useState('');
  const [category, setCategory] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [maxPages, setMaxPages] = useState('');
  const [follow, setFollow]     = useState(true);
  const [sel, setSel]           = useState({ item: '', name: '', price: '', image: '', link: '', next: '' });
  const [starting, setStarting] = useState(false);
  const [error, setError]       = useState('');
  const [notice, setNotice]     = useState('');
  const [jobs, setJobs]         = useState<any[]>([]);
  const [jobId, setJobId]       = useState<number | null>(null);
  const [job, setJob]           = useState<any>(null);
  const [rows, setRows]         = useState<{ total: number; rows: any[] }>({ total: 0, rows: [] });
  const [status, setStatus]     = useState('');
  const [q, setQ]               = useState('');
  const [picked, setPicked]     = useState<number[]>([]);
  const [priceAs, setPriceAs]   = useState<'sale' | 'cost'>('sale');
  const [working, setWorking]   = useState(false);
  const [modal, setModal]       = useState<{ id: number; mode: 'preview' | 'edit' } | null>(null);
  const [editProfile, setEditProfile] = useState(false);
  const [deleting, setDeleting] = useState<any | null>(null);
  const [showTyre, setShowTyre] = useState(false);
  const jobRef = useRef<number | null>(null);
  jobRef.current = jobId;

  const loadProfile = useCallback(async (t: string) => { try { setProfile(await api.catalogue.profile(t)); } catch (e: any) { setError(e.message); } }, []);
  useEffect(() => { setProfile(null); loadProfile(type); }, [type, loadProfile]);

  const loadJobs = useCallback(async () => { try { setJobs(await api.catalogue.jobs()); } catch (e: any) { setError(e.message); } }, []);
  const loadJob = useCallback(async () => {
    const id = jobRef.current;
    if (!id) { setJob(null); setRows({ total: 0, rows: [] }); return; }
    try {
      const [j, r] = await Promise.all([api.catalogue.job(id), api.catalogue.records(id, { status, q, limit: 200 })]);
      if (jobRef.current === id) { setJob(j); setRows(r); }
    } catch (e: any) { setError(e.message); }
  }, [status, q]);
  useEffect(() => { loadJobs(); }, [loadJobs]);
  useEffect(() => { loadJob(); setPicked([]); }, [jobId, status, q, loadJob]);
  const live = !!job?.running || jobs.some(j => j.running);
  useEffect(() => { const t = setInterval(() => { loadJobs(); loadJob(); }, live ? 2000 : 20000); return () => clearInterval(t); }, [live, loadJobs, loadJob]);

  const start = async () => {
    setStarting(true); setError(''); setNotice('');
    try {
      const selectors = Object.fromEntries(Object.entries(sel).filter(([, v]) => v.trim()));
      const j = await api.catalogue.startJob({
        business_type: type, source_name: name, source_url: url, category: category || null,
        keywords: keywords.split(',').map(s => s.trim()).filter(Boolean),
        ...(maxPages ? { max_pages: Number(maxPages) } : {}), follow_details: follow, ...(Object.keys(selectors).length ? { selectors } : {}),
      });
      setJobId(j.id); setStatus(''); setQ('');
      await loadJobs();
    } catch (e: any) { setError(e.message); } finally { setStarting(false); }
  };

  const act = async (fn: () => Promise<any>, ok?: string) => {
    setWorking(true); setError(''); setNotice('');
    try { const r = await fn(); if (ok) setNotice(ok); await loadJob(); await loadJobs(); return r; } catch (e: any) { setError(e.message); } finally { setWorking(false); }
  };
  const importIds = async (ids: number[]) => {
    const r = await act(() => api.catalogue.import(ids, priceAs));
    if (!r) return;
    const failed = r.results.filter((x: any) => !x.ok);
    setNotice(`${r.imported} product${r.imported === 1 ? '' : 's'} added to your products.${failed.length ? ` ${failed.length} not imported: ${[...new Set(failed.map((f: any) => f.error))].slice(0, 2).join(' / ')}` : ''}`);
    setPicked([]);
  };

  const attrFields = (profile?.fields || []).filter((f: any) => !CORE.includes(f.key));
  const exportRows = async (format: 'csv' | 'xlsx') => {
    if (!jobId) return;
    setWorking(true);
    try {
      const all = (await api.catalogue.records(jobId, { limit: 500 })).rows;
      const data = all.map(r => ({
        'Product name': r.name, SKU: r.sku, Barcode: r.barcode, 'OEM number': r.oem, Brand: r.brand, Category: r.category, Subcategory: r.subcategory, Price: r.price, 'Wholesale price': r.wholesale_price,
        Currency: r.currency, Unit: r.unit, 'Package size': r.pack_size, ...Object.fromEntries(attrFields.map((f: any) => [f.label, r.attributes[f.key]])),
        Image: r.image_url, 'Source URL': r.source_url, 'Extracted at': when(r.extracted_at), Status: STATUS[r.status]?.label, Notes: [...r.issues, r.duplicate_reason].filter(Boolean).join('; '),
      }));
      const safe = (v: any) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? "'" + v : v);        // a scraped value must never run as a formula
      const clean = data.map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, safe(v)])));
      const ws = XLSX.utils.json_to_sheet(clean);
      if (format === 'xlsx') { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Catalogue'); XLSX.writeFile(wb, `catalogue-${jobId}.xlsx`); }
      else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + XLSX.utils.sheet_to_csv(ws)], { type: 'text/csv;charset=utf-8' }));
        a.download = `catalogue-${jobId}.csv`; a.click(); URL.revokeObjectURL(a.href);
      }
    } catch (e: any) { setError(e.message); } finally { setWorking(false); }
  };

  const importable = (r: any) => r.status === 'validated' || r.status === 'pending';
  const toggle = (id: number) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  const allShown = rows.rows.filter(importable).map(r => r.id);
  const counts = job?.counts || {};

  return (
    <div className="space-y-6" data-testid="catalogue-scraper">
      <div>
        <h2 className="text-base font-bold text-slate-900">Catalogue scraper</h2>
        <p className="text-xs text-slate-400 mt-0.5">Pull product details from a supplier or manufacturer page, review them, and add the ones you approve to your products. Only public pages are read; sites that forbid it (robots.txt), need a login or show a bot check are skipped.</p>
      </div>
      <ErrorBanner error={error} />
      {notice && <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm text-emerald-700" role="status">{notice}</div>}

      {/* New scrape */}
      <section className="border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100"><h3 className="text-sm font-bold text-slate-900">New scrape</h3></div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Business type" help="Decides which product details are looked for.">
            <select aria-label="Business type" className={inputCls} value={type} onChange={e => setType(e.target.value)}>
              {BUSINESS_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}{t.id === orgType ? ' (your business)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Source name" help="For your records, e.g. the supplier's name."><input aria-label="Source name" className={inputCls} value={name} maxLength={100} onChange={e => setName(e.target.value)} placeholder="e.g. Al-Madina Wholesale" /></Field>
          <div className="md:col-span-2"><Field label="Catalogue source URL" help="A product listing page or a single product page, on a public site."><input aria-label="Catalogue source URL" className={inputCls} value={url} maxLength={500} onChange={e => setUrl(e.target.value)} placeholder="https://supplier.example.com/products/rice" /></Field></div>
          <Field label="Scraping keywords" help={profile?.keywords?.length ? 'Optional. Only products mentioning one are kept.' : 'Optional.'}>
            <input aria-label="Scraping keywords" className={inputCls} value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="comma separated" />
            {profile?.keywords?.length > 0 && <div className="flex flex-wrap gap-1 mt-1.5">{profile.keywords.slice(0, 8).map((k: string) => <button key={k} type="button" onClick={() => setKeywords(s => (s.split(',').map(x => x.trim()).includes(k) ? s : s ? `${s}, ${k}` : k))} className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 hover:bg-teal-50 hover:text-teal-700">{k}</button>)}</div>}
          </Field>
          <Field label="Product category" help="Used when the page does not say. Known categories are filed automatically.">
            <input aria-label="Product category" list="catalogue-cats" className={inputCls} value={category} onChange={e => setCategory(e.target.value)} placeholder="optional" />
            <datalist id="catalogue-cats">{(profile?.categories || []).map((c: any) => <option key={c.name} value={c.name} />)}</datalist>
          </Field>
        </div>

        {profile && (
          <div className="px-4 pb-4">
            <div className="bg-slate-50 rounded-xl p-3 text-xs text-slate-600 flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="profile-summary">
              <span className="font-semibold text-slate-700">{label(type)} extracts:</span>
              <span className="flex flex-wrap gap-1">{profile.fields.map((f: any) => <span key={f.key} className={`px-2 py-0.5 rounded-full border ${f.required ? 'bg-teal-50 border-teal-100 text-teal-700 font-semibold' : 'bg-white border-slate-200'}`}>{f.label}{f.required ? ' *' : ''}</span>)}</span>
              <button onClick={() => setEditProfile(true)} className="ml-auto flex items-center gap-1.5 font-semibold text-teal-600 hover:text-teal-700"><SlidersHorizontal size={13} /> Edit profile</button>
            </div>
          </div>
        )}

        <div className="px-4 pb-4">
          <button type="button" onClick={() => setAdvanced(a => !a)} className="flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-slate-700">{advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Advanced</button>
          {advanced && (
            <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="Pages to read"><input aria-label="Pages to read" type="number" min={1} max={10} className={inputCls} value={maxPages} onChange={e => setMaxPages(e.target.value)} placeholder={String(profile?.max_pages ?? 3)} /></Field>
              <label className="flex items-center gap-2 text-sm text-slate-700 md:mt-6"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} /> Open each product page for more detail</label>
              <div />
              {(['item', 'name', 'price', 'image', 'link', 'next'] as const).map(k => (
                <Field key={k} label={`CSS selector: ${k === 'item' ? 'product card' : k === 'next' ? 'next-page link' : k}`}><input aria-label={`Selector ${k}`} className={`${inputCls} font-mono text-xs`} value={sel[k]} onChange={e => setSel(s => ({ ...s, [k]: e.target.value }))} placeholder="leave empty to detect automatically" /></Field>
              ))}
            </div>
          )}
        </div>
        <div className="px-4 py-3 border-t border-slate-100 flex justify-end">
          <button onClick={start} disabled={starting || !name.trim() || !url.trim()} className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-teal-500 hover:bg-teal-600 disabled:opacity-40 rounded-xl">
            {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Start scraping
          </button>
        </div>
      </section>

      {/* Scrapes */}
      <section className="border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-100"><h3 className="text-sm font-bold text-slate-900">Recent scrapes</h3></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="catalogue-jobs">
            <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-100"><th className="px-4 py-2.5 font-bold">Source</th><th className="px-3 py-2.5 font-bold">Business type</th><th className="px-3 py-2.5 font-bold">Status</th><th className="px-3 py-2.5 font-bold">Found</th><th className="px-3 py-2.5 font-bold">Imported</th><th className="px-4 py-2.5 font-bold text-right">Actions</th></tr></thead>
            <tbody>
              {jobs.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No scrapes yet.</td></tr>}
              {jobs.map(j => (
                <tr key={j.id} data-job={j.source_name} onClick={() => setJobId(j.id)} className={`border-b border-slate-50 last:border-0 cursor-pointer ${jobId === j.id ? 'bg-teal-50/50' : 'hover:bg-slate-50'}`}>
                  <td className="px-4 py-2.5"><p className="font-semibold text-slate-900">{j.source_name}</p><p className="text-xs text-slate-400 truncate max-w-xs" title={j.source_url}>{j.source_url}</p>{j.message && <p className={`text-xs mt-0.5 ${j.status === 'failed' ? 'text-red-600' : 'text-amber-700'}`}>{j.message}</p>}</td>
                  <td className="px-3 py-2.5 text-slate-600">{label(j.business_type)}</td>
                  <td className="px-3 py-2.5">{j.running ? <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-700"><Loader2 size={12} className="animate-spin" /> Running · page {j.pages_fetched}</span> : <span className={`text-xs font-semibold ${j.status === 'failed' ? 'text-red-600' : 'text-slate-600'}`}>{JOB_STATUS[j.status]}</span>}</td>
                  <td className="px-3 py-2.5 text-slate-700">{j.found}</td><td className="px-3 py-2.5 text-slate-700">{j.imported}</td>
                  <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      {j.running ? <button aria-label={`Stop ${j.source_name}`} title="Stop" onClick={() => act(() => api.catalogue.cancelJob(j.id))} className="p-2 text-amber-600 hover:bg-amber-50 rounded-lg"><Square size={15} /></button>
                        : <button aria-label={`Delete ${j.source_name}`} title="Delete" onClick={() => setDeleting(j)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={15} /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Results */}
      {job && (
        <section className="border border-slate-200 rounded-2xl overflow-hidden" data-testid="catalogue-results">
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="text-sm font-bold text-slate-900">Review: {job.source_name}</h3><p className="text-xs text-slate-400">Nothing is added to your products until you approve it.</p></div>
            <div className="flex items-center gap-2">
              <button onClick={() => exportRows('csv')} disabled={working || !rows.total} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-white disabled:opacity-40"><Download size={13} /> CSV</button>
              <button onClick={() => exportRows('xlsx')} disabled={working || !rows.total} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 rounded-lg hover:bg-white disabled:opacity-40"><Download size={13} /> Excel</button>
            </div>
          </div>
          <div className="px-4 py-2.5 border-b border-slate-100 flex flex-wrap items-center gap-2">
            {(['', 'pending', 'validated', 'duplicate', 'ignored', 'imported'] as const).map(s => (
              <button key={s || 'all'} onClick={() => setStatus(s)} className={`px-3 py-1 text-xs font-semibold rounded-full border ${status === s ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                {s ? STATUS[s].label : 'All'} <span className="opacity-60">{s ? counts[s] ?? 0 : Object.values(counts as Record<string, number>).reduce((a, b) => a + b, 0)}</span>
              </button>
            ))}
            <div className="relative ml-auto"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" /><input aria-label="Search results" value={q} onChange={e => setQ(e.target.value)} placeholder="Search name, brand, SKU…" className="pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg w-52" /></div>
          </div>
          {picked.length > 0 && (
            <div className="px-4 py-2.5 bg-teal-50 border-b border-teal-100 flex flex-wrap items-center gap-3 text-sm" data-testid="bulk-bar">
              <span className="font-semibold text-teal-800">{picked.length} selected</span>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">Listed price is your
                <select aria-label="Price meaning" value={priceAs} onChange={e => setPriceAs(e.target.value as any)} className="border border-slate-200 rounded-lg px-2 py-1 bg-white text-xs"><option value="sale">selling price</option><option value="cost">buying price (cost)</option></select>
              </label>
              <button onClick={() => importIds(picked)} disabled={working} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-500 hover:bg-teal-600 disabled:opacity-50 rounded-lg">{working ? <Loader2 size={13} className="animate-spin" /> : <PackagePlus size={13} />} Approve &amp; import</button>
              <button onClick={() => act(() => api.catalogue.ignore(picked), 'Ignored.')} disabled={working} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-600 border border-slate-200 bg-white rounded-lg"><EyeOff size={13} /> Ignore</button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="catalogue-records">
              <thead><tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
                <th className="px-3 py-2.5 w-8"><input type="checkbox" aria-label="Select all" checked={allShown.length > 0 && allShown.every(i => picked.includes(i))} onChange={e => setPicked(e.target.checked ? allShown : [])} /></th>
                <th className="px-2 py-2.5 font-bold">Image</th><th className="px-3 py-2.5 font-bold">Product</th><th className="px-3 py-2.5 font-bold">SKU</th><th className="px-3 py-2.5 font-bold">Brand</th><th className="px-3 py-2.5 font-bold">Category</th>
                <th className="px-3 py-2.5 font-bold">Attributes</th><th className="px-3 py-2.5 font-bold text-right">Price</th><th className="px-3 py-2.5 font-bold">Source</th><th className="px-3 py-2.5 font-bold">Status</th><th className="px-3 py-2.5 font-bold text-right">Actions</th>
              </tr></thead>
              <tbody>
                {rows.rows.length === 0 && <tr><td colSpan={11} className="px-4 py-8 text-center text-slate-400">{job.running ? 'Reading the site…' : 'No records match.'}</td></tr>}
                {rows.rows.map(r => {
                  const attrs = Object.entries(r.attributes as Record<string, string>).filter(([k]) => k !== 'specifications').slice(0, 4);
                  return (
                    <tr key={r.id} data-record={r.name} className="border-b border-slate-50 last:border-0 align-top">
                      <td className="px-3 py-2.5"><input type="checkbox" aria-label={`Select ${r.name}`} disabled={!importable(r)} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} /></td>
                      <td className="px-2 py-2.5">{safeUrl(r.image_url) ? <img src={safeUrl(r.image_url)} alt="" loading="lazy" referrerPolicy="no-referrer" className="w-10 h-10 object-contain rounded-lg border border-slate-100 bg-slate-50" /> : <div className="w-10 h-10 rounded-lg bg-slate-50 border border-slate-100" />}</td>
                      <td className="px-3 py-2.5 max-w-[220px]"><p className="font-semibold text-slate-900 break-words">{r.name}</p>{(r.issues.length > 0 || r.duplicate_reason) && <p className={`text-[11px] mt-0.5 ${r.status === 'duplicate' ? 'text-red-600' : 'text-amber-700'}`}>{r.duplicate_reason || r.issues.join('; ')}</p>}</td>
                      <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{r.sku || '—'}</td>
                      <td className="px-3 py-2.5 text-slate-600">{r.brand || '—'}</td>
                      <td className="px-3 py-2.5 text-slate-600">{r.category || '—'}{r.subcategory && <span className="text-slate-400 text-xs block">{r.subcategory}</span>}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-500 max-w-[200px]">{attrs.length ? attrs.map(([k, v]) => <span key={k} className="inline-block mr-1.5 mb-0.5"><span className="text-slate-400">{k.replace(/_/g, ' ')}:</span> {v}</span>) : '—'}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap text-slate-800">{money(r.price, r.currency)}</td>
                      <td className="px-3 py-2.5">{safeUrl(r.source_url) ? <a href={safeUrl(r.source_url)} target="_blank" rel="noopener noreferrer nofollow" title={`${r.source_url}\nExtracted ${when(r.extracted_at)}`} className="text-teal-600 hover:underline inline-flex items-center gap-1 text-xs">Open <ExternalLink size={11} /></a> : '—'}</td>
                      <td className="px-3 py-2.5"><Badge s={r.status} /></td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-0.5">
                          <button title="Preview" aria-label={`Preview ${r.name}`} onClick={() => setModal({ id: r.id, mode: 'preview' })} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg"><Eye size={15} /></button>
                          {r.status !== 'imported' && <button title="Edit" aria-label={`Edit ${r.name}`} onClick={() => setModal({ id: r.id, mode: 'edit' })} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg"><Pencil size={15} /></button>}
                          {r.status === 'ignored'
                            ? <button title="Restore" aria-label={`Restore ${r.name}`} onClick={() => act(() => api.catalogue.restore([r.id]), 'Restored.')} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg"><Undo2 size={15} /></button>
                            : r.status !== 'imported' && <button title="Ignore" aria-label={`Ignore ${r.name}`} onClick={() => act(() => api.catalogue.ignore([r.id]))} className="p-1.5 text-slate-500 hover:bg-slate-100 rounded-lg"><EyeOff size={15} /></button>}
                          {importable(r) && <button title="Approve & import" aria-label={`Import ${r.name}`} disabled={working} onClick={() => importIds([r.id])} className="p-1.5 text-teal-600 hover:bg-teal-50 rounded-lg disabled:opacity-40"><PackagePlus size={15} /></button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.total > rows.rows.length && <p className="px-4 py-2.5 text-xs text-slate-400 border-t border-slate-100">Showing the first {rows.rows.length} of {rows.total}. Use search or the status filters to narrow down.</p>}
        </section>
      )}

      {modules.tyreCatalog && (
        <section className="border border-slate-200 rounded-2xl overflow-hidden">
          <button onClick={() => setShowTyre(s => !s)} className="w-full px-4 py-3 bg-slate-50 flex items-center justify-between text-left">
            <span><span className="text-sm font-bold text-slate-900 block">Tyre reference database</span><span className="text-xs text-slate-400">The scheduled scraper that keeps the shared tyre brand / model / size list up to date.</span></span>
            {showTyre ? <ChevronDown size={16} className="text-slate-400" /> : <ChevronRight size={16} className="text-slate-400" />}
          </button>
          {showTyre && <div className="p-4 border-t border-slate-100"><CatalogScraperTab /></div>}
        </section>
      )}

      {modal && <RecordModal id={modal.id} mode={modal.mode} profile={profile} onClose={() => setModal(null)} onSaved={() => { setModal(null); setNotice('Saved.'); loadJob(); }} />}
      {editProfile && profile && <ProfileModal type={type} profile={profile} onClose={() => setEditProfile(false)} onSaved={p => { setProfile(p); setEditProfile(false); setNotice('Profile saved.'); }} />}
      {deleting && <ConfirmDialog title="Delete scrape" message={`Delete "${deleting.source_name}" and its ${deleting.found} records? Products you already imported stay.`} confirmLabel="Delete" loading={working}
        onCancel={() => setDeleting(null)} onConfirm={async () => { await act(() => api.catalogue.deleteJob(deleting.id), 'Scrape deleted.'); if (jobId === deleting.id) setJobId(null); setDeleting(null); }} />}
    </div>
  );
}
