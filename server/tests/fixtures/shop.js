// A tiny fake web shop on 127.0.0.1 for the catalogue scraper tests: listings with pagination, product pages with JSON-LD and spec tables,
// a robots.txt, a login wall, a slow page, a redirect to the cloud metadata address and a page with nothing on it.
const http = require('http');

const P = {
  1: { name: 'GUARD BASMATI RICE 5KG', brand: 'GUARD', sku: 'RICE-5KG', gtin: '5901234123457', price: 1850, cat: 'Rice' },
  2: { name: 'Shan Biryani Masala 100g', brand: 'Shan', sku: 'SHAN-100', gtin: '4006381333931', price: 220, cat: 'Spices' },
  3: { name: 'Tapal Danedar Tea 190g', brand: 'Tapal', sku: 'TAPAL-190', price: 410, cat: 'Tea' },
  5: { name: 'Olpers Full Cream Milk 1L', brand: 'Olpers', sku: 'OLP-1L', gtin: '8901030865278', price: 330, cat: 'Dairy' },
  7: { name: '=HYPERLINK("http://evil.test","click")', brand: 'Evil', sku: 'EVIL-1', price: 10, cat: 'Other' },
};
const T = {
  1: { name: 'Bridgestone Turanza T005 205/55R16 91V', brand: 'Bridgestone', sku: 'BS-T005-205', price: 22000, cat: 'Passenger tyres', extra: { Season: 'Summer' } },
  2: { name: 'Yokohama Geolandar', brand: 'Yokohama', sku: 'YK-GEO', price: 31000, cat: 'SUV tyres' },
};
const ld = (p, url) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: p.name, brand: { '@type': 'Brand', name: p.brand }, sku: p.sku, ...(p.gtin ? { gtin13: p.gtin } : {}),
  image: `/img/${p.sku}.jpg`, url, category: p.cat, offers: { '@type': 'Offer', price: p.price, priceCurrency: 'PKR' }, description: p.name + ' from the fixture shop.' })}</script>`;
const card = (id, p, href) => `<li class="product-card"><a href="${href}"><img src="/img/${p.sku}.jpg"><h3 class="title">${p.name.replace(/</g, '&lt;')}</h3></a><span class="price">Rs. ${p.price}</span></li>`;
const page = (body, head = '') => `<!doctype html><html><head><title>Fixture shop</title>${head}</head><body>${body}</body></html>`;

function start(port) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => { res.writeHead(status, { 'Content-Type': type, ...headers }); res.end(body); };
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    if (path === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /private/\n', 'text/plain');
    if (path === '/shop/page1') return send(200, page(`<h1>Grocery</h1><ul>${card(1, P[1], '/p/1')}${card(2, P[2], '/p/2')}${card(3, P[3], '/p/3')}${card(4, { name: 'Private Item', sku: 'PRIV', price: 5 }, '/private/p4')}</ul><a rel="next" href="/shop/page2">Next</a>`));
    if (path === '/shop/page2') return send(200, page(`<h1>Grocery 2</h1><ul>${card(5, P[5], '/p/5')}${card(2, P[2], '/p/2')}${card(7, P[7], '/p/7')}</ul>`));
    const m = path.match(/^\/p\/(\d+)$/);
    if (m && P[m[1]]) return send(200, page(`<h1>${P[m[1]].name.replace(/</g, '&lt;')}</h1><table><tr><th>Pack size</th><td>${/\d+\s?(kg|g|l)/i.test(P[m[1]].name) ? P[m[1]].name.match(/\d+\s?(?:kg|g|l)\b/i)[0] : ''}</td></tr><tr><th>Ingredients</th><td>Fixture ingredients</td></tr></table>`, ld(P[m[1]], `http://127.0.0.1:${port}${path}`)));
    if (path === '/t/list') return send(200, page(`<ul>${card(1, T[1], '/t/1')}${card(2, T[2], '/t/2')}</ul>`));
    const t = path.match(/^\/t\/(\d+)$/);
    if (t && T[t[1]]) return send(200, page(`<h1>${T[t[1]].name}</h1><table>${Object.entries(T[t[1]].extra || {}).map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`, ld(T[t[1]], `http://127.0.0.1:${port}${path}`)));
    if (path === '/slow') return setTimeout(() => send(200, page(`<ul>${card(5, P[5], '/p/5')}</ul>`)), 1500);
    if (path === '/login') return send(403, 'Forbidden');
    if (path === '/redir') return send(302, '', 'text/html', { Location: 'http://169.254.169.254/latest/meta-data/' });
    if (path === '/empty') return send(200, page('<p>Nothing here</p>'));
    if (path.startsWith('/img/')) return send(200, 'x', 'image/jpeg');
    if (path.startsWith('/private/')) return send(200, page('<h1>Private</h1>'));
    send(404, 'Not found');
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, hits, close: () => new Promise(c => server.close(c)) })));
}
module.exports = { start };
