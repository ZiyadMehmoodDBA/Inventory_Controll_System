const path = require('path');
// Product master data: new form sections, save, change history, export, status filter, picker rules.
module.exports = async ({ page, check, api, ids, errors, SHOTS, label }) => {
  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Add new"]').click();
  await page.waitForSelector('text=Classification', { timeout: 8000 });
  for (const s of ['Classification', 'Units & packaging', 'Stock levels', 'Tax', 'Storage, handling & safety'])
    check(`form has "${s}" section`, (await page.locator(`summary:has-text("${s}")`).count()) > 0);

  const modal = page.locator('form').last();
  await modal.locator('label:has(span.text-red-500)').first().locator('xpath=..').locator('input').first().fill('E2E Steel Rod');
  await modal.locator('select').filter({ has: page.locator('option[value="raw_material"]') }).selectOption('raw_material');
  for (const s of ['Units & packaging', 'Stock levels', 'Storage, handling & safety']) await page.locator(`summary:has-text("${s}")`).click();
  await page.getByText('Add conversion').click();
  const conv = page.locator('div:has(> span:text-is("="))').first();
  await conv.locator('select').selectOption('carton');
  await conv.locator('input[type=number]').fill('24');
  await modal.getByText('Manufacturer').locator('xpath=..').locator('input').fill('SteelCo');
  await modal.getByText('Minimum', { exact: true }).locator('xpath=..').locator('input').fill('10');
  await modal.getByText('Maximum', { exact: true }).locator('xpath=..').locator('input').fill('5');
  await page.getByRole('button', { name: 'Add SKU' }).click();
  await page.waitForSelector('text=/Minimum cannot be greater than maximum|Minimum stock cannot/', { timeout: 5000 });
  check('min > max blocked in the form', true);
  await modal.getByText('Maximum', { exact: true }).locator('xpath=..').locator('input').fill('100');
  await modal.getByText('Shelf life (days)').locator('xpath=..').locator('input').fill('365');
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-master-form.png`) });
  await page.getByRole('button', { name: 'Add SKU' }).click();

  let rod;
  for (let i = 0; i < 20 && !rod; i++) { await page.waitForTimeout(400); rod = (await api('GET', '/inventory')).body.find(x => x.model === 'E2E Steel Rod'); }
  check('item saved with master data', rod && rod.item_type === 'raw_material' && rod.manufacturer === 'SteelCo' && rod.min_stock === 10 && rod.max_stock === 100 && rod.shelf_life_days === 365, JSON.stringify(rod));
  const full = rod && (await api('GET', `/inventory/${rod.id}`)).body;
  check('conversion saved', full && full.conversions.length === 1 && full.conversions[0].uom === 'carton' && full.conversions[0].factor === 24, JSON.stringify(full?.conversions));

  await page.waitForSelector('text=E2E Steel Rod', { timeout: 8000 });
  await page.locator('tr:has-text("E2E Steel Rod") button[title="Edit"], div:has-text("E2E Steel Rod") button[title="Edit"]').first().click();
  await page.waitForSelector('text=Classification', { timeout: 8000 });
  await page.waitForFunction(() => [...document.querySelectorAll('select')].some(s => s.value === 'carton'), null, { timeout: 8000 });
  check('edit form reloads saved conversion', true);
  await page.locator('form select').filter({ has: page.locator('option[value="discontinued"]') }).selectOption('discontinued');
  await page.getByRole('button', { name: 'Update SKU' }).click();
  let st;
  for (let i = 0; i < 20 && st !== 'discontinued'; i++) { await page.waitForTimeout(400); st = (await api('GET', `/inventory/${rod.id}`)).body.status; }
  check('status change saved from the form', st === 'discontinued', st);
  await page.waitForTimeout(1200);

  await page.locator('tr:has-text("E2E Steel Rod") button[title="Change history"], div:has-text("E2E Steel Rod") button[title="Change history"]').first().click();
  await page.waitForSelector('text=Change history', { timeout: 8000 });
  await page.waitForSelector('div.fixed table tbody tr', { timeout: 8000 });
  const hist = await page.locator('div.fixed:has(h2:text-is("Change history"))').innerText();
  check('change history modal shows creation and status change', /Created/.test(hist) && /Status/.test(hist) && /discontinued/.test(hist), hist.slice(0, 300));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-master-history.png`) });
  await page.locator('div.fixed button:has(svg.lucide-x)').first().click();

  await page.locator('select[title="Filter by status"]').selectOption('discontinued');
  check('status filter shows only discontinued', (await page.locator('text=E2E Steel Rod').count()) > 0 && (await page.locator('text=Widget').count()) === 0);
  await page.locator('select[title="Filter by status"]').selectOption('active');
  check('active filter hides discontinued item', (await page.locator('text=E2E Steel Rod').count()) === 0);
  await page.locator('select[title="Filter by status"]').selectOption('all');

  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('button[title="Export products to CSV"]').click()]);
  const file = await download.path();
  const csv = require('fs').readFileSync(file, 'utf8');
  check('export downloads CSV with the new item', /sku,barcode/.test(csv) && /E2E Steel Rod/.test(csv) && /raw_material/.test(csv) && /carton=24/.test(csv), csv.slice(0, 200));

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  check('no page errors in master-data flow', errors.filter(e => e.startsWith('pageerror')).length === 0, errors.slice(0, 3).join(' | '));
};
