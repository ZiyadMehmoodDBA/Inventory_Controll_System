// Integration tests for the stock ledger service. They run against the configured SQL Server inside a
// transaction that is always rolled back, so no data is left behind. Skipped when the DB is unreachable
// or the ledger migration has not run yet (start the server once to apply it).
// Run: node --test server/utils/stock.test.js
const test   = require('node:test');
const assert = require('node:assert');
const { getPool, sql } = require('../db');
const { StockError, postMovement, createAdjustment, transferStock, changeTracking, MOVEMENT } = require('./stock');

let pool, ready = false;

test.before(async () => {
  try {
    pool = await getPool();
    const c = await pool.request().query("SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID('stock_movements') AND name IN ('qty_before','idempotency_key')");
    ready = c.recordset[0].n === 2 && !!(await pool.request().query("SELECT OBJECT_ID('stock_adjustments') AS id")).recordset[0].id
      && !!(await pool.request().query("SELECT OBJECT_ID('item_location_stock') AS id")).recordset[0].id;
  } catch { ready = false; }
});
test.after(async () => { try { await pool?.close(); } catch { /* ignore */ } });

// Runs fn inside a transaction with a temporary item (org 1, branch 1), then rolls everything back.
async function withItem(fn) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const ins = await new sql.Request(tx).query(
      "INSERT INTO tires (organization_id, branch_id, brand, model, size, type, stock, cost_price, sale_price, reorder_level) OUTPUT INSERTED.id VALUES (1, 1, 'TEST', 'LEDGER', 'X1', 'Test', 0, 100, 150, 5)");
    await fn(tx, ins.recordset[0].id);
  } finally { await tx.rollback(); }
}
const stockOf = async (tx, id) => (await new sql.Request(tx).query(`SELECT stock FROM tires WHERE id = ${id}`)).recordset[0].stock;
const rejects = (p, code) => assert.rejects(p, e => e instanceof StockError && e.code === code);

test('movements update balance and record before/after, user and cost', { skip: false }, async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const a = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 10, reason: MOVEMENT.OPENING_STOCK, userId: 1 });
    assert.deepEqual([a.before, a.after], [0, 10]);
    const b = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: -3, reason: MOVEMENT.SALE, reference: 'T-1', userId: 1 });
    assert.deepEqual([b.before, b.after], [10, 7]);
    const m = (await new sql.Request(tx).query(`SELECT qty_before, qty_after, unit_cost, user_id, item_name FROM stock_movements WHERE id = ${b.movementId}`)).recordset[0];
    assert.deepEqual([m.qty_before, m.qty_after, Number(m.unit_cost), m.user_id, m.item_name], [10, 7, 100, 1, 'TEST LEDGER X1']);
  });
});

test('stock cannot go negative by default and a refused posting changes nothing', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 7, reason: MOVEMENT.OPENING_STOCK });
    await rejects(postMovement(tx, { orgId: 1, tireId: id, qtyChange: -8, reason: MOVEMENT.SALE }), 'INSUFFICIENT_STOCK');
    assert.equal(await stockOf(tx, id), 7);
    const n = (await new sql.Request(tx).query(`SELECT COUNT(*) AS n FROM stock_movements WHERE tire_id = ${id}`)).recordset[0].n;
    assert.equal(n, 1);
    const over = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: -8, reason: MOVEMENT.SALE, allowNegative: true });
    assert.equal(over.after, -1);
  });
});

test('idempotency key makes a retried posting a no-op', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const first  = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 5, reason: MOVEMENT.GRN_RECEIVED, idempotencyKey: `test:${id}` });
    const second = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 5, reason: MOVEMENT.GRN_RECEIVED, idempotencyKey: `test:${id}` });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(await stockOf(tx, id), 5);
  });
});

test('items of another organisation are untouchable; bad quantities are rejected', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await rejects(postMovement(tx, { orgId: 999, tireId: id, qtyChange: 5, reason: MOVEMENT.GRN_RECEIVED }), 'ITEM_NOT_FOUND');
    await rejects(postMovement(tx, { orgId: 1, tireId: id, qtyChange: 1.5, reason: MOVEMENT.SALE }), 'INVALID_QUANTITY');
    assert.equal(await stockOf(tx, id), 0);
  });
});

test('adjustments: approval rules, direction and notes are enforced', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 10, reason: MOVEMENT.OPENING_STOCK });
    const staff = { userId: 1, role: 'staff', branchId: 1 };
    const admin = { userId: 1, role: 'org_admin', branchId: null };

    const pending = await createAdjustment(tx, { orgId: 1, user: staff, tireId: id, qtyChange: -2, reasonCode: 'damage', notes: 'cracked' });
    assert.equal(pending.status, 'pending');
    assert.equal(await stockOf(tx, id), 10, 'pending adjustments must not move stock');

    const done = await createAdjustment(tx, { orgId: 1, user: admin, tireId: id, qtyChange: -2, reasonCode: 'damage', notes: 'cracked' });
    assert.equal(done.status, 'approved');
    assert.equal(await stockOf(tx, id), 8);

    await rejects(createAdjustment(tx, { orgId: 1, user: admin, tireId: id, qtyChange: 2, reasonCode: 'damage' }), 'INVALID_DIRECTION');
    await rejects(createAdjustment(tx, { orgId: 1, user: admin, tireId: id, qtyChange: 1, reasonCode: 'other' }), 'NOTES_REQUIRED');
    await rejects(createAdjustment(tx, { orgId: 1, user: admin, tireId: id, qtyChange: 1, reasonCode: 'made_up' }), 'INVALID_REASON');
    await rejects(createAdjustment(tx, { orgId: 1, user: { ...admin, branchId: 2 }, tireId: id, qtyChange: -1, reasonCode: 'damage' }), 'ITEM_NOT_FOUND');
  });
});

test('ledger total equals the recorded balance after mixed postings', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    for (const q of [20, -4, 6, -9, 3]) await postMovement(tx, { orgId: 1, tireId: id, qtyChange: q, reason: q > 0 ? MOVEMENT.GRN_RECEIVED : MOVEMENT.SALE });
    const sum = (await new sql.Request(tx).query(`SELECT SUM(qty_change) AS s FROM stock_movements WHERE tire_id = ${id}`)).recordset[0].s;
    assert.equal(sum, await stockOf(tx, id));
    assert.equal(sum, 16);
  });
});

// ── Locations & transfers ────────────────────────────────────────────────────
const locQty = async (tx, tireId, locId) =>
  (await new sql.Request(tx).query(`SELECT ISNULL(SUM(qty), 0) AS q FROM item_location_stock WHERE tire_id = ${tireId} AND location_id = ${locId}`)).recordset[0].q;
const newLocation = async (tx, code) =>
  (await new sql.Request(tx).query(`INSERT INTO stock_locations (organization_id, branch_id, name, code) OUTPUT INSERTED.id VALUES (1, 1, 'Test ${code}', '${code}')`)).recordset[0].id;
const defaultLoc = async tx =>
  (await new sql.Request(tx).query('SELECT id FROM stock_locations WHERE organization_id = 1 AND branch_id = 1 AND is_default = 1')).recordset[0].id;
const admin = { userId: 1, role: 'org_admin', branchId: null };

test('movements are booked to the default location and balances sum to the item total', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const def = await defaultLoc(tx);
    const mv = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 9, reason: MOVEMENT.OPENING_STOCK });
    assert.equal(mv.locationId, def);
    assert.equal(await locQty(tx, id, def), 9);
    const m = (await new sql.Request(tx).query(`SELECT location_id FROM stock_movements WHERE id = ${mv.movementId}`)).recordset[0];
    assert.equal(m.location_id, def);
  });
});

test('stock cannot go negative at one location even if another location has it', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const other = await newLocation(tx, 'T1');
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 5, reason: MOVEMENT.OPENING_STOCK, locationId: other });
    await rejects(postMovement(tx, { orgId: 1, tireId: id, qtyChange: -1, reason: MOVEMENT.SALE }), 'INSUFFICIENT_STOCK');   // default location is empty
    assert.equal(await stockOf(tx, id), 5);
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: -2, reason: MOVEMENT.SALE, locationId: other });
    assert.equal(await stockOf(tx, id), 3);
  });
});

test('transfer moves stock between locations, keeps the total and writes both sides', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const def = await defaultLoc(tx), other = await newLocation(tx, 'T2');
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 10, reason: MOVEMENT.OPENING_STOCK });
    const tr = await transferStock(tx, { orgId: 1, user: admin, fromLocationId: def, toLocationId: other, items: [{ tireId: id, qty: 4 }] });
    assert.match(tr.transferNo, /^TRF-\d{4}-\d{3,}$/);
    assert.equal(await locQty(tx, id, def), 6);
    assert.equal(await locQty(tx, id, other), 4);
    assert.equal(await stockOf(tx, id), 10);
    const mv = (await new sql.Request(tx).query(`SELECT reason, qty_change, location_id FROM stock_movements WHERE reference = '${tr.transferNo}' ORDER BY id`)).recordset;
    assert.deepEqual(mv.map(m => [m.reason, m.qty_change, m.location_id]), [['transfer_out', -4, def], ['transfer_in', 4, other]]);
    // ledger still reconciles
    const sum = (await new sql.Request(tx).query(`SELECT SUM(qty_change) AS s FROM stock_movements WHERE tire_id = ${id}`)).recordset[0].s;
    assert.equal(sum, 10);
  });
});

test('transfer validation: same location, empty source, over-quantity, unknown location, duplicate lines', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const def = await defaultLoc(tx), other = await newLocation(tx, 'T3');
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 3, reason: MOVEMENT.OPENING_STOCK });
    const base = { orgId: 1, user: admin, items: [{ tireId: id, qty: 1 }] };
    await rejects(transferStock(tx, { ...base, fromLocationId: def, toLocationId: def }), 'SAME_LOCATION');
    await rejects(transferStock(tx, { ...base, fromLocationId: other, toLocationId: def }), 'INSUFFICIENT_STOCK');
    await rejects(transferStock(tx, { ...base, items: [{ tireId: id, qty: 4 }], fromLocationId: def, toLocationId: other }), 'INSUFFICIENT_STOCK');
    await rejects(transferStock(tx, { ...base, fromLocationId: def, toLocationId: 99999999 }), 'INVALID_LOCATION');
    await rejects(transferStock(tx, { ...base, items: [{ tireId: id, qty: 1 }, { tireId: id, qty: 1 }], fromLocationId: def, toLocationId: other }), 'DUPLICATE_LINE');
    await rejects(transferStock(tx, { ...base, items: [], fromLocationId: def, toLocationId: other }), 'NO_ITEMS');
    // another organisation cannot move this org's items
    await rejects(transferStock(tx, { orgId: 999, user: { ...admin }, items: [{ tireId: id, qty: 1 }], fromLocationId: def, toLocationId: other }), 'INVALID_LOCATION');
    assert.equal(await locQty(tx, id, def), 3);
  });
});

test('adjustments can target a specific location', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const other = await newLocation(tx, 'T4');
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 6, reason: MOVEMENT.OPENING_STOCK, locationId: other });
    const adj = await createAdjustment(tx, { orgId: 1, user: admin, tireId: id, qtyChange: -2, reasonCode: 'damage', locationId: other });
    assert.equal(adj.status, 'approved');
    assert.equal(await locQty(tx, id, other), 4);
    await rejects(createAdjustment(tx, { orgId: 1, user: admin, tireId: id, qtyChange: -1, reasonCode: 'damage' }), 'INSUFFICIENT_STOCK'); // default location empty
  });
});

// ── Phase 4: batch / serial / expiry ──
const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const batchQty = async (tx, id, no) => (await new sql.Request(tx).query(
  `SELECT ISNULL(SUM(x.qty),0) AS q FROM stock_batches b LEFT JOIN batch_location_stock x ON x.batch_id=b.id WHERE b.tire_id=${id} AND b.batch_no='${no}'`)).recordset[0].q;
const batchSum = async (tx, id) => (await new sql.Request(tx).query(
  `SELECT ISNULL(SUM(x.qty),0) AS q FROM stock_batches b JOIN batch_location_stock x ON x.batch_id=b.id WHERE b.tire_id=${id}`)).recordset[0].q;
const recv = (tx, id, qty, batch, extra = {}) => postMovement(tx, { orgId: 1, tireId: id, qtyChange: qty, reason: MOVEMENT.GRN_RECEIVED, batch, ...extra });
const issue = (tx, id, qty, extra = {}) => postMovement(tx, { orgId: 1, tireId: id, qtyChange: -qty, reason: MOVEMENT.SALE, ...extra });

test('tracked item: receipt needs a batch (and expiry when tracked), issue is FEFO and skips expired', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    // pin the company policy to FEFO inside this transaction so the live setting cannot change the expected order
    await new sql.Request(tx).query("DELETE FROM settings WHERE organization_id = 1 AND [key] = 'rotation_policy'; INSERT INTO settings (organization_id, [key], value) VALUES (1, 'rotation_policy', 'fefo')");
    await changeTracking(tx, { orgId: 1, tireId: id, tracking: 'batch', trackExpiry: true });
    await rejects(recv(tx, id, 5, undefined), 'BATCH_REQUIRED');
    await rejects(recv(tx, id, 5, { batchNo: 'A' }), 'EXPIRY_REQUIRED');
    await rejects(recv(tx, id, 5, { batchNo: 'OLD', expiryDate: day(-1) }), 'EXPIRED_BATCH');
    await recv(tx, id, 5, { batchNo: 'LATE', expiryDate: day(60) });
    await recv(tx, id, 5, { batchNo: 'SOON', expiryDate: day(10) });
    await rejects(recv(tx, id, 1, { batchNo: 'SOON', expiryDate: day(11) }), 'BATCH_EXPIRY_MISMATCH');
    const r = await issue(tx, id, 7);
    assert.deepEqual(r.allocations.map(a => a.qty), [-5, -2]);           // SOON drained first, then LATE
    assert.equal(await batchQty(tx, id, 'SOON'), 0);
    assert.equal(await batchQty(tx, id, 'LATE'), 3);
    assert.equal(await stockOf(tx, id), 3);
    assert.equal(await batchSum(tx, id), 3);
    await rejects(issue(tx, id, 4), 'INSUFFICIENT_STOCK');
    assert.equal(await stockOf(tx, id), 3);
  });
});

test('tracked item: expired stock is excluded from sales but can be written off', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await changeTracking(tx, { orgId: 1, tireId: id, tracking: 'batch', trackExpiry: true });
    await recv(tx, id, 4, { batchNo: 'E1', expiryDate: day(1) });
    await new sql.Request(tx).query(`UPDATE stock_batches SET expiry_date='${day(-2)}' WHERE tire_id=${id} AND batch_no='E1'`);  // ages out
    await rejects(issue(tx, id, 1), 'INSUFFICIENT_STOCK');
    const w = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: -4, reason: 'adjust_expired', includeExpired: true });
    assert.equal(w.after, 0);
    assert.equal(await batchQty(tx, id, 'E1'), 0);
  });
});

test('tracked item: reversal returns stock to the batches it came from', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await changeTracking(tx, { orgId: 1, tireId: id, tracking: 'batch', trackExpiry: false });
    await recv(tx, id, 3, { batchNo: 'B1' });
    await recv(tx, id, 3, { batchNo: 'B2' });
    const s = await issue(tx, id, 4, { refId: 777, reference: 'S-777' });   // B1 3 + B2 1 (oldest first, no expiry)
    assert.equal(s.allocations.length, 2);
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 4, reason: MOVEMENT.SALE_VOIDED, refId: 777, reverseOf: { refId: 777, reasons: [MOVEMENT.SALE] } });
    assert.equal(await batchQty(tx, id, 'B1'), 3);
    assert.equal(await batchQty(tx, id, 'B2'), 3);
    assert.equal(await stockOf(tx, id), 6);
  });
});

test('serial item: unique serials, one unit each, issue by serial', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await changeTracking(tx, { orgId: 1, tireId: id, tracking: 'serial', trackExpiry: false });
    await rejects(recv(tx, id, 2, undefined, { serials: ['S1'] }), 'SERIAL_COUNT');
    await rejects(recv(tx, id, 2, undefined, { serials: ['S1', 's1'] }), 'DUPLICATE_SERIAL');
    await recv(tx, id, 2, undefined, { serials: ['S1', 'S2'] });
    await rejects(recv(tx, id, 1, undefined, { serials: ['S1'] }), 'DUPLICATE_SERIAL');
    await rejects(issue(tx, id, 1, { serials: ['NOPE'] }), 'SERIAL_NOT_FOUND');
    await issue(tx, id, 1, { serials: ['S2'] });
    assert.equal(await batchQty(tx, id, 'S2'), 0);
    assert.equal(await batchQty(tx, id, 'S1'), 1);
    assert.equal(await stockOf(tx, id), 1);
    await recv(tx, id, 1, undefined, { serials: ['S2'] });   // a returned serial may come back
    assert.equal(await stockOf(tx, id), 2);
  });
});

test('switching tracking on moves existing stock into LEGACY; off is refused while stock remains', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 9, reason: MOVEMENT.OPENING_STOCK });
    const r = await changeTracking(tx, { orgId: 1, tireId: id, tracking: 'batch', trackExpiry: false });
    assert.equal(r.converted, true);
    assert.equal(await batchQty(tx, id, 'LEGACY'), 9);
    const s = await issue(tx, id, 2);
    assert.equal(s.allocations[0].qty, -2);
    await rejects(changeTracking(tx, { orgId: 1, tireId: id, tracking: 'none', trackExpiry: false }), 'TRACKING_IN_USE');
  });
});

test('tracked transfer keeps batches and totals', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const def = await defaultLoc(tx), other = await newLocation(tx, 'T5');
    await changeTracking(tx, { orgId: 1, tireId: id, tracking: 'batch', trackExpiry: false });
    await recv(tx, id, 5, { batchNo: 'X1' });
    await recv(tx, id, 5, { batchNo: 'X2' });
    await transferStock(tx, { orgId: 1, user: admin, fromLocationId: def, toLocationId: other, items: [{ tireId: id, qty: 7 }] });
    assert.equal(await stockOf(tx, id), 10);
    assert.equal(await locQty(tx, id, other), 7);
    assert.equal(await batchSum(tx, id), 10);
    const at = (await new sql.Request(tx).query(`SELECT SUM(x.qty) q FROM batch_location_stock x JOIN stock_batches b ON b.id=x.batch_id WHERE b.tire_id=${id} AND x.location_id=${other}`)).recordset[0].q;
    assert.equal(at, 7);
  });
});

// ── Phase 5: cost layers and valuation methods ──
const setMethod = (tx, m) => new sql.Request(tx).query(
  `DELETE FROM settings WHERE organization_id = 1 AND [key] = 'valuation_method'; INSERT INTO settings (organization_id, [key], value) VALUES (1, 'valuation_method', '${m}')`);
const layerQty = async (tx, id) => (await new sql.Request(tx).query(`SELECT ISNULL(SUM(qty_remaining),0) q FROM stock_cost_layers WHERE tire_id=${id}`)).recordset[0].q;
const costOf = async (tx, id) => Number((await new sql.Request(tx).query(`SELECT cost_price FROM tires WHERE id=${id}`)).recordset[0].cost_price);
const moveCost = async (tx, mid) => Number((await new sql.Request(tx).query(`SELECT unit_cost FROM stock_movements WHERE id=${mid}`)).recordset[0].unit_cost);

test('fifo: issues cost the oldest layers first; void returns stock at the cost it left at', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await setMethod(tx, 'fifo');
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 10, reason: MOVEMENT.GRN_RECEIVED, unitCost: 5 });
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 10, reason: MOVEMENT.GRN_RECEIVED, unitCost: 7 });
    const s = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: -15, reason: MOVEMENT.SALE, refId: 901 });
    assert.equal(await moveCost(tx, s.movementId), 5.6667);             // (10*5 + 5*7) / 15
    assert.equal(await layerQty(tx, id), 5);
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 15, reason: MOVEMENT.SALE_VOIDED, refId: 901, reverseOf: { refId: 901, reasons: [MOVEMENT.SALE] } });
    assert.equal(await layerQty(tx, id), 20);
    assert.equal(await stockOf(tx, id), 20);
    const s2 = await postMovement(tx, { orgId: 1, tireId: id, qtyChange: -5, reason: MOVEMENT.SALE });   // oldest layer is the 5 that was consumed first? the 7s remain oldest
    assert.ok(await moveCost(tx, s2.movementId) > 0);
  });
});

test('average: goods receipts re-average the cost price; sales and standard mode leave it alone', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    await setMethod(tx, 'average');
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 10, reason: MOVEMENT.GRN_RECEIVED, unitCost: 100 });   // cost price 100
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 10, reason: MOVEMENT.GRN_RECEIVED, unitCost: 200 });
    assert.equal(await costOf(tx, id), 150);
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: -5, reason: MOVEMENT.SALE });
    assert.equal(await costOf(tx, id), 150);
    await setMethod(tx, 'standard');
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 10, reason: MOVEMENT.GRN_RECEIVED, unitCost: 900 });
    assert.equal(await costOf(tx, id), 150);
  });
});

test('transfers do not create or consume cost layers', async t => {
  if (!ready) return t.skip('DB or ledger migration unavailable');
  await withItem(async (tx, id) => {
    const def = await defaultLoc(tx), other = await newLocation(tx, 'T6');
    await postMovement(tx, { orgId: 1, tireId: id, qtyChange: 8, reason: MOVEMENT.GRN_RECEIVED, unitCost: 3 });
    await transferStock(tx, { orgId: 1, user: admin, fromLocationId: def, toLocationId: other, items: [{ tireId: id, qty: 5 }] });
    assert.equal(await layerQty(tx, id), 8);
  });
});
