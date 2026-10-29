// HTTP smoke test in a throwaway organisation; everything is deleted at the end.
process.chdir(require('path').resolve(__dirname, '../..'));
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../../db');
const BASE = 'http://localhost:3055/api';
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + extra}`); };

(async () => {
  const pool = await getPool();
  const org = (await pool.request().query("INSERT INTO organizations (name, code, type) OUTPUT INSERTED.id VALUES ('SMOKE ORG', 'SMOKE' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'retail')")).recordset[0].id;
  const br  = (await pool.request().input('o', sql.Int, org).query("INSERT INTO branches (organization_id, name, code) OUTPUT INSERTED.id VALUES (@o, 'Main', 'MAIN')")).recordset[0].id;
  const tok = (userId, role, branchId = null) => jwt.sign({ userId, orgId: org, branchId, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const admin = tok(1001, 'org_admin'), staff = tok(1002, 'staff', br), mgr = tok(1002, 'branch_manager', br);
  const call = async (method, path, token, body, headers = {}) => {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Branch-ID': String(br), ...headers }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch { /* empty */ }
    return { status: r.status, body: json, headers: r.headers };
  };
  try {
    // 1 create item with opening stock
    let r = await call('POST', '/inventory', admin, { brand: 'Smoke', model: 'Item', size: 'S1', stock: 5, cost_price: 100, sale_price: 150 });
    check('create item with opening stock', r.status === 201 && r.body.stock === 5, JSON.stringify(r.body));
    const id = r.body.id;
    r = await call('GET', `/inventory/movements?tire_id=${id}`, admin);
    check('opening stock is in the ledger', r.status === 200 && r.body.length === 1 && r.body[0].reason === 'opening_stock' && r.body[0].qty_after === 5, JSON.stringify(r.body));

    // 2 sale larger than stock is refused
    const sale = qty => ({ date: '2026-10-28', items: [{ tire_id: id, qty, unit_price: 150 }], tax_rate: 0 });
    r = await call('POST', '/sales', admin, sale(6));
    check('oversell refused with 409', r.status === 409 && r.body.code === 'INSUFFICIENT_STOCK', JSON.stringify(r.body));
    r = await call('POST', '/sales', admin, sale(-3));
    check('negative quantity refused', r.status === 400, JSON.stringify(r.body));

    // 3 valid sale and duplicate guard
    r = await call('POST', '/sales', admin, sale(2));
    check('sale accepted', r.status === 201, JSON.stringify(r.body));
    const saleId = r.body.id;
    const dup = await call('POST', '/sales', admin, sale(2));
    check('identical resubmission blocked', dup.status === 409 && dup.body.code === 'DUPLICATE_REQUEST', JSON.stringify(dup.body));
    r = await call('GET', `/inventory/${id}`, admin);
    check('stock is 3 after one sale only', r.body.stock === 3, JSON.stringify(r.body));

    // 4 Idempotency-Key replay
    const k = 'smoke-key-' + Date.now();
    const a = await call('POST', '/sales', admin, sale(1), { 'Idempotency-Key': k });
    const b = await call('POST', '/sales', admin, sale(1), { 'Idempotency-Key': k });
    check('idempotency key replays the first response', a.status === 201 && b.status === 201 && a.body.id === b.body.id && b.headers.get('idempotent-replay') === 'true', JSON.stringify([a.body?.id, b.body?.id]));
    r = await call('GET', `/inventory/${id}`, admin);
    check('replay did not deduct twice (stock 2)', r.body.stock === 2, JSON.stringify(r.body));

    // 5 manual edit becomes an adjustment
    r = await call('PUT', `/inventory/${id}`, admin, { brand: 'Smoke', model: 'Item', size: 'S1', stock: 10, cost_price: 100, sale_price: 150, reorder_level: 3 });
    check('admin edit of stock posts an adjustment', r.status === 200 && r.body.stock === 10, JSON.stringify(r.body));
    r = await call('GET', '/inventory/adjustments?status=approved', admin);
    check('adjustment document recorded', r.status === 200 && r.body.some(x => x.tire_id === id && x.qty_change === 8), JSON.stringify(r.body));

    // 6 staff stock change goes pending, manager approves, self-approval blocked
    r = await call('PUT', `/inventory/${id}`, staff, { brand: 'Smoke', model: 'Item', size: 'S1', stock: 7, cost_price: 100, sale_price: 150, reorder_level: 3 });
    check('staff cannot edit the product master (403)', r.status === 403 && r.body.code === 'FORBIDDEN', JSON.stringify(r.body));
    r = await call('POST', '/inventory/adjustments', staff, { tire_id: id, qty_change: -3, reason_code: 'damage' });
    check('staff adjustment request is pending, stock unchanged', r.status === 202 && r.body.status === 'pending', JSON.stringify(r.body));
    r = await call('GET', '/inventory/adjustments?status=pending', mgr);
    const adj = r.body?.[0];
    check('pending adjustment visible to manager', r.status === 200 && adj && adj.qty_change === -3, JSON.stringify(r.body));
    r = await call('POST', `/inventory/adjustments/${adj.id}/approve`, mgr, {});
    check('requester cannot approve own adjustment', r.status === 403 && r.body.code === 'SELF_APPROVAL', JSON.stringify(r.body));
    r = await call('POST', `/inventory/adjustments/${adj.id}/approve`, admin, {});
    check('admin approval posts the movement', r.status === 200 && r.body.status === 'approved', JSON.stringify(r.body));
    r = await call('POST', `/inventory/adjustments/${adj.id}/approve`, admin, {});
    check('cannot decide twice', r.status === 409, JSON.stringify(r.body));
    r = await call('GET', `/inventory/${id}`, admin);
    check('stock is 7 after approval', r.body.stock === 7, JSON.stringify(r.body));
    r = await call('POST', '/inventory/adjustments', staff, { tire_id: id, qty_change: 3, reason_code: 'damage' });
    check('wrong-direction reason rejected', r.status === 400 && r.body.code === 'INVALID_DIRECTION', JSON.stringify(r.body));

    // 7 void, then delete the voided sale: stock restored exactly once
    r = await call('POST', `/sales/${saleId}/void`, admin, {});
    check('void accepted', r.status === 200, JSON.stringify(r.body));
    r = await call('GET', `/inventory/${id}`, admin);
    check('void returned 2 units (stock 9)', r.body.stock === 9, JSON.stringify(r.body));
    r = await call('DELETE', `/sales/${saleId}`, admin);
    r = await call('GET', `/inventory/${id}`, admin);
    check('deleting a voided sale does not restore stock again', r.body.stock === 9, JSON.stringify(r.body));

    // 8 purchase receive then cancel after stock consumed
    r = await call('POST', '/purchases', admin, { supplier_id: null, items: [] });
    r = await pool.request().input('o', sql.Int, org).query("INSERT INTO suppliers (organization_id, code, name) OUTPUT INSERTED.id VALUES (@o, 'SMK-' + CAST(ABS(CHECKSUM(NEWID())) % 100000 AS NVARCHAR), 'Smoke Supplier')");
    const supplier = r.recordset[0].id;
    r = await call('POST', '/purchases', admin, { supplier_id: supplier, status: 'received', date: '2026-10-28', items: [{ tire_id: id, qty: 4, unit_price: 90 }] });
    check('received purchase adds stock', r.status === 201, JSON.stringify(r.body));
    const poId = r.body.id;
    r = await call('GET', `/inventory/${id}`, admin);
    check('stock is 13 after receiving 4', r.body.stock === 13, JSON.stringify(r.body));
    const big = await call('POST', '/sales', admin, sale(12)); console.log('sale12:', big.status, JSON.stringify(big.body).slice(0,160));
    r = await call('PATCH', `/purchases/${poId}/status`, admin, { status: 'cancelled' });
    check('cancel refused when goods already sold', r.status === 409 && r.body.code === 'INSUFFICIENT_STOCK', JSON.stringify(r.body));

    // 9 reconciliation and ledger history
    r = await call('GET', '/inventory/reconciliation', admin);
    check('reconciliation reports no mismatch', r.status === 200 && r.body.mismatches === 0, JSON.stringify(r.body));
    check('reconciliation is admin only', (await call('GET', '/inventory/reconciliation', mgr)).status === 403);
    r = await call('GET', `/inventory/movements?tire_id=${id}&limit=100`, staff);
    check('movement history readable with names', r.status === 200 && r.body.length >= 8 && r.body.every(m => m.item_name), JSON.stringify(r.body.slice(0, 2)));

    // 10 cannot delete an item that still has stock
    r = await call('DELETE', `/inventory/${id}`, admin);
    check('delete blocked while item has history', r.status === 409, JSON.stringify(r.body));

    // 11 cross-org isolation
    const other = jwt.sign({ userId: 1, orgId: org + 100000, branchId: null, role: 'org_admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    r = await call('POST', '/inventory/adjustments', other, { tire_id: id, qty_change: 1, reason_code: 'found' });
    check('other organisation cannot adjust this item', [400, 403, 404].includes(r.status), JSON.stringify(r.body));
  } catch (e) { fail++; console.log('EXCEPTION', e.stack); }
  finally {
    for (const q of [
      'DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE organization_id = @o)',
      'DELETE FROM sale_payments WHERE organization_id = @o', 'DELETE FROM ledger_entries WHERE organization_id = @o',
      'DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE organization_id = @o)',
      'DELETE FROM purchase_payments WHERE organization_id = @o', 'DELETE FROM sales WHERE organization_id = @o',
      'DELETE FROM purchases WHERE organization_id = @o', 'DELETE FROM stock_movements WHERE organization_id = @o',
      'DELETE FROM stock_adjustments WHERE organization_id = @o', 'DELETE FROM tires WHERE organization_id = @o',
      'DELETE FROM suppliers WHERE organization_id = @o', 'DELETE FROM audit_logs WHERE organization_id = @o',
      'DELETE FROM idempotency_keys WHERE organization_id = @o', 'DELETE FROM report_execution_history WHERE organization_id = @o',
      'DELETE FROM branches WHERE organization_id = @o', 'DELETE FROM settings WHERE organization_id = @o', 'DELETE FROM organizations WHERE id = @o',
    ]) { try { await pool.request().input('o', sql.Int, org).query("EXEC sp_set_session_context N'allow_purge', 1; " + q); } catch (e) { console.log('cleanup warn:', q.slice(0, 40), e.message); } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
