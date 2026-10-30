'use strict';
// Catalogue scraper engine: runs a job (fetch -> extract -> normalise -> duplicate check -> store), re-evaluates edited records, and imports
// approved records into the product master. Raw extraction (catalogue_raw) is kept apart from the normalised records (catalogue_records);
// nothing reaches the product master without a user approving it, and an existing product is never overwritten.
const { getPool, sql } = require('../db');
const { AppError } = require('../utils/errors');
const { writeAudit } = require('../utils/audit');
const { getBusinessType } = require('../utils/businessTypes');
const IM = require('../utils/itemMaster');
const { fetchPage } = require('./netguard');
const { extractPage } = require('./extract');
const N = require('./normalize');
const Prof = require('./profiles');

const MAX_PRODUCTS = 200, MAX_REQUESTS = 60, MAX_RUNNING = 2;
const running = new Map();       // jobId -> { cancelled, orgId }
const json = o => JSON.stringify(o ?? {});
const parse = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const cut = (s, n) => (s === null || s === undefined || s === '' ? null : String(s).slice(0, n));

async function profileFor(orgId, type) {
  const r = await (await getPool()).request().input('o', sql.Int, orgId).input('t', sql.NVarChar(30), type)
    .query('SELECT config FROM catalogue_profiles WHERE organization_id = @o AND business_type = @t');
  return Prof.effective(type, r.recordset[0] ? parse(r.recordset[0].config) : null);
}

// ── existing products, indexed for duplicate checks ──
async function loadIndex(orgId, orgType) {
  const rows = (await (await getPool()).request().input('o', sql.Int, orgId)
    .query("SELECT id, brand, model, size, sku, barcode FROM tires WHERE organization_id = @o")).recordset;
  const idx = { sku: new Map(), barcode: new Map(), ident: new Map(), oem: new Map(), orgType };
  for (const t of rows) {
    if (t.sku) idx.sku.set(String(t.sku).toUpperCase(), t.id);
    if (t.barcode) idx.barcode.set(String(t.barcode), t.id);
    const k = N.identity(t.brand, t.model, t.size);
    if (k && !idx.ident.has(k)) idx.ident.set(k, t.id);
  }
  const oem = (await (await getPool()).request().input('o', sql.Int, orgId)
    .query("SELECT oem, item_id FROM catalogue_records WHERE organization_id = @o AND status = 'imported' AND oem IS NOT NULL")).recordset;
  for (const r of oem) idx.oem.set(String(r.oem).toUpperCase(), r.item_id);
  return idx;
}
const identOf = (rec, tyre) => (tyre ? N.identity(rec.brand, rec.attributes?.model, rec.pack_size) : N.identity(rec.brand, rec.name, rec.pack_size));

/** { item_id, reason } when the record is already a product, else null. `seen` holds keys of earlier records in the same job. */
function findDuplicate(rec, idx, seen) {
  const tyre = idx.orgType === 'tyre_shop';
  const sku = rec.sku && rec.sku.toUpperCase(), oem = rec.oem && rec.oem.toUpperCase();
  const ident = identOf(rec, tyre);
  if (sku && idx.sku.has(sku)) return { item_id: idx.sku.get(sku), reason: `Same SKU as an existing product (${rec.sku})` };
  if (rec.barcode && idx.barcode.has(rec.barcode)) return { item_id: idx.barcode.get(rec.barcode), reason: `Same barcode as an existing product (${rec.barcode})` };
  if (oem && idx.oem.has(oem)) return { item_id: idx.oem.get(oem), reason: `Same OEM number as a product already imported (${rec.oem})` };
  if (ident && idx.ident.has(ident)) return { item_id: idx.ident.get(ident), reason: 'Same brand, name and size as an existing product' };
  if (seen) {
    for (const [kind, key] of [['SKU', sku], ['barcode', rec.barcode], ['OEM number', oem], ['name and size', ident]]) {
      if (key && seen.has(kind + key)) return { item_id: null, reason: `Same ${kind} as another record in this scrape` };
    }
  }
  return null;
}
const remember = (rec, tyre, seen) => {
  for (const [kind, key] of [['SKU', rec.sku && rec.sku.toUpperCase()], ['barcode', rec.barcode], ['OEM number', rec.oem && rec.oem.toUpperCase()], ['name and size', identOf(rec, tyre)]]) if (key) seen.add(kind + key);
};

/** Status for a record: pending (something required is missing), duplicate, or validated. */
function evaluate(rec, profile, idx, seen) {
  const missing = N.missingRequired(rec, profile);
  const issues = [...(rec.issues || [])];
  if (missing.length) issues.push('missing: ' + missing.join(', '));
  const dup = findDuplicate(rec, idx, seen);
  if (dup) return { status: 'duplicate', issues, duplicate_item_id: dup.item_id, duplicate_reason: dup.reason };
  return { status: missing.length || !rec.name ? 'pending' : 'validated', issues, duplicate_item_id: null, duplicate_reason: null };
}

async function insertRecord(job, raw, rec, ev) {
  const pool = await getPool();
  const rawRow = await pool.request().input('j', sql.Int, job.id).input('o', sql.Int, job.organization_id)
    .input('u', sql.NVarChar(1000), cut(raw.url || job.source_url, 1000)).input('v', sql.NVarChar(12), raw.via || 'html')
    .input('p', sql.NVarChar(sql.MAX), JSON.stringify({ ...raw, source_node: raw.source_node, snippet: raw.snippet }).slice(0, 200000))
    .query('INSERT INTO catalogue_raw (job_id, organization_id, source_url, via, payload) OUTPUT INSERTED.id VALUES (@j, @o, @u, @v, @p)');
  await pool.request().input('j', sql.Int, job.id).input('o', sql.Int, job.organization_id).input('raw', sql.Int, rawRow.recordset[0].id)
    .input('url', sql.NVarChar(1000), cut(raw.url || job.source_url, 1000))
    .input('name', sql.NVarChar(200), rec.name).input('brand', sql.NVarChar(80), cut(rec.brand, 80)).input('sku', sql.NVarChar(60), cut(rec.sku, 60))
    .input('barcode', sql.NVarChar(20), cut(rec.barcode, 20)).input('oem', sql.NVarChar(60), cut(rec.oem, 60))
    .input('cat', sql.NVarChar(100), cut(rec.category, 100)).input('sub', sql.NVarChar(100), cut(rec.subcategory, 100))
    .input('price', sql.Decimal(18, 2), rec.price).input('wp', sql.Decimal(18, 2), rec.wholesale_price).input('cur', sql.NVarChar(3), cut(rec.currency, 3))
    .input('unit', sql.NVarChar(20), cut(rec.unit, 20)).input('pack', sql.NVarChar(60), cut(rec.pack_size, 60)).input('img', sql.NVarChar(500), cut(rec.image_url, 500))
    .input('desc', sql.NVarChar(1500), cut(rec.description, 1500)).input('attr', sql.NVarChar(sql.MAX), json(rec.attributes))
    .input('st', sql.NVarChar(10), ev.status).input('iss', sql.NVarChar(500), cut(ev.issues.join('; '), 500))
    .input('di', sql.Int, ev.duplicate_item_id).input('dr', sql.NVarChar(200), cut(ev.duplicate_reason, 200))
    .query(`INSERT INTO catalogue_records (job_id, organization_id, raw_id, source_url, name, brand, sku, barcode, oem, category, subcategory, price, wholesale_price, currency,
              unit, pack_size, image_url, description, attributes, status, issues, duplicate_item_id, duplicate_reason)
            VALUES (@j, @o, @raw, @url, @name, @brand, @sku, @barcode, @oem, @cat, @sub, @price, @wp, @cur, @unit, @pack, @img, @desc, @attr, @st, @iss, @di, @dr)`);
}

const sameHost = (a, b) => { try { return new URL(a).hostname === new URL(b).hostname; } catch { return false; } };
async function setJob(id, patch) {
  const sets = Object.keys(patch).map(k => `${k} = @${k}`).join(', ');
  const rq = (await getPool()).request().input('id', sql.Int, id);
  for (const [k, v] of Object.entries(patch)) rq.input(k, typeof v === 'number' ? sql.Int : sql.NVarChar(500), v);
  await rq.query(`UPDATE catalogue_jobs SET ${sets} WHERE id = @id`);
}

/** Runs one job to the end. Never throws: the outcome is written to the job row. */
async function runJob(jobId) {
  const state = running.get(jobId) || { cancelled: false };
  running.set(jobId, state);
  const pool = await getPool();
  try {
    const job = (await pool.request().input('id', sql.Int, jobId).query('SELECT * FROM catalogue_jobs WHERE id = @id')).recordset[0];
    if (!job) return;
    const cfg = parse(job.config);
    const profile = await profileFor(job.organization_id, job.business_type);
    const orgType = await getBusinessType(job.organization_id);
    const tyre = orgType === 'tyre_shop';
    const idx = await loadIndex(job.organization_id, orgType);
    const seen = new Set();
    const keywords = String(job.keywords || '').split(',').map(s => s.trim()).filter(Boolean);
    const maxPages = Math.min(10, Math.max(1, cfg.max_pages || profile.max_pages));
    const maxProducts = Math.min(MAX_PRODUCTS, Math.max(1, cfg.max_products || MAX_PRODUCTS));
    const follow = cfg.follow_details !== false;
    await setJob(jobId, { status: 'running' });
    await pool.request().input('id', sql.Int, jobId).query('UPDATE catalogue_jobs SET started_at = SYSUTCDATETIME() WHERE id = @id');

    let url = job.source_url, pages = 0, found = 0, requests = 0, note = null;
    const visited = new Set();
    const details = new Map();            // product page url -> what it said, so a product linked twice is read once
    const keep = async (raw, pageUrl) => {
      const rec = N.normalize(raw, profile, { category: job.category, keywords });
      if (!rec.name || !rec.matches_keywords) return;
      raw.url = raw.url || pageUrl;
      await insertRecord(job, raw, rec, evaluate(rec, profile, idx, seen));
      remember(rec, tyre, seen);
      found++;
    };
    while (url && pages < maxPages && found < maxProducts && requests < MAX_REQUESTS && !state.cancelled && !visited.has(url)) {
      visited.add(url);
      let page;
      try { page = await fetchPage(url); requests++; } catch (e) {
        if (pages === 0) throw e;
        note = `Stopped after page ${pages}: ${e.message}`; break;
      }
      pages++;
      const out = extractPage(page.html, page.url, cfg.selectors);
      if (!out.products.length && pages === 1) note = 'No products were found on this page. Check the address, or set the product selectors under Advanced.';
      for (const p of out.products) {
        if (found >= maxProducts || state.cancelled) break;
        let raw = p;
        // listing cards carry little; the product's own page carries the specification
        if (follow && p.via === 'card' && p.url && sameHost(p.url, page.url) && (details.has(p.url) || (requests < MAX_REQUESTS && !visited.has(p.url)))) {
          visited.add(p.url);
          try {
            if (!details.has(p.url)) { const d = extractPage((await fetchPage(p.url)).html, p.url, cfg.selectors); requests++; details.set(p.url, d.products[0] || null); }
            const dp = details.get(p.url);
            if (dp) raw = { ...p, ...Object.fromEntries(Object.entries(dp).filter(([, v]) => v !== '' && v !== null && v !== undefined)), url: p.url, specs: { ...p.specs, ...dp.specs }, price_text: dp.price !== null && dp.price !== undefined ? undefined : p.price_text, via: 'card+detail', snippet: p.snippet };
          } catch (e) { if (e.code === 'ROBOTS' || e.code === 'DENIED') note = note || `Some product pages were skipped: ${e.message}`; }
        }
        await keep(raw, page.url);
      }
      await setJob(jobId, { pages_fetched: pages, found });
      url = out.next && sameHost(out.next, job.source_url) ? out.next : null;
    }
    if (state.cancelled) { await setJob(jobId, { status: 'cancelled', pages_fetched: pages, found, message: 'Stopped by a user' }); }
    else await setJob(jobId, { status: 'done', pages_fetched: pages, found, message: note || (found ? null : 'Nothing matched. Try other keywords or another page of the site.') });
  } catch (e) {
    await setJob(jobId, { status: 'failed', message: String(e.message || e).slice(0, 480) }).catch(() => {});
  } finally {
    running.delete(jobId);
    await (await getPool()).request().input('id', sql.Int, jobId).query('UPDATE catalogue_jobs SET finished_at = SYSUTCDATETIME() WHERE id = @id').catch(() => {});
  }
}

/** Queue a job. At most one per organisation and a few across the server, so scraping never crowds out normal work. */
async function startJob(orgId, userId, body) {
  const active = [...running.values()];
  if (active.some(s => s.orgId === orgId)) throw new AppError('A catalogue scrape is already running for your organisation. Wait for it to finish or stop it.', 409, 'BUSY');
  if (active.length >= MAX_RUNNING) throw new AppError('The server is busy with other scrapes. Try again in a minute.', 409, 'BUSY');
  // Take the slot now, before any await: two requests arriving together must not both pass the checks above.
  const slot = { cancelled: false, orgId }, key = Symbol('catalogue-slot');
  running.set(key, slot);
  let job;
  try {
  const pool = await getPool();
  const r = await pool.request().input('o', sql.Int, orgId).input('t', sql.NVarChar(30), body.business_type).input('n', sql.NVarChar(100), body.source_name)
    .input('u', sql.NVarChar(500), body.source_url).input('k', sql.NVarChar(500), (body.keywords || []).join(', ')).input('c', sql.NVarChar(100), body.category || null)
    .input('cfg', sql.NVarChar(sql.MAX), json(body.config)).input('by', sql.Int, userId)
    .query(`INSERT INTO catalogue_jobs (organization_id, business_type, source_name, source_url, keywords, category, config, created_by)
            OUTPUT INSERTED.* VALUES (@o, @t, @n, @u, @k, @c, @cfg, @by)`);
  job = r.recordset[0];
  running.set(job.id, slot);
  } finally { running.delete(key); }
  setImmediate(() => runJob(job.id));
  return job;
}
const cancelJob = (jobId, orgId) => { const s = running.get(jobId); if (s && s.orgId === orgId) { s.cancelled = true; return true; } return false; };
const isRunning = jobId => running.has(jobId);

/** A job left 'running' by a restart will never finish: mark it failed so it does not block the organisation. */
async function recover() {
  try { await (await getPool()).request().query("UPDATE catalogue_jobs SET status = 'failed', message = 'The server restarted while this scrape was running', finished_at = SYSUTCDATETIME() WHERE status IN ('queued', 'running')"); }
  catch (e) { console.error('[catalogue] recover:', e.message); }
}

// ── records ──
const FIELDS = {
  name: 200, brand: 80, sku: 60, barcode: 20, oem: 60, category: 100, subcategory: 100, unit: 20, pack_size: 60, image_url: 500, description: 1500,
};
function shape(row) { return { ...row, attributes: parse(row.attributes), issues: row.issues ? row.issues.split('; ') : [] }; }

/** Apply a user's edits, then work out the status again (it may now be valid, or now collide with a product). */
async function editRecord(orgId, id, patch) {
  const pool = await getPool();
  const row = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, orgId).query('SELECT r.*, j.business_type FROM catalogue_records r JOIN catalogue_jobs j ON j.id = r.job_id WHERE r.id = @id AND r.organization_id = @o')).recordset[0];
  if (!row) throw new AppError('Record not found', 404, 'NOT_FOUND');
  if (row.status === 'imported') throw new AppError('This record is already in your products. Edit the product instead.', 409, 'ALREADY_IMPORTED');
  const rec = { ...row, attributes: parse(row.attributes) };
  for (const [k, max] of Object.entries(FIELDS)) if (k in patch) rec[k] = cut(String(patch[k] ?? '').replace(/\s+/g, ' ').trim(), max);
  if ('barcode' in patch && rec.barcode && !N.gtin(rec.barcode)) throw new AppError('That is not a valid barcode (GTIN-8/12/13/14 with a correct check digit)', 400, 'INVALID_BARCODE');
  if (!rec.name) throw new AppError('A product name is required', 400, 'VALIDATION_FAILED');
  for (const k of ['price', 'wholesale_price']) if (k in patch) { const n = patch[k] === null || patch[k] === '' ? null : N.parsePrice(patch[k]); if (patch[k] !== null && patch[k] !== '' && n === null) throw new AppError(`${k.replace('_', ' ')} is not a valid amount`, 400, 'VALIDATION_FAILED'); rec[k] = n; }
  if (patch.attributes && typeof patch.attributes === 'object') {
    const a = {}; for (const [k, v] of Object.entries(patch.attributes)) { const s = String(v ?? '').trim().slice(0, 300); if (s && /^[a-z_]{1,40}$/.test(k)) a[k] = s; }
    rec.attributes = a;
  }
  const profile = await profileFor(orgId, row.business_type);
  const idx = await loadIndex(orgId, await getBusinessType(orgId));
  const others = new Set();
  const peers = (await pool.request().input('j', sql.Int, row.job_id).input('id', sql.Int, id).query("SELECT sku, barcode, oem, brand, name, pack_size, attributes FROM catalogue_records WHERE job_id = @j AND id < @id AND status <> 'ignored'")).recordset;
  for (const p of peers) remember({ ...p, attributes: parse(p.attributes) }, idx.orgType === 'tyre_shop', others);
  const ev = evaluate({ ...rec, issues: [] }, profile, idx, others);
  await pool.request().input('id', sql.Int, id)
    .input('name', sql.NVarChar(200), rec.name).input('brand', sql.NVarChar(80), rec.brand).input('sku', sql.NVarChar(60), rec.sku).input('barcode', sql.NVarChar(20), rec.barcode)
    .input('oem', sql.NVarChar(60), rec.oem).input('cat', sql.NVarChar(100), rec.category).input('sub', sql.NVarChar(100), rec.subcategory)
    .input('price', sql.Decimal(18, 2), rec.price).input('wp', sql.Decimal(18, 2), rec.wholesale_price).input('unit', sql.NVarChar(20), rec.unit).input('pack', sql.NVarChar(60), rec.pack_size)
    .input('img', sql.NVarChar(500), /^https?:\/\//i.test(rec.image_url || '') ? rec.image_url : null).input('desc', sql.NVarChar(1500), rec.description).input('attr', sql.NVarChar(sql.MAX), json(rec.attributes))
    .input('st', sql.NVarChar(10), ev.status).input('iss', sql.NVarChar(500), cut(ev.issues.join('; '), 500)).input('di', sql.Int, ev.duplicate_item_id).input('dr', sql.NVarChar(200), cut(ev.duplicate_reason, 200))
    .query(`UPDATE catalogue_records SET name=@name, brand=@brand, sku=@sku, barcode=@barcode, oem=@oem, category=@cat, subcategory=@sub, price=@price, wholesale_price=@wp, unit=@unit,
              pack_size=@pack, image_url=@img, description=@desc, attributes=@attr, status=@st, issues=@iss, duplicate_item_id=@di, duplicate_reason=@dr, edited=1 WHERE id=@id AND status <> 'imported'`);
  return shape((await pool.request().input('id', sql.Int, id).query('SELECT * FROM catalogue_records WHERE id = @id')).recordset[0]);
}

// ── import into the product master ──
const stripBrand = (name, brand) => (brand && name.toLowerCase().startsWith(brand.toLowerCase() + ' ') ? name.slice(brand.length).trim() : name);
function descriptionOf(rec) {
  const a = rec.attributes || {};
  const lines = Object.entries(a).filter(([k]) => !['specifications', 'model', 'width', 'aspect_ratio', 'rim_diameter', 'load_index', 'speed_rating', 'dot'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  const text = [rec.description, ...lines].filter(Boolean).join('. ');
  return cut(text, 500);
}
async function categoryId(tx, orgId, name) {
  if (!name) return null;
  const found = await new sql.Request(tx).input('o', sql.Int, orgId).input('n', sql.NVarChar(100), name).query('SELECT id FROM item_categories WHERE organization_id = @o AND LOWER(name) = LOWER(@n)');
  if (found.recordset.length) return found.recordset[0].id;
  return (await new sql.Request(tx).input('o', sql.Int, orgId).input('n', sql.NVarChar(100), name).query('INSERT INTO item_categories (organization_id, name) OUTPUT INSERTED.id VALUES (@o, @n)')).recordset[0].id;
}

/** Import approved records one by one (a bad record never blocks the others). Returns [{ id, ok, item_id?, error? }]. */
async function importRecords({ orgId, branchId, userId, ids, priceAs }) {
  const pool = await getPool();
  const orgType = await getBusinessType(orgId);
  const tyre = orgType === 'tyre_shop';
  const results = [];
  for (const id of ids) {
    const row = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, orgId).query('SELECT * FROM catalogue_records WHERE id = @id AND organization_id = @o')).recordset[0];
    if (!row) { results.push({ id, ok: false, code: 'NOT_FOUND', error: 'Record not found' }); continue; }
    if (row.status === 'imported') { results.push({ id, ok: false, code: 'ALREADY_IMPORTED', error: 'Already imported', item_id: row.item_id }); continue; }
    if (row.status === 'ignored') { results.push({ id, ok: false, code: 'IGNORED', error: 'Ignored records are not imported. Restore it first.' }); continue; }
    const rec = { ...row, attributes: parse(row.attributes) };
    // a fresh duplicate check at the moment of import: the product list may have changed since the scrape
    const idx = await loadIndex(orgId, orgType);
    const dup = findDuplicate(rec, idx, null);
    if (dup) {
      await pool.request().input('id', sql.Int, id).input('di', sql.Int, dup.item_id).input('dr', sql.NVarChar(200), cut(dup.reason, 200)).query("UPDATE catalogue_records SET status = 'duplicate', duplicate_item_id = @di, duplicate_reason = @dr WHERE id = @id");
      results.push({ id, ok: false, code: 'DUPLICATE', error: dup.reason + '. Existing products are never overwritten.', item_id: dup.item_id }); continue;
    }
    const a = rec.attributes;
    let brand = rec.brand || '', model, size;
    if (tyre) {
      size = a.width && a.aspect_ratio && a.rim_diameter ? `${a.width}/${a.aspect_ratio}R${a.rim_diameter}` : '';
      model = a.model || '';
      if (!brand || !model || !size) { results.push({ id, ok: false, code: 'INCOMPLETE', error: 'A tyre needs brand, model, width, aspect ratio and rim diameter. Edit the record to add them.' }); continue; }
    } else { model = stripBrand(rec.name, brand) || rec.name; size = rec.pack_size || ''; }
    const price = rec.price === null ? 0 : Number(rec.price);
    const sale = priceAs === 'cost' ? 0 : price, cost = priceAs === 'cost' ? price : Number(rec.wholesale_price || 0);
    const uom = IM.UOMS.includes(rec.unit) ? rec.unit : 'pcs';
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const cat = await categoryId(tx, orgId, rec.category);
      const ins = await new sql.Request(tx)
        .input('o', sql.Int, orgId).input('b', sql.Int, branchId).input('brand', sql.NVarChar, brand).input('model', sql.NVarChar, model.slice(0, 100)).input('size', sql.NVarChar, size)
        .input('type', sql.NVarChar, tyre ? 'Passenger' : null).input('cost', sql.Decimal(18, 2), cost).input('sale', sql.Decimal(18, 2), sale)
        .input('li', sql.NVarChar, tyre ? a.load_index || null : null).input('si', sql.NVarChar, tyre ? a.speed_rating || null : null).input('dot', sql.NVarChar, tyre ? a.dot || null : null)
        .input('sku', sql.NVarChar, rec.sku).input('barcode', sql.NVarChar, rec.barcode).input('desc', sql.NVarChar, descriptionOf(rec)).input('uom', sql.NVarChar, uom).input('cat', sql.Int, cat)
        .query(`INSERT INTO tires (organization_id, branch_id, brand, model, size, type, stock, cost_price, sale_price, reorder_level, load_index, speed_index, dot, sku, barcode, description, uom, category_id, is_active)
                OUTPUT INSERTED.id, INSERTED.sku VALUES (@o, @b, @brand, @model, @size, @type, 0, @cost, @sale, 10, @li, @si, @dot, @sku, @barcode, @desc, @uom, @cat, 1)`);
      const itemId = ins.recordset[0].id;
      if (!ins.recordset[0].sku) await new sql.Request(tx).input('id', sql.Int, itemId).query("UPDATE tires SET sku = 'SKU-' + RIGHT('000000' + CAST(id AS NVARCHAR(10)), 6) WHERE id = @id");
      await IM.logCreated(tx, { orgId, tireId: itemId, userId, name: [brand, model, size].filter(Boolean).join(' ') });
      await new sql.Request(tx).input('id', sql.Int, id).input('item', sql.Int, itemId).input('u', sql.Int, userId)
        .query("UPDATE catalogue_records SET status = 'imported', item_id = @item, imported_by = @u, imported_at = SYSUTCDATETIME() WHERE id = @id");
      await tx.commit();
      writeAudit(pool, { orgId, branchId, userId, action: 'CREATE', entity: 'inventory', entityId: itemId, before: null, after: { brand, model, size, sale_price: sale, source: 'catalogue', source_url: rec.source_url } });
      results.push({ id, ok: true, item_id: itemId });
    } catch (e) {
      try { await tx.rollback(); } catch { /* already rolled back */ }
      if (e.number === 2601 || e.number === 2627) {
        await pool.request().input('id', sql.Int, id).query("UPDATE catalogue_records SET status = 'duplicate', duplicate_reason = 'SKU or barcode is already used by another product' WHERE id = @id");
        results.push({ id, ok: false, code: 'DUPLICATE', error: 'SKU or barcode is already used by another product' });
      } else { console.error('[catalogue] import', e.message); results.push({ id, ok: false, code: 'FAILED', error: 'Could not import this record' }); }
    }
  }
  return results;
}

module.exports = { startJob, cancelJob, isRunning, recover, runJob, profileFor, editRecord, importRecords, shape, evaluate, findDuplicate, loadIndex, FIELDS };
