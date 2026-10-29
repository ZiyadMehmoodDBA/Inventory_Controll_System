process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + x}`); };
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG9', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Acme', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 1000000 AS NVARCHAR))")).recordset[0].id;
  const tok = (role, uid) => jwt.sign({ userId: uid, orgId: org, branchId: role === 'staff' ? br : null, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok('org_admin', 1001), staff = tok('staff', 1002);
  const call = async (m, p, body, t = admin) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(br) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const mk = async (model, extra = {}) => (await call('POST', '/inventory', { model, cost_price: 2, sale_price: 9, ...extra })).body.id;
  const recv = (id, items) => call('POST', '/purchases', { supplier_id: sup, date: day(0), status: 'received', items: items.map(i => ({ tire_id: id, tire_name: 'x', unit_price: 2, ...i })) });
  const sell = (id, qty, extra = {}) => call('POST', '/sales', { date: day(0), items: [{ tire_id: id, qty, unit_price: 9 + Math.random(), ...extra }], tax_rate: 0 });
  const batches = async id => Object.fromEntries((await call('GET', `/inventory/batches?tire_id=${id}`)).body.map(b => [b.batch_no, b.qty]));
  const pick = async (id, qty = 1, loc = '') => (await call('GET', `/inventory/pick-suggestion?tire_id=${id}&qty=${qty}${loc}`)).body;
  try {
    // ── policies ──
    let r = await call('GET', '/inventory/rotation');
    check('policy list: fefo, fifo, smallest_first, manual — and no LIFO picking', r.status === 200 && r.body.policies.map(p => p.value).join() === 'fefo,fifo,smallest_first,manual', JSON.stringify(r.body.policies?.map(p => p.value)));
    const milk = await mk('Milk', { tracking: 'batch', track_expiry: true });
    const plainT = await mk('Bolts', { tracking: 'batch', track_expiry: false });
    check('default policy: FEFO for expiring goods', (await pick(milk)).policy === 'fefo' && (await pick(milk)).source === 'default');
    check('default policy: FIFO for goods without expiry', (await pick(plainT)).policy === 'fifo');

    // two batches: OLD received 30 days ago expiring later, NEW received today expiring sooner
    await recv(milk, [{ qty: 10, batch_no: 'OLD', expiry_date: day(90), received_date: day(-30) }, { qty: 10, batch_no: 'NEW', expiry_date: day(20), received_date: day(0) }]);
    let p = await pick(milk, 4);
    check('FEFO recommends the soonest-expiring batch (NEW) first', p.picks[0].batch_no === 'NEW' && p.picks[0].pick === 4, JSON.stringify(p.picks));
    r = await sell(milk, 2);
    let b = await batches(milk);
    check('FEFO sale really takes from NEW', r.status === 201 && b.NEW === 8 && b.OLD === 10, JSON.stringify(b));
    check('receipt date is recorded on the batch', (await pick(milk)).plan.find(x => x.batch_no === 'OLD').received_date === day(-30) && (await pick(milk)).plan.find(x => x.batch_no === 'OLD').age_days === 30);

    // item override beats default
    r = await call('PUT', '/inventory/rotation', { scope: 'item', id: milk, policy: 'fifo' });
    check('set an item to FIFO', r.status === 200 && r.body.policy === 'fifo', JSON.stringify(r.body));
    p = await pick(milk, 3);
    check('FIFO recommends the oldest received (OLD) even though it expires later', p.policy === 'fifo' && p.source === 'item' && p.picks[0].batch_no === 'OLD', JSON.stringify(p.picks));
    r = await sell(milk, 3);
    b = await batches(milk);
    check('FIFO sale really takes from OLD', b.OLD === 7 && b.NEW === 8, JSON.stringify(b));
    r = await call('PUT', '/inventory/rotation', { scope: 'item', id: milk, policy: 'lifo' });
    check('LIFO is not a picking rule', r.status === 400 && r.body.code === 'INVALID_ROTATION', JSON.stringify(r.body));
    r = await call('PUT', '/inventory/rotation', { scope: 'item', id: milk, policy: 'fefo' }, staff);
    check('staff cannot change rotation policy', r.status === 403, JSON.stringify(r.body));

    // category and company levels
    const cat = (await call('POST', '/inventory/categories', { name: 'Dairy' })).body.id;
    await call('PUT', '/inventory/rotation', { scope: 'item', id: milk, policy: null });
    await call('PUT', `/inventory/${milk}`, { model: 'Milk', category_id: cat, cost_price: 2, sale_price: 9 });
    await call('PUT', '/inventory/rotation', { scope: 'category', id: cat, policy: 'fifo' });
    p = await pick(milk);
    check('category policy applies when the item has none', p.policy === 'fifo' && p.source === 'category', JSON.stringify([p.policy, p.source]));
    await call('PUT', '/inventory/rotation', { scope: 'category', id: cat, policy: null });
    r = await call('PUT', '/inventory/rotation', { scope: 'company', policy: 'smallest_first' });
    p = await pick(milk);
    check('company default applies below category and item', r.status === 200 && p.policy === 'smallest_first' && p.source === 'company', JSON.stringify([p.policy, p.source]));
    check('smallest batch first: NEW (8) before OLD (7)? no — OLD (7) is smaller', p.picks[0].batch_no === 'OLD', JSON.stringify(p.picks));
    r = await call('PUT', '/inventory/rotation', { scope: 'company', policy: 'fefo' }, tok('branch_manager', 1004));
    check('only an administrator sets the company default', r.status === 403, JSON.stringify(r.body));
    await call('PUT', '/inventory/rotation', { scope: 'company', policy: null });
    r = await call('GET', '/inventory/rotation');
    check('rotation overview lists category and item settings', r.body.company === null && r.body.categories.some(c => c.id === cat), JSON.stringify(r.body.categories?.slice(0, 2)));

    // manual
    await call('PUT', '/inventory/rotation', { scope: 'item', id: milk, policy: 'manual' });
    r = await sell(milk, 1);
    check('manual policy: a sale without a batch is refused', r.status === 409 && r.body.code === 'MANUAL_ROTATION', JSON.stringify(r.body));
    const oldId = (await call('GET', `/inventory/batches?tire_id=${milk}`)).body.find(x => x.batch_no === 'OLD').batch_id;
    r = await sell(milk, 1, { batch_id: oldId });
    check('manual policy: choosing the batch works', r.status === 201, JSON.stringify(r.body));
    p = await pick(milk);
    check('manual policy still gets a suggested order', p.policy === 'manual' && p.picks.length === 1 && /manual/i.test(p.note), JSON.stringify([p.policy, p.note]));
    r = await call('POST', '/inventory/adjustments', { tire_id: milk, qty_change: -1, reason_code: 'damage' });
    check('manual does not block write-offs', r.status === 201, JSON.stringify(r.body));
    r = await call('PUT', `/inventory/${milk}`, { model: 'Milk', rotation_policy: 'bogus', cost_price: 2, sale_price: 9 });
    check('invalid rotation policy on the item form is rejected', r.status === 400 && r.body.code === 'INVALID_ROTATION', JSON.stringify(r.body));
    r = await call('GET', `/inventory/${milk}/history`);
    check('rotation changes are in the item history', r.body.some(h => h.field === 'rotation_policy'), JSON.stringify(r.body.map(h => h.field)));

    // eligibility: expired / restricted / reserved
    await call('PUT', '/inventory/rotation', { scope: 'item', id: milk, policy: null });
    await pool.request().input('t', sql.Int, milk).query("UPDATE stock_batches SET expiry_date = DATEADD(DAY, -3, CAST(GETDATE() AS DATE)) WHERE tire_id = @t AND batch_no = 'OLD'");
    p = await pick(milk, 50);
    check('expired batch excluded from the recommendation', p.excluded.some(x => x.batch_no === 'OLD' && x.reason === 'expired') && p.picks.every(x => x.batch_no !== 'OLD'), JSON.stringify(p.excluded));
    check('shortfall is reported', p.shortfall > 0 && p.free === p.eligible, JSON.stringify([p.eligible, p.shortfall]));
    await call('POST', '/inventory/reservations', { tire_id: milk, qty: 2 });
    p = await pick(milk, 10);
    check('reserved units are held back from the pick', p.reserved === 2 && p.free === p.eligible - 2 && p.picks.reduce((a, x) => a + x.pick, 0) === p.free, JSON.stringify([p.eligible, p.reserved, p.free, p.picks]));
    const plainItem = await mk('Plain', { stock: 12 });
    p = await pick(plainItem, 5);
    check('untracked item: pick from the location total', p.picks.length === 1 && p.picks[0].pick === 5 && p.picks[0].batch_id === null, JSON.stringify(p.picks));
    const qa = (await call('POST', '/inventory/locations', { name: 'QA', code: 'QA', kind: 'quarantine' })).body.id;
    p = await pick(plainItem, 1, '&location_id=' + qa);
    check('restricted location offers nothing', p.picks.length === 0 && p.shortfall === 1, JSON.stringify(p));

    // ── stock age ──
    const aged = await mk('Aged goods');
    await recv(aged, [{ qty: 10 }]);
    await pool.request().input('t', sql.Int, aged).query("EXEC sp_set_session_context N'allow_purge', 1; UPDATE stock_movements SET created_at = DATEADD(DAY, -200, GETDATE()) WHERE tire_id = @t AND qty_change > 0");
    await recv(aged, [{ qty: 4 }]);
    const batchAged = await mk('Batch aged', { tracking: 'batch' });
    await recv(batchAged, [{ qty: 6, batch_no: 'BA1', received_date: day(-100) }, { qty: 2, batch_no: 'BA2', received_date: day(-5) }]);
    r = await call('GET', '/inventory/stock-age');
    const ag = r.body.items.find(x => x.tire_id === aged), bg = r.body.items.find(x => x.tire_id === batchAged);
    check('untracked age: newest receipts stay (4 fresh + 10 old of 14)', ag && ag.units === 14 && ag.buckets['0-30'].units === 4 && ag.buckets['181-365'].units === 10 && ag.oldest_days >= 199, JSON.stringify(ag));
    check('batch age uses receipt dates (100 days -> 91-180, 5 days -> 0-30)', bg && bg.buckets['91-180'].units === 6 && bg.buckets['0-30'].units === 2, JSON.stringify(bg?.buckets));
    check('age totals and slow-stock value', r.body.totals['181-365'].units >= 10 && r.body.slow_units >= 10 && r.body.slow_value >= 20 && r.body.items[0].oldest_days >= r.body.items[r.body.items.length - 1].oldest_days, JSON.stringify(r.body.totals));

    // ── expiry exposure ──
    const exp = await mk('Short life', { tracking: 'batch', track_expiry: true });
    await recv(exp, [{ qty: 50, batch_no: 'S1', expiry_date: day(10) }, { qty: 20, batch_no: 'S2', expiry_date: day(60) }]);
    r = await call('GET', '/inventory/expiry-exposure');
    const s1 = r.body.rows.find(x => x.batch_no === 'S1'), s2 = r.body.rows.find(x => x.batch_no === 'S2');
    check('no sales: everything expiring is expected unsold', s1.expected_unsold === 50 && s1.at_risk_value === 100 && s2.expected_unsold === 20, JSON.stringify([s1, s2]));
    check('exposure buckets by time to expiry', r.body.buckets['0-30'].units >= 50 && r.body.buckets['31-60'].units >= 20 && r.body.buckets.expired.units >= 5, JSON.stringify(r.body.buckets));
    check('expired stock is a total loss in the totals', r.body.expired_value > 0 && r.body.at_risk_value >= r.body.expired_value + 100, JSON.stringify([r.body.expired_value, r.body.at_risk_value]));
    // velocity: fake 60 units sold over 60 days -> 1/day; S1 (10 days) can sell 10, S2 (60 days) can sell 50-50 = 0 extra... demand(60)=60, before=50 -> sells 10
    await pool.request().input('t', sql.Int, exp).input('o', sql.Int, org).input('b', sql.Int, br)
      .query("INSERT INTO stock_movements (tire_id, organization_id, branch_id, qty_change, reason, qty_before, qty_after, item_name, created_at) VALUES (@t, @o, @b, -60, 'sale', 70, 10, 'x', DATEADD(DAY, -10, GETDATE()))");
    r = await call('GET', '/inventory/expiry-exposure');
    const t1 = r.body.rows.find(x => x.batch_no === 'S1'), t2 = r.body.rows.find(x => x.batch_no === 'S2');
    check('sales rate reduces the expected loss (S1 sells 10 of 50, S2 sells 10 of 20)', t1.expected_unsold === 40 && t2.expected_unsold === 10, JSON.stringify([t1, t2]));
    await pool.request().input('t', sql.Int, exp).query("EXEC sp_set_session_context N'allow_purge', 1; DELETE FROM stock_movements WHERE tire_id = @t AND reason = 'sale' AND qty_change = -60");

    // ── valuation: LIFO is a financial choice with a legal acknowledgement ──
    r = await call('GET', '/inventory/valuation-method');
    check('methods: standard, weighted average, FIFO, LIFO — LIFO needs acknowledgement', r.body.options.map(o => o.value).join() === 'standard,average,fifo,lifo' && r.body.options.find(o => o.value === 'lifo').needs_ack && /IFRS/.test(r.body.options.find(o => o.value === 'lifo').description), JSON.stringify(r.body.options.map(o => o.value)));
    r = await call('PUT', '/inventory/valuation-method', { method: 'lifo' });
    check('LIFO without acknowledgement is refused', r.status === 400 && r.body.code === 'LEGAL_ACK_REQUIRED', JSON.stringify(r.body));
    r = await call('PUT', '/inventory/valuation-method', { method: 'lifo', acknowledge_legal: true }, staff);
    check('staff cannot change the valuation method', r.status === 403);
    const cogsItem = async (name, method, ack) => {
      await call('PUT', '/inventory/valuation-method', { method, acknowledge_legal: ack, note: 'test ' + method });
      const id = await mk(name);
      await recv(id, [{ qty: 10, unit_price: 2 }]);
      await recv(id, [{ qty: 10, unit_price: 4 }]);
      await sell(id, 5);
      const mv = (await call('GET', `/inventory/movements?tire_id=${id}`)).body.find(m => m.reason === 'sale');
      const v = (await call('GET', '/inventory/valuation')).body.items.find(i => i.tire_id === id);
      return { id, cogs: Number(mv.unit_cost), value: v.value };
    };
    const lifo = await cogsItem('Costed LIFO', 'lifo', true);
    check('LIFO: newest cost (4) expensed, stock keeps the old costs: 10x2 + 5x4 = 40', lifo.cogs === 4 && lifo.value === 40, JSON.stringify(lifo));
    const fifo = await cogsItem('Costed FIFO', 'fifo');
    check('FIFO: oldest cost (2) expensed, stock keeps newest: 5x2 + 10x4 = 50', fifo.cogs === 2 && fifo.value === 50, JSON.stringify(fifo));
    const avg = await cogsItem('Costed AVG', 'average');
    check('weighted average: receipts blend (2 and 4 -> 3), stock 15 x 3 = 45', avg.cogs === 3 && avg.value === 45, JSON.stringify(avg));
    const stdc = await cogsItem('Costed STD', 'standard');
    check('standard: item cost price (2, receipts do not change it) x 15 = 30', stdc.value === 30, JSON.stringify(stdc));
    // picking is unaffected by valuation: FEFO still picks soonest expiry while valuation is LIFO
    await call('PUT', '/inventory/valuation-method', { method: 'lifo', acknowledge_legal: true });
    const dual = await mk('Dual', { tracking: 'batch', track_expiry: true });
    await recv(dual, [{ qty: 5, batch_no: 'D-SOON', expiry_date: day(5), unit_price: 1 }, { qty: 5, batch_no: 'D-LATE', expiry_date: day(80), unit_price: 9 }]);
    p = await pick(dual, 2);
    check('rotation and valuation are independent (LIFO valuation, FEFO picking)', p.policy === 'fefo' && p.picks[0].batch_no === 'D-SOON', JSON.stringify(p.picks));
    r = await call('GET', '/inventory/valuation-method');
    check('method changes are kept in a history with who and why', r.body.history.length >= 5 && r.body.history.some(h => h.new_method === 'lifo' && /test lifo/.test(h.note || '') && h.old_method), JSON.stringify(r.body.history.slice(0, 2)));
    await call('PUT', '/inventory/valuation-method', { method: 'fifo' });

    // ── valuation adjustment ──
    const adjI = fifo.id;
    r = await call('POST', '/inventory/valuation-adjustments', { tire_id: adjI, new_unit_cost: 1.5, reason: 'Write-down to net realisable value' }, staff);
    check('staff cannot revalue', r.status === 403, JSON.stringify(r.body));
    r = await call('POST', '/inventory/valuation-adjustments', { tire_id: adjI, new_unit_cost: 1.5, reason: '' });
    check('reason is mandatory', r.status === 400 && r.body.code === 'REASON_REQUIRED', JSON.stringify(r.body));
    r = await call('POST', '/inventory/valuation-adjustments', { tire_id: adjI, new_unit_cost: -1, reason: 'bad' });
    check('negative cost rejected', r.status === 400, JSON.stringify(r.body));
    r = await call('POST', '/inventory/valuation-adjustments', { tire_id: adjI, new_unit_cost: 1.5, reason: 'Write-down to net realisable value' });
    check('revalue 15 units from 50 to 22.50 (delta -27.50)', r.status === 201 && r.body.qty === 15 && r.body.old_value === 50 && r.body.new_value === 22.5 && r.body.delta === -27.5 && r.body.layers === 2, JSON.stringify(r.body));
    const adjId = r.body.id;
    r = await call('GET', `/inventory/valuation-adjustments/${adjId}`);
    check('every layer\'s previous cost is preserved', r.body.layers.length === 2 && r.body.layers.map(l => Number(l.old_cost)).sort().join() === '2,4' && r.body.layers.every(l => Number(l.new_cost) === 1.5), JSON.stringify(r.body.layers));
    r = await call('GET', '/inventory/valuation');
    check('the valuation report reflects the adjustment', r.body.items.find(i => i.tire_id === adjI).value === 22.5);
    r = await call('GET', `/inventory/${adjI}/history`);
    check('cost price change is in the item history', r.body.some(h => h.field === 'cost_price' && h.new_value === '1.5'), JSON.stringify(r.body.map(h => [h.field, h.new_value])));
    r = await call('POST', '/inventory/valuation-adjustments', { tire_id: adjI, new_unit_cost: 1.5, reason: 'again' });
    check('an adjustment that changes nothing is refused', r.status === 400 && r.body.code === 'NO_CHANGE', JSON.stringify(r.body));
    const empty = await mk('Empty');
    r = await call('POST', '/inventory/valuation-adjustments', { tire_id: empty, new_unit_cost: 1, reason: 'test' });
    check('no stock, nothing to revalue', r.status === 409 && r.body.code === 'NO_STOCK', JSON.stringify(r.body));
    r = await call('GET', `/inventory/valuation-adjustments?tire_id=${adjI}`);
    check('adjustment list', r.body.length === 1 && r.body[0].reason.startsWith('Write-down'), JSON.stringify(r.body));

    // ── snapshots ──
    r = await call('POST', '/inventory/valuation-snapshots', { note: 'Month end' });
    check('take a valuation snapshot', r.status === 201 && r.body.total_value > 0 && r.body.items >= 5, JSON.stringify(r.body));
    const snap = r.body;
    await call('POST', '/inventory/valuation-adjustments', { tire_id: adjI, new_unit_cost: 3, reason: 'Revalue up' });
    r = await call('GET', `/inventory/valuation-snapshots/${snap.id}`);
    const frozen = r.body.items.find(i => i.tire_id === adjI);
    check('a snapshot is frozen: later changes do not touch it', frozen && Number(frozen.value) === 22.5 && r.body.method === 'fifo' && r.body.note === 'Month end', JSON.stringify(frozen));
    r = await call('GET', '/inventory/valuation-snapshots');
    check('snapshot list shows method and total', r.body[0].id === snap.id && Number(r.body[0].total_value) === snap.total_value, JSON.stringify(r.body[0]));

    r = await call('GET', '/inventory/reconciliation');
    check('reconciliation clean', r.body.mismatches === 0 && r.body.location_mismatches === 0 && r.body.batch_mismatches === 0, JSON.stringify(r.body).slice(0, 300));
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const q of [
      'DELETE FROM valuation_adjustment_layers WHERE adjustment_id IN (SELECT id FROM valuation_adjustments WHERE organization_id=@o)', 'DELETE FROM valuation_adjustments WHERE organization_id=@o',
      'DELETE FROM valuation_snapshot_items WHERE snapshot_id IN (SELECT id FROM valuation_snapshots WHERE organization_id=@o)', 'DELETE FROM valuation_snapshots WHERE organization_id=@o', 'DELETE FROM valuation_policy_history WHERE organization_id=@o',
      'DELETE FROM stock_reservations WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o',
      'DELETE FROM item_uom_conversions WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
      'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)', 'DELETE FROM stock_batches WHERE organization_id=@o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
      'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM stock_locations WHERE organization_id=@o',
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sale_payments WHERE organization_id=@o', 'DELETE FROM ledger_entries WHERE organization_id=@o',
      'DELETE FROM sales WHERE organization_id=@o', 'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
      'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
      'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o'])
      { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 40), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
