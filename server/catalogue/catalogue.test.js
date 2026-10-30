'use strict';
const test = require('node:test');
const assert = require('node:assert');
delete process.env.CATALOGUE_ALLOW_LOOPBACK;
const G = require('./netguard');
const { extractPage } = require('./extract');
const N = require('./normalize');
const Prof = require('./profiles');

test('SSRF guard refuses private, loopback, link-local and metadata addresses', () => {
  for (const u of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.5/x', 'http://172.16.4.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data',
    'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:10.0.0.1]/', 'http://0.0.0.0/', 'ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'http://example.com:22/', 'http://printer.local/', 'http://db.internal/'])
    assert.throws(() => G.checkUrl(u), undefined, u);
  assert.ok(G.checkUrl('https://example.com/shop?page=2'));
  assert.ok(G.checkUrl('http://example.com:8080/'));
});

test('robots.txt: longest matching rule wins, our agent group beats *', () => {
  const r = G.parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public/\nDisallow: /*.pdf$\n\nUser-agent: TuneGENCatalogueBot\nDisallow: /nope');
  assert.equal(G.robotsAllows(r, '/nope/x'), false);
  assert.equal(G.robotsAllows(r, '/private/a'), true, 'our group has no /private rule');
  const s = G.parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public/\nDisallow: /*.pdf$');
  assert.equal(G.robotsAllows(s, '/private/a'), false);
  assert.equal(G.robotsAllows(s, '/private/public/a'), true);
  assert.equal(G.robotsAllows(s, '/files/a.pdf'), false);
  assert.equal(G.robotsAllows(s, '/shop'), true);
});

const LD = `<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'MICHELIN Primacy 4 205/55R16 91V', brand: { name: 'MICHELIN' }, sku: 'PR4-205', gtin13: '5901234123457',
  image: '/img/p.jpg', offers: { '@type': 'Offer', price: '24,500', priceCurrency: 'PKR', availability: 'https://schema.org/InStock' }, description: 'All-season tubeless radial tyre, run flat.' })}</script></head><body><h1>x</h1></body></html>`;

test('extract: JSON-LD product, and normalisation to a tyre profile', () => {
  const out = extractPage(LD, 'https://shop.test/p/1');
  assert.equal(out.products.length, 1);
  const rec = N.normalize(out.products[0], Prof.effective('tyre_shop'), {});
  assert.equal(rec.name, 'Michelin Primacy 4 205/55R16 91V');
  assert.equal(rec.brand, 'Michelin');
  assert.equal(rec.barcode, '5901234123457');
  assert.equal(rec.price, 24500);
  assert.equal(rec.currency, 'PKR');
  assert.deepEqual([rec.attributes.width, rec.attributes.aspect_ratio, rec.attributes.rim_diameter, rec.attributes.load_index, rec.attributes.speed_rating], ['205', '55', '16', '91', 'V']);
  assert.equal(rec.attributes.season, 'All-season');
  assert.equal(rec.attributes.run_flat, 'Yes');
  assert.equal(rec.attributes.tube_type, 'Tubeless');
  assert.equal(rec.image_url, 'https://shop.test/img/p.jpg');
  assert.equal(rec.attributes.model, 'Primacy 4');
});

test('the same engine yields business-specific attributes from a different profile', () => {
  const html = `<html><body><h1>Samsung Galaxy A15 128GB Black</h1><span class="price">Rs. 54,999</span><table><tr><th>Warranty</th><td>1 year warranty</td></tr><tr><th>Storage</th><td>128 GB</td></tr></table></body></html>`;
  const out = extractPage(html, 'https://shop.test/a15');
  const rec = N.normalize(out.products[0], Prof.effective('electronics'), {});
  assert.equal(rec.price, 54999);
  assert.equal(rec.attributes.storage_capacity, '128 GB');
  assert.equal(rec.attributes.color, 'Black');
  assert.match(rec.attributes.warranty, /1 year/);
  assert.equal(rec.attributes.width, undefined, 'tyre attributes do not leak into other profiles');
  assert.equal(rec.category, 'Mobile phones');
});

test('listing page: cards, pagination link, keyword filter flag', () => {
  const html = `<html><body><ul>${[1, 2, 3].map(i => `<li class="product-card"><a href="/p/${i}"><img src="/i${i}.jpg"><h3>Basmati Rice ${i}kg</h3></a><span class="price">Rs ${i * 100}</span></li>`).join('')}</ul><a rel="next" href="/list?page=2">Next</a></body></html>`;
  const out = extractPage(html, 'https://shop.test/list');
  assert.equal(out.products.length, 3);
  assert.equal(out.products[1].url, 'https://shop.test/p/2');
  assert.equal(out.next, 'https://shop.test/list?page=2');
  const rec = N.normalize(out.products[0], Prof.effective('grocery'), { keywords: ['oil'] });
  assert.equal(rec.matches_keywords, false);
  assert.equal(N.normalize(out.products[0], Prof.effective('grocery'), { keywords: ['rice'] }).matches_keywords, true);
  assert.equal(N.normalize(out.products[0], Prof.effective('grocery'), {}).pack_size, '1 kg');
});

test('GTIN check digits, prices and identity', () => {
  assert.equal(N.gtin('5901234123457'), '5901234123457');
  assert.equal(N.gtin('5901234123458'), null);
  assert.equal(N.gtin('123'), null);
  assert.equal(N.parsePrice('Rs. 1,299.50'), 1299.5);
  assert.equal(N.parsePrice('free'), null);
  assert.equal(N.identity('Dior', 'Sauvage Dior 100 ml', '100 ml'), N.identity('Dior', 'Sauvage', '100ml'));
});

test('every business type has a profile with a name field or tyre identity, and categories', () => {
  for (const t of Prof.BUSINESS_TYPES) {
    const p = Prof.effective(t);
    assert.ok(p.fields.length >= 5, t);
    assert.ok(p.categories.length >= 1, t);
    assert.ok(p.fields.some(f => f.key === 'name' || f.key === 'model'), t);
  }
  const o = Prof.effective('grocery', { keywords: ['a', 'a', ' b '], required: ['barcode'], max_pages: 99 });
  assert.deepEqual(o.keywords, ['a', 'b']);
  assert.equal(o.fields.find(f => f.key === 'barcode').required, true);
  assert.equal(o.fields.find(f => f.key === 'name').required, false);
  assert.equal(o.max_pages, 10);
});
