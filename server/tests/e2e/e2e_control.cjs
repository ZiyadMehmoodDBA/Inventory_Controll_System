const path = require('path');
// Stock control: position, reserve/release, in-transit receive, physical count.
module.exports = async ({ page, check, api, ids, errors, SHOTS, label }) => {
  const pos = async id => (await api('GET', `/inventory/position/${id}`)).body;
  const poll = async (fn, tries = 25) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await page.waitForTimeout(300); } return false; };

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Stock position"]').click();
  await page.waitForSelector('text=Stock Control', { timeout: 8000 });
  await page.waitForSelector('text=All items', { timeout: 8000 });
  const modal = page.locator('div.fixed:has(h3:text-is("Stock Control"))');
  let txt = await modal.innerText();
  check('position table shows all seven quantities', ['On hand', 'Reserved', 'Quarantined', 'Expired', 'Available', 'In transit', 'On order'].every(h => txt.toLowerCase().includes(h.toLowerCase())), txt.slice(0, 200));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-control-position.png`) });

  // reserve from the item view
  await modal.locator('tr:has-text("Widget")').first().click();
  await page.waitForSelector('text=Reserve stock', { timeout: 8000 });
  await page.getByLabel('Reserve quantity').fill('2');
  await modal.getByPlaceholder('For (order / customer)').fill('E2E order');
  await modal.getByRole('button', { name: 'Reserve', exact: true }).click();
  check('reserve 2 from the UI', await poll(async () => (await pos(ids.plain)).reserved === 2), JSON.stringify(await pos(ids.plain)));
  await page.waitForSelector('text=E2E order', { timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-control-item.png`) });
  const overMsg = await (async () => { await page.getByLabel('Reserve quantity').fill('50'); await modal.getByRole('button', { name: 'Reserve', exact: true }).click(); await page.waitForSelector('text=/available/', { timeout: 5000 }); return true; })();
  check('over-reserving shows the availability error', overMsg);

  // reservations tab + release
  await page.getByRole('button', { name: 'Reservations', exact: true }).click();
  await page.waitForSelector('td:has-text("E2E order")', { timeout: 8000 });
  await modal.locator('tr:has-text("E2E order") button:has-text("Release")').click();
  check('release from the Reservations tab', await poll(async () => (await pos(ids.plain)).reserved === 0));

  // in transit
  const locs = (await api('GET', '/inventory/locations')).body;
  const def = locs.find(l => l.is_default).id;
  const cage = (await api('POST', '/inventory/locations', { name: 'E2E Cage', code: 'ECG' })).body.id;
  const trf = (await api('POST', '/inventory/transfers', { from_location_id: def, to_location_id: cage, items: [{ tire_id: ids.plain, qty: 1 }], in_transit: true })).body;
  await page.getByRole('button', { name: 'In transit', exact: true }).click();
  await page.waitForSelector(`text=${trf.transferNo}`, { timeout: 8000 });
  check('dispatched transfer is out of the source (on hand counted once)', (await pos(ids.plain)).in_transit === 1 && (await pos(ids.plain)).on_hand === 1);
  await modal.locator(`div:has(> div > p:text-is("${trf.transferNo}")) button:has-text("Receive")`).click();
  check('receive from the UI puts it at the destination', await poll(async () => { const p = await pos(ids.plain); return p.in_transit === 0 && p.on_hand === 2 && p.locations.find(l => l.location_id === cage)?.on_hand === 1; }), JSON.stringify(await pos(ids.plain)));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-control-transit.png`) });

  // physical count
  await page.getByRole('button', { name: 'Stock counts', exact: true }).click();
  await page.waitForSelector('text=Start a stock count', { timeout: 8000 });
  await modal.locator('select[title="Location to count"]').selectOption(String(def));
  await modal.getByRole('button', { name: /Start count/ }).click();
  await page.waitForSelector('text=Finish & post differences', { timeout: 8000 });
  await modal.getByLabel(/Counted Widget/).fill('6');
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-control-count.png`) });
  await modal.getByRole('button', { name: /Finish & post differences/ }).click();
  await page.waitForSelector('text=Count finished', { timeout: 10000 });
  check('finishing the count adjusts Widget to the counted 6 (1 left in default + 5 added)', (await pos(ids.plain)).locations.find(l => l.location_id === def)?.on_hand === 6, JSON.stringify((await pos(ids.plain)).locations));
  txt = await modal.innerText();
  check('count result is explained', /adjustment/.test(txt) && /not counted|matched/.test(txt), txt.slice(-300));
  const recon = (await api('GET', '/inventory/reconciliation')).body;
  check('reconciliation still clean', recon.mismatches === 0 && recon.location_mismatches === 0 && recon.batch_mismatches === 0, JSON.stringify(recon).slice(0, 200));

  // list shows availability next to stock, location kind select exists
  await modal.getByRole('button', { name: 'Close' }).click();
  await api('POST', '/inventory/reservations', { tire_id: ids.plain, qty: 3 });
  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.reload();
  await page.getByRole('button', { name: /^Inventory/ }).first().click({ timeout: 15000 });
  await page.waitForSelector('text=Widget', { timeout: 15000 });
  check('item list flags available < on hand', (await page.locator('button:has-text("avail")').count()) > 0);
  check('no page errors in stock-control flow', errors.filter(e => e.startsWith('pageerror')).length === 0, errors.slice(0, 3).join(' | '));
};
