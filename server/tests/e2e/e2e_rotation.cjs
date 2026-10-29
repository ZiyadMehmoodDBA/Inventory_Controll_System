const path = require('path');
// Rotation & valuation: policy tabs, pick guide, stock age, expiry exposure, LIFO acknowledgement, adjustment, snapshot, item form.
module.exports = async ({ page, check, api, errors, SHOTS, label, day }) => {
  const poll = async (fn, tries = 25) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await page.waitForTimeout(300); } return false; };
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const sup = (await api('POST', '/suppliers', { name: 'E2E Dairy Co' })).body.id;
  const mk = async (model, extra = {}) => (await api('POST', '/inventory', { model, cost_price: 2, sale_price: 9, ...extra })).body.id;
  const milk = await mk('E2E Rot Milk', { tracking: 'batch', track_expiry: true });
  await api('POST', '/purchases', { supplier_id: sup, date: d(0), status: 'received', items: [
    { tire_id: milk, tire_name: 'x', qty: 10, unit_price: 2, batch_no: 'OLD', expiry_date: d(90), received_date: d(-30) },
    { tire_id: milk, tire_name: 'x', qty: 10, unit_price: 4, batch_no: 'NEW', expiry_date: d(20), received_date: d(0) }] });

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Stock rotation policy"]').click();
  const modal = page.locator('div.fixed:has(h3:text-is("Stock rotation & valuation"))');
  await modal.waitFor({ timeout: 8000 });
  await page.waitForSelector('text=Company default', { timeout: 8000 });
  let txt = await modal.innerText();
  check('policies tab explains rotation vs valuation separately', /which units leave first/i.test(txt) && /what cost is booked/i.test(txt));
  check('four picking policies, no LIFO among them', ['FEFO', 'FIFO', 'Smallest batch first', 'Manual'].every(p => txt.includes(p)) && !/LIFO/.test(txt), txt.slice(0, 300));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-rotation-policies.png`) });

  // company default via UI
  await modal.getByLabel('Company rotation policy').selectOption('fifo');
  check('company default saved from the UI', await poll(async () => (await api('GET', '/inventory/rotation')).body.company === 'fifo'));
  // item override via item API then shown in list
  await api('PUT', '/inventory/rotation', { scope: 'item', id: milk, policy: 'fefo' });
  await modal.getByRole('button', { name: 'Pick guide' }).click();
  await modal.getByPlaceholder('Search an item to pick').fill('E2E Rot Milk');
  await modal.locator('button:has-text("E2E Rot Milk")').first().click();
  await page.waitForSelector('text=/FEFO — first expiry/', { timeout: 8000 });
  txt = await modal.innerText();
  const rows = await modal.locator('tbody tr').allInnerTexts();
  check('pick guide: FEFO picks NEW (soonest expiry) first', /item/.test(txt) && rows[0].includes('NEW') && /\b1\b\s*$/.test(rows[0].trim()), rows.join(' | '));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-rotation-pick.png`) });
  await api('PUT', '/inventory/rotation', { scope: 'item', id: milk, policy: 'fifo' });
  await modal.getByLabel('Quantity to pick').fill('2');
  await page.waitForSelector('text=/FIFO — first in, first out/', { timeout: 8000 });
  const rows2 = await modal.locator('tbody tr').allInnerTexts();
  check('pick guide: FIFO switches to OLD (received first)', rows2[0].includes('OLD'), rows2.join(' | '));

  // age + expiry
  await modal.getByRole('button', { name: 'Stock age', exact: true }).click();
  await page.waitForSelector('text=Older than 180 days', { timeout: 8000 });
  txt = await modal.innerText();
  check('stock age shows buckets and the batch item', ['0-30', '31-60', '91-180', '365+'].every(b => txt.includes(b)) && txt.includes('E2E Rot Milk'), txt.slice(0, 200));
  await modal.getByRole('button', { name: 'Expiry exposure' }).click();
  await page.waitForSelector('text=Expected loss within', { timeout: 8000 });
  txt = await modal.innerText();
  check('expiry exposure lists the batches expiring in 20 days', txt.includes('NEW') && /20 d/.test(txt), txt.slice(0, 300));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-rotation-expiry.png`) });

  // valuation: LIFO needs acknowledgement
  await modal.getByRole('button', { name: 'Valuation', exact: true }).click();
  await page.waitForSelector('text=Costing policy', { timeout: 8000 });
  let dialog = null;
  page.once('dialog', dl => { dialog = dl.message(); dl.dismiss(); });
  await modal.getByRole('radio').nth(3).click();
  await page.waitForTimeout(800);
  check('LIFO shows a legal warning and declining keeps the method', /IFRS/.test(dialog || '') && (await api('GET', '/inventory/valuation-method')).body.method !== 'lifo', String(dialog).slice(0, 120));
  page.once('dialog', dl => dl.accept());
  await modal.getByPlaceholder(/Reason for the next change/).fill('E2E switch');
  await modal.getByRole('radio').nth(3).click();
  check('accepting enables LIFO and logs it', await poll(async () => { const r = (await api('GET', '/inventory/valuation-method')).body; return r.method === 'lifo' && r.history[0].note === 'E2E switch'; }));
  await modal.getByRole('radio').nth(2).click();   // back to FIFO, no prompt
  check('FIFO needs no acknowledgement', await poll(async () => (await api('GET', '/inventory/valuation-method')).body.method === 'fifo'));

  // adjustment
  await modal.getByLabel('Item to revalue').selectOption({ label: 'E2E Rot Milk' });
  await modal.getByLabel('New unit cost').fill('1');
  check('reason is required for the adjustment (button stays disabled)', await modal.getByRole('button', { name: 'Apply', exact: true }).isDisabled());
  await modal.getByLabel('Adjustment reason').fill('E2E write-down');
  await modal.getByRole('button', { name: 'Apply', exact: true }).click();
  check('adjustment appears in the list and is recorded', await poll(async () => (await api('GET', '/inventory/valuation-adjustments')).body.some(a => a.reason === 'E2E write-down' && Number(a.new_unit_cost) === 1)));
  await page.waitForSelector('td:has-text("E2E write-down")', { timeout: 8000 });

  // snapshot
  await modal.getByPlaceholder('Label, e.g. Month end').fill('E2E month end');
  await modal.getByRole('button', { name: 'Take snapshot' }).click();
  await page.waitForSelector('td:has-text("E2E month end")', { timeout: 8000 });
  await modal.locator('tr:has-text("E2E month end") button:has-text("View")').click();
  await page.waitForSelector('text=E2E Rot Milk >> nth=-1', { timeout: 8000 });
  check('snapshot saved and viewable', (await api('GET', '/inventory/valuation-snapshots')).body.some(s => s.note === 'E2E month end'));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-rotation-valuation.png`) });
  await modal.locator('button:has(svg.lucide-x)').first().click();

  // item form
  await api('PUT', '/inventory/rotation', { scope: 'company', policy: null });
  await page.reload();
  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Add new"]').click();
  await page.waitForSelector('text=Stock tracking', { timeout: 8000 });
  const form = page.locator('form').last();
  check('rotation select hidden while tracking is none', (await form.getByText('Which units go out first').count()) === 0);
  await form.locator('select').filter({ has: page.locator('option[value="serial"]') }).selectOption('batch');
  await form.getByText('Which units go out first').waitFor({ timeout: 5000 });
  await form.locator('label:has-text("Which units go out first") select').selectOption('smallest_first');
  await form.locator('label:has(span.text-red-500)').first().locator('xpath=..').locator('input').first().fill('E2E Rot Form Item');
  await page.getByRole('button', { name: 'Add SKU' }).click();
  let made;
  for (let i = 0; i < 20 && !made; i++) { await page.waitForTimeout(400); made = (await api('GET', '/inventory')).body.find(x => x.model === 'E2E Rot Form Item'); }
  check('item saved with its rotation policy', made && made.rotation_policy === 'smallest_first', JSON.stringify(made?.rotation_policy));
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
};
