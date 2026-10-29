const path = require('path');
// Expiry & quality: alerts, hold/release, recall from the batch list, disposal, profile creation, item form section.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: require('path').join(ctx.SHOTS, 'e2e-quality-fail.png') }); throw e; } };
const body = async ({ page, check, api, errors, SHOTS, label }) => {
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const sup = (await api('POST', '/suppliers', { name: 'E2E Q Supplier' })).body.id;
  const mk = async (model, extra) => (await api('POST', '/inventory', { model, cost_price: 10, sale_price: 20, tracking: 'batch', track_expiry: true, ...extra })).body.id;
  const recv = (tire, it) => api('POST', '/purchases', { supplier_id: sup, date: d(0), status: 'received', items: [{ tire_id: tire, tire_name: 'x', qty: 10, unit_price: 10, ...it }] });
  const soon = await mk('E2E Soon Milk', { shelf_life_days: 60 });
  await recv(soon, { batch_no: 'QS1', mfg_date: d(-45) });
  const sb = (await api('GET', `/inventory/quality/batches?tire_id=${soon}`)).body[0];
  check('API derives expiry from manufacturing date and shelf life (day 60)', sb && sb.expiry_date === d(15) && sb.near_expiry, JSON.stringify(sb));
  const insp = await mk('E2E Inspect Glue', { inspection_interval_days: 10 });
  await recv(insp, { batch_no: 'QI1', expiry_date: d(200) });
  const plain = await api('POST', '/inventory', { model: 'E2E Plain Item', cost_price: 1, sale_price: 2, stock: 5 });
  check('plain item needs no expiry', plain.status === 201);

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Expiry, shelf life and quality"]').click();
  const modal = page.locator('div.fixed:has(h3:text-is("Expiry & Quality"))');
  await modal.waitFor({ timeout: 8000 });
  await page.waitForSelector('text=/E2E Soon Milk/', { timeout: 10000 });
  const txt = await modal.innerText();
  check('alerts tab lists the near-expiry batch', txt.includes('E2E Soon Milk') && txt.includes('QS1'), txt.slice(0, 400));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-quality-alerts.png`) });

  await modal.getByRole('button', { name: 'Batches', exact: true }).click();
  await modal.getByPlaceholder('Search item, SKU or batch').fill('E2E Inspect');
  const row = modal.locator('tr:has-text("QI1")');
  await row.waitFor({ timeout: 8000 });
  check('batch row shows released status', (await row.innerText()).includes('Released'));

  // hold via UI
  await row.getByRole('button', { name: 'Hold', exact: true }).click();
  const dlg = page.locator('div.fixed.z-\\[60\\]');
  await dlg.waitFor({ timeout: 5000 });
  const confirm = dlg.getByRole('button', { name: 'Confirm' });
  check('confirm disabled without a reason', await confirm.isDisabled());
  await dlg.locator('textarea').fill('Customer complaint about smell');
  await confirm.click();
  await modal.locator('tr:has-text("QI1"):has-text("On hold")').waitFor({ timeout: 8000 });
  const held = (await api('GET', `/inventory/quality/batches?tire_id=${insp}`)).body[0];
  check('hold applied through the UI', held.quality_status === 'on_hold' && /smell/.test(held.status_reason), JSON.stringify(held));
  const sale = await api('POST', '/sales', { date: d(0), items: [{ tire_id: insp, qty: 1, unit_price: 20 }], tax_rate: 0 });
  check('held batch cannot be sold', sale.status === 409, JSON.stringify([sale.status, sale.body]));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-quality-batches.png`) });

  // release via UI
  await modal.locator('tr:has-text("QI1")').getByRole('button', { name: 'Release', exact: true }).click();
  await dlg.waitFor({ timeout: 5000 });
  await dlg.locator('textarea').fill('Lab result clean');
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await modal.locator('tr:has-text("QI1"):has-text("Released")').waitFor({ timeout: 8000 });
  let relOk = false; for (let i = 0; i < 20 && !relOk; i++) { relOk = (await api('GET', `/inventory/quality/batches?tire_id=${insp}`)).body[0].quality_status === 'released'; if (!relOk) await page.waitForTimeout(300); }
  check('release applied through the UI', relOk);

  // recall via UI
  await modal.getByPlaceholder('Search item, SKU or batch').fill('E2E Soon');
  await modal.locator('tr:has-text("QI1")').waitFor({ state: 'detached', timeout: 8000 });
  const r2 = modal.locator('tr:has-text("QS1")');
  await r2.waitFor({ timeout: 8000 });
  await r2.locator('input[type=checkbox]').check();
  await modal.getByRole('button', { name: /Recall selected \(1\)/ }).click();
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByPlaceholder('Title').fill('E2E milk recall');
  await dlg.getByPlaceholder('Why are these products recalled?').fill('Possible contamination');
  await dlg.getByRole('button', { name: 'Open recall' }).click();
  await modal.locator('tr:has-text("QS1"):has-text("Recalled")').waitFor({ timeout: 8000 });
  const recalls = (await api('GET', '/inventory/quality/recalls')).body;
  check('recall opened through the UI', recalls.some(r => r.title === 'E2E milk recall' && r.status === 'open' && r.batches === 1), JSON.stringify(recalls));
  await modal.getByRole('button', { name: 'Recalls', exact: true }).click();
  await modal.locator('tr:has-text("E2E milk recall")').click();
  await page.getByPlaceholder('Closure note (required)').waitFor({ timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-quality-recall.png`) });

  // dispose from batch tab
  await modal.getByRole('button', { name: 'Batches', exact: true }).click();
  await modal.getByPlaceholder('Search item, SKU or batch').fill('E2E Soon');
  await modal.locator('tr:has-text("QS1")').waitFor({ timeout: 8000 });
  await modal.locator('tr:has-text("QS1")').getByRole('button', { name: 'Dispose', exact: true }).click();
  await dlg.waitFor({ timeout: 5000 });
  await dlg.locator('textarea').fill('Destroyed per recall');
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForSelector('text=/DSP.*10 unit/', { timeout: 8000 });
  check('disposal posted and stock cleared', (await api('GET', `/inventory/position/${soon}`)).body.on_hand === 0);
  await modal.getByRole('button', { name: 'Disposals', exact: true }).click();
  await page.waitForSelector('text=/Destroyed per recall/', { timeout: 8000 });
  check('disposals register shows it', (await modal.innerText()).includes('E2E Soon Milk'));

  // rules & profile
  await modal.getByRole('button', { name: 'Rules & profiles' }).click();
  await modal.getByRole('button', { name: 'New profile' }).click();
  await dlg.getByPlaceholder('Name').fill('E2E Pharma');
  await dlg.getByPlaceholder('Applicable regulation or standard').fill('GDP');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.locator('tr:has-text("E2E Pharma")').waitFor({ timeout: 8000 });
  check('profile created through the UI', (await api('GET', '/inventory/quality/profiles')).body.some(p => p.name === 'E2E Pharma' && p.regulation === 'GDP'));

  // item form: quality section and profile assignment
  await modal.locator('button:has(svg.lucide-x)').first().click();
  await page.locator('input[placeholder*="Search"]').first().fill('E2E Inspect');
  await page.waitForTimeout(700);
  await page.locator('button[title="Edit"], button:has(svg.lucide-pencil)').first().click();
  await page.locator('summary:has-text("Quality & inspection")').waitFor({ timeout: 8000 });
  await page.locator('summary:has-text("Quality & inspection")').click();
  const sel = page.locator('select:has(option:text-is("None (category or company rules)"))');
  await sel.selectOption({ label: 'E2E Pharma — GDP' });
  await page.getByRole('button', { name: /Update|Save/ }).last().click();
  await page.waitForTimeout(1500);
  const list = (await api('GET', '/inventory')).body;
  const itemNow = (Array.isArray(list) ? list : list.items || []).find(t => t.id === insp);
  check('item form saves the quality profile', itemNow && Number(itemNow.quality_profile_id) > 0, JSON.stringify(itemNow).slice(0, 200));
  check('no console or page errors', errors.length === 0, JSON.stringify(errors).slice(0, 300));
};
