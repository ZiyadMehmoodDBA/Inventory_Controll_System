// AI Reporting API. Identity, organisation, branch and role come ONLY from the verified JWT
// (req.user, set by requireAuth); nothing scope-related is read from the request body or headers.
const express   = require('express');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const { scopeFromUser } = require('../reporting/policy');
const { REPORTS }       = require('../reporting/registry');
const service           = require('../reporting/service');
const store             = require('../reporting/store');
const { validateSpec }  = require('../reporting/validator');
const { canAccess }     = require('../reporting/policy');

const perUser = (windowMs, max, message) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => `u${req.user?.userId ?? 'anon'}`,
  validate: { keyGeneratorIpFallback: false },
  message: { error: message },
});
const askLimiter    = perUser(60 * 1000, 20, 'Too many report requests. Please wait a minute.');
const exportLimiter = perUser(60 * 1000, 10, 'Too many exports. Please wait a minute.');

// Only these keys may come from a client-supplied spec.
function cleanSpec(s) {
  if (!s || typeof s !== 'object') return null;
  const out = { reportId: String(s.reportId || '') };
  if (s.period !== undefined) out.period = s.period;
  if (s.days !== undefined) out.days = s.days;
  if (s.limit !== undefined) out.limit = s.limit;
  if (s.entityId !== undefined) out.entityId = s.entityId;
  if (s.entityKind !== undefined) out.entityKind = s.entityKind;
  return out;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;   // spreadsheet formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(result) {
  const cols = result.evidence.columns;
  const lines = [cols.map(c => csvCell(c.label)).join(',')];
  for (const r of result.evidence.rows) lines.push(cols.map(c => csvCell(r[c.key])).join(','));
  return lines.join('\r\n');
}

router.get('/definitions', (req, res) => {
  res.json({ definitions: service.listDefinitions(req.user.role), suggestions: service.SUGGESTIONS });
});

router.post('/ask', askLimiter, async (req, res) => {
  try {
    const scope = scopeFromUser(req.user);
    const { question, spec } = req.body || {};
    res.json(await service.ask(scope, { question, spec: spec ? cleanSpec(spec) : undefined }));
  } catch (err) {
    console.error('[reports/ask]', err.message);
    res.status(500).json({ status: 'error', message: 'The report could not be generated.' });
  }
});

router.get('/history', async (req, res) => {
  try { res.json(await store.listHistory(scopeFromUser(req.user))); }
  catch (err) { console.error('[reports/history]', err.message); res.status(500).json({ error: 'Could not load history' }); }
});

router.get('/saved', async (req, res) => {
  try { res.json(await store.listSaved(scopeFromUser(req.user))); }
  catch (err) { console.error('[reports/saved]', err.message); res.status(500).json({ error: 'Could not load saved reports' }); }
});

router.post('/saved', async (req, res) => {
  try {
    const scope = scopeFromUser(req.user);
    const name = String(req.body?.name || '').trim().slice(0, 150);
    const spec = cleanSpec(req.body?.spec);
    if (!name || !spec) return res.status(400).json({ error: 'Name and report are required' });
    const def = REPORTS[spec.reportId];
    if (!def || !Object.prototype.hasOwnProperty.call(REPORTS, spec.reportId)) return res.status(400).json({ error: 'Unknown report' });
    if (!canAccess(scope.role, def.classification)) {
      await store.recordAccess(scope, { reportId: spec.reportId, classification: def.classification, action: 'save', outcome: 'denied' });
      return res.status(403).json({ error: 'Insufficient permissions for this report' });
    }
    const policy = await store.getPolicy(scope.orgId);
    const v = validateSpec(spec, policy);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const id = await store.createSaved(scope, { name, reportId: spec.reportId, spec, question: req.body?.question });
    await store.recordAccess(scope, { reportId: spec.reportId, classification: def.classification, action: 'save', outcome: 'success' });
    res.status(201).json({ id });
  } catch (err) { console.error('[reports/saved POST]', err.message); res.status(500).json({ error: 'Could not save report' }); }
});

router.delete('/saved/:id', async (req, res) => {
  try {
    const ok = await store.deleteSaved(scopeFromUser(req.user), parseInt(req.params.id, 10));
    res.status(ok ? 200 : 404).json(ok ? { success: true } : { error: 'Not found' });
  } catch (err) { console.error('[reports/saved DELETE]', err.message); res.status(500).json({ error: 'Could not delete' }); }
});

// Saved reports are re-authorised and re-validated on every run and export.
async function runSaved(req, action) {
  const scope = scopeFromUser(req.user);
  const saved = await store.getSaved(scope, parseInt(req.params.id, 10));
  if (!saved) return { notFound: true };
  return { result: await service.runSpec(scope, saved.params, { question: saved.question || saved.name, action }) };
}

router.post('/saved/:id/run', askLimiter, async (req, res) => {
  try {
    const r = await runSaved(req, 'run');
    if (r.notFound) return res.status(404).json({ error: 'Not found' });
    res.json(r.result);
  } catch (err) { console.error('[reports/saved run]', err.message); res.status(500).json({ status: 'error', message: 'The report could not be generated.' }); }
});

function sendCsv(res, result, filenameBase) {
  if (result.status !== 'ok') return res.status(result.status === 'denied' ? 403 : 400).json(result);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase.replace(/[^a-z0-9_-]/gi, '_')}.csv"`);
  res.send('﻿' + toCsv(result));
}

router.post('/saved/:id/export', exportLimiter, async (req, res) => {
  try {
    const r = await runSaved(req, 'export');
    if (r.notFound) return res.status(404).json({ error: 'Not found' });
    sendCsv(res, r.result, r.result.reportId || 'report');
  } catch (err) { console.error('[reports/saved export]', err.message); res.status(500).json({ error: 'Export failed' }); }
});

// Export an ad-hoc report: body is a spec; it is re-authorised and re-run, never taken as data from the client.
router.post('/:reportId/export', exportLimiter, async (req, res) => {
  try {
    const spec = cleanSpec({ ...(req.body?.spec || {}), reportId: req.params.reportId });
    const result = await service.runSpec(scopeFromUser(req.user), spec, { question: 'export', action: 'export' });
    sendCsv(res, result, req.params.reportId);
  } catch (err) { console.error('[reports/export]', err.message); res.status(500).json({ error: 'Export failed' }); }
});

router.get('/:reportId', (req, res) => {
  const def = Object.prototype.hasOwnProperty.call(REPORTS, req.params.reportId) ? REPORTS[req.params.reportId] : null;
  if (!def || !canAccess(req.user.role, def.classification)) return res.status(404).json({ error: 'Not found' });
  res.json({ id: req.params.reportId, title: def.title, domain: def.domain, classification: def.classification, description: def.description,
    metric: def.metric, columns: def.columns, caveats: def.caveats });
});

module.exports = router;
