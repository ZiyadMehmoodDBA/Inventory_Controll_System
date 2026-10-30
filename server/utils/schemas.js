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

module.exports = {
  SALE_BODY, PURCHASE_BODY, STATUS_BODY, PO_STATUS_BODY, SALE_PAYMENT_BODY, PURCHASE_PAYMENT_BODY,
  BULK_INVOICE, BULK_PO, BULK_LIST,
};
