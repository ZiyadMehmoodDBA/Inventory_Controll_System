const path = require('path');
// Warehouses: network view, item search, warehouse + assignment, cross-branch dispatch, short receipt, trail, counts, access editor.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: require('path').join(ctx.SHOTS, 'e2e-warehouse-fail.png') }); throw e; } };
const body = async ({ page, check, api, errors, SHOTS, label }) => {
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const sup = (await api('POST', '/suppliers', { name: 'E2E Wh Supplier' })).body.id;
  const W = (await api('POST', '/inventory', { model: 'E2E Wh Item', cost_price: 10, sale_price: 20, supplier_id: sup, stock: 0 })).body.id;
  await api('POST', '/purchases', { supplier_id: sup, date: d(0), status: 'received', items: [{ tire_id: W, tire_name: 'x', qty: 50, unit_price: 10 }] });
  const nb = await api('POST', '/branches', { name: 'E2E East', code: 'E2EEAST' });
  check('second branch created', nb.status === 201 || nb.status === 200, JSON.stringify(nb.body));
  const east = nb.body.id;
  const pos = async (id, br) => {
    const r = await fetch('http://localhost:3055/api/inventory/position/' + id, { headers: { Authorization: (await api.token?.()) || '' } }).catch(() => null);
    return r;
  };
  const stockOf = async id => (await api('GET', `/inventory/position/${id}`)).body.on_hand;
  const rack = await api('POST', '/inventory/locations', { name: 'E2E Rack B', code: 'E2ERACK' });
  check('extra location created', rack.status === 201 || rack.status === 200, JSON.stringify(rack.body));

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Warehouses and locations"]').click();
  const modal = page.locator('div.fixed:has(h3:text-is("Warehouses & Locations"))');
  await modal.waitFor({ timeout: 8000 });
  await page.waitForSelector('text=Whole organisation', { timeout: 10000 });
  let txt = await modal.innerText();
  check('network view spans the organisation with both branches', /Whole organisation/.test(txt) && /Main/.test(txt) && /E2E East/.test(txt), txt.slice(0, 300));
  check('locations are listed with unit counts', /E2E Rack B/.test(txt) && /75 units/.test(txt), txt.slice(-200));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-warehouse-network.png`) });
  await modal.getByPlaceholder(/Find an item/).fill('E2E Wh Item');
  await modal.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForFunction(() => /50 units/.test(document.body.innerText), null, { timeout: 8000 });
  check('item search narrows the totals', true);
  await modal.locator('tr:has-text("Main Store"):has-text("1 items")').first().click().catch(() => {});
  const dlg = page.locator('div.fixed.z-\\[60\\]');
  await dlg.first().waitFor({ timeout: 5000 });
  await dlg.first().locator('text=E2E Wh Item').waitFor({ timeout: 8000 });
  check('clicking a location lists its items', /E2E Wh Item/.test(await dlg.first().innerText()) && /50/.test(await dlg.first().innerText()), await dlg.first().innerText());
  await dlg.first().locator('button:has(svg.lucide-x)').click();

  // warehouses & access
  await modal.getByRole('button', { name: 'Warehouses & access', exact: true }).click();
  await modal.getByLabel('Warehouse name').fill('E2E DC');
  await modal.getByRole('button', { name: 'Add warehouse' }).click();
  await page.waitForSelector('text=Warehouse added.', { timeout: 8000 });
  const whs = (await api('GET', '/inventory/warehouses')).body;
  check('warehouse added through the UI', whs.some(w => w.name === 'E2E DC' && w.code === 'E2EDC'), JSON.stringify(whs));
  const wid = whs.find(w => w.name === 'E2E DC').id;
  await modal.getByLabel('Warehouse of E2E Rack B').selectOption(String(wid));
  await page.waitForSelector('text=E2E Rack B updated.', { timeout: 8000 });
  const locs = (await api('GET', '/inventory/warehouses')).body;
  check('location assigned to the warehouse', locs.find(w => w.id === wid).locations === 1);
  await modal.locator('tr:has-text("E2E Rack B")').getByRole('button', { name: 'Access' }).click();
  await dlg.first().locator('text=/No staff users/').waitFor({ timeout: 8000 });
  check('access editor explains the open default and handles no staff', /every staff member of the branch can use this location/i.test(await dlg.first().innerText()) && /No staff users/i.test(await dlg.first().innerText()));
  await dlg.first().getByRole('button', { name: 'Close' }).click();

  // dispatch to the other branch
  await modal.getByRole('button', { name: /^Transfers/ }).click();
  await modal.getByRole('button', { name: /New transfer/ }).click();
  const nt = page.locator('div.fixed.z-\\[60\\]:has(h4:text-is("New transfer"))');
  await nt.waitFor({ timeout: 5000 });
  await nt.locator('select:has(option:text-is("This branch"))').selectOption(String(east));
  await nt.locator('select:has(option:text-is("Choose…"))').waitFor();
  const eastLocs = await nt.locator('select:has(option:text-is("Choose…")) option').allInnerTexts();
  check('destination branch offers its locations', eastLocs.length >= 2, eastLocs.join());
  await nt.locator('select:has(option:text-is("Choose…"))').selectOption({ index: 1 });
  check('cross-branch transfer is forced to stay in transit', await nt.locator('input[type=checkbox]').isChecked() && await nt.locator('input[type=checkbox]').isDisabled());
  await nt.getByPlaceholder('Search items to add').fill('E2E Wh Item');
  await nt.locator('button:has-text("E2E Wh Item")').first().click();
  await nt.getByLabel('Quantity of E2E Wh Item').fill('10');
  await nt.getByLabel(/Carrier/).fill('E2E Van').catch(() => {});
  await nt.getByRole('button', { name: 'Dispatch' }).click();
  await page.waitForSelector('text=stays in transit until the destination confirms receipt', { timeout: 8000 });
  check('dispatch leaves the source immediately', (await stockOf(W)) === 40);
  const board = (await api('GET', '/inventory/warehouse/in-transit')).body;
  check('in-transit board lists the shipment', board.count === 1 && board.transfers[0].units === 10 && board.transfers[0].cross_branch === 1, JSON.stringify(board).slice(0, 300));
  check('transfers tab badge shows what is on the way', /1/.test(await modal.getByRole('button', { name: /^Transfers/ }).innerText()));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-warehouse-transit.png`) });

  // short receipt
  await modal.getByRole('button', { name: 'Confirm receipt', exact: true }).click();
  const rc = page.locator('div.fixed.z-\\[60\\]:has(h4:has-text("Confirm receipt of"))');
  await rc.waitFor({ timeout: 5000 });
  await rc.getByLabel('Received E2E Wh Item').fill('7');
  check('shortage panel appears for missing units', /3 unit\(s\) short/.test(await rc.innerText()));
  await rc.getByRole('button', { name: 'Confirm receipt' }).click();
  await rc.locator('p.bg-red-50').waitFor({ timeout: 8000 });
  check('shortage cannot be confirmed without an explanation', /Say what happened to the missing/.test(await rc.locator('p.bg-red-50').innerText()) && (await stockOf(W)) === 40);
  await rc.getByLabel('Shortage note').fill('3 crushed on the van');
  await rc.getByRole('button', { name: 'Confirm receipt' }).click();
  await page.waitForSelector('text=received with a shortage', { timeout: 8000 });
  check('missing units returned to the source', (await stockOf(W)) === 43);
  const hist = (await api('GET', '/inventory/warehouse/transfers')).body;
  const tr = hist.find(t => t.status === 'received');
  check('history shows the received transfer with its shortage', tr && tr.has_discrepancy === true && tr.units_short === 3, JSON.stringify(hist).slice(0, 300));
  await modal.locator(`tr:has-text("${tr.transfer_no}")`).click();
  const det = page.locator('div.fixed.z-\\[60\\]:has(h4:has-text("Transfer TRF"))');
  await det.waitFor({ timeout: 5000 });
  const dt = await det.innerText();
  check('detail shows dispatch and short receipt with the note', /Dispatched/.test(dt) && /Received with shortage/.test(dt) && /3 crushed on the van/.test(dt), dt.slice(0, 400));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-warehouse-detail.png`) });
  await det.locator('button:has(svg.lucide-x)').click();

  // counts
  await modal.getByRole('button', { name: 'Counts', exact: true }).click();
  await modal.locator('tr:has-text("E2E Rack B")').getByRole('button', { name: 'Start count' }).click();
  await page.waitForSelector('text=/Count CNT-.* started/', { timeout: 8000 });
  const counts = (await api('GET', '/inventory/warehouse/counts')).body;
  check('count started for that location only', counts.find(l => l.location_name === 'E2E Rack B')?.open_count_no && !counts.find(l => l.location_name !== 'E2E Rack B' && l.open_count_no));
  check('no uncaught page errors', errors.filter(e => e.startsWith('pageerror')).length === 0, errors.slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-warehouse-counts.png`) });
};
