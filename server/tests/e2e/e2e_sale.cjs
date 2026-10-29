const path = require('path');
module.exports = async (ctx) => { try { await run(ctx); } catch (e) { await ctx.page.screenshot({ path: ctx.SHOTS + "/e2e-sale-fail.png" }); console.log("selects:", await ctx.page.locator("select").count(), (await ctx.page.locator("select").first().innerText().catch(()=>"")).slice(0,200)); throw e; } };
async function run({ page, check, api, ids, errors, SHOTS, label }) {
  const batches = async id => (await api('GET', `/inventory/batches?tire_id=${id}`)).body;
  const modal = page;

  await page.getByRole('button', { name: /^Invoices/ }).first().click();
  const newBtn = page.getByRole('button', { name: /^New$/ }).first();
  await newBtn.waitFor({ timeout: 15000 });

  // ── batch line: sell from the LATER batch on purpose (FEFO would take SOON) ──
  await newBtn.click();
  await page.waitForSelector('text=Create Invoice', { timeout: 8000 });
  await modal.locator('select', { has: page.locator('option', { hasText: 'Walk-in' }) }).first().selectOption('walkin');
  const lineSelect = modal.locator('select', { has: page.locator('option', { hasText: 'Milk' }) }).first();
  await lineSelect.selectOption(`t:${ids.milk}`);
  await page.waitForSelector('text=/Batch \\(optional/', { timeout: 8000 });
  check('batch picker appears for a batch-tracked item', true);
  const batchSel = modal.locator('select', { has: page.locator('option', { hasText: 'Automatic' }) }).first();
  await batchSel.selectOption(await batchSel.locator("option", { hasText: "M-LATE" }).first().getAttribute("value"));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-salebatch.png`) });
  await modal.getByRole('button', { name: 'Create Invoice' }).click();
  await page.waitForSelector('text=Create Invoice', { state: 'detached', timeout: 15000 });
  const settle = async (id, ok) => { let r; for (let i = 0; i < 40; i++) { r = await batches(id); if (ok(r)) return r; await page.waitForTimeout(250); } return r; };
  let b = await settle(ids.milk, r => r.reduce((a, x) => a + x.qty, 0) < 20);
  const q = no => b.filter(x => x.batch_no === no).reduce((a, x) => a + x.qty, 0);
  check('sold from the chosen batch (M-LATE 9, M-SOON untouched 10)', q('M-LATE') === 9 && q('M-SOON') === 10, JSON.stringify(b.map(x => [x.batch_no, x.qty])));
  await page.waitForTimeout(1500);

  // ── serial line: pick IMEI3 ──
  await newBtn.click();
  await page.waitForSelector('text=Create Invoice', { timeout: 8000 });
  await modal.locator('select', { has: page.locator('option', { hasText: 'Walk-in' }) }).first().selectOption('walkin');
  const lineSelect2 = modal.locator('select', { has: page.locator('option', { hasText: 'Phone' }) }).first();
  await lineSelect2.selectOption(`t:${ids.phone}`);
  await page.waitForSelector('text=/Serial numbers \\(optional/', { timeout: 8000 });
  await modal.getByRole('button', { name: 'IMEI3', exact: true }).click();
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-saleserial.png`) });
  await modal.getByRole('button', { name: 'Create Invoice' }).click();
  await page.waitForSelector('text=Create Invoice', { state: 'detached', timeout: 15000 });
  b = await settle(ids.phone, r => r.length < 3);
  check('sold the picked serial; IMEI1 and IMEI2 remain', b.length === 2 && !b.some(x => x.batch_no === 'IMEI3'), JSON.stringify(b.map(x => x.batch_no)));
  check('no page errors in sale flow', errors.filter(e => e.startsWith('pageerror')).length === 0, errors.slice(0, 3).join(' | '));
}
