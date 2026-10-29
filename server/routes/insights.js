// Inventory dashboard and standard reports (read-only). Mounted on /api/inventory/insights before routes/inventory.js.
// Scope: branch users and managers see their own branch; an organisation administrator sees the selected branch, or every branch with ?scope=org.
const express = require('express');
const router  = express.Router();
const { getPool }    = require('../db');
const { writeAudit } = require('../utils/audit');
const { getContext } = require('../context');
const I = require('../utils/insights');
const { handleError, AppError } = require('../utils/errors');
const P = require('../utils/permissions');
const K = require('../utils/kpis');
const Ls = require('../utils/losses');
const { v, validate } = require('../utils/validate');

// Everything here needs the inventory reports permission; valuation and audit reports ask for their own; exports for the export permission.
router.use('/insights', P.requirePermission('reports.inventory'));

const scopeOf = req => {
  const { orgId, branchId } = getContext(req);
  const org = req.user.role === 'org_admin' && req.query.scope === 'org';
  return { orgId, branchId: org ? null : (req.user.branchId ?? branchId), role: req.user.role, userId: req.user.userId, can: code => P.has(req.user, code) };
};

const fail = (res, err) => handleError(res, err, 'insights');

router.get('/insights/dashboard', async (req, res) => {
  try { res.json(await I.dashboard(scopeOf(req))); } catch (err) { fail(res, err); }
});

// Performance scorecard: eleven measures against configured targets. ?days=30|90|180|365 (default 90) or ?from=&to=.
// Money measures are withheld from users without the cost permission; targets and the carrying-cost rate are policy and need policy.configure.
router.get('/insights/kpis', async (req, res) => {
  try {
    const q = validate(req.query, { days: v.int({ min: 1, max: 730, optional: true }), from: v.string({ max: 10, pattern: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, optional: true }), to: v.string({ max: 10, pattern: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/, optional: true }) });
    const range = Ls.periodOf(q.from, q.to, q.days ?? 90);
    if (range.start > range.end) throw new AppError('The start date is after the end date', 400, 'VALIDATION_FAILED');
    const res0 = await K.compute(scopeOf(req), range);
    res.json(P.has(req.user, 'inventory.view_cost') ? res0 : K.redact(res0));
  } catch (err) { fail(res, err); }
});

router.put('/insights/kpis/targets', P.requirePermission('policy.configure'), async (req, res) => {
  try {
    const body = validate(req.body, { targets: v.object({ optional: true }), carrying_cost_rate: v.number({ optional: true, nullable: true, emptyIsNull: true }) });
    const scope = scopeOf(req);
    const pool = await getPool();
    const before = await K.loadConfig(pool, scope.orgId);
    const after = await K.saveConfig(pool, scope.orgId, body);
    writeAudit(pool, { orgId: scope.orgId, branchId: scope.branchId ?? req.user.branchId ?? 1, userId: req.user.userId, action: 'UPDATE', entity: 'kpi_targets', entityId: 0, before, after });
    res.json(after);
  } catch (err) { fail(res, err); }
});

router.get('/insights/reports', (req, res) => {
  res.json(I.REPORTS.filter(r => !r.perm || P.has(req.user, r.perm)).map(({ perm, ...r }) => ({ ...r, exportable: P.has(req.user, 'reports.export') })));
});

// ?export=xlsx|pdf|print is sent by the screen when it builds one of those files from the full report; it lifts the row limit and leaves an audit record.
router.get('/insights/reports/:id', async (req, res) => {
  try {
    const scope = scopeOf(req);
    const exporting = ['xlsx', 'pdf', 'print'].includes(String(req.query.export));
    if (exporting && !P.has(req.user, 'reports.export')) { P.requirePermission('reports.export')(req, res, () => {}); return; }
    const rep = await I.runReport(req.params.id, scope, exporting ? { ...req.query, limit: 50000 } : req.query);
    if (exporting) {
      writeAudit(await getPool(), { orgId: scope.orgId, branchId: scope.branchId ?? req.user.branchId ?? 1, userId: req.user.userId, action: 'EXPORT', entity: 'inventory_report', entityId: 0,
        before: null, after: { report: rep.id, format: req.query.export, rows: rep.row_count, from: rep.filters.from, to: rep.filters.to } });
    }
    res.json(rep);
  } catch (err) { fail(res, err); }
});

// Spreadsheet formula injection guard: a text cell that starts with = + - @ is prefixed with a quote.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : String(v);
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const iso = v => (v instanceof Date ? v.toISOString() : String(v));
const cellOf = (c, v) => (c.type === 'datetime' && v ? iso(v).slice(0, 16).replace('T', ' ') : c.type === 'date' && v ? iso(v).slice(0, 10) : v);

router.get('/insights/reports/:id/export', P.requirePermission('reports.export'), async (req, res) => {
  try {
    const scope = scopeOf(req);
    const rep = await I.runReport(req.params.id, scope, { ...req.query, limit: 50000 });
    const lines = [rep.columns.map(c => csvCell(c.label)).join(',')];
    for (const r of rep.rows) lines.push(rep.columns.map(c => csvCell(cellOf(c, r[c.key]))).join(','));
    if (Object.keys(rep.totals).length) lines.push(rep.columns.map((c, i) => (i === 0 ? 'Total' : csvCell(rep.totals[c.key] ?? ''))).join(','));
    writeAudit(await getPool(), { orgId: scope.orgId, branchId: scope.branchId ?? req.user.branchId ?? 1, userId: req.user.userId, action: 'EXPORT', entity: 'inventory_report', entityId: 0,
      before: null, after: { report: rep.id, rows: rep.row_count, from: rep.filters.from, to: rep.filters.to } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${rep.id}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  } catch (err) { fail(res, err); }
});

module.exports = router;
