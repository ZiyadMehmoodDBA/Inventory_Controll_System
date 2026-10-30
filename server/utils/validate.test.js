const test = require('node:test');
const assert = require('node:assert');
const { v, validate } = require('./validate');
const { ValidationError } = require('./errors');

const LINE = { qty: v.int({ min: 1 }), price: v.number({ min: 0 }) };

test('shape validates a nested object and names the path of the first problem', () => {
  const schema = { lines: v.array(v.shape(LINE), { min: 1 }) };
  assert.deepStrictEqual(validate({ lines: [{ qty: '2', price: 1.5, junk: 1 }] }, schema), { lines: [{ qty: 2, price: 1.5 }] });
  assert.throws(() => validate({ lines: [{ qty: 1, price: 1 }, { qty: 0, price: 1 }] }, schema), e => e instanceof ValidationError && /lines\[1\]: qty must be at least 1/.test(e.message));
  assert.throws(() => validate({ lines: [{ qty: 1, price: -1 }] }, schema), e => e.details.fields.lines && /price/.test(e.details.fields.lines));
  assert.throws(() => validate({ lines: ['x'] }, schema), e => /must be an object/.test(e.details.fields.lines));
  assert.throws(() => validate({ lines: [] }, schema), e => /at least 1/.test(e.details.fields.lines));
});

test('custom runs the supplied check', () => {
  const schema = { s: v.custom((x, k) => (typeof x === 'string' || Array.isArray(x) ? [null, x] : [`${k} must be a list or text`]), { optional: true }) };
  assert.deepStrictEqual(validate({ s: 'a,b' }, schema), { s: 'a,b' });
  assert.deepStrictEqual(validate({}, schema), {});
  assert.throws(() => validate({ s: 5 }, schema), ValidationError);
});

test('numbers must be real numbers, not text with digits in it', () => {
  assert.throws(() => validate({ n: '12abc' }, { n: v.number() }), ValidationError);
  assert.throws(() => validate({ n: NaN }, { n: v.number() }), ValidationError);
  assert.throws(() => validate({ n: Infinity }, { n: v.number() }), ValidationError);
  assert.strictEqual(validate({ n: ' 7 ' }, { n: v.number() }).n, 7);
});

test('empty string becomes null for optional ids; null refused where required', () => {
  const schema = { id: v.int({ min: 1, optional: true, nullable: true, emptyIsNull: true }), req: v.int({ min: 1 }) };
  assert.deepStrictEqual(validate({ id: '', req: 1 }, schema), { id: null, req: 1 });
  assert.throws(() => validate({ id: 1, req: null }, schema), e => e.details.fields.req === 'req is required');
});

test('the money schemas refuse what would corrupt a document', () => {
  const S = require('./schemas');
  const base = { items: [{ tire_id: 1, qty: 1, unit_price: 5 }] };
  assert.ok(validate(base, S.SALE_BODY).items.length === 1);
  for (const bad of [{ qty: 0 }, { qty: -1 }, { qty: 1.2 }, { unit_price: -1 }, { unit_price: 1e12 }, { discount: 101 }])
    assert.throws(() => validate({ items: [{ tire_id: 1, qty: 1, unit_price: 5, ...bad }] }, S.SALE_BODY), ValidationError, JSON.stringify(bad));
  assert.throws(() => validate({ ...base, status: 'voided' }, S.SALE_BODY), ValidationError);
  assert.throws(() => validate({ amount: 0, sale_id: 1 }, S.SALE_PAYMENT_BODY), ValidationError);
  assert.strictEqual(validate({ amount: '12.5', sale_id: 1 }, S.SALE_PAYMENT_BODY).payment_method, 'cash');
});
