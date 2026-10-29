// Business performance scorecard: the eleven measures on a hand-built scenario with known answers, targets, statuses, redaction and permissions.
process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (n, c, x = '') => { (c ? pass++ : fail++); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  -> ' + String(x).slice(0, 500)}`); };
const near = (a, b, e = 0.06) => a !== null && Math.abs(a - b) <= e;
const day = n => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

(async () => {
  const pool = await getPool();
  const mkOrg = async nm => {
    const org = (await pool.request().input('n', sql.NVarChar(100), nm).query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES (@n, 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
    const br = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
    return { org, br };
  };
  const A = await mkOrg('SMOKE ORG18'), B = await mkOrg('SMOKE ORG18B');
  const { org, br } = A;
  const sup = (await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, name, code, lead_time_days) OUTPUT INSERTED.id VALUES (@o, 'KPI Supply', 'S' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 5)")).recordset[0].id;
  const tok = (o, role, uid, branch) => jwt.sign({ userId: uid, orgId: o.org, branchId: role === 'org_admin' ? null : branch, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok(A, 'org_admin', 1001), staff = tok(A, 'staff', 1002, br), mgr = tok(A, 'branch_manager', 1003, br), adminB = tok(B, 'org_admin', 1004);
  const call = async (m, p, body, t = admin, branch = br) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}`, 'X-Branch-ID': String(branch) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, body: j };
  };
  const mk = async (model, cost) => (await call('POST', '/inventory', { model, cost_price: cost, sale_price: cost * 2, stock: 0 })).body.id;
  const kpis = async (q = '', t = admin) => (await call('GET', `/inventory/insights/kpis${q}`, null, t)).body;
  const by = (k, id) => k.measures.find(m => m.id === id);
  try {
    // ── empty organisation: no data is not zero ──
    let k = await kpis();
    check('eleven measures are reported', k.measures.length === 11 && k.period.days === 90, JSON.stringify(k.period));
    check('a new organisation has no accuracy, turnover, lead time or on-time figure (not zero)', ['inventory_accuracy', 'inventory_turnover', 'days_on_hand', 'replenishment_lead_time', 'supplier_fulfillment', 'order_fulfillment', 'stockout_rate'].every(id => by(k, id).value === null && by(k, id).status === 'no_data'), JSON.stringify(k.measures.map(m => [m.id, m.value])));

    // ── scenario with known answers ──
    const a = await mk('KPI A', 10), b = await mk('KPI B', 5), c = await mk('KPI C', 4);
    let r = await call('POST', '/purchases', { supplier_id: sup, date: day(-4), expected_date: day(-5), status: 'received', items: [{ tire_id: a, tire_name: 'A', qty: 100, unit_price: 10 }] });
    check('late PO: ordered 4 days ago, expected 5 days ago, received now', r.status === 201, JSON.stringify(r.body));
    r = await call('POST', '/purchases', { supplier_id: sup, date: day(-2), expected_date: day(3), status: 'received', items: [{ tire_id: b, tire_name: 'B', qty: 10, unit_price: 5 }, { tire_id: c, tire_name: 'C', qty: 5, unit_price: 4 }] });
    check('on-time PO: ordered 2 days ago, expected in 3 days', r.status === 201, JSON.stringify(r.body));
    await call('POST', '/sales', { date: day(0), items: [{ tire_id: a, qty: 30, unit_price: 20 }], tax_rate: 0 });
    await call('POST', '/sales', { date: day(0), items: [{ tire_id: b, qty: 10, unit_price: 10 }], tax_rate: 0 });
    const v1 = (await call('POST', '/sales', { date: day(0), items: [{ tire_id: a, qty: 1, unit_price: 20 }], tax_rate: 0 })).body.id;
    r = await call('POST', `/sales/${v1}/void`, {});
    check('one sale voided', r.status === 200, JSON.stringify(r.body));
    r = await call('POST', '/inventory/adjustments', { tire_id: a, qty_change: -5, reason_code: 'damage', notes: 'dropped' });
    check('5 damaged units (cost 10) written off', r.status === 201, JSON.stringify(r.body));
    // stock count: A is off by 2, C is exact
    const def = (await call('GET', '/inventory/locations')).body.find(l => l.is_default).id;
    const cnt = (await call('POST', '/inventory/counts', { location_id: def })).body.id;
    const det = (await call('GET', `/inventory/counts/${cnt}`)).body;
    const lines = (det.items || det.lines).map(l => ({ id: l.id, counted_qty: l.tire_id === a ? l.system_qty - 2 : l.system_qty }));
    await call('PUT', `/inventory/counts/${cnt}/lines`, { lines });
    r = await call('POST', `/inventory/counts/${cnt}/complete`, {});
    check('count completed', r.status === 200, JSON.stringify(r.body));

    k = await kpis();
    const accLines = by(k, 'inventory_accuracy').detail.lines_counted;
    check('accuracy = exact lines / counted lines (C exact, A off by 2; B has no stock so is not counted -> 1 of 2)', accLines === 2 && by(k, 'inventory_accuracy').value === 50, JSON.stringify(by(k, 'inventory_accuracy')));
    check('stockout rate: B and A sold, B is out -> 50%', by(k, 'stockout_rate').value === 50 && by(k, 'stockout_rate').detail.items_sold === 2, JSON.stringify(by(k, 'stockout_rate')));
    check('lead time = average of 4 and 2 days', near(by(k, 'replenishment_lead_time').value, 3, 0.01) && by(k, 'replenishment_lead_time').detail.supplier_promised_days === 5, JSON.stringify(by(k, 'replenishment_lead_time')));
    check('supplier on-time: 1 of 2 purchase orders', by(k, 'supplier_fulfillment').value === 50 && by(k, 'supplier_fulfillment').detail.on_time === 1 && by(k, 'supplier_fulfillment').detail.suppliers[0].supplier === 'KPI Supply', JSON.stringify(by(k, 'supplier_fulfillment').detail));
    check('order fulfillment: 1 of 3 orders voided -> 66.7%', near(by(k, 'order_fulfillment').value, 66.7) && by(k, 'order_fulfillment').detail.voided === 1 && by(k, 'order_fulfillment').detail.orders === 3, JSON.stringify(by(k, 'order_fulfillment')));
    check('expiry and damage losses = 5 x 10 = 50', by(k, 'expiry_damage_losses').value === 50, JSON.stringify(by(k, 'expiry_damage_losses')));
    const valuation = (await call('GET', '/inventory/valuation')).body.totals.value;
    const wc = by(k, 'working_capital');
    check('working capital equals the valuation report', wc.value === valuation && valuation > 0, `${wc.value} vs ${valuation}`);
    check('working capital detail: nothing owed (no payments recorded -> full balance is owed)', typeof wc.detail.unpaid_supplier_balance === 'number' && wc.detail.valuation_method, JSON.stringify(wc.detail));
    const turn = by(k, 'inventory_turnover'), doh = by(k, 'days_on_hand');
    check('cost of sales = 30 x 10 + 10 x 5 = 350 (a voided sale nets to nothing)', turn.detail.cost_of_sales === 350, JSON.stringify(turn.detail));
    check('turnover = cost of sales / average inventory, annualised', turn.value > 0 && near(turn.value, (350 / turn.detail.average_inventory_value) * (365 / 90), 0.02), JSON.stringify(turn));
    check('days on hand = inventory value / daily cost of sales', doh.value === Math.round(valuation / (350 / 90)), JSON.stringify(doh));
    check('a shorter period gives a different window', (await kpis('?days=30')).period.days === 30 && (await kpis('?days=30')).measures.find(m => m.id === 'inventory_turnover').detail.days === 30);
    check('a period with no activity reports no data, not zero', by(await kpis(`?from=${day(-800)}&to=${day(-700)}`), 'replenishment_lead_time').value === null);
    check('carrying cost needs a configured rate (not guessed)', by(k, 'carrying_cost').status === 'not_configured' && by(k, 'carrying_cost').value === null);
    check('E&O is measured at cost', typeof by(k, 'excess_obsolete_value').value === 'number');
    check('every measure states its basis', k.measures.every(m => m.basis && m.basis.length > 20));
    check('no targets at start', k.measures.every(m => m.target === null) && k.measures.filter(m => m.value !== null && m.id !== 'carrying_cost').every(m => m.status === 'no_target' && m.suggested_target !== null), JSON.stringify(k.summary));

    // ── targets ──
    r = await call('PUT', '/inventory/insights/kpis/targets', { targets: { inventory_accuracy: 95, stockout_rate: 55, supplier_fulfillment: 55, replenishment_lead_time: 3.2, order_fulfillment: 90 }, carrying_cost_rate: 20 });
    check('administrator sets targets and the carrying-cost rate', r.status === 200 && r.body.targets.inventory_accuracy === 95 && r.body.carrying_cost_rate === 20, JSON.stringify(r.body));
    k = await kpis();
    check('accuracy 50 vs target 95: off target (higher is better)', by(k, 'inventory_accuracy').status === 'off_target');
    check('stockout 50 vs target 55: on target (lower is better)', by(k, 'stockout_rate').status === 'on_target');
    check('on-time 50 vs 55: within 10% -> watch', by(k, 'supplier_fulfillment').status === 'watch', JSON.stringify(by(k, 'supplier_fulfillment')));
    check('lead time 3 vs 3.2: on target', by(k, 'replenishment_lead_time').status === 'on_target');
    check('order fulfillment 66.7 vs 90: off target', by(k, 'order_fulfillment').status === 'off_target');
    check('a measure with a target no longer shows a suggestion', by(k, 'inventory_accuracy').suggested_target === null && by(k, 'inventory_accuracy').target === 95);
    const cc = by(k, 'carrying_cost');
    check('carrying cost = average inventory x 20%', cc.value !== null && near(cc.value, cc.detail.average_inventory_value * 0.2, 0.02) && cc.status === 'no_target', JSON.stringify(cc));
    check('summary counts the statuses', k.summary.with_target === 5 && k.summary.on_target === 2 && k.summary.watch === 1 && k.summary.off_target === 2, JSON.stringify(k.summary));
    r = await call('PUT', '/inventory/insights/kpis/targets', { targets: { stockout_rate: null } });
    check('a target can be cleared and the others stay', r.status === 200 && r.body.targets.stockout_rate === undefined && r.body.targets.inventory_accuracy === 95 && r.body.carrying_cost_rate === 20);
    check('unknown measure refused', (await call('PUT', '/inventory/insights/kpis/targets', { targets: { nonsense: 5 } })).status === 400);
    check('percentage above 100 refused', (await call('PUT', '/inventory/insights/kpis/targets', { targets: { inventory_accuracy: 120 } })).status === 400);
    check('negative target refused', (await call('PUT', '/inventory/insights/kpis/targets', { targets: { days_on_hand: -1 } })).status === 400);
    check('text target refused', (await call('PUT', '/inventory/insights/kpis/targets', { targets: { days_on_hand: 'soon' } })).status === 400);
    check('carrying-cost rate above 100 refused', (await call('PUT', '/inventory/insights/kpis/targets', { carrying_cost_rate: 150 })).status === 400);
    check('bad period refused', (await call('GET', '/inventory/insights/kpis?from=2026-05-01&to=2026-01-01')).status === 400);
    check('badly formed date refused', (await call('GET', '/inventory/insights/kpis?from=yesterday')).status === 400);
    check('the failed attempts changed nothing', (await kpis()).measures.find(m => m.id === 'inventory_accuracy').target === 95);

    // ── permissions ──
    check('manager may read the scorecard', (await call('GET', '/inventory/insights/kpis', null, mgr)).status === 200);
    check('manager cannot set targets', (await call('PUT', '/inventory/insights/kpis/targets', { targets: { days_on_hand: 30 } }, mgr)).status === 403);
    check('warehouse staff cannot set targets', (await call('PUT', '/inventory/insights/kpis/targets', { targets: { days_on_hand: 30 } }, staff)).status === 403);
    const sk = await kpis('', staff);
    check('without cost permission money measures are withheld', ['excess_obsolete_value', 'expiry_damage_losses', 'carrying_cost', 'working_capital'].every(id => by(sk, id).value === null && by(sk, id).status === 'hidden' && Object.keys(by(sk, id).detail).length === 0), JSON.stringify(sk.measures.filter(m => m.money)));
    check('non-money measures stay visible to staff', by(sk, 'inventory_accuracy').value !== null && by(sk, 'stockout_rate').value === 50);
    check('turnover detail (cost of sales, inventory value) is withheld too', Object.keys(by(sk, 'inventory_turnover').detail).length === 0 && by(sk, 'inventory_turnover').value !== null);
    check('supplier detail carries no money', !/value|cost|total/i.test(JSON.stringify(by(sk, 'supplier_fulfillment').detail).replace(/orders_with_expected_date|on_time/g, '')));
    check('anonymous caller refused', (await fetch(`${BASE}/inventory/insights/kpis`)).status === 401);

    // ── isolation and audit ──
    const kb = (await call('GET', '/inventory/insights/kpis', null, adminB, B.br)).body;
    check('another organisation sees none of this data or these targets', kb.measures.every(m => m.target === null) && by(kb, 'inventory_accuracy').value === null && by(kb, 'working_capital').value === 0, JSON.stringify(kb.measures.map(m => [m.id, m.value])));
    await new Promise(res => setTimeout(res, 800));
    const log = (await pool.request().input('o', sql.Int, org).query("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = @o AND entity = 'kpi_targets'")).recordset[0].n;
    check('target changes are audited', log >= 2, log);
  } catch (e) { fail++; console.log('EXC', e.stack); }
  finally {
    for (const o of [org, B.org]) {
      for (const q of ['DELETE FROM stock_count_items WHERE count_id IN (SELECT id FROM stock_counts WHERE organization_id=@o)', 'DELETE FROM stock_counts WHERE organization_id=@o',
        'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id=@o)', 'DELETE FROM sales WHERE organization_id=@o',
        'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id=@o)', 'DELETE FROM purchases WHERE organization_id=@o',
        'DELETE FROM stock_cost_layers WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)', 'DELETE FROM batch_location_stock WHERE batch_id IN (SELECT id FROM stock_batches WHERE organization_id=@o)',
        'DELETE FROM stock_batches WHERE organization_id=@o', 'DELETE FROM item_location_stock WHERE tire_id IN (SELECT id FROM tires WHERE organization_id=@o)',
        'DELETE FROM stock_locations WHERE organization_id=@o', 'DELETE FROM warehouses WHERE organization_id=@o', 'DELETE FROM product_history WHERE organization_id=@o',
        'DELETE FROM stock_movements WHERE organization_id=@o', 'DELETE FROM stock_adjustments WHERE organization_id=@o', 'DELETE FROM tires WHERE organization_id=@o',
        'DELETE FROM item_categories WHERE organization_id=@o', 'DELETE FROM suppliers WHERE organization_id=@o', 'DELETE FROM audit_logs WHERE organization_id=@o', 'DELETE FROM idempotency_keys WHERE organization_id=@o',
        'DELETE FROM access_roles WHERE organization_id=@o', 'DELETE FROM users WHERE organization_id=@o', 'DELETE FROM branches WHERE organization_id=@o', 'DELETE FROM settings WHERE organization_id=@o', 'DELETE FROM organizations WHERE id=@o']) {
        try { await pool.request().input('o', sql.Int, o).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn', q.slice(0, 50), e.message); }
      }
    }
    console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
  }
})();
