// Business-aware catalogue scraper API (Settings > Catalogue Scraper). The engine is in catalogue/; what each business type extracts is data in
// catalogue/profiles.js. Everything is organisation-scoped. Nothing reaches the product master except through POST /records/import.
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db');
const { getContext } = require('../context');
const { writeAudit } = require('../utils/audit');
const { AppError, handleError } = require('../utils/errors');
const { v, validate } = require('../utils/validate');
const { getBusinessType } = require('../utils/businessTypes');
const P = require('../utils/permissions');
const Prof = require('../catalogue/profiles');
const Svc = require('../catalogue/service');
const { checkUrl } = require('../catalogue/netguard');

const fail = (res, e) => handleError(res, e, 'catalogue');
const audit = async (req, action, entity, entityId, before, after) => {
  const { orgId, branchId } = getContext(req);
  return writeAudit(await getPool(), { orgId, branchId, userId: req.user.userId, action, entity, entityId, before, after });
};
router.use(P.requirePermission('inventory.manage_items'));

const TYPE = v.enum(Prof.BUSINESS_TYPES);
const SEL = v.string({ max: 200, optional: true, nullable: true });
const JOB = {
  business_type: TYPE, source_name: v.string({ min: 1, max: 100 }), source_url: v.string({ min: 8, max: 500 }),
  keywords: v.array(v.string({ max: 60 }), { max: 20, optional: true }), category: v.string({ max: 100, optional: true, nullable: true }),
  max_pages: v.int({ min: 1, max: 10, optional: true }), follow_details: v.bool({ optional: true }),
  selectors: v.shape({ item: SEL, name: SEL, price: SEL, image: SEL, link: SEL, next: SEL }, { optional: true }),
};
const PROFILE = {
  keywords: v.array(v.string({ max: 60 }), { max: 30, optional: true }),
  categories: v.array(v.shape({ name: v.string({ min: 1, max: 100 }), match: v.array(v.string({ max: 60 }), { max: 20, optional: true }) }), { max: 40, optional: true }),
  required: v.array(v.string({ max: 40 }), { max: 40, optional: true }), max_pages: v.int({ min: 1, max: 10, optional: true }),
};
const IDS = { ids: v.array(v.int({ min: 1 }), { min: 1, max: 200 }) };
const STATUSES = ['pending', 'validated', 'duplicate', 'ignored', 'imported'];

const jobIn = async (orgId, id) => {
  const r = (await (await getPool()).request().input('id', sql.Int, id).input('o', sql.Int, orgId).query('SELECT * FROM catalogue_jobs WHERE id = @id AND organization_id = @o')).recordset[0];
  if (!r) throw new AppError('Scrape not found', 404, 'NOT_FOUND');
  return r;
};
const intParam = (req, name = 'id') => { const n = parseInt(req.params[name], 10); if (!Number.isInteger(n) || n < 1) throw new AppError('Not found', 404, 'NOT_FOUND'); return n; };

// ── profiles ──
router.get('/profiles', async (req, res) => {
  try { res.json({ types: Prof.BUSINESS_TYPES, current: await getBusinessType(getContext(req).orgId) }); } catch (e) { fail(res, e); }
});
router.get('/profile/:type', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const type = validate({ type: req.params.type }, { type: TYPE }).type;
    const saved = (await (await getPool()).request().input('o', sql.Int, orgId).input('t', sql.NVarChar(30), type).query('SELECT 1 AS x FROM catalogue_profiles WHERE organization_id = @o AND business_type = @t')).recordset.length > 0;
    res.json({ ...(await Svc.profileFor(orgId, type)), customised: saved, defaults: Prof.base(type) });
  } catch (e) { fail(res, e); }
});
router.put('/profile/:type', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const type = validate({ type: req.params.type }, { type: TYPE }).type;
    const body = validate(req.body, PROFILE);
    const known = new Set(Prof.base(type).fields.map(f => f.key));
    if (body.required && body.required.some(k => !known.has(k))) throw new AppError('Unknown attribute in the required list', 400, 'VALIDATION_FAILED');
    const before = await Svc.profileFor(orgId, type);
    await (await getPool()).request().input('o', sql.Int, orgId).input('t', sql.NVarChar(30), type).input('c', sql.NVarChar(sql.MAX), JSON.stringify(body)).input('u', sql.Int, req.user.userId)
      .query(`MERGE catalogue_profiles AS t USING (SELECT @o AS organization_id, @t AS business_type) AS s ON t.organization_id = s.organization_id AND t.business_type = s.business_type
              WHEN MATCHED THEN UPDATE SET config = @c, updated_by = @u, updated_at = SYSUTCDATETIME()
              WHEN NOT MATCHED THEN INSERT (organization_id, business_type, config, updated_by) VALUES (@o, @t, @c, @u);`);
    await audit(req, 'UPDATE', 'catalogue_profile', null, { type, keywords: before.keywords }, { type, ...body });
    res.json({ ...(await Svc.profileFor(orgId, type)), customised: true, defaults: Prof.base(type) });
  } catch (e) { fail(res, e); }
});
router.delete('/profile/:type', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const type = validate({ type: req.params.type }, { type: TYPE }).type;
    await (await getPool()).request().input('o', sql.Int, orgId).input('t', sql.NVarChar(30), type).query('DELETE FROM catalogue_profiles WHERE organization_id = @o AND business_type = @t');
    await audit(req, 'DELETE', 'catalogue_profile', null, { type }, null);
    res.json({ ...(await Svc.profileFor(orgId, type)), customised: false, defaults: Prof.base(type) });
  } catch (e) { fail(res, e); }
});

// ── jobs ──
router.get('/jobs', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const rows = (await (await getPool()).request().input('o', sql.Int, orgId).query(`
      SELECT TOP 30 j.id, j.business_type, j.source_name, j.source_url, j.keywords, j.category, j.status, j.pages_fetched, j.found, j.message, j.created_at, j.started_at, j.finished_at,
             (SELECT COUNT(*) FROM catalogue_records r WHERE r.job_id = j.id AND r.status = 'imported') AS imported
      FROM catalogue_jobs j WHERE j.organization_id = @o ORDER BY j.id DESC`)).recordset;
    res.json(rows.map(r => ({ ...r, running: Svc.isRunning(r.id) })));
  } catch (e) { fail(res, e); }
});
router.post('/jobs', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const b = validate(req.body, JOB);
    try { checkUrl(b.source_url.trim()); } catch (e) { throw new AppError(e.message, 400, 'INVALID_SOURCE'); }
    const config = { max_pages: b.max_pages, follow_details: b.follow_details, selectors: b.selectors };
    const job = await Svc.startJob(orgId, req.user.userId, { ...b, source_url: b.source_url.trim(), source_name: b.source_name.trim(), keywords: (b.keywords || []).map(s => s.trim()).filter(Boolean), config });
    await audit(req, 'CREATE', 'catalogue_job', job.id, null, { business_type: b.business_type, source_url: b.source_url, keywords: b.keywords });
    res.status(202).json(job);
  } catch (e) { fail(res, e); }
});
router.get('/jobs/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = intParam(req);
    const job = await jobIn(orgId, id);
    const counts = (await (await getPool()).request().input('j', sql.Int, id).query('SELECT status, COUNT(*) AS n FROM catalogue_records WHERE job_id = @j GROUP BY status')).recordset;
    res.json({ ...job, config: undefined, running: Svc.isRunning(id), counts: Object.fromEntries(STATUSES.map(s => [s, counts.find(c => c.status === s)?.n || 0])) });
  } catch (e) { fail(res, e); }
});
router.post('/jobs/:id/cancel', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = intParam(req);
    await jobIn(orgId, id);
    res.json({ cancelled: Svc.cancelJob(id, orgId) });
  } catch (e) { fail(res, e); }
});
router.delete('/jobs/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = intParam(req);
    const job = await jobIn(orgId, id);
    if (Svc.isRunning(id)) throw new AppError('Stop the scrape before deleting it', 409, 'BUSY');
    const pool = await getPool();
    await pool.request().input('j', sql.Int, id).query('DELETE FROM catalogue_records WHERE job_id = @j; DELETE FROM catalogue_raw WHERE job_id = @j; DELETE FROM catalogue_jobs WHERE id = @j;');
    await audit(req, 'DELETE', 'catalogue_job', id, { source_url: job.source_url, found: job.found }, null);
    res.json({ deleted: true });
  } catch (e) { fail(res, e); }
});

// ── records ──
const COLS = 'id, job_id, source_url, extracted_at, name, brand, sku, barcode, oem, category, subcategory, price, wholesale_price, currency, unit, pack_size, image_url, description, attributes, status, issues, duplicate_item_id, duplicate_reason, edited, item_id';
router.get('/jobs/:id/records', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = intParam(req);
    await jobIn(orgId, id);
    const q = validate(req.query, { status: v.enum(STATUSES, { optional: true }), q: v.string({ max: 100, optional: true }), limit: v.int({ min: 1, max: 500, optional: true }), offset: v.int({ min: 0, optional: true }) });
    const rq = (await getPool()).request().input('j', sql.Int, id).input('lim', sql.Int, q.limit ?? 100).input('off', sql.Int, q.offset ?? 0);
    let where = 'job_id = @j';
    if (q.status) { rq.input('st', sql.NVarChar(10), q.status); where += ' AND status = @st'; }
    if (q.q) { rq.input('q', sql.NVarChar(120), `%${q.q.replace(/[%_[]/g, '[$&]')}%`); where += ' AND (name LIKE @q OR brand LIKE @q OR sku LIKE @q OR barcode LIKE @q OR category LIKE @q)'; }
    const total = (await rq.query(`SELECT COUNT(*) AS n FROM catalogue_records WHERE ${where}`)).recordset[0].n;
    const rq2 = (await getPool()).request().input('j', sql.Int, id).input('lim', sql.Int, q.limit ?? 100).input('off', sql.Int, q.offset ?? 0);
    if (q.status) rq2.input('st', sql.NVarChar(10), q.status);
    if (q.q) rq2.input('q', sql.NVarChar(120), `%${q.q.replace(/[%_[]/g, '[$&]')}%`);
    const rows = (await rq2.query(`SELECT ${COLS} FROM catalogue_records WHERE ${where} ORDER BY id OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`)).recordset;
    res.json({ total, rows: rows.map(Svc.shape) });
  } catch (e) { fail(res, e); }
});
router.get('/records/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = intParam(req);
    const pool = await getPool();
    const row = (await pool.request().input('id', sql.Int, id).input('o', sql.Int, orgId).query(`SELECT ${COLS}, raw_id FROM catalogue_records WHERE id = @id AND organization_id = @o`)).recordset[0];
    if (!row) throw new AppError('Record not found', 404, 'NOT_FOUND');
    const raw = row.raw_id ? (await pool.request().input('r', sql.Int, row.raw_id).query('SELECT source_url, fetched_at, via, payload FROM catalogue_raw WHERE id = @r')).recordset[0] : null;
    let payload = null; try { payload = raw ? JSON.parse(raw.payload) : null; } catch { /* unreadable raw payload: show none */ }
    if (payload) delete payload.source_node;
    res.json({ ...Svc.shape(row), raw: raw ? { source_url: raw.source_url, fetched_at: raw.fetched_at, via: raw.via, data: payload } : null });
  } catch (e) { fail(res, e); }
});
const EDIT = {
  name: v.string({ max: 200, optional: true }), brand: v.string({ max: 80, optional: true, nullable: true }), sku: v.string({ max: 60, optional: true, nullable: true }), barcode: v.string({ max: 20, optional: true, nullable: true }),
  oem: v.string({ max: 60, optional: true, nullable: true }), category: v.string({ max: 100, optional: true, nullable: true }), subcategory: v.string({ max: 100, optional: true, nullable: true }),
  price: v.custom((x, k) => (x === null || x === '' || Number.isFinite(Number(x)) ? [null, x] : [`${k} must be a number`]), { optional: true, nullable: true }),
  wholesale_price: v.custom((x, k) => (x === null || x === '' || Number.isFinite(Number(x)) ? [null, x] : [`${k} must be a number`]), { optional: true, nullable: true }),
  unit: v.string({ max: 20, optional: true, nullable: true }), pack_size: v.string({ max: 60, optional: true, nullable: true }), image_url: v.string({ max: 500, optional: true, nullable: true }),
  description: v.string({ max: 1500, optional: true, nullable: true }), attributes: v.object({ optional: true }),
};
router.put('/records/:id', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = intParam(req);
    const body = validate(req.body, EDIT);
    const rec = await Svc.editRecord(orgId, id, body);
    await audit(req, 'UPDATE', 'catalogue_record', id, null, { fields: Object.keys(body) });
    res.json(rec);
  } catch (e) { fail(res, e); }
});
router.post('/records/ignore', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { ids } = validate(req.body, IDS);
    const rq = (await getPool()).request().input('o', sql.Int, orgId);
    ids.forEach((x, i) => rq.input('i' + i, sql.Int, x));
    const r = await rq.query(`UPDATE catalogue_records SET status = 'ignored' WHERE organization_id = @o AND status <> 'imported' AND id IN (${ids.map((_, i) => '@i' + i).join(',')})`);
    res.json({ updated: r.rowsAffected[0] });
  } catch (e) { fail(res, e); }
});
router.post('/records/restore', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const { ids } = validate(req.body, IDS);
    const pool = await getPool();
    const rows = (await pool.request().input('o', sql.Int, orgId).query(`SELECT id FROM catalogue_records WHERE organization_id = @o AND status = 'ignored' AND id IN (${ids.map(Number).join(',')})`)).recordset;
    for (const r of rows) await Svc.editRecord(orgId, r.id, {});     // re-checks it against the product list
    res.json({ updated: rows.length });
  } catch (e) { fail(res, e); }
});
router.post('/records/import', async (req, res) => {
  try {
    const { orgId, branchId } = getContext(req);
    const b = validate(req.body, { ...IDS, price_as: v.enum(['sale', 'cost'], { optional: true }) });
    const results = await Svc.importRecords({ orgId, branchId, userId: req.user.userId, ids: b.ids, priceAs: b.price_as || 'sale' });
    const imported = results.filter(r => r.ok).length;
    if (imported) await audit(req, 'CREATE', 'catalogue_import', null, null, { imported, requested: b.ids.length, price_as: b.price_as || 'sale' });
    res.json({ imported, failed: results.length - imported, results });
  } catch (e) { fail(res, e); }
});

// ── export ──
const csvCell = x => {
  let s = x === null || x === undefined ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x));
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                        // a spreadsheet must not run a scraped value as a formula
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
router.get('/jobs/:id/export', async (req, res) => {
  try {
    const { orgId } = getContext(req);
    const id = intParam(req);
    const job = await jobIn(orgId, id);
    const profile = await Svc.profileFor(orgId, job.business_type);
    const attrKeys = profile.fields.filter(f => !Prof.CORE.includes(f.key));
    const rows = (await (await getPool()).request().input('j', sql.Int, id).query(`SELECT ${COLS} FROM catalogue_records WHERE job_id = @j ORDER BY id`)).recordset.map(Svc.shape);
    const head = ['Product name', 'SKU', 'Barcode', 'OEM number', 'Brand', 'Category', 'Subcategory', 'Price', 'Wholesale price', 'Currency', 'Unit', 'Package size', ...attrKeys.map(f => f.label), 'Image', 'Source URL', 'Extracted at', 'Status', 'Notes'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of rows) lines.push([r.name, r.sku, r.barcode, r.oem, r.brand, r.category, r.subcategory, r.price, r.wholesale_price, r.currency, r.unit, r.pack_size, ...attrKeys.map(f => r.attributes[f.key]),
      r.image_url, r.source_url, r.extracted_at && new Date(r.extracted_at).toISOString(), r.status, [...r.issues, r.duplicate_reason].filter(Boolean).join('; ')].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="catalogue-${id}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  } catch (e) { fail(res, e); }
});

module.exports = router;
