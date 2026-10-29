import { useEffect, useState } from 'react';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';

export interface Conversion { uom: string; factor: string | number }
export interface MasterForm {
  item_type: string; manufacturer: string; supplier_id: string | number; status: string;
  uom: string; purchase_uom: string; sales_uom: string; pack_size: string | number;
  length_cm: string | number; width_cm: string | number; height_cm: string | number; weight_kg: string | number; volume_l: string | number;
  conversions: Conversion[];
  min_stock: string | number; max_stock: string | number; reorder_level: string | number; reorder_qty: string | number;
  reorder_mode: string; safety_stock: string | number; lead_time_days: string | number; moq: string | number; order_multiple: string | number; capacity_units: string | number;
  tax_class: string; tax_rate: string | number;
  hazard_class_id: string | number; un_number: string; packing_group: string; flash_point_c: string | number; sds_ref: string; sds_date: string; ppe: string; emergency_info: string;
  storage_temp_min_c: string | number; storage_temp_max_c: string | number; hazard_inspection_days: string | number;
  quality_profile_id: string | number; near_expiry_days: string | number; inspection_interval_days: string | number; min_remaining_days: string | number; require_mfg_date: string;
  shelf_life_days: string | number; storage_conditions: string; storage_requirements: string; handling_instructions: string; safety_requirements: string;
}

interface Meta { uoms: string[]; item_types: { value: string; label: string }[]; statuses: string[]; tax_classes: string[] }
interface Props { form: MasterForm; set: (field: string, value: any) => void }

const input = 'w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50';
const label = 'block text-xs font-semibold text-slate-700 mb-1';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Section({ title, hint, open, children }: { title: string; hint?: string; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="group rounded-xl border border-slate-200 bg-white">
      <summary className="flex items-center justify-between cursor-pointer list-none px-3.5 py-2.5 select-none">
        <span><span className="text-xs font-bold text-slate-600 uppercase tracking-wider">{title}</span>{hint && <span className="ml-2 text-[11px] text-slate-400 normal-case">{hint}</span>}</span>
        <ChevronDown size={14} className="text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-3.5 pb-3.5 pt-1 space-y-3">{children}</div>
    </details>
  );
}

// Classification, units & packaging, stock levels, tax and storage/handling attributes of an item.
export default function ProductMasterFields({ form, set }: Props) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [suppliers, setSuppliers] = useState<{ id: number; name: string }[]>([]);
  const [profiles, setProfiles] = useState<{ id: number; name: string; regulation?: string }[]>([]);
  const [hclasses, setHclasses] = useState<{ id: number; code: string; name: string; is_active: boolean; requires_sds: boolean }[]>([]);
  useEffect(() => {
    api.inventory.quality.profiles().then(setProfiles).catch(() => {});
    api.inventory.hazmat.classes().then(r => setHclasses(r.classes)).catch(() => {});
    api.inventory.meta().then(setMeta).catch(() => {});
    api.suppliers.list().then((s: any[]) => setSuppliers(s.map(x => ({ id: x.id, name: x.name })))).catch(() => {});
  }, []);

  const uoms = meta?.uoms ?? ['pcs', 'kg', 'l', 'm', 'box'];
  const uomSelect = (field: keyof MasterForm, blank?: string) => (
    <select value={String(form[field] ?? '')} onChange={e => set(field, e.target.value)} className={input}>
      {blank !== undefined && <option value="">{blank}</option>}
      {uoms.map(u => <option key={u} value={u}>{u}</option>)}
    </select>
  );
  const num = (field: keyof MasterForm, props: { step?: string; min?: number; placeholder?: string } = {}) => (
    <input type="number" min={props.min ?? 0} step={props.step ?? '1'} value={String(form[field] ?? '')} placeholder={props.placeholder}
      onChange={e => set(field, e.target.value)} className={`${input} text-center`} />
  );
  const txt = (field: keyof MasterForm, max: number, placeholder?: string) => (
    <input value={String(form[field] ?? '')} maxLength={max} placeholder={placeholder} onChange={e => set(field, e.target.value)} className={input} />
  );
  const setConv = (i: number, patch: Partial<Conversion>) => set('conversions', form.conversions.map((c, n) => n === i ? { ...c, ...patch } : c));
  const minMaxBad = form.min_stock !== '' && form.max_stock !== '' && Number(form.min_stock) > Number(form.max_stock);

  return (
    <div className="space-y-2.5">
      <Section title="Classification" hint="type, source, status" open>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Item type</label>
            <select value={form.item_type} onChange={e => set('item_type', e.target.value)} className={input}>
              {(meta?.item_types ?? [{ value: 'finished_good', label: 'Finished goods' }]).map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>Status</label>
            <select value={form.status} onChange={e => set('status', e.target.value)} className={input}>
              {(meta?.statuses ?? ['active', 'inactive', 'discontinued']).map(s => <option key={s} value={s}>{cap(s)}</option>)}
            </select>
            {form.status !== 'active' && <p className="text-[11px] text-amber-600 mt-1">{form.status === 'inactive' ? 'Cannot be sold or purchased.' : 'Can be sold until stock runs out; cannot be purchased.'}</p>}
          </div>
          <div>
            <label className={label}>Manufacturer</label>
            {txt('manufacturer', 100)}
          </div>
          <div>
            <label className={label}>Preferred supplier</label>
            <select value={String(form.supplier_id ?? '')} onChange={e => set('supplier_id', e.target.value)} className={input}>
              <option value="">None</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
      </Section>

      <Section title="Units & packaging" hint="purchase / sales units, size, conversions">
        <div className="grid grid-cols-3 gap-3">
          <div><label className={label}>Base unit</label>{uomSelect('uom')}</div>
          <div><label className={label}>Purchase unit</label>{uomSelect('purchase_uom', 'Same as base')}</div>
          <div><label className={label}>Sales unit</label>{uomSelect('sales_uom', 'Same as base')}</div>
          <div><label className={label}>Pack size</label>{num('pack_size', { step: 'any', placeholder: 'units / pack' })}</div>
          <div><label className={label}>Weight (kg)</label>{num('weight_kg', { step: 'any' })}</div>
          <div><label className={label}>Volume (l)</label>{num('volume_l', { step: 'any' })}</div>
          <div><label className={label}>Length (cm)</label>{num('length_cm', { step: 'any' })}</div>
          <div><label className={label}>Width (cm)</label>{num('width_cm', { step: 'any' })}</div>
          <div><label className={label}>Height (cm)</label>{num('height_cm', { step: 'any' })}</div>
        </div>
        <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5 space-y-2">
          <p className="text-[11px] font-semibold text-slate-500">Unit conversions <span className="font-normal">— 1 of the unit = how many {form.uom || 'base units'}</span></p>
          {form.conversions.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-xs text-slate-500">1</span>
              <select value={c.uom} onChange={e => setConv(i, { uom: e.target.value })} className={`${input} !w-28`}>
                <option value="">Unit…</option>
                {uoms.filter(u => u !== form.uom).map(u => <option key={u} value={u}>{u}</option>)}
              </select>
              <span className="text-xs text-slate-500">=</span>
              <input type="number" min={0} step="any" value={c.factor} onChange={e => setConv(i, { factor: e.target.value })} className={`${input} !w-28 text-center`} />
              <span className="text-xs text-slate-500">{form.uom}</span>
              <button type="button" onClick={() => set('conversions', form.conversions.filter((_, n) => n !== i))} className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg"><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" onClick={() => set('conversions', [...form.conversions, { uom: '', factor: '' }])} className="flex items-center gap-1 text-xs font-medium text-teal-600 hover:underline"><Plus size={12} /> Add conversion</button>
        </div>
      </Section>

      <Section title="Stock levels" hint="minimum, maximum, reorder">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div><label className={label}>Minimum</label>{num('min_stock')}</div>
          <div><label className={label}>Fixed reorder point</label>{num('reorder_level')}</div>
          <div><label className={label}>Maximum</label>{num('max_stock')}</div>
          <div><label className={label}>Reorder qty</label>{num('reorder_qty', { placeholder: 'lot size' })}</div>
        </div>
        {minMaxBad && <p className="text-[11px] text-red-600">Minimum cannot be greater than maximum.</p>}
        <p className="text-[11px] text-slate-400">Reorder suggestions order up to the maximum, rounded up to the order multiple.</p>
      </Section>

      <Section title="Replenishment" hint="lead time, safety stock, supplier limits">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="col-span-2 sm:col-span-3">
            <label className={label}>Reorder point is</label>
            <select value={form.reorder_mode} onChange={e => set('reorder_mode', e.target.value)} className={input}>
              <option value="">Company default</option>
              <option value="auto">Calculated: demand during lead time + safety stock</option>
              <option value="manual">Fixed: use the reorder point above</option>
            </select>
          </div>
          <div><label className={label}>Safety stock</label>{num('safety_stock', { placeholder: 'auto' })}</div>
          <div><label className={label}>Lead time (days)</label>{num('lead_time_days', { placeholder: 'supplier' })}</div>
          <div><label className={label}>Min. order qty</label>{num('moq')}</div>
          <div><label className={label}>Order multiple</label>{num('order_multiple', { placeholder: 'pack size' })}</div>
          <div><label className={label}>Storage capacity</label>{num('capacity_units', { placeholder: 'units' })}</div>
        </div>
        <p className="text-[11px] text-slate-400">Leave blank to use the supplier lead time, an automatic safety stock from demand variability, and no supplier or storage limits.</p>
      </Section>

      <Section title="Tax" hint="classification and rate">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Tax classification</label>
            <select value={form.tax_class} onChange={e => set('tax_class', e.target.value)} className={input}>
              <option value="">Not set</option>
              {(meta?.tax_classes ?? ['standard', 'reduced', 'zero', 'exempt']).map(t => <option key={t} value={t}>{cap(t)}</option>)}
            </select>
          </div>
          <div><label className={label}>Tax rate (%)</label>{num('tax_rate', { step: 'any' })}</div>
        </div>
      </Section>

      <Section title="Quality & inspection" hint="expiry windows, inspections, regulation profile">
        <div>
          <label className={label}>Quality profile</label>
          <select value={String(form.quality_profile_id ?? '')} onChange={e => set('quality_profile_id', e.target.value)} className={input}>
            <option value="">None (category or company rules)</option>
            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}{p.regulation ? ` — ${p.regulation}` : ''}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div><label className={label}>Near-expiry alert (days)</label>{num('near_expiry_days', { placeholder: 'inherit' })}</div>
          <div><label className={label}>Inspect every (days)</label>{num('inspection_interval_days', { placeholder: 'inherit' })}</div>
          <div><label className={label}>Min. shelf life on receipt</label>{num('min_remaining_days', { placeholder: 'inherit' })}</div>
          <div>
            <label className={label}>Mfg date required</label>
            <select value={form.require_mfg_date} onChange={e => set('require_mfg_date', e.target.value)} className={input}>
              <option value="">Inherit</option><option value="yes">Yes</option><option value="no">No</option>
            </select>
          </div>
        </div>
        <p className="text-[11px] text-slate-400">Blank values inherit from the quality profile, then the category, then company rules. Inspection interval 0 turns inspections off. Batches received with less shelf life than the minimum are placed on hold. Expiry tracking itself is switched on per item under batch tracking, so items that never expire are not affected.</p>
      </Section>

      <Section title="Hazard & special handling" hint="hazard class, SDS, temperature range; leave blank for ordinary stock">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="col-span-2">
            <label className={label}>Hazard class</label>
            <select value={String(form.hazard_class_id ?? '')} onChange={e => set('hazard_class_id', e.target.value)} className={input}>
              <option value="">Not hazardous</option>
              {hclasses.filter(c => c.is_active || String(c.id) === String(form.hazard_class_id)).map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
            </select>
          </div>
          <div><label className={label}>UN number</label>{txt('un_number', 10, 'UN1203')}</div>
          <div>
            <label className={label}>Packing group</label>
            <select value={form.packing_group} onChange={e => set('packing_group', e.target.value)} className={input}><option value="">—</option><option>I</option><option>II</option><option>III</option></select>
          </div>
          <div><label className={label}>Flash point (°C)</label>{num('flash_point_c', { step: 'any', min: -273 })}</div>
          <div className="col-span-2"><label className={label}>Safety Data Sheet reference</label>{txt('sds_ref', 300, 'document no. or link')}</div>
          <div><label className={label}>SDS date</label><input type="date" value={form.sds_date} max={new Date().toISOString().slice(0, 10)} onChange={e => set('sds_date', e.target.value)} className={input} /></div>
          <div className="col-span-2"><label className={label}>Protective equipment (PPE)</label>{txt('ppe', 300, 'gloves, goggles')}</div>
          <div className="col-span-2"><label className={label}>Emergency information</label>{txt('emergency_info', 500, 'spill / fire / first aid contact')}</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><label className={label}>Store at least (°C)</label>{num('storage_temp_min_c', { step: 'any', min: -273, placeholder: 'any' })}</div>
          <div><label className={label}>Store at most (°C)</label>{num('storage_temp_max_c', { step: 'any', min: -273, placeholder: 'any' })}</div>
          <div><label className={label}>Inspect every (days)</label>{num('hazard_inspection_days', { placeholder: 'none' })}</div>
        </div>
        <p className="text-[11px] text-slate-400">Setting a hazard class or temperature range switches on special-handling rules for this item only: it may only be stored in locations approved for it, incompatible products are kept apart, and dispatch needs an SDS where the class requires one. Approve storage locations under Inventory › Hazmat.</p>
      </Section>

      <Section title="Storage, handling & safety" hint="shelf life, conditions">
        <div className="grid grid-cols-2 gap-3">
          <div><label className={label}>Shelf life (days)</label>{num('shelf_life_days')}</div>
          <div><label className={label}>Storage conditions</label>{txt('storage_conditions', 200, 'e.g. Cool, dry, below 25°C')}</div>
        </div>
        <div><label className={label}>Storage requirements</label>{txt('storage_requirements', 500)}</div>
        <div><label className={label}>Handling instructions</label>{txt('handling_instructions', 500)}</div>
        <div><label className={label}>Safety requirements</label>{txt('safety_requirements', 500)}</div>
      </Section>
    </div>
  );
}
