import { Field, Input } from './shared';
import { BUSINESS_TYPES, modulesFor, termsFor } from '../../lib/businessTypes';

interface Props {
  settings: Record<string, string>;
  onChange: (k: string, v: string) => void;
}

export default function CompanyTab({ settings, onChange }: Props) {
  const type = settings.business_type || 'general_store';
  const tyre = modulesFor(type).tyreFitment;
  const announceExample = termsFor(type).announceExample;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
      <div className="sm:col-span-2">
        <Field label="Business Type" help="Turns industry-specific sections on or off. Tyre Fitment Guide, By Vehicle lookup, Catalog Import and the Catalog Scraper are only available for Tyre & Wheel Shops.">
          <select
            value={type}
            onChange={e => onChange('business_type', e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
          >
            {BUSINESS_TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </Field>
        <p className="text-xs text-slate-400 mt-1.5">
          {tyre ? 'Tyre modules are enabled.' : 'Tyre-specific modules are hidden for this business type.'} Save to apply.
        </p>
      </div>
      <div className="sm:col-span-2">
        <Field label="Company Name" help="Appears on invoices, POs, and all printouts">
          <Input value={settings.company_name ?? ''} onChange={v => onChange('company_name', v)} placeholder="e.g. TuneGEN" />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Tagline" help="Short description shown below company name on documents">
          <Input value={settings.company_tagline ?? ''} onChange={v => onChange('company_tagline', v)} placeholder="e.g. Quality products, trusted service" />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Address" help="Full postal address printed on invoices and purchase orders">
          <textarea
            value={settings.company_address ?? ''}
            onChange={e => onChange('company_address', e.target.value)}
            placeholder="123 Industrial Zone, Lahore, Pakistan"
            rows={2}
            className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 resize-none"
          />
        </Field>
      </div>
      <Field label="Phone" help="Customer-facing phone number on documents">
        <Input value={settings.company_phone ?? ''} onChange={v => onChange('company_phone', v)} placeholder="+92-42-1234567" />
      </Field>
      <Field label="Email" help="Business email shown on invoices">
        <Input value={settings.company_email ?? ''} onChange={v => onChange('company_email', v)} placeholder="info@company.pk" type="email" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Announcement / News Banner" help="Shows a banner at the top of the app for all users. Leave blank to hide.">
          <textarea
            value={settings.announcement ?? ''}
            onChange={e => onChange('announcement', e.target.value)}
            placeholder={`e.g. Office closed on Friday · ${announceExample} · System maintenance tonight at 11 PM`}
            rows={2}
            className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50 resize-none"
          />
        </Field>
      </div>
    </div>
  );
}
