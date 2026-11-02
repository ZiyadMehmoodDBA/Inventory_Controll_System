// Request contracts shared by the money-moving routes (sales, purchases, payments). Declared once so every endpoint
// that accepts a document line or an amount enforces the same limits. See utils/validate.js for the rule kinds.
const { v } = require('./validate');

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?$/;
const MAX_MONEY = 1e9;        // far above any real document, far below what DECIMAL(18,2) or a double mishandles
const MAX_QTY = 1e6;

const date = (o = {}) => v.string({ pattern: DATE_RE, max: 30, ...o });
const optDate = () => date({ optional: true, nullable: true, emptyIsNull: true });
const id = (o = {}) => v.int({ min: 1, optional: true, nullable: true, emptyIsNull: true, ...o });
const money = (o = {}) => v.number({ min: 0, max: MAX_MONEY, ...o });
const text = (max, o = {}) => v.string({ max, trim: false, optional: true, nullable: true, ...o });
// Serial numbers arrive as a list or as one comma / newline separated string (Excel imports).
const serials = () => v.custom((x, k) => (Array.isArray(x) || typeof x === 'string') && JSON.stringify(x).length <= 200000 ? [null, x] : [`${k} must be a list or text`], { optional: true, nullable: true });

const SALE_STATUS = ['pending', 'partial', 'paid', 'overdue'];
const PO_STATUS = ['pending', 'received'];

const SALE_LINE = {
  tire_id: id(), product_id: id(),
  tire_name: text(255), item_name: text(255),
  qty: v.int({ min: 1, max: MAX_QTY }),
  unit_price: money(),
  discount: v.number({ min: 0, max: 100, optional: true, nullable: true }),
  batch_id: id(), reservation_id: id(), serials: serials(),
};

const PURCHASE_LINE = {
  tire_id: id(), product_id: id(),
  tire_name: text(255), item_name: text(255),
  qty: v.int({ min: 1, max: MAX_QTY }),
  unit_price: money(),
  batch_no: text(60, { emptyIsNull: true }), expiry_date: optDate(), mfg_date: optDate(), received_date: optDate(), serials: serials(),
};

const SALE_BODY = {
  customer_id: id(),
  date: date({ optional: true }),
  items: v.array(v.shape(SALE_LINE), { min: 1, max: 500 }),
  tax_rate: v.number({ min: 0, max: 100, default: 15 }),
  discount: money({ default: 0 }),
  status: v.enum(SALE_STATUS, { default: 'pending' }),
  notes: text(1000),
  payment_method: v.string({ max: 30, optional: true, nullable: true, emptyIsNull: true }),
  amount_paid: money({ default: 0 }),
  cash_given: money({ optional: true, nullable: true }),
  cash_amount: money({ optional: true, nullable: true }),
  card_amount: money({ optional: true, nullable: true }),
  location_id: id(),
};

const PURCHASE_BODY = {
  supplier_id: v.int({ min: 1 }),
  date: date({ optional: true }),
  items: v.array(v.shape(PURCHASE_LINE), { min: 1, max: 500 }),
  status: v.enum(PO_STATUS, { default: 'pending' }),
  notes: text(1000),
  expected_date: optDate(),
  location_id: id(),
};

const STATUS_BODY = { status: v.enum(SALE_STATUS) };
const PO_STATUS_BODY = { status: v.enum([...PO_STATUS, 'cancelled']) };

const PAYMENT_COMMON = {
  amount: v.number({ min: 0.01, max: MAX_MONEY }),
  payment_date: date({ optional: true, nullable: true, emptyIsNull: true }),
  payment_method: v.string({ min: 1, max: 30, default: 'cash' }),
  reference_no: v.string({ max: 100, default: '' }),
  notes: v.string({ max: 500, default: '' }),
};
const SALE_PAYMENT_BODY = { sale_id: v.int({ min: 1 }), ...PAYMENT_COMMON };
const PURCHASE_PAYMENT_BODY = { purchase_id: v.int({ min: 1 }), ...PAYMENT_COMMON };

// Excel imports: one row per document, lines named rather than identified. Each document is validated on its own so one bad row never blocks the rest.
const BULK_LINE = {
  item_name: v.string({ min: 1, max: 255 }),
  qty: v.int({ min: 1, max: MAX_QTY }),
  unit_price: money({ default: 0 }),
  batch_no: text(60, { emptyIsNull: true }), expiry_date: optDate(), mfg_date: optDate(), serials: serials(),
};
const BULK_INVOICE = {
  customer_name: v.string({ min: 1, max: 255 }),
  invoice_ref: text(100),
  date: date({ optional: true, nullable: true, emptyIsNull: true }),
  status: v.enum(SALE_STATUS, { default: 'pending' }),
  notes: text(1000),
  tax_rate: v.number({ min: 0, max: 100, default: 0 }),
  items: v.array(v.shape(BULK_LINE), { min: 1, max: 500 }),
};
const BULK_PO = {
  supplier_name: v.string({ min: 1, max: 255 }),
  po_ref: text(100),
  date: date({ optional: true, nullable: true, emptyIsNull: true }),
  status: v.enum(PO_STATUS, { default: 'pending' }),
  notes: text(1000),
  items: v.array(v.shape(BULK_LINE), { min: 1, max: 500 }),
};
const BULK_LIST = (max = 1000) => v.array(v.object(), { min: 1, max });


// ── Stock movements: adjustments and transfers (2026-10-30) ──
// An id from a form may arrive as a number, a numeric string, or empty; an empty value means "not given".
const optId = v.custom((x, k) => (x === null || x === undefined || x === '' ? [null, null] : Number.isInteger(Number(x)) && Number(x) >= 1 ? [null, Number(x)] : [`${k} must be a positive whole number`]), { optional: true, nullable: true });
const optText = max => v.string({ max, optional: true, nullable: true });
const QTY = v.number({ int: true, min: 1, max: 1000000 });

const ADJUSTMENT_BODY = {
  tire_id: v.int({ min: 1 }),
  qty_change: v.number({ int: true, min: -1000000, max: 1000000 }),
  reason_code: v.string({ min: 1, max: 30 }),
  notes: optText(500), location_id: optId, batch_id: optId, batch_no: optText(60), expiry_date: optDate(),
};
const DECISION_BODY = { note: optText(300) };
const TRANSFER_BODY = {
  from_location_id: v.int({ min: 1 }), to_location_id: v.int({ min: 1 }),
  items: v.array(v.shape({ tire_id: v.int({ min: 1 }), qty: QTY }), { min: 1, max: 200 }),
  notes: optText(500), in_transit: v.bool({ optional: true, nullable: true }), expected_at: optDate(), carrier: optText(100), reference: optText(100),
};
const TRANSFER_RECEIVE_BODY = {
  lines: v.array(v.shape({ tire_id: v.int({ min: 1 }), qty_received: v.number({ int: true, min: 0, max: 1000000 }) }), { max: 200, optional: true, nullable: true }),
  short_action: v.enum(['return', 'write_off'], { optional: true, nullable: true }), note: optText(300),
};
const TRANSFER_CANCEL_BODY = { note: optText(300) };

// ── Master data: customers, suppliers, services (2026-10-30). Limits mirror the column sizes. ──
const mtext = (max, o = {}) => v.string({ max, optional: true, nullable: true, ...o });
const mmoney = v.number({ min: 0, max: 1e9, optional: true, nullable: true, emptyIsNull: true });
const PARTY = { name: v.string({ min: 1, max: 100 }), phone: mtext(50), email: mtext(100), address: mtext(200) };
const CUSTOMER_BODY = {
  ...PARTY, balance: v.number({ min: -1e9, max: 1e9, optional: true, nullable: true, emptyIsNull: true }),
  vehicle_plate: mtext(20), vehicle_make: mtext(50), vehicle_model: mtext(50), vehicle_year: v.int({ min: 1900, max: 2100, optional: true, nullable: true, emptyIsNull: true }),
};
const SUPPLIER_BODY = { ...PARTY, balance: v.number({ min: -1e9, max: 1e9, optional: true, nullable: true, emptyIsNull: true }) };
const SERVICE_BODY = {
  code: mtext(50), name: v.string({ min: 1, max: 200 }), description: mtext(500), category: mtext(100), unit: mtext(50),
  cost_price: mmoney, sale_price: mmoney, is_active: v.bool({ optional: true, nullable: true }),
};

// Item master (inventory POST/PUT). Free-form extras (tracking, conversions, supplier, etc.) are read from the raw body by their own parsers.
const ITEM_BODY = {
  brand: mtext(100), model: mtext(100), size: mtext(50), type: mtext(50),
  stock: v.number({ min: 0, max: 1e7, optional: true, nullable: true, emptyIsNull: true }),
  cost_price: mmoney, sale_price: mmoney,
  reorder_level: v.int({ min: 0, max: 1e7, optional: true, nullable: true, emptyIsNull: true }),
  pattern: mtext(50), load_index: mtext(50), speed_index: mtext(50), dot: mtext(50),
};

// Organisation profile and defaults (POST /settings). Policy keys (valuation, negative stock, approvals, rotation...) have their own
// permissioned routes and are deliberately NOT writable here, even though GET returns them and the form posts the whole map back.
const scalar = (max, o = {}) => v.custom((x, k) => {
  if (!['string', 'number', 'boolean'].includes(typeof x)) return [`${k} must be text or a number`];
  const s = String(x).trim();
  if (s.length > max) return [`${k} must be at most ${max} characters`];
  if (o.pattern && s && !o.pattern.test(s)) return [o.msg || `${k} has an invalid format`];
  return [null, s];
}, { optional: true, nullable: true });
const SETTINGS_BODY = {
  company_name: scalar(100), company_tagline: scalar(200), company_address: scalar(300), company_phone: scalar(50), company_email: scalar(120),
  announcement: scalar(500), currency: scalar(3, { pattern: /^[A-Za-z]{3}$/, msg: 'currency must be a 3-letter code' }),
  invoice_prefix: scalar(10, { pattern: /^[A-Za-z0-9-]+$/ }), po_prefix: scalar(10, { pattern: /^[A-Za-z0-9-]+$/ }),
  default_tax_rate: scalar(6, { pattern: /^\d{1,3}(\.\d{1,2})?$/, msg: 'default_tax_rate must be a number from 0 to 100' }),
  payment_due_days: scalar(3, { pattern: /^\d{1,3}$/, msg: 'payment_due_days must be a whole number of days' }),
  default_sale_status: scalar(20, { pattern: /^[a-z_]+$/ }), refresh_interval: scalar(6, { pattern: /^\d{1,6}$/ }),
  business_type: scalar(40, { pattern: /^[a-z_]+$/ }),
};

module.exports = { SETTINGS_BODY, ITEM_BODY, CUSTOMER_BODY, SUPPLIER_BODY, SERVICE_BODY, ADJUSTMENT_BODY, DECISION_BODY, TRANSFER_BODY, TRANSFER_RECEIVE_BODY, TRANSFER_CANCEL_BODY,
  SALE_BODY, PURCHASE_BODY, STATUS_BODY, PO_STATUS_BODY, SALE_PAYMENT_BODY, PURCHASE_PAYMENT_BODY,
  BULK_INVOICE, BULK_PO, BULK_LIST,
};
