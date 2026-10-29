// Small request validator: declare the contract of an endpoint once, get a cleaned object or a ValidationError naming every bad field.
// Unknown properties are dropped, strings are trimmed, numbers are real numbers (not "12abc"), enums are exact.
//
//   const body = validate(req.body, {
//     name:  v.string({ min: 1, max: 80 }),
//     limit: v.number({ min: 0, optional: true, nullable: true }),
//     perms: v.array(v.string(), { max: 100 }),
//   });
const { ValidationError } = require('./errors');

const MISSING = Symbol('missing');
const rule = (type, check, opts = {}) => ({ type, check, opts });

const v = {
  string: (o = {}) => rule('string', (x, k) => {
    if (typeof x !== 'string') return [`${k} must be text`];
    const s = o.trim === false ? x : x.trim();
    if (o.min != null && s.length < o.min) return [`${k} is required`];
    if (o.max != null && s.length > o.max) return [`${k} must be at most ${o.max} characters`];
    if (o.pattern && !o.pattern.test(s)) return [`${k} has an invalid format`];
    return [null, s];
  }, o),
  number: (o = {}) => rule('number', (x, k) => {
    const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
    if (!Number.isFinite(n)) return [`${k} must be a number`];
    if (o.int && !Number.isInteger(n)) return [`${k} must be a whole number`];
    if (o.min != null && n < o.min) return [`${k} must be at least ${o.min}`];
    if (o.max != null && n > o.max) return [`${k} must be at most ${o.max}`];
    return [null, n];
  }, o),
  int: (o = {}) => v.number({ ...o, int: true }),
  bool: (o = {}) => rule('bool', (x, k) => (typeof x === 'boolean' ? [null, x] : [`${k} must be true or false`]), o),
  enum: (values, o = {}) => rule('enum', (x, k) => (values.includes(x) ? [null, x] : [`${k} must be one of: ${values.join(', ')}`]), o),
  object: (o = {}) => rule('object', (x, k) => (x && typeof x === 'object' && !Array.isArray(x) ? [null, x] : [`${k} must be an object`]), o),
  array: (item, o = {}) => rule('array', (x, k) => {
    if (!Array.isArray(x)) return [`${k} must be a list`];
    if (o.max != null && x.length > o.max) return [`${k} may hold at most ${o.max} entries`];
    if (o.min != null && x.length < o.min) return [`${k} needs at least ${o.min} entries`];
    const out = [], bad = [];
    x.forEach((el, i) => { const [e, val] = item.check(el, `${k}[${i}]`); if (e) bad.push(e); else out.push(val); });
    return bad.length ? [bad[0]] : [null, o.unique ? [...new Set(out)] : out];
  }, o),
};

/** Validate `input` against `schema`. Returns the cleaned object; throws ValidationError listing all problems. */
function validate(input, schema) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {}, fields = {};
  for (const [key, r] of Object.entries(schema)) {
    const raw = Object.prototype.hasOwnProperty.call(src, key) ? src[key] : MISSING;
    if (raw === MISSING || raw === undefined || (raw === '' && r.opts.emptyIsNull)) {
      if (raw === '' && r.opts.emptyIsNull && r.opts.nullable) { out[key] = null; continue; }
      if (r.opts.default !== undefined) { out[key] = r.opts.default; continue; }
      if (r.opts.optional) continue;
      fields[key] = `${key} is required`;
      continue;
    }
    if (raw === null) {
      if (r.opts.nullable) { out[key] = null; continue; }
      fields[key] = `${key} is required`;
      continue;
    }
    const [err, val] = r.check(raw, key);
    if (err) fields[key] = err; else out[key] = val;
  }
  if (Object.keys(fields).length) throw new ValidationError(Object.values(fields)[0], fields);
  return out;
}

module.exports = { v, validate };
