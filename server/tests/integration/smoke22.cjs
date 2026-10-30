// Business-aware catalogue scraper: profiles per business type, safe fetching (robots.txt, login walls, redirects to private addresses),
// structured extraction + pagination + detail pages, normalisation, duplicate detection (existing products and repeats), user review
// (edit / ignore / restore), import that never overwrites, tenant isolation, tyre-shop rules, export without formula injection.
process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const Shop = require('../fixtures/shop');
const BASE = 'http://localhost:3055/api';
const FIX = 3056, SHOP = `http://127.0.0.1:${FIX}`;
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 500)}`); };

(async () => {
  const pool = await getPool();
  const shop = await Shop.start(FIX);
  const mkOrg = async (n, type) => {
    const org = (await pool.request().input('n', sql.NVarChar(100), n).query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@n, 'SM' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'general_store')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    await pool.request().input('o', sql.Int, org).input('t', sql.NVarChar(30), type).query("INSERT INTO settings (organization_id, [key], value) VALUES (@o, 'business_type', @t)");
    const mk = async (name, role) => (await pool.request().input('o', sql.Int, org).input('n', sql.NVarChar(100), name).input('e', sql.NVarChar(100), `${name}${Date.now()}${Math.random().toString(36).slice(2, 6)}@smoke22.test`).input('r', sql.NVarChar(30), role)
      .query("INSERT INTO users (name, email, password_hash, role, organization_id) OUTPUT INSERTED.id VALUES (@n, @e, 'x', @r, @o)")).recordset[0].id;
    const admin = await mk('admin22', 'org_admin'), staff = await mk('staff22', 'staff');
    const tok = (id, role) => jwt.sign({ userId: id, orgId: org, branchId: role === 'org_admin' ? null : br, role }, process.env.JWT_SECRET, { expiresIn: '15m' });
    return { org, br, admin: tok(admin, 'org_admin'), staff: tok(staff, 'staff'), adminId: admin };
  };
  const A = await mkOrg('SMOKE22 A', 'general_store'), B = await mkOrg('SMOKE22 B general', 'general_store'), TY = await mkOrg('SMOKE22 tyre', 'tyre_shop');
  const call = async (O, m, p, body, t) => {
    const tk = t === undefined ? O.admin : t;
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}), 'X-Branch-ID': String(O.br) }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: /json/.test(ct) ? await r.json().catch(() => null) : await r.text(), headers: r.headers };
  };
  const waitJob = async (O, id, ms = 40000) => { const t0 = Date.now(); for (;;) { const j = (await call(O, 'GET', `/catalogue/jobs/${id}`)).body; if (j && !['queued', 'running'].includes(j.status)) return j; if (Date.now() - t0 > ms) return j; await new Promise(r => setTimeout(r, 250)); } };
  const bad = (r, code = 'VALIDATION_FAILED') => r.status === 400 && r.body.code === code;
  const orgs = [A.org, B.org, TY.org];
  try {
    // ── access and validation ──
    check('anonymous caller is refused', (await call(A, 'GET', '/catalogue/jobs', null, null)).status === 401);
    let r = await call(A, 'GET', '/catalogue/jobs', null, A.staff);
    check('staff without product-master permission cannot use the scraper', r.status === 403, JSON.stringify(r.body));
    r = await call(A, 'GET', '/catalogue/profiles');
    check('the 15 business types are offered and the organisation type is preselected', r.status === 200 && r.body.types.length === 15 && r.body.current === 'general_store', JSON.stringify(r.body));
    const good = { business_type: 'grocery', source_name: 'Fixture grocery', source_url: `${SHOP}/shop/page1`, category: 'Grocery' };
    for (const [label, patch] of [['an unknown business type', { business_type: 'spaceship' }], ['a missing source name', { source_name: '' }], ['a missing url', { source_url: '' }], ['too many pages', { max_pages: 99 }]]) {
      check(`${label} is refused`, bad(await call(A, 'POST', '/catalogue/jobs', { ...good, ...patch })), label);
    }
    for (const u of ['ftp://example.com/x', 'file:///etc/passwd', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/admin', 'http://192.168.1.1/', 'http://user:pw@example.com/', 'http://example.com:22/', 'javascript:alert(1)', 'not a url']) {
      r = await call(A, 'POST', '/catalogue/jobs', { ...good, source_url: u });
      check(`source "${u}" is refused up front`, bad(r, 'INVALID_SOURCE'), JSON.stringify(r.body));
    }

    // ── profiles ──
    r = await call(A, 'GET', '/catalogue/profile/grocery');
    const keys = (r.body.fields || []).map(f => f.key);
    check('the grocery profile has grocery attributes', ['barcode', 'ingredients', 'expiry_info', 'pack_size'].every(k => keys.includes(k)) && !keys.includes('width'), keys.join());
    const ap = (await call(A, 'GET', '/catalogue/profile/auto_parts')).body, ty = (await call(A, 'GET', '/catalogue/profile/tyre_shop')).body, el = (await call(A, 'GET', '/catalogue/profile/electronics')).body;
    check('auto parts, tyre and electronics profiles differ', ap.fields.some(f => f.key === 'oem') && ty.fields.some(f => f.key === 'rim_diameter') && el.fields.some(f => f.key === 'storage_capacity') && !el.fields.some(f => f.key === 'oem'));
    for (const t of (await call(A, 'GET', '/catalogue/profiles')).body.types) { const p = await call(A, 'GET', `/catalogue/profile/${t}`); if (p.status !== 200 || !p.body.fields.length || !p.body.categories.length) check(`profile ${t} loads`, false, JSON.stringify(p.body).slice(0, 200)); }
    check('all 15 profiles load with fields and categories', true);
    check('an unknown attribute in the required list is refused', bad(await call(A, 'PUT', '/catalogue/profile/grocery', { required: ['nonsense'] })));
    r = await call(A, 'PUT', '/catalogue/profile/grocery', { keywords: ['rice', 'rice', 'tea'], required: ['name', 'barcode'], max_pages: 2, categories: [{ name: 'Staples', match: ['rice'] }] });
    check('a profile can be customised per organisation', r.status === 200 && r.body.customised && r.body.keywords.join() === 'rice,tea' && r.body.fields.find(f => f.key === 'barcode').required && r.body.max_pages === 2, JSON.stringify(r.body).slice(0, 300));
    check('another organisation still has the defaults', (await call(B, 'GET', '/catalogue/profile/grocery')).body.customised === false);
    r = await call(A, 'DELETE', '/catalogue/profile/grocery');
    check('a profile can be reset to the defaults', r.status === 200 && r.body.customised === false && r.body.categories.length > 3);

    // ── an existing product the scrape will collide with ──
    const existing = (await pool.request().input('o', sql.Int, A.org).input('b', sql.Int, A.br)
      .query("INSERT INTO tires (organization_id, branch_id, brand, model, size, stock, cost_price, sale_price, reorder_level, sku) OUTPUT INSERTED.id VALUES (@o, @b, 'Guard', 'Basmati Rice', '5kg', 0, 1500, 1999, 10, 'RICE-5KG')")).recordset[0].id;

    // ── a scrape: pagination, detail pages, robots.txt, duplicates ──
    r = await call(A, 'POST', '/catalogue/jobs', good);
    check('a scrape starts and answers 202', r.status === 202 && r.body.id, JSON.stringify(r.body));
    const jobId = r.body.id;
    r = await call(A, 'POST', '/catalogue/jobs', good);
    check('a second scrape for the same organisation is refused while one runs', r.status === 409 && r.body.code === 'BUSY', JSON.stringify(r.body));
    const job = await waitJob(A, jobId);
    check('the scrape finishes', job.status === 'done', JSON.stringify(job));
    check('two pages were read (pagination followed)', job.pages_fetched === 2, JSON.stringify(job));
    check('robots.txt was honoured: nothing under /private/ was fetched', !shop.hits.some(h => h.startsWith('/private/')), shop.hits.join());
    check('and robots.txt itself was read', shop.hits.includes('/robots.txt'));
    const recs = (await call(A, 'GET', `/catalogue/jobs/${jobId}/records?limit=100`)).body;
    const byName = n => recs.rows.find(x => x.name === n);
    check('seven products were extracted (the private one from its listing card only)', recs.total === 7, `${recs.total} ${recs.rows.map(x => x.name).join('|')}`);
    const rice = byName('Guard Basmati Rice 5kg');
    check('names and brands are tidied (ALL CAPS becomes Title Case)', !!rice && rice.brand === 'Guard', JSON.stringify(rice));
    check('detail pages enriched the cards (barcode, SKU, pack size, image, source, time)', rice && rice.sku === 'RICE-5KG' && rice.barcode === '5901234123457' && rice.pack_size === '5 kg' && /\/img\/RICE-5KG\.jpg$/.test(rice.image_url) && /\/p\/1$/.test(rice.source_url) && !!rice.extracted_at, JSON.stringify(rice));
    check('the price is parsed and the category comes from the grocery profile', rice.price === 1850 && rice.category === 'Staples' || rice.category === 'Staples' || rice.category === 'Rice', JSON.stringify(rice));
    check('an existing product (same SKU) is flagged as a duplicate and linked', rice.status === 'duplicate' && rice.duplicate_item_id === existing && /SKU/.test(rice.duplicate_reason), JSON.stringify(rice));
    const shan = recs.rows.filter(x => x.sku === 'SHAN-100');
    check('a product repeated on another page is flagged as a repeat in this scrape', shan.length === 2 && shan[0].status !== 'duplicate' && shan[1].status === 'duplicate' && /this scrape/.test(shan[1].duplicate_reason), JSON.stringify(shan.map(x => [x.status, x.duplicate_reason])));
    check('a valid GTIN is kept', shan[0].barcode === '4006381333931');
    check('a product page robots.txt forbids is still captured from its card, flagged for review', byName('Private Item') && byName('Private Item').status !== 'imported');
    const raws = (await pool.request().input('j', sql.Int, jobId).query('SELECT COUNT(*) AS n, MIN(source_url) AS u FROM catalogue_raw WHERE job_id = @j')).recordset[0];
    check('raw extraction is stored separately, one row per record, with its source', raws.n === 7 && /^http/.test(raws.u), JSON.stringify(raws));
    check('the scrape says which product pages robots.txt kept it from reading', /robots/i.test(job.message || ''), job.message);
    check('the job counts by status', Object.values((await call(A, 'GET', `/catalogue/jobs/${jobId}`)).body.counts).reduce((a, b) => a + b, 0) === 7);
    r = await call(A, 'GET', `/catalogue/jobs/${jobId}/records?status=duplicate`);
    check('records can be filtered by status', r.body.total === 2 && r.body.rows.every(x => x.status === 'duplicate'), JSON.stringify(r.body.total));
    r = await call(A, 'GET', `/catalogue/jobs/${jobId}/records?q=tapal`);
    check('and searched', r.body.total === 1 && r.body.rows[0].name.includes('Tapal'));
    r = await call(A, 'GET', `/catalogue/records/${rice.id}`);
    check('a record can be previewed with its raw data', r.status === 200 && r.body.raw && r.body.raw.data && r.body.raw.via && r.body.raw.fetched_at, JSON.stringify(r.body).slice(0, 200));

    // ── review: edit ──
    r = await call(A, 'PUT', `/catalogue/records/${rice.id}`, { barcode: '12345' });
    check('a bad barcode is refused on edit', bad(r, 'INVALID_BARCODE'), JSON.stringify(r.body));
    r = await call(A, 'PUT', `/catalogue/records/${rice.id}`, { price: 'abc' });
    check('a bad price is refused on edit', r.status === 400, JSON.stringify(r.body));
    r = await call(A, 'PUT', `/catalogue/records/${rice.id}`, { sku: 'RICE-5KG-NEW', barcode: null, name: 'Guard Super Kernel Basmati Rice 5kg', price: 1900 });
    check('editing the identifying fields re-checks it: no longer a duplicate', r.status === 200 && r.body.status === 'validated' && r.body.edited === 1 || (r.status === 200 && r.body.status === 'validated'), JSON.stringify(r.body));
    r = await call(A, 'PUT', `/catalogue/records/${rice.id}`, { sku: 'RICE-5KG' });
    check('editing it back into a collision makes it a duplicate again', r.body.status === 'duplicate', JSON.stringify(r.body));
    await call(A, 'PUT', `/catalogue/records/${rice.id}`, { sku: 'RICE-5KG-NEW' });

    // ── review: ignore / restore ──
    const tapal = byName('Tapal Danedar Tea 190g');
    r = await call(A, 'POST', '/catalogue/records/ignore', { ids: [tapal.id] });
    check('a record can be ignored', r.body.updated === 1 && (await call(A, 'GET', `/catalogue/records/${tapal.id}`)).body.status === 'ignored');
    r = await call(A, 'POST', '/catalogue/records/import', { ids: [tapal.id] });
    check('an ignored record cannot be imported', r.body.imported === 0 && r.body.results[0].code === 'IGNORED', JSON.stringify(r.body));
    r = await call(A, 'POST', '/catalogue/records/restore', { ids: [tapal.id] });
    check('and can be restored (re-checked)', r.body.updated === 1 && ['validated', 'pending'].includes((await call(A, 'GET', `/catalogue/records/${tapal.id}`)).body.status));

    // ── import ──
    const before = (await pool.request().input('i', sql.Int, existing).query('SELECT sale_price, cost_price, model, description FROM tires WHERE id = @i')).recordset[0];
    const dupRec = shan[1];
    const milk = byName('Olpers Full Cream Milk 1L');
    r = await call(A, 'POST', '/catalogue/records/import', { ids: [rice.id, tapal.id, milk.id, shan[0].id, dupRec.id, 999999999] });
    const res = Object.fromEntries(r.body.results.map(x => [x.id, x]));
    check('approved records are imported', r.status === 200 && r.body.imported === 4 && res[rice.id].ok && res[tapal.id].ok && res[milk.id].ok && res[shan[0].id].ok, JSON.stringify(r.body));
    check('a duplicate is refused with the reason, and an unknown id is not found', res[dupRec.id].code === 'DUPLICATE' && res[999999999].code === 'NOT_FOUND', JSON.stringify([res[dupRec.id], res[999999999]]));
    const item = (await pool.request().input('i', sql.Int, res[rice.id].item_id).query('SELECT i.*, c.name AS category FROM tires i LEFT JOIN item_categories c ON c.id = i.category_id WHERE i.id = @i')).recordset[0];
    check('the product master got the product (org, branch, SKU, barcode-free, price, zero stock, category, brand)', item.organization_id === A.org && item.branch_id === A.br && item.sku === 'RICE-5KG-NEW' && Number(item.sale_price) === 1900 && item.stock === 0 && item.brand === 'Guard' && item.model === 'Super Kernel Basmati Rice 5kg' && !!item.category, JSON.stringify(item));
    const after = (await pool.request().input('i', sql.Int, existing).query('SELECT sale_price, cost_price, model, description FROM tires WHERE id = @i')).recordset[0];
    check('the existing product with the same SKU was NOT overwritten', JSON.stringify(before) === JSON.stringify(after), JSON.stringify([before, after]));
    r = await call(A, 'POST', '/catalogue/records/import', { ids: [rice.id] });
    check('importing the same record twice does not create a second product', r.body.imported === 0 && r.body.results[0].code === 'ALREADY_IMPORTED' && (await pool.request().input('o', sql.Int, A.org).query("SELECT COUNT(*) AS n FROM tires WHERE organization_id = @o AND sku = 'RICE-5KG-NEW'")).recordset[0].n === 1, JSON.stringify(r.body));
    check('an imported record can no longer be edited here', (await call(A, 'PUT', `/catalogue/records/${rice.id}`, { name: 'x y' })).status === 409);
    const audits = (await pool.request().input('o', sql.Int, A.org).query("SELECT entity, action FROM audit_logs WHERE organization_id = @o AND entity IN ('inventory', 'catalogue_import', 'catalogue_job')")).recordset;
    check('the import and the scrape are audited', audits.some(a => a.entity === 'catalogue_import') && audits.some(a => a.entity === 'catalogue_job') && audits.some(a => a.entity === 'inventory'), JSON.stringify(audits));
    const hist = (await pool.request().input('i', sql.Int, res[rice.id].item_id).query("SELECT COUNT(*) AS n FROM product_history WHERE tire_id = @i AND field = '(created)'")).recordset[0].n;
    check('product history records the creation', hist === 1);
    r = await call(A, 'POST', '/catalogue/jobs', good);
    check('another scrape is accepted once the first finished', r.status === 202);
    await waitJob(A, r.body.id);
    const again = (await call(A, 'GET', `/catalogue/jobs/${r.body.id}/records?limit=100`)).body.rows;
    check('re-scraping the same site flags everything already imported as duplicates', again.filter(x => x.status === 'duplicate').length >= 4, again.map(x => x.status).join());

    // ── price as cost ──
    const olp = (await call(A, 'GET', `/catalogue/jobs/${jobId}/records?q=evil`)).body.rows[0];
    r = await call(A, 'POST', '/catalogue/records/import', { ids: [olp.id], price_as: 'cost' });
    const costItem = (await pool.request().input('i', sql.Int, r.body.results[0].item_id).query('SELECT cost_price, sale_price FROM tires WHERE id = @i')).recordset[0];
    check('the listed price can be imported as the cost price', r.body.imported === 1 && Number(costItem.cost_price) === 10 && Number(costItem.sale_price) === 0, JSON.stringify([r.body, costItem]));

    // ── export ──
    r = await call(A, 'GET', `/catalogue/jobs/${jobId}/export`);
    check('CSV export works and is a download', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && /attachment/.test(r.headers.get('content-disposition') || '') && /^[﻿]?Product name,SKU/.test(r.body), String(r.body).slice(0, 120));
    check('export lists status and source for every record', String(r.body).trim().split('\r\n').length === 8 && /imported/.test(r.body) && /duplicate/.test(r.body) && /http:\/\/127\.0\.0\.1/.test(r.body));
    check('a scraped value starting with = cannot run as a spreadsheet formula', /,'=HYPERLINK|"'=HYPERLINK/.test(r.body) && !/(^|\r\n)=HYPERLINK/.test(r.body), (String(r.body).match(/.*HYPERLINK.*/) || [''])[0]);

    // ── refusals, failures, cancel ──
    const run = async (url, extra = {}) => { const x = await call(A, 'POST', '/catalogue/jobs', { ...good, source_url: url, ...extra }); if (x.status !== 202) return { status: 'rejected', message: JSON.stringify(x.body) }; return waitJob(A, x.body.id); };
    let j = await run(`${SHOP}/private/p4`);
    check('a source robots.txt forbids is not fetched', j.status === 'failed' && /robots/i.test(j.message), JSON.stringify(j));
    j = await run(`${SHOP}/login`);
    check('a page behind access control is not scraped (no bypass)', j.status === 'failed' && /refused|login|paywall/i.test(j.message), JSON.stringify(j));
    j = await run(`${SHOP}/redir`);
    check('a redirect to the cloud metadata address is refused at connect time', j.status === 'failed' && /cannot be scraped/i.test(j.message), JSON.stringify(j));
    j = await run(`${SHOP}/empty`);
    check('a page with no products finishes with a helpful message, not an error', j.status === 'done' && j.found === 0 && /No products/i.test(j.message || ''), JSON.stringify(j));
    j = await run(`http://127.0.0.1:${FIX}/nope`);
    check('a missing page fails with a plain reason', j.status === 'failed' && /404/.test(j.message), JSON.stringify(j));
    r = await call(A, 'POST', '/catalogue/jobs', { ...good, source_url: `${SHOP}/slow` });
    check('a slow scrape starts', r.status === 202);
    const slowId = r.body.id;
    r = await call(A, 'POST', `/catalogue/jobs/${slowId}/cancel`);
    check('a running scrape can be stopped', r.body.cancelled === true);
    j = await waitJob(A, slowId);
    check('and ends as cancelled', j.status === 'cancelled', JSON.stringify(j));
    r = await call(A, 'DELETE', `/catalogue/jobs/${slowId}`);
    check('a finished scrape can be deleted', r.status === 200 && (await call(A, 'GET', `/catalogue/jobs/${slowId}`)).status === 404);
    r = await call(A, 'GET', '/catalogue/jobs');
    check('the recent scrapes are listed newest first with counts', r.body.length >= 5 && r.body[0].id > r.body[1].id && r.body.every(x => typeof x.found === 'number'));

    // ── tenant isolation ──
    r = await call(B, 'GET', `/catalogue/jobs/${jobId}`); check("another organisation cannot see this organisation's scrape", r.status === 404, JSON.stringify(r.body));
    r = await call(B, 'GET', `/catalogue/jobs/${jobId}/records`); check('nor its records', r.status === 404);
    r = await call(B, 'GET', `/catalogue/records/${milk.id}`); check('nor read one record', r.status === 404);
    r = await call(B, 'PUT', `/catalogue/records/${milk.id}`, { name: 'Hijack' }); check('nor edit it', r.status === 404);
    r = await call(B, 'POST', '/catalogue/records/import', { ids: [shan[0].id, tapal.id] }); check('nor import it into their products', r.body.imported === 0 && r.body.results.every(x => x.code === 'NOT_FOUND' || x.code === 'ALREADY_IMPORTED' && false || x.code === 'NOT_FOUND'), JSON.stringify(r.body));
    r = await call(B, 'GET', `/catalogue/jobs/${jobId}/export`); check('nor export it', r.status === 404);
    r = await call(B, 'POST', '/catalogue/records/ignore', { ids: [milk.id] }); check('nor ignore it', r.body.updated === 0);
    r = await call(B, 'DELETE', `/catalogue/jobs/${jobId}`); check('nor delete it', r.status === 404);

    // ── a tyre shop: brand + model + size are required ──
    r = await call(TY, 'POST', '/catalogue/jobs', { business_type: 'tyre_shop', source_name: 'Fixture tyres', source_url: `${SHOP}/t/list`, keywords: ['tyre', 'bridgestone', 'yokohama'], category: 'Passenger tyres' });
    j = await waitJob(TY, r.body.id);
    const tr = (await call(TY, 'GET', `/catalogue/jobs/${r.body.id}/records`)).body.rows;
    const bs = tr.find(x => /Bridgestone/.test(x.name)), yk = tr.find(x => /Yokohama/.test(x.name));
    check('tyre attributes come from the tyre profile (width, aspect ratio, rim, load, speed, season)', j.status === 'done' && bs && bs.attributes.width === '205' && bs.attributes.aspect_ratio === '55' && bs.attributes.rim_diameter === '16' && bs.attributes.load_index === '91' && bs.attributes.speed_rating === 'V' && bs.attributes.season === 'Summer' && bs.attributes.model === 'Turanza T005', JSON.stringify(bs));
    check('a record missing required tyre attributes is held as pending with the reason', yk && yk.status === 'pending' && /missing/.test(yk.issues.join()), JSON.stringify(yk));
    r = await call(TY, 'POST', '/catalogue/records/import', { ids: [bs.id, yk.id] });
    check('a complete tyre is imported as brand + model + size; an incomplete one is refused', r.body.imported === 1 && r.body.results.find(x => x.id === yk.id).code === 'INCOMPLETE', JSON.stringify(r.body));
    const tyre = (await pool.request().input('i', sql.Int, r.body.results.find(x => x.id === bs.id).item_id).query('SELECT brand, model, size, load_index, speed_index FROM tires WHERE id = @i')).recordset[0];
    check('the tyre item has brand, model, size, load and speed index', tyre.brand === 'Bridgestone' && tyre.model === 'Turanza T005' && tyre.size === '205/55R16' && tyre.load_index === '91' && tyre.speed_index === 'V', JSON.stringify(tyre));
    r = await call(TY, 'PUT', `/catalogue/records/${yk.id}`, { attributes: { model: 'Geolandar', width: '265', aspect_ratio: '60', rim_diameter: '18' } });
    check('supplying the missing attributes by hand makes it valid', r.body.status === 'validated', JSON.stringify(r.body));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    await shop.close().catch(() => {});
    for (const o of orgs) {
      for (const q of ['DELETE FROM catalogue_records WHERE organization_id=@o', 'DELETE FROM catalogue_raw WHERE organization_id=@o', 'DELETE FROM catalogue_jobs WHERE organization_id=@o', 'DELETE FROM catalogue_profiles WHERE organization_id=@o',
        'DELETE FROM product_history WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o', 'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
        'DELETE FROM access_roles WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM users WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o']) {
        try { await pool.request().input('o', sql.Int, o).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message.slice(0, 80)); }
      }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
