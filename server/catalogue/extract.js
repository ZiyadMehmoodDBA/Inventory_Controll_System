'use strict';
// Turns a fetched web page into raw product candidates. Structured data first (JSON-LD, schema.org microdata, Open Graph product meta),
// then HTML: spec tables and product cards. No industry knowledge here: see profiles.js and normalize.js. Output records are "raw": strings as found.
const cheerio = require('cheerio');

const text = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const first = v => (Array.isArray(v) ? v[0] : v);
const abs = (href, base) => { try { const u = new URL(href, base); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } };
const PRICE_RE = /(?:rs\.?|pkr|usd|\$|€|£|aed|sar)?\s?\d[\d,]*(?:\.\d{1,2})?/i;

// ── JSON-LD ──
function jsonLdNodes($) {
  const out = [];
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    out.push(n);
    if (n['@graph']) walk(n['@graph']);
    if (n.itemListElement) walk(n.itemListElement);
    if (n.item && typeof n.item === 'object') walk(n.item);
    if (n.mainEntity) walk(n.mainEntity);
  };
  $('script[type="application/ld+json"]').each((_, el) => { try { walk(JSON.parse($(el).contents().text().trim())); } catch { /* malformed block: skip it */ } });
  return out;
}
const typeOf = n => [].concat(n['@type'] || []).map(String);
const isType = (n, t) => typeOf(n).some(x => x === t || x.endsWith('/' + t));

function nodeText(v) { const x = first(v); return typeof x === 'object' && x ? text(x.name ?? x['@id'] ?? '') : text(x); }
function imageOf(v, base) { const x = first(v); const s = typeof x === 'object' && x ? (x.url || x.contentUrl) : x; return s ? abs(String(s), base) : null; }

function fromProductNode(n, base) {
  let offers = n.offers; offers = Array.isArray(offers) ? offers : (offers ? [offers] : []);
  if (offers[0] && offers[0].offers) offers = [].concat(offers[0].offers);
  const o = offers[0] || {};
  const specs = {};
  for (const p of [].concat(n.additionalProperty || [])) if (p && p.name) specs[text(p.name)] = text(first(p.value));
  const rec = {
    name: nodeText(n.name), brand: nodeText(n.brand), sku: text(n.sku), mpn: text(n.mpn),
    barcode: text(n.gtin || n.gtin13 || n.gtin12 || n.gtin14 || n.gtin8), description: text(n.description).slice(0, 1500),
    image_url: imageOf(n.image, base), price: o.price ?? o.lowPrice ?? null, currency: text(o.priceCurrency), availability: text(o.availability).replace(/^.*\//, ''),
    category: text(first(n.category)), manufacturer: nodeText(n.manufacturer), color: text(n.color), material: text(n.material),
    url: n.url ? abs(String(n.url), base) : null, specs,
  };
  if (n.size) rec.size = text(n.size);
  return rec;
}

// ── schema.org microdata (itemprop) ──
function microdataProducts($, base) {
  const out = [];
  $('[itemtype*="schema.org/Product" i]').each((_, el) => {
    const $e = $(el);
    const prop = name => text($e.find(`[itemprop="${name}"]`).first().attr('content') || $e.find(`[itemprop="${name}"]`).first().text());
    const img = $e.find('[itemprop="image"]').first();
    out.push({ name: prop('name'), brand: prop('brand'), sku: prop('sku'), mpn: prop('mpn'), barcode: prop('gtin13') || prop('gtin'), description: prop('description').slice(0, 1500),
      image_url: abs(img.attr('src') || img.attr('content') || img.attr('href') || '', base), price: prop('price') || null, currency: prop('priceCurrency'), category: prop('category'), specs: {} });
  });
  return out;
}

function metaProduct($, base) {
  const m = k => text($(`meta[property="${k}"], meta[name="${k}"]`).first().attr('content'));
  if (!/product/i.test(m('og:type')) && !m('product:price:amount')) return null;
  return { name: m('og:title'), description: m('og:description').slice(0, 1500), image_url: abs(m('og:image'), base), price: m('product:price:amount') || null, currency: m('product:price:currency'),
    brand: m('product:brand'), category: m('product:category'), sku: m('product:retailer_item_id'), specs: {} };
}

// ── specification tables / lists → { label: value } ──
function specMap($) {
  const specs = {};
  const put = (k, v) => { k = text(k).replace(/:$/, ''); v = text(v); if (k && v && k.length <= 60 && v.length <= 300 && !(k in specs)) specs[k] = v; };
  $('table').each((_, t) => { $(t).find('tr').each((__, tr) => { const c = $(tr).children('th,td'); if (c.length === 2) put($(c[0]).text(), $(c[1]).text()); }); });
  $('dl').each((_, dl) => { $(dl).children('dt').each((__, dt) => { const dd = $(dt).next('dd'); if (dd.length) put($(dt).text(), dd.text()); }); });
  $('[class*="spec" i] li, [class*="attribute" i] li, [class*="feature" i] li').each((_, li) => { const m = text($(li).text()).match(/^([^:]{2,40}):\s*(.+)$/); if (m) put(m[1], m[2]); });
  return specs;
}

function breadcrumb($, nodes) {
  const bc = nodes.find(n => isType(n, 'BreadcrumbList'));
  let path = [];
  if (bc) path = [].concat(bc.itemListElement || []).sort((a, b) => (a.position || 0) - (b.position || 0)).map(i => nodeText(i.name ?? i.item)).filter(Boolean);
  if (!path.length) path = $('[class*="breadcrumb" i] a, nav[aria-label*="breadcrumb" i] a').map((_, a) => text($(a).text())).get().filter(Boolean);
  return path.filter(p => !/^(home|shop|all products|products)$/i.test(p));
}

// ── product cards on a listing page ──
const CARD_CLASS = /(^|[\s_-])(product|item|card|grid-item|listing|tile)([\s_-]|$)/i;
function cardsOf($, base, sel) {
  const q = sel && sel.item ? $(sel.item).toArray()
    : $('article, li, div').filter((_, el) => CARD_CLASS.test($(el).attr('class') || '')).toArray();
  const cards = q.filter(el => {
    const $e = $(el);
    if (!sel?.item && $e.find('article, li, div').filter((_, c) => CARD_CLASS.test($(c).attr('class') || '')).length) return false;   // keep the innermost card
    return $e.find('a[href]').length && (sel?.price ? $e.find(sel.price).length : PRICE_RE.test($e.text()));
  });
  const out = [];
  for (const el of cards) {
    const $e = $(el);
    const link = $e.find(sel?.link || 'a[href]').first();
    const nameEl = sel?.name ? $e.find(sel.name).first() : $e.find('h1,h2,h3,h4,[class*="title" i],[class*="name" i]').first();
    const name = text(nameEl.text()) || text(link.attr('title') || link.text());
    if (!name) continue;
    const img = $e.find(sel?.image || 'img').first();
    const priceEl = sel?.price ? $e.find(sel.price).first() : $e.find('[class*="price" i]').first();
    const priceText = text(priceEl.text()) || (text($e.text()).match(PRICE_RE) || [''])[0];
    out.push({ name, url: abs(link.attr('href') || '', base), image_url: abs(img.attr('data-src') || img.attr('src') || '', base), price_text: priceText, snippet: text($e.text()).slice(0, 500), specs: {} });
  }
  return out;
}

function nextPage($, base, sel) {
  const cand = sel?.next ? $(sel.next).first().attr('href') : ($('link[rel="next"]').attr('href') || $('a[rel="next"]').attr('href')
    || $('a[aria-label*="next" i]').first().attr('href') || $('a').filter((_, a) => /^(next|next page|›|»|>)$/i.test(text($(a).text()))).first().attr('href'));
  return cand ? abs(cand, base) : null;
}

/** Everything one page offers. { products: [raw...], next, detailLinks, page: 'detail'|'list' } */
function extractPage(html, url, sel) {
  const $ = cheerio.load(html);
  const nodes = jsonLdNodes($);
  const crumbs = breadcrumb($, nodes);
  const specs = specMap($);
  const products = [];
  const ld = nodes.filter(n => isType(n, 'Product'));
  for (const n of ld) products.push({ via: 'jsonld', ...fromProductNode(n, url), source_node: n });
  if (!products.length) for (const p of microdataProducts($, url)) products.push({ via: 'microdata', ...p });
  if (!products.length) { const m = metaProduct($, url); if (m) products.push({ via: 'meta', ...m }); }

  let page = 'list';
  const cards = cardsOf($, url, sel);
  const listItems = nodes.filter(n => isType(n, 'ItemList'));
  if (products.length && (products.length === 1 || !cards.length)) {
    page = products.length === 1 && cards.length < 3 ? 'detail' : 'list';
    if (page === 'detail') { products[0].specs = { ...specs, ...products[0].specs }; if (crumbs.length) products[0].crumbs = crumbs; }
  }
  if (page === 'list' || !products.length) {
    if (!products.length || products.length < cards.length) {
      const known = new Set(products.map(p => (p.url || p.name || '').toLowerCase()));
      for (const c of cards) if (!known.has((c.url || c.name).toLowerCase())) products.push({ via: 'card', ...c, crumbs });
    }
    if (!products.length && specs && Object.keys(specs).length && $('h1').length) {          // a detail page with no structured data
      products.push({ via: 'html', name: text($('h1').first().text()), image_url: abs($('meta[property="og:image"]').attr('content') || '', url), price_text: text($('[class*="price" i]').first().text()), specs, crumbs, specs_html: true });
      page = 'detail';
    }
  }
  const detailLinks = [];
  for (const n of listItems) for (const it of [].concat(n.itemListElement || [])) { const u = abs(it.url || it.item?.url || '', url); if (u) detailLinks.push(u); }
  for (const p of products) if (p.url && p.url !== url) detailLinks.push(p.url);
  return { products, next: nextPage($, url, sel), detailLinks: [...new Set(detailLinks)], page, crumbs };
}

module.exports = { extractPage, specMap, PRICE_RE };
