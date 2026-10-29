process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 500)}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;
(async () => {
  const pool = await getPool();
  const mkOrg = async nm => {
    const org = (await pool.request().input('n', sql.NVarChar(100), nm).query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@n, 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'L Supply', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR))")).recordset[0].id;
    return { org, br, sup };
  };
  const A = await mkOrg('SMOKE ORG13'), B = await mkOrg('SMOKE ORG13B');
  const { org, br, sup } = A;
  const tok = (o, role, uid) => jwt.sign({ userId: uid, orgId: o.org, branchId: role === 'staff' ? o.br : null, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok(A, 'org_admin', 1001), staff = tok(A, 'staff', 1002), mgr = tok(A, 'branch_manager', 1003), demo = tok(A, 'demo', 1004), admin2 = tok(B, 'org_admin', 2001);
  const call = async (m, p, body, t = admin, branch = br) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(branch) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  let n = 0;
  const mk = async (model, extra = {}) => {
    const r = await call('POST', '/inventory', { model, cost_price: 10, sale_price: 20, ...extra });
    if (r.status !== 201 && r.status !== 200) throw new Error('create ' + model + ' ' + JSON.stringify(r.body));
    return r.body.id;
  };
  const receive = (tire, qty, it = {}) => call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: [{ tire_id: tire, tire_name: 'x', qty: qty + (++n) * 0, unit_price: 10, ...it }] });
  const adj = (tire, qty, code, t = admin, extra = {}) => call('POST', '/inventory/adjustments', { tire_id: tire, qty_change: qty, reason_code: code, notes: `n${++n}`, ...extra }, t);
  const sell = (tire, qty) => call('POST', '/sales', { date: day(0), items: [{ tire_id: tire, qty, unit_price: 20 + (++n) / 100 }], tax_rate: 0 });
  const stockOf = async id => (await call('GET', `/inventory/position/${id}`)).body.on_hand;
  const sum = async (q = '') => (await call('GET', '/inventory/losses/summary' + q)).body;
  const backdate = async (tire, days) => {
    await pool.request().input('t', sql.Int, tire).input('d', sql.Int, days).query('UPDATE tires SET created_at = DATEADD(DAY, -@d, GETDATE()) WHERE id = @t');
    await pool.request().input('t', sql.Int, tire).input('d', sql.Int, days).query("EXEC sp_set_session_context N'allow_purge', 1; UPDATE stock_movements SET created_at = DATEADD(DAY, -@d, GETDATE()) WHERE tire_id = @t");
  };
  try {
    // ── reasons & validation ──
    let r = await call('GET', '/inventory/adjustments/reasons');
    const codes = r.body.map(x => x.code);
    check('new physical-loss reasons offered', ['deterioration', 'contamination', 'missing_stock', 'handling_error', 'obsolete_writeoff', 'loss_theft', 'damage', 'expiry_writeoff'].every(c => codes.includes(c)), codes.join());
    r = await call('GET', '/inventory/losses/meta');
    check('meta lists causes, loss reasons with their cause, classes and defaults', r.body.causes.length === 10 && r.body.reasons.find(x => x.code === 'damage').cause === 'breakage' && r.body.classes.length === 4 && r.body.settings.obs_slow_days === 90, JSON.stringify(r.body).slice(0, 200));

    const L1 = await mk('Loss item', { supplier_id: sup, stock: 0 });
    await receive(L1, 300);
    check('loss item stocked', (await stockOf(L1)) === 300);
    r = await adj(L1, 3, 'damage');
    check('a loss reason cannot increase stock', r.status === 400 && r.body.code === 'INVALID_DIRECTION', JSON.stringify(r.body));
    r = await call('POST', '/inventory/adjustments', { tire_id: L1, qty_change: -1, reason_code: 'missing_stock' });
    check('missing stock needs an explanation', r.status === 400 && r.body.code === 'NOTES_REQUIRED', JSON.stringify(r.body));

    // ── recording write-offs with approval ──
    r = await adj(L1, -5, 'damage');
    check('admin write-off posts at once', r.status === 201 && r.body.status === 'approved', JSON.stringify(r.body));
    r = await adj(L1, -3, 'loss_theft', staff);
    const pendingTheft = r.body.id;
    check('staff write-off waits for approval and moves no stock', r.status === 202 && r.body.status === 'pending' && (await stockOf(L1)) === 295, JSON.stringify(r.body));
    r = await call('POST', `/inventory/adjustments/${pendingTheft}/approve`, {}, mgr);
    check('manager cannot approve a restricted reason (theft)', r.status === 403 && r.body.code === 'RESTRICTED_REASON' && (await stockOf(L1)) === 295, JSON.stringify(r.body));
    r = await call('POST', `/inventory/adjustments/${pendingTheft}/approve`, {}, admin);
    check('administrator approves it', r.status === 200 && (await stockOf(L1)) === 292, JSON.stringify(r.body));
    r = await adj(L1, -2, 'contamination', mgr);
    check('manager write-off under the usual limits posts directly', r.status === 201, JSON.stringify(r.body));

    r = await call('PUT', '/inventory/losses/settings', { loss_writeoff_approval_value: 100 }, mgr);
    check('only admin can set the write-off approval value', r.status === 403, r.status);
    r = await call('PUT', '/inventory/losses/settings', { loss_writeoff_approval_value: 100 });
    check('approval value saved', r.status === 200 && r.body.loss_writeoff_approval_value === 100, JSON.stringify(r.body));
    r = await adj(L1, -20, 'damage', mgr);
    const bigId = r.body.id;
    check('manager write-off above the value limit needs approval', r.status === 202 && r.body.status === 'pending', JSON.stringify(r.body));
    r = await call('POST', `/inventory/adjustments/${bigId}/approve`, {}, mgr);
    check('manager cannot approve their own', r.status === 403, r.status);
    r = await call('POST', `/inventory/adjustments/${bigId}/approve`, {});
    check('admin approves the large write-off', r.status === 200, JSON.stringify(r.body));
    r = await adj(L1, -5, 'deterioration', mgr);
    check('below the limit stays direct', r.status === 201, JSON.stringify(r.body));
    r = await adj(L1, -30, 'internal_use', mgr);
    check('non-loss reasons ignore the loss limit', r.status === 201, JSON.stringify(r.body));
    for (let i = 0; i < 3; i++) await adj(L1, -2, 'expiry_writeoff');
    r = await call('POST', '/inventory/adjustments', { tire_id: L1, qty_change: -4, reason_code: 'count_correction', notes: 'cycle count short' });
    await call('POST', '/inventory/adjustments', { tire_id: L1, qty_change: -1, reason_code: 'missing_stock', notes: 'unexplained gap' });
    await adj(L1, -1, 'obsolete_writeoff');
    await adj(L1, 4, 'found');
    await adj(L1, 2, 'count_correction');
    await adj(L1, -2, 'return_to_supplier');
    check('ledger holds the expected stock after all records', (await stockOf(L1)) === 300 - 5 - 3 - 2 - 20 - 5 - 30 - 6 - 4 - 1 - 1 + 4 + 2 - 2, await stockOf(L1));

    // ── tracked batches: disposals ──
    const D = await mk('Batch item', { tracking: 'batch', track_expiry: true, stock: 0 });
    await receive(D, 10, { batch_no: 'D1', expiry_date: day(90) });
    await receive(D, 11, { batch_no: 'D2', expiry_date: day(40) });
    await receive(D, 12, { batch_no: 'D3', expiry_date: day(80) });
    const bl = (await call('GET', '/inventory/quality/batches?tire_id=' + D)).body;
    const bid = no => bl.find(b => b.batch_no === no).batch_id;
    await pool.request().input('i', sql.Int, bid('D2')).query('UPDATE stock_batches SET expiry_date = DATEADD(DAY, -5, CAST(GETDATE() AS DATE)) WHERE id = @i');
    let s = await sum();
    check('expired stock on hand shows as exposure before any write-off', s.exposure.expired.units === 11 && near(s.exposure.expired.value, 110), JSON.stringify(s.exposure.expired));
    r = await call('POST', `/inventory/quality/batches/${bid('D1')}/dispose`, { qty: 4, method: 'destroy', reason: 'Seal broken, contaminated', loss_cause: 'contamination' }, mgr);
    check('disposal accepts a loss cause', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${bid('D1')}/dispose`, { qty: 1, method: 'destroy', reason: 'bad cause', loss_cause: 'bogus' }, mgr);
    check('unknown loss cause rejected', r.status === 400 && r.body.code === 'INVALID_CAUSE', JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${bid('D2')}/dispose`, { qty: 3, method: 'write_off', reason: 'Past its date' }, mgr);
    check('expired batch disposal needs no cause', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', `/inventory/quality/batches/${bid('D3')}/dispose`, { qty: 2, method: 'return_to_supplier', reason: 'Supplier collected' }, mgr);
    check('batch disposal returned to supplier', r.status === 201, JSON.stringify(r.body));

    // ── summary: physical losses ──
    s = await sum();
    const cause = k => s.physical.by_cause.find(x => x.key === k);
    check('physical loss total = all write-offs and disposals at ledger cost', near(s.physical.value, 540 + 0) && s.physical.events === 13 && s.physical.units === 54, JSON.stringify([s.physical.value, s.physical.events, s.physical.units]));
    check('by cause: breakage, theft, contamination (adjustment + disposal), deterioration', near(cause('breakage').value, 250) && near(cause('theft').value, 30) && near(cause('contamination').value, 60) && near(cause('deterioration').value, 50), JSON.stringify(s.physical.by_cause.map(x => [x.key, x.value])));
    check('by cause: expiry (adjustments + inferred from expired batch), missing (count shortage + unexplained), obsolete', near(cause('expiry').value, 90) && near(cause('missing').value, 50) && near(cause('obsolete').value, 10), JSON.stringify(s.physical.by_cause.map(x => [x.key, x.value])));
    check('shares add to 100%', Math.abs(s.physical.by_cause.reduce((a, x) => a + x.share, 0) - 100) < 0.5);
    check('internal use is not a loss', !s.physical.by_reason.some(x => /Internal/.test(x.label)));
    check('gains (found, count surplus) netted into net shrinkage', near(s.gains.value, 60) && near(s.net_shrinkage, 480), JSON.stringify([s.gains.value, s.net_shrinkage]));
    check('return outside the supplier-return document is flagged as untracked', s.supplier_returns.unlinked.events === 2 && near(s.supplier_returns.unlinked.value, 40), JSON.stringify(s.supplier_returns.unlinked));
    check('sources split adjustments and disposals', s.physical.by_source.adjustments.events === 11 && s.physical.by_source.disposals.events === 2, JSON.stringify(s.physical.by_source));
    check('monthly trend covers the period', s.physical.by_month.length >= 3 && near(s.physical.by_month.reduce((a, m) => a + m.value, 0), 540));
    await sell(L1, 5);
    s = await sum();
    check('loss rate is measured against cost of sales', s.cost_of_sales > 0 && s.loss_rate_pct != null, JSON.stringify([s.cost_of_sales, s.loss_rate_pct]));

    // ── register ──
    r = await call('GET', '/inventory/losses/register');
    check('register lists every record with who, when, how much and approval', r.body.rows.length === 13 && near(r.body.totals.value, 540), JSON.stringify(r.body.totals));
    const theft = r.body.rows.find(x => x.cause === 'theft');
    check('row carries product, quantity, reason, responsible user, timestamp and approver', theft.item_name && theft.qty === 3 && theft.reason_label && theft.recorded_by_id === 1002 && theft.approved_by_id === 1001 && !!theft.at && theft.ref.startsWith('ADJ-'), JSON.stringify(theft));
    r = await call('GET', '/inventory/losses/register?cause=breakage');
    check('filter by cause', r.body.rows.length === 2 && near(r.body.totals.value, 250));
    r = await call('GET', '/inventory/losses/register?source=disposal');
    check('filter by source', r.body.rows.length === 2 && near(r.body.totals.value, 70) && r.body.rows.every(x => x.ref.startsWith('DSP-')), JSON.stringify(r.body.totals));
    r = await call('GET', `/inventory/losses/register?user_id=1002`);
    check('filter by user', r.body.rows.length === 1);
    r = await call('GET', '/inventory/losses/register?limit=3');
    check('limit truncates and says so', r.body.rows.length === 3 && r.body.truncated === true && r.body.totals.events === 13);
    r = await call('GET', '/inventory/losses/register?from=' + day(-400) + '&to=' + day(-300));
    check('period filter excludes recent losses', r.body.rows.length === 0);
    r = await call('GET', '/inventory/losses/register?from=2026-13-40');
    check('bad date rejected', r.status === 400 && r.body.code === 'INVALID_DATE', JSON.stringify(r.body));
    r = await call('GET', '/inventory/losses/register?from=' + day(0) + '&to=' + day(-5));
    check('inverted range rejected', r.status === 400 && r.body.code === 'INVALID_RANGE');

    // ── breakdowns ──
    r = await call('GET', '/inventory/losses/breakdown?by=item');
    check('breakdown by item', r.body.rows[0].key === L1 && near(r.body.rows[0].value, 470), JSON.stringify(r.body.rows[0]));
    r = await call('GET', '/inventory/losses/breakdown?by=user');
    check('breakdown by recording user', r.body.rows.some(x => x.key === 1001) && r.body.rows.some(x => x.key === 1002));
    r = await call('GET', '/inventory/losses/breakdown?by=supplier');
    check('breakdown by supplier names the supplier', r.body.rows.some(x => x.label === 'L Supply'), JSON.stringify(r.body.rows));
    r = await call('GET', '/inventory/losses/breakdown?by=bogus');
    check('unknown breakdown rejected', r.status === 400);

    // ── supplier returns ──
    const R2 = await mk('Returnable', { supplier_id: sup, stock: 0 });
    await receive(R2, 50);
    r = await call('POST', '/inventory/losses/returns', { supplier_id: sup, tire_id: R2, qty: 4, reason: 'Faulty batch', reference: 'RMA-1' }, staff);
    const sr1 = r.body.id;
    check('staff return waits for approval, stock unchanged', r.status === 202 && r.body.status === 'awaiting_approval' && /^SRT-/.test(r.body.return_no) && (await stockOf(R2)) === 50, JSON.stringify(r.body));
    r = await call('POST', `/inventory/losses/returns/${sr1}/credit`, { amount: 10 }, mgr);
    check('cannot credit a return that was never approved', r.status === 409 && r.body.code === 'NOT_SHIPPED', JSON.stringify(r.body));
    await call('POST', `/inventory/adjustments/${r.body ? (await call('GET', '/inventory/adjustments?status=pending')).body.find(x => x.tire_id === R2).id : 0}/approve`, {}, mgr);
    check('approval ships the return and reduces stock', (await stockOf(R2)) === 46);
    let rets = (await call('GET', '/inventory/losses/returns')).body;
    let row = rets.rows.find(x => x.id === sr1);
    check('return value is the cost taken out of stock; credit still outstanding', row.status === 'shipped' && near(row.value, 40) && near(row.outstanding, 40), JSON.stringify(row));
    r = await call('POST', '/inventory/losses/returns', { supplier_id: 999999, tire_id: R2, qty: 1, reason: 'x y z' });
    check('unknown supplier rejected', r.status === 404);
    r = await call('POST', '/inventory/losses/returns', { supplier_id: sup, tire_id: R2, qty: 0, reason: 'nope' });
    check('quantity must be positive', r.status === 400);
    r = await call('POST', '/inventory/losses/returns', { supplier_id: sup, tire_id: R2, qty: 1, reason: '' });
    check('reason required', r.status === 400 && r.body.code === 'REASON_REQUIRED');
    r = await call('POST', '/inventory/losses/returns', { supplier_id: sup, tire_id: R2, qty: 9999, reason: 'too many' });
    check('cannot return more than on hand', r.status === 409, JSON.stringify([r.status, r.body]));
    r = await call('POST', `/inventory/losses/returns/${sr1}/credit`, { amount: 15, reference: 'CN-100' }, staff);
    check('staff cannot record credits', r.status === 403);
    r = await call('POST', `/inventory/losses/returns/${sr1}/credit`, { amount: 15, reference: 'CN-100' }, mgr);
    check('partial credit keeps it open', r.status === 200 && r.body.closed === false && near(r.body.credit_amount, 15), JSON.stringify(r.body));
    r = await call('POST', `/inventory/losses/returns/${sr1}/credit`, { amount: 0, final: true }, mgr);
    check('closing short needs a note', r.status === 400 && r.body.code === 'NOTE_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', `/inventory/losses/returns/${sr1}/credit`, { amount: 1e6 }, mgr);
    check('absurd credit rejected', r.status === 400 && r.body.code === 'CREDIT_TOO_HIGH', JSON.stringify(r.body));
    r = await call('POST', `/inventory/losses/returns/${sr1}/credit`, { amount: 0, final: true, note: 'Supplier disputes condition' }, mgr);
    check('closed short: shortfall becomes a real loss', r.status === 200 && r.body.closed && near(r.body.shortfall, 25), JSON.stringify(r.body));
    r = await call('POST', `/inventory/losses/returns/${sr1}/credit`, { amount: 5 }, mgr);
    check('closed return cannot be credited again', r.status === 409 && r.body.code === 'ALREADY_CLOSED');
    r = await call('POST', '/inventory/losses/returns', { supplier_id: sup, tire_id: R2, qty: 3, reason: 'Wrong spec delivered' });
    r = await call('POST', `/inventory/losses/returns/${r.body.id}/credit`, { amount: 30, reference: 'CN-101' }, mgr);
    check('full credit closes automatically with no loss', r.status === 200 && r.body.closed && r.body.shortfall === 0, JSON.stringify(r.body));
    rets = (await call('GET', '/inventory/losses/returns')).body;
    check('return totals: shipped, credited, unrecovered', rets.totals.documents === 2 && near(rets.totals.shipped_value, 70) && near(rets.totals.credit_received, 45) && near(rets.totals.unrecovered_loss, 25) && near(rets.totals.credit_outstanding, 0), JSON.stringify(rets.totals));
    check('statuses derived', rets.rows.find(x => x.id === sr1).status === 'short_credited' && rets.rows.filter(x => x.status === 'credited').length === 1);
    s = await sum();
    check('only the unrecovered shortfall adds to net physical loss', near(s.physical.value, 540) && near(s.net_physical_loss, 565) && near(s.supplier_returns.unrecovered_loss, 25), JSON.stringify([s.physical.value, s.net_physical_loss]));
    check('supplier-return adjustments are not double counted as untracked returns', s.supplier_returns.unlinked.events === 2, JSON.stringify(s.supplier_returns.unlinked));

    // ── valuation vs physical ──
    const V = await mk('Valued', { stock: 0 });
    await receive(V, 20);
    r = await call('POST', '/inventory/valuation-adjustments', { tire_id: V, new_unit_cost: 8, reason: 'Write-down to net realisable value' });
    check('valuation write-down recorded', r.status === 201, JSON.stringify(r.body));
    s = await sum();
    check('valuation change reported on its own', near(s.valuation.write_down, 40) && near(s.valuation.net_change, -40) && s.valuation.adjustments.length === 1 && /No units/.test(s.valuation.note), JSON.stringify(s.valuation).slice(0, 200));
    check('valuation never touches physical loss', near(s.physical.value, 540) && near(s.net_physical_loss, 565) && (await stockOf(V)) === 20);

    // ── slow moving & obsolete ──
    const ACT = await mk('Active seller', { stock: 0 }); await receive(ACT, 20); await sell(ACT, 5);
    const SLW = await mk('Slow one', { stock: 0 }); await receive(SLW, 10); await backdate(SLW, 120);
    const NMV = await mk('Non moving', { stock: 0 }); await receive(NMV, 10); await backdate(NMV, 250);
    const OBS = await mk('Obsolete by age', { stock: 0 }); await receive(OBS, 10); await backdate(OBS, 500);
    const NEW = await mk('Restocked recently', { stock: 0 }); await receive(NEW, 10); await pool.request().input('t', sql.Int, NEW).query('UPDATE tires SET created_at = DATEADD(DAY, -500, GETDATE()) WHERE id = @t');
    const FLG = await mk('Flagged item', { stock: 0, reorder_level: 500 }); await receive(FLG, 10);
    const COV = await mk('Overstocked', { stock: 0 }); await receive(COV, 1000); await sell(COV, 10);
    let ob = (await call('GET', '/inventory/losses/obsolescence?class=all')).body;
    const cls = id => ob.rows.find(x => x.tire_id === id);
    check('active seller stays active', cls(ACT).class === 'active');
    check('120 days idle is slow moving', cls(SLW).class === 'slow' && cls(SLW).idle_days >= 119, JSON.stringify(cls(SLW)));
    check('250 days idle is non-moving', cls(NMV).class === 'non_moving', JSON.stringify(cls(NMV)));
    check('500 days idle is obsolete', cls(OBS).class === 'obsolete' && /500|No sale/.test(cls(OBS).reason), JSON.stringify(cls(OBS)));
    check('recently received stock is not judged yet', cls(NEW).class === 'active' && cls(NEW).new_stock === true, JSON.stringify(cls(NEW)));
    check('selling slowly against a large stock is slow (cover)', cls(COV).class === 'slow' && cls(COV).cover_days > 365 && /cover/.test(cls(COV).reason), JSON.stringify(cls(COV)));
    check('provision is a percentage of value: slow 10, non-moving 25, obsolete 50', near(cls(SLW).provision_value, 10) && near(cls(NMV).provision_value, 25) && near(cls(OBS).provision_value, 50) && near(cls(OBS).suggested_unit_cost, 5), JSON.stringify([cls(SLW).provision_value, cls(NMV).provision_value, cls(OBS).provision_value]));
    check('summary totals per class and idle buckets cover every item', ob.summary.obsolete.items >= 1 && ob.summary.non_moving.items >= 1 && ob.summary.slow.items >= 2 && ob.idle_buckets.reduce((a, b) => a + b.items, 0) === ob.rows.length, JSON.stringify(ob.summary));
    check('explains valuation versus physical', /valuation write-down/.test(ob.note) && ob.suggested_provision > 0 && ob.at_risk_value > 0);
    let before = (await call('GET', '/inventory/replenishment')).body.items.some(i => i.id === FLG || i.tire_id === FLG);
    r = await call('PUT', `/inventory/losses/items/${FLG}/lifecycle`, { status: 'obsolete', note: 'Replaced by new model' }, staff);
    check('staff cannot retire an item', r.status === 403);
    r = await call('PUT', `/inventory/losses/items/${FLG}/lifecycle`, { status: 'bogus', note: 'x y z' }, mgr);
    check('invalid lifecycle status rejected', r.status === 400);
    r = await call('PUT', `/inventory/losses/items/${FLG}/lifecycle`, { status: 'obsolete' }, mgr);
    check('retiring needs a note', r.status === 400 && r.body.code === 'REASON_REQUIRED');
    r = await call('PUT', `/inventory/losses/items/${FLG}/lifecycle`, { status: 'obsolete', note: 'Replaced by new model' }, mgr);
    check('manager marks an item obsolete', r.status === 200);
    ob = (await call('GET', '/inventory/losses/obsolescence?class=all')).body;
    check('flagged item is obsolete whatever its sales', cls(FLG).class === 'obsolete' && /Marked obsolete/.test(cls(FLG).reason));
    const after = (await call('GET', '/inventory/replenishment')).body.items.some(i => i.id === FLG || i.tire_id === FLG);
    check('replenishment no longer proposes retired items', before === true && after === false, JSON.stringify({ before, after }));
    r = await call('GET', '/inventory/losses/obsolescence?class=obsolete');
    check('class filter', r.body.rows.length >= 2 && r.body.rows.every(x => x.class === 'obsolete'));
    r = await call('PUT', `/inventory/losses/items/${FLG}/lifecycle`, { status: null }, mgr);
    ob = (await call('GET', '/inventory/losses/obsolescence?class=all')).body;
    check('clearing the flag restores normal classification', r.status === 200 && cls(FLG).class === 'active');
    r = await call('PUT', '/inventory/losses/settings', { obs_slow_days: 300, obs_nonmoving_days: 200 });
    check('thresholds must increase', r.status === 400, JSON.stringify(r.body));
    r = await call('PUT', '/inventory/losses/settings', { obs_provision_obsolete: 60, obs_slow_days: 60 });
    ob = (await call('GET', '/inventory/losses/obsolescence?class=all')).body;
    check('settings change classification and provision', r.status === 200 && near(cls(OBS).provision_value, 60), JSON.stringify(r.body));
    r = await call('PUT', '/inventory/losses/settings', { obs_provision_obsolete: null, obs_slow_days: null, loss_writeoff_approval_value: null });
    check('clearing a setting restores its default', r.body.obs_slow_days === 90 && r.body.loss_writeoff_approval_value === null, JSON.stringify(r.body));
    r = await call('PUT', '/inventory/losses/settings', { obs_slow_days: 'abc' });
    check('non-numeric setting rejected', r.status === 400);

    // ── patterns ──
    const back = (await call('POST', '/inventory/locations', { name: 'Back store' })).body.id;
    await adj(L1, 6, 'found', admin, { location_id: back });
    await adj(L1, -1, 'damage', admin, { location_id: back });
    const H = await mk('Handling item', { stock: 0 }); await receive(H, 100);
    for (let i = 0; i < 3; i++) await adj(H, -1, 'handling_error');
    await pool.request().input('t', sql.Int, H).query("UPDATE stock_adjustments SET decided_at = DATEADD(DAY, -200, GETDATE()), requested_at = DATEADD(DAY, -200, GETDATE()) WHERE tire_id = @t");
    for (let i = 0; i < 4; i++) await adj(H, -3, 'handling_error');
    await adj(L1, -30, 'damage');
    const P = (await call('GET', '/inventory/losses/patterns')).body;
    const find = k => P.patterns.find(x => x.key === k);
    check('repeated losses on one item detected with a recommendation', find(`item:${L1}`)?.type === 'repeat_item' && find(`item:${L1}`).evidence.events >= 10 && find(`item:${L1}`).recommendation.length > 20, JSON.stringify(find(`item:${L1}`)));
    check('supplier with repeated quality losses flagged', find(`supplier:${sup}`)?.type === 'supplier_quality' && /supplier/i.test(find(`supplier:${sup}`).recommendation), JSON.stringify(P.patterns.map(x => x.key)));
    check('loss hotspot location found', P.patterns.some(x => x.type === 'location_hotspot'), JSON.stringify(P.patterns.map(x => x.key)));
    check('recording concentration noted (neutral wording, review)', find('user:1001')?.type === 'recorder_concentration' && /not proof/.test(find('user:1001').detail), JSON.stringify(P.patterns.map(x => x.key)));
    check('rising cause against the previous period', find('trend:handling')?.type === 'rising_cause' && find('trend:handling').evidence.previous_value > 0, JSON.stringify(find('trend:handling')));
    check('recurring expiry flagged', find('cause:expiry')?.type === 'recurring_expiry', JSON.stringify(P.patterns.map(x => x.key)));
    check('short-credited supplier flagged', find(`returns:${sup}`)?.type === 'unrecovered_returns', JSON.stringify(P.patterns.map(x => x.key)));
    check('patterns ranked by severity', ['high', 'medium', 'low'].indexOf(P.patterns[0].severity) <= ['high', 'medium', 'low'].indexOf(P.patterns[P.patterns.length - 1].severity));
    r = await call('GET', '/inventory/losses/patterns?days=3650');
    check('pattern window is capped', r.body.days === 730);

    // ── corrective actions ──
    r = await call('POST', '/inventory/losses/actions', { pattern_key: `item:${L1}`, title: 'Repack and relabel Loss item' }, staff);
    check('staff cannot create actions', r.status === 403);
    r = await call('POST', '/inventory/losses/actions', { pattern_key: `item:${L1}`, title: 'Repack and relabel Loss item', owner_name: 'Warehouse lead', due_date: day(14) }, mgr);
    const act = r.body.id;
    check('manager creates a corrective action from a pattern', r.status === 201 && act, JSON.stringify(r.body));
    check('pattern now shows its action', (await call('GET', '/inventory/losses/patterns')).body.patterns.find(x => x.key === `item:${L1}`).action?.status === 'open');
    r = await call('POST', '/inventory/losses/actions', { title: 'x' }, mgr);
    check('action needs a title', r.status === 400);
    r = await call('POST', '/inventory/losses/actions', { title: 'Late action', due_date: '2020-01-01' }, mgr);
    const lateAct = r.body.id;
    let al = (await call('GET', '/inventory/losses/alerts')).body;
    check('overdue action counted in alerts', al.overdue_actions === 1, JSON.stringify(al));
    r = await call('PUT', `/inventory/losses/actions/${act}`, { status: 'done' }, mgr);
    check('closing an action needs a note', r.status === 400);
    r = await call('PUT', `/inventory/losses/actions/${act}`, { status: 'done', resolution: 'New packaging in use' }, mgr);
    check('action closed with outcome', r.status === 200 && (await call('GET', '/inventory/losses/actions?status=done')).body.some(x => x.id === act));
    await call('PUT', `/inventory/losses/actions/${lateAct}`, { status: 'dismissed', resolution: 'Not needed' }, mgr);

    // ── alerts ──
    await adj(L1, -1, 'damage', staff);
    al = (await call('GET', '/inventory/losses/alerts')).body;
    check('alerts: pending write-offs, expired stock, obsolete items', al.pending_writeoffs === 1 && al.expired_batches === 1 && al.obsolete_items >= 1 && al.overdue_actions === 0 && al.needs_attention >= 3, JSON.stringify(al));

    // ── permissions, demo, isolation ──
    r = await call('POST', '/inventory/losses/actions', { title: 'Demo try' }, demo);
    check('demo user is read-only', r.status === 403 && r.body.code === 'DEMO');
    r = await call('GET', '/inventory/losses/summary', null, admin2, B.br);
    check('other organisation sees none of it', r.body.physical.events === 0 && r.body.exposure.expired.units === 0 && r.body.supplier_returns.documents === 0, JSON.stringify(r.body.physical));
    r = await call('GET', '/inventory/losses/obsolescence?class=all', null, admin2, B.br);
    check('and no stock classification', r.body.rows.length === 0);
    r = await call('PUT', `/inventory/losses/items/${OBS}/lifecycle`, { status: 'obsolete', note: 'cross org try' }, admin2, B.br);
    check('cannot retire another organisation\'s item', r.status === 404);
    r = await call('POST', `/inventory/losses/returns/${sr1}/credit`, { amount: 1 }, admin2, B.br);
    check('cannot credit another organisation\'s return', r.status === 404);
    r = await call('POST', '/inventory/losses/returns', { supplier_id: sup, tire_id: R2, qty: 1, reason: 'cross org try' }, admin2, B.br);
    check('cannot use another organisation\'s supplier', r.status === 404, JSON.stringify([r.status, r.body]));

    // ── ledger intact ──
    r = await call('GET', '/inventory/reconciliation');
    check('ledger still reconciles', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 300));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of [org, B.org]) {
      for (const q of [
        'DELETE FROM loss_actions WHERE organization_id=@o', 'DELETE FROM supplier_returns WHERE organization_id=@o', 'DELETE FROM quality_disposals WHERE organization_id=@o',
        'DELETE FROM valuation_adjustment_layers WHERE adjustment_id IN (SELECT id FROM valuation_adjustments WHERE organization_id=@o)', 'DELETE FROM valuation_adjustments WHERE organization_id=@o',
        'DELETE FROM batch_quality_events WHERE organization_id=@o', 'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o',
        'DELETE FROM stock_transfer_items WHERE transfer_id IN (SELECT id FROM stock_transfers WHERE organization_id=@o)', 'DELETE FROM stock_transfers WHERE organization_id=@o',
        'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
        'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
        'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sales WHERE organization_id=@o',
        'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
        'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
        'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
        'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
        'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
        { try { await pool.request().input('o', sql.Int, o).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); } }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
