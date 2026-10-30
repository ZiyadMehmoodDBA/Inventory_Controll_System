'use strict';
// Raw page data -> a standard catalogue record, using only the profile (profiles.js) for what to look for. Pure functions, no I/O.
const { CORE } = require('./profiles');

const text = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const lower = s => text(s).toLowerCase();
const labelKey = s => lower(s).replace(/[^a-z0-9]+/g, ' ').trim();

// ── small value parsers ──
function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null;
  const m = String(v).replace(/ /g, ' ').match(/\d[\d,]*(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n * 100) / 100 : null;
}
function currencyOf(v, hint) {
  const s = `${v ?? ''} ${hint ?? ''}`;
  if (/\b(PKR)\b|\brs\.?\b|₨/i.test(s)) return 'PKR';
  if (/\bUSD\b|\$/.test(s)) return 'USD';
  if (/\bEUR\b|€/.test(s)) return 'EUR';
  if (/\bGBP\b|£/.test(s)) return 'GBP';
  if (/\bAED\b/.test(s)) return 'AED';
  if (/\bSAR\b/.test(s)) return 'SAR';
  return text(hint).slice(0, 3).toUpperCase();
}
/** A GTIN is 8, 12, 13 or 14 digits with a valid check digit. Anything else is dropped rather than imported as a barcode. */
function gtin(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(d.length)) return null;
  const digits = d.split('').map(Number), check = digits.pop();
  const sum = digits.reverse().reduce((s, x, i) => s + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check ? d : null;
}
const UNIT_MAP = { ml: 'ml', l: 'l', ltr: 'l', litre: 'l', liter: 'l', litres: 'l', liters: 'l', g: 'g', gm: 'g', gram: 'g', grams: 'g', kg: 'kg', kgs: 'kg', oz: 'oz', lb: 'lb', lbs: 'lb', pcs: 'pcs', pc: 'pcs', pieces: 'pcs', piece: 'pcs', pack: 'pack', dozen: 'dozen' };
function packOf(s) {
  const m = String(s ?? '').match(/(\d+(?:\.\d+)?)\s?(ml|ltrs?|litres?|liters?|l|kgs?|grams?|gm|g|oz|lbs?|pcs|pc|pieces?|pack|dozen)\b/i);
  return m ? { pack_size: `${Number(m[1])} ${UNIT_MAP[m[2].toLowerCase()] || m[2].toLowerCase()}`, unit: UNIT_MAP[m[2].toLowerCase()] || null } : null;
}
function tidyName(n) {
  let s = text(n).replace(/\s*[|–—]\s*[^|–—]{2,40}$/, m => (/\b(shop|store|mart|online|pakistan|official)\b/i.test(m) ? '' : m));
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length > 6 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) s = s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
  return s.slice(0, 200);
}
function tidyBrand(b) {
  const s = text(b).slice(0, 80);
  if (!s) return '';
  if (s.length <= 3 && s === s.toUpperCase()) return s;                       // BMW, LG, HP, TVS
  return s === s.toUpperCase() || s === s.toLowerCase() ? s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()) : s;
}

// ── attribute extractors: field key -> (text) => value | undefined ──
const SPEED = 'JKLMNPQRSTUHVWYZ';
const tyreSize = t => { const m = t.match(new RegExp(`\\b(\\d{3})\\s*/\\s*(\\d{2,3})\\s*(?:Z?R|ZR|-)\\s*(\\d{2})(?:\\s*(\\d{2,3})(?:/\\d{2,3})?\\s?([${SPEED}])\\b)?`, 'i')); return m && { width: m[1], aspect_ratio: m[2], rim_diameter: m[3], load_index: m[4], speed_rating: m[5] && m[5].toUpperCase() }; };
const COLORS = 'black|white|red|blue|green|yellow|orange|purple|pink|brown|grey|gray|silver|gold|beige|navy|maroon|cyan|titanium|graphite|midnight|starlight';
const MATERIALS = 'stainless steel|steel|aluminium|aluminum|cotton|polyester|leather|wool|silk|linen|denim|nylon|brass|copper|pvc|plastic|wood|rubber|ceramic|glass|viscose|lawn|chiffon';
const pick = (re, t, f = m => m[1] || m[0]) => { const m = t.match(re); return m ? text(f(m)) : undefined; };
const cap = s => s && s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const EXTRACT = {
  width: t => tyreSize(t)?.width, aspect_ratio: t => tyreSize(t)?.aspect_ratio, rim_diameter: t => tyreSize(t)?.rim_diameter,
  load_index: t => tyreSize(t)?.load_index, speed_rating: t => tyreSize(t)?.speed_rating,
  season: t => { const s = pick(/\b(all[- ]?season|summer|winter)\b/i, t); return s && (/all/i.test(s) ? 'All-season' : cap(s)); },
  construction: t => cap(pick(/\b(radial|bias|cross[- ]?ply)\b/i, t)),
  run_flat: t => (/run[- ]?flat|\b(RFT|ROF)\b/i.test(t) ? 'Yes' : undefined),
  tube_type: t => { const s = pick(/\b(tubeless|tube[- ]?type)\b/i, t); return s && (/less/i.test(s) ? 'Tubeless' : 'Tube type'); },
  vehicle_year: t => pick(/\b((?:19|20)\d{2})(?:\s?[-–]\s?(?:19|20)?\d{2})?\b/, t, m => m[0]),
  engine_capacity: t => pick(/\b(\d\.\d)\s?(?:L|ltr|litre)\b|\b(\d{3,4})\s?cc\b/i, t, m => (m[1] ? `${m[1]} L` : `${m[2]} cc`)),
  storage_capacity: t => { const all = [...t.matchAll(/\b(\d{1,4})\s?(GB|TB)\b/gi)].map(m => ({ v: Number(m[1]) * (/tb/i.test(m[2]) ? 1024 : 1), s: `${m[1]} ${m[2].toUpperCase()}` })); return all.length ? all.sort((a, b) => b.v - a.v)[0].s : undefined; },
  warranty: t => pick(/(\d+)[- ]?(year|yr|month)s?\s+(?:limited\s+|brand\s+|official\s+)?warranty|warranty[: ]+(\d+\s?(?:year|month)s?)/i, t, m => (m[3] || `${m[1]} ${/yr|year/i.test(m[2]) ? 'year' : 'month'}${m[1] === '1' ? '' : 's'}`)),
  color: t => cap(pick(new RegExp(`\\b(${COLORS})\\b`, 'i'), t)),
  material: t => cap(pick(new RegExp(`\\b(${MATERIALS})\\b`, 'i'), t)),
  material_type: t => cap(pick(new RegExp(`\\b(${MATERIALS}|cement|concrete|timber|pvc|gi|hdpe)\\b`, 'i'), t)),
  gender: t => { const s = pick(/\b(men|women|boys|girls|kids|unisex|ladies|gents)\b/i, t); return s && ({ ladies: 'Women', gents: 'Men' }[s.toLowerCase()] || cap(s)); },
  size: t => pick(/\b(XXS|XS|XL|XXL|3XL|4XL)\b|\bsize[: ]+(S|M|L)\b/, t, m => m[1] || m[2]),
  pattern: t => cap(pick(/\b(striped|checked|plaid|floral|solid|printed|polka)\b/i, t)),
  strength: t => pick(/\b(\d+(?:\.\d+)?\s?(?:mg|mcg|iu|%)|\d+(?:\.\d+)?\s?g\b(?=\s*\/))/i, t),
  dosage_form: t => cap(pick(/\b(tablets?|capsules?|syrup|suspension|injection|ointment|cream|gel|drops|inhaler|sachet)\b/i, t)),
  volume: t => pick(/\b(\d+(?:\.\d+)?)\s?(ml|oz|fl\.? ?oz)\b/i, t, m => `${m[1]} ${m[2].toLowerCase()}`),
  fragrance_family: t => cap(pick(/\b(floral|woody|oriental|fresh|citrus|musk|aquatic|oud|amber|spicy)\b/i, t)),
  dimensions: t => pick(/\b\d+(?:\.\d+)?\s?(?:x|×)\s?\d+(?:\.\d+)?(?:\s?(?:x|×)\s?\d+(?:\.\d+)?)?\s?(?:mm|cm|m|in|inch|ft)?\b/i, t, m => m[0]),
  weight: t => pick(/\b(\d+(?:\.\d+)?)\s?(kg|kgs|g|gm|lb|lbs)\b/i, t, m => `${m[1]} ${UNIT_MAP[m[2].toLowerCase()] || m[2].toLowerCase()}`),
  grade: t => pick(/\bgrade\s?([A-Za-z0-9]+)\b/i, t, m => m[1].toUpperCase()),
  carton_quantity: t => pick(/\b(\d+)\s?(?:pcs|pieces|units)?\s?(?:per|\/)\s?(?:carton|case|box)\b/i, t),
};

/** { normalised label: value } -> value for a profile field, matching on key, label or any alias. */
function fromSpecs(specs, field) {
  const names = [field.key.replace(/_/g, ' '), field.label, ...(field.aliases || [])].map(labelKey);
  for (const [k, v] of Object.entries(specs || {})) {
    const lk = labelKey(k);
    if (names.some(n => lk === n || lk.startsWith(n + ' '))) return text(v);
  }
  return undefined;
}

/**
 * raw: one candidate from extract.js, profile: profiles.effective(), job: { category, keywords }.
 * Returns a normalised record: core columns + attributes (profile fields that are not core columns).
 */
function normalize(raw, profile, job = {}) {
  const specs = raw.specs || {};
  const blob = [raw.name, raw.description, raw.snippet, raw.category, ...Object.values(specs)].filter(Boolean).join(' . ');
  const rec = { attributes: {} };

  rec.name = tidyName(raw.name);
  rec.brand = tidyBrand(raw.brand || fromSpecs(specs, { key: 'brand', label: 'Brand', aliases: ['make', 'manufacturer', 'brand name'] }));
  const rawBrand = text(raw.brand);
  if (rawBrand && rec.brand && rec.name.toLowerCase().startsWith(rawBrand.toLowerCase()) && !rec.name.startsWith(rec.brand)) rec.name = rec.brand + rec.name.slice(rawBrand.length);
  rec.sku = text(raw.sku || fromSpecs(specs, { key: 'sku', label: 'SKU', aliases: ['sku', 'part number', 'part no', 'item number', 'model number', 'article number'] }) || raw.mpn).slice(0, 60) || null;
  const oem = fromSpecs(specs, { key: 'oem', label: 'OEM number', aliases: ['oem', 'oem number', 'oe number', 'cross reference'] });
  rec.oem = text(oem || (raw.mpn && raw.mpn !== rec.sku ? raw.mpn : '')).slice(0, 60) || null;
  const code = gtin(raw.barcode || fromSpecs(specs, { key: 'barcode', label: 'GTIN', aliases: ['gtin', 'ean', 'upc', 'barcode', 'isbn'] }));
  rec.barcode = code;
  const issues = [];
  if ((raw.barcode || '').toString().replace(/\D/g, '') && !code) issues.push('barcode ignored (not a valid GTIN)');

  const priceSrc = raw.price ?? raw.price_text;
  rec.price = parsePrice(priceSrc);
  rec.currency = currencyOf(raw.price_text, raw.currency) || null;
  rec.wholesale_price = parsePrice(fromSpecs(specs, { key: 'wholesale_price', label: 'Wholesale price', aliases: ['trade price', 'dealer price'] }));
  rec.image_url = raw.image_url && /^https?:\/\//i.test(raw.image_url) ? String(raw.image_url).slice(0, 500) : null;
  rec.description = text(raw.description).slice(0, 1500) || null;

  const pk = packOf(fromSpecs(specs, { key: 'pack_size', label: 'Package size', aliases: ['size', 'pack size', 'net weight', 'net quantity', 'volume', 'net content'] })) || packOf(rec.name);
  rec.pack_size = pk ? pk.pack_size : null;
  rec.unit = (pk && pk.unit) || (UNIT_MAP[lower(fromSpecs(specs, { key: 'unit', label: 'Unit', aliases: ['unit of measure', 'uom'] }))] || null);

  // profile attributes: direct from structured data, then spec tables, then patterns in the text
  for (const fld of profile.fields) {
    if (CORE.includes(fld.key)) continue;
    let val = raw[fld.key];
    if (typeof val === 'object') val = undefined;
    val = text(val) || fromSpecs(specs, fld) || (EXTRACT[fld.key] ? EXTRACT[fld.key](blob) : undefined);
    if (val) rec.attributes[fld.key] = String(val).slice(0, 300);
  }
  if (profile.fields.some(x => x.key === 'specifications')) {
    const s = Object.entries(specs).slice(0, 14).map(([k, v]) => `${k}: ${v}`).join('; ');
    if (s) rec.attributes.specifications = s.slice(0, 1200);
  }
  if (profile.fields.some(x => x.key === 'availability') && raw.availability) rec.attributes.availability = text(raw.availability).replace(/([a-z])([A-Z])/g, '$1 $2');
  if (profile.fields.some(x => x.key === 'compatibility') && !rec.attributes.compatibility) {
    const c = text(specs.Fitment || specs.Compatibility || specs['Compatible with'] || specs.Fits || specs['Vehicle compatibility'] || '');
    if (c) rec.attributes.compatibility = c.slice(0, 300);
  }

  // tyres: brand/model/size are the identity; compose a name when the page gave none
  if (profile.id === 'tyre_shop') {
    const a = rec.attributes;
    if (!a.model) { const m = rec.name.replace(new RegExp(rec.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').replace(/\b\d{3}\s*\/\s*\d{2,3}\s*(?:Z?R|-)\s*\d{2}.*$/i, '').trim(); if (m) a.model = m; }
    if (!rec.name && rec.brand && a.model) rec.name = [rec.brand, a.model].join(' ');
    if (a.width && a.aspect_ratio && a.rim_diameter) rec.pack_size = `${a.width}/${a.aspect_ratio}R${a.rim_diameter}`;
  }

  // category: the profile's own list first (so every business gets its own tidy categories), then what the page says
  const crumbs = (raw.crumbs || []).map(text).filter(Boolean);
  const catText = lower([raw.category, ...crumbs, rec.name].join(' '));
  const hit = profile.categories.find(c => lower(c.name) === lower(raw.category) || c.match.some(w => catText.includes(w.toLowerCase())));
  rec.category = hit ? hit.name : (text(raw.category) || crumbs[0] || text(job.category) || null);
  const sub = crumbs.length > 1 ? crumbs[crumbs.length - 1] : (hit && raw.category && lower(raw.category) !== lower(hit.name) ? text(raw.category) : null);
  rec.subcategory = sub && lower(sub) !== lower(rec.category) ? sub.slice(0, 100) : null;
  if (rec.category) rec.category = String(rec.category).slice(0, 100);

  // keywords narrow what is kept: when given, a product must mention at least one
  const kws = (job.keywords || []).map(lower).filter(Boolean);
  rec.matches_keywords = !kws.length || kws.some(k => lower(blob + ' ' + rec.name).includes(k));

  if (!rec.name) issues.push('no product name');
  if (rec.price === null) issues.push('no price found');
  rec.issues = issues;
  return rec;
}

/** Which required profile fields a record lacks (names shown to the user). */
function missingRequired(rec, profile) {
  const out = [];
  for (const f of profile.fields) {
    if (!f.required) continue;
    const v = CORE.includes(f.key) ? rec[f.key] : rec.attributes?.[f.key];
    if (v === null || v === undefined || String(v).trim() === '') out.push(f.label);
  }
  return out;
}

// ── identity for duplicate detection ──
const tokens = s => [...new Set(labelKey(String(s).replace(/(\d)\s+([a-z]{1,3})\b/gi, '$1$2')).split(' ').filter(Boolean))].sort();
const identity = (...parts) => { const t = tokens(parts.join(' ')); return t.length >= 2 ? t.join(' ') : null; };

module.exports = { normalize, missingRequired, parsePrice, gtin, packOf, tidyName, tidyBrand, identity, labelKey, EXTRACT, tyreSize };
