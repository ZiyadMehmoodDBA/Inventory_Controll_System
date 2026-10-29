import { Field, Input } from './shared';

interface Props {
  settings: Record<string, string>;
  onChange: (k: string, v: string) => void;
}

export default function DefaultsTab({ settings, onChange }: Props) {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Numbering Prefixes</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field label="Invoice Prefix" help="Prepended to invoice numbers — e.g. 'INV' → INV-2025-001">
            <Input
              value={settings.invoice_prefix ?? ''}
              onChange={v => onChange('invoice_prefix', v.toUpperCase())}
              placeholder="INV"
            />
          </Field>
          <Field label="Purchase Order Prefix" help="Prepended to PO numbers — e.g. 'PO' → PO-2025-001">
            <Input
              value={settings.po_prefix ?? ''}
              onChange={v => onChange('po_prefix', v.toUpperCase())}
              placeholder="PO"
            />
          </Field>
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Financial Defaults</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <Field label="Default Tax Rate (%)" help="Applied automatically to new sales invoices">
            <Input type="number" value={settings.default_tax_rate ?? ''} onChange={v => onChange('default_tax_rate', v)} placeholder="15" />
          </Field>
          <Field label="Payment Due (days)" help="Payment terms printed at the bottom of invoices">
            <Input type="number" value={settings.payment_due_days ?? ''} onChange={v => onChange('payment_due_days', v)} placeholder="30" />
          </Field>
          <Field label="Currency Code" help="3-letter ISO code shown on all amounts">
            <Input value={settings.currency ?? ''} onChange={v => onChange('currency', v.toUpperCase())} placeholder="PKR" />
          </Field>
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Sale Defaults</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field label="Default Sale Status" help="Status pre-selected when creating a new invoice">
            <select
              value={settings.default_sale_status ?? 'pending'}
              onChange={e => onChange('default_sale_status', e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
            >
              <option value="pending">Pending</option>
              <option value="paid">Paid</option>
              <option value="overdue">Overdue</option>
            </select>
          </Field>
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Auto-Refresh</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <Field
            label="Auto-Refresh Interval (seconds)"
            help="How often all data pages refresh automatically. Set to 0 to disable. Restart any open page after saving."
          >
            <select
              value={settings.refresh_interval ?? '60'}
              onChange={e => onChange('refresh_interval', e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500 bg-slate-50"
            >
              <option value="0">Disabled</option>
              <option value="30">30 seconds</option>
              <option value="60">1 minute</option>
              <option value="120">2 minutes</option>
              <option value="300">5 minutes</option>
              <option value="600">10 minutes</option>
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}
