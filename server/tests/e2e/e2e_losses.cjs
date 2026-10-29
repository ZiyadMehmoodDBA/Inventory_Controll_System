const path = require('path');
// Losses: overview, record write-off, register, obsolete retire + write-down, supplier return + credit, patterns + action, settings.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: require('path').join(ctx.SHOTS, 'e2e-losses-fail.png') }); throw e; } };
const body = async ({ page, check, api, errors, SHOTS, label }) => {
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const sup = (await api('POST', '/suppliers', { name: 'E2E Loss Supplier' })).body.id;
  let n = 0;
  const mk = async (model, extra = {}) => (await api('POST', '/inventory', { model, cost_price: 10, sale_price: 20, ...extra })).body.id;
  const receive = (tire, qty) => api('POST', '/purchases', { supplier_id: sup, date: d(0), status: 'received', items: [{ tire_id: tire, tire_name: 'x', qty, unit_price: 10 }] });
  const adj = (tire, qty, code) => api('POST', '/inventory/adjustments', { tire_id: tire, qty_change: qty, reason_code: code, notes: 'e2e ' + (++n) });
  const pos = async id => (await api('GET', `/inventory/position/${id}`)).body.on_hand;
  const A = await mk('E2E Loss Item', { supplier_id: sup, stock: 0 }); await receive(A, 60);
  const B = await mk('E2E Old Stock', { stock: 0 }); await receive(B, 20);
  const C = await mk('E2E Return Item', { supplier_id: sup, stock: 0 }); await receive(C, 30);

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Waste, damage"]').click();
  const modal = page.locator('div.fixed:has(h3:text-is("Waste, Damage & Obsolete Stock"))');
  await modal.waitFor({ timeout: 8000 });
  await page.waitForSelector('text=/not part of the physical loss/i', { timeout: 10000 });
  check('overview separates physical losses from accounting valuation', /accounting valuation/i.test(await modal.innerText()) && /not part of the physical loss/i.test(await modal.innerText()));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-losses-overview.png`) });

  // write-off through the UI
  const dlg = page.locator('div.fixed.z-\\[60\\]');
  await modal.getByRole('button', { name: 'Write-offs', exact: true }).click();
  await modal.locator('select:has(option:text-is("Choose…"))').first().selectOption(String(A));
  await modal.locator('select:has(option:text-is("Breakage / damage")), select:has(option:text-is("Damaged / broken goods"))').first().selectOption('contamination');
  const rec = modal.getByRole('button', { name: 'Record', exact: true });
  check('record disabled until a quantity is entered', await rec.isDisabled());
  await modal.locator('input[type=number]').first().fill('4');
  await rec.click();
  await page.waitForSelector('text=Write-off recorded and stock reduced', { timeout: 8000 });
  check('UI write-off reduces stock by the quantity', (await pos(A)) === 56);
  await modal.locator('tr:has-text("E2E Loss Item"):has-text("Contamination")').first().waitFor({ timeout: 8000 });
  check('register row shows cause, quantity and value', /4/.test(await modal.locator('tr:has-text("E2E Loss Item")').first().innerText()) && /40\.00/.test(await modal.locator('tr:has-text("E2E Loss Item")').first().innerText()), await modal.locator('tr:has-text("E2E Loss Item")').first().innerText());
  await modal.locator('select:has(option:text-is("All causes"))').selectOption('theft');
  await page.waitForSelector('text=No losses recorded for this selection', { timeout: 8000 });
  check('cause filter narrows the register', true);
  await modal.locator('select:has(option:text-is("All causes"))').selectOption('');

  // obsolete: retire + write down through the UI
  await api('PUT', `/inventory/losses/items/${B}/lifecycle`, { status: 'obsolete', note: 'e2e retired' });
  await modal.getByRole('button', { name: 'Slow & obsolete', exact: true }).click();
  const orow = modal.locator('tr:has-text("E2E Old Stock")');
  await orow.waitFor({ timeout: 8000 });
  check('retired item shows as obsolete with a suggested provision', /Obsolete/.test(await orow.innerText()) && /5\.00|50%/.test(await orow.innerText()), await orow.innerText());
  await orow.getByRole('button', { name: 'Write down' }).click();
  await dlg.waitFor({ timeout: 5000 });
  check('write-down dialog says no stock moves', /Accounting valuation only/.test(await dlg.innerText()));
  await dlg.locator('input[type=number]').fill('6');
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForSelector('text=written down. No stock moved', { timeout: 8000 });
  const adjs = (await api('GET', '/inventory/valuation-adjustments')).body;
  check('valuation adjustment recorded, units untouched', adjs.some(x => x.tire_id === B && Number(x.new_unit_cost) === 6) && (await pos(B)) === 20, JSON.stringify(adjs).slice(0, 200));
  await modal.locator('tr:has-text("E2E Old Stock")').getByRole('button', { name: 'Write off' }).click();
  await dlg.waitFor({ timeout: 5000 });
  check('write-off dialog says units leave stock', /Physical loss/.test(await dlg.innerText()));
  await dlg.locator('input[type=number]').fill('5');
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForSelector('text=5 unit(s) written off', { timeout: 8000 });
  check('obsolete write-off reduced stock', (await pos(B)) === 15);

  // aging
  await modal.getByRole('button', { name: 'Aging', exact: true }).click();
  await page.waitForSelector('text=/by time since last sale/i', { timeout: 8000 });
  check('aging tab shows both views', /by age of stock/i.test(await modal.innerText()));

  // supplier return + credit
  await modal.getByRole('button', { name: 'Supplier returns', exact: true }).click();
  await modal.locator('select:has(option:text-is("Choose…"))').nth(0).selectOption(String(sup));
  await modal.locator('select:has(option:text-is("Choose…"))').nth(1).selectOption(String(C));
  await modal.locator('input[type=number]').first().fill('5');
  await modal.getByPlaceholder('Faulty, wrong spec, damaged in transit').fill('Wrong specification delivered');
  await modal.getByRole('button', { name: 'Return', exact: true }).click();
  await modal.locator('tr:has-text("E2E Return Item")').waitFor({ timeout: 8000 });
  check('supplier return ships stock', (await pos(C)) === 25);
  await modal.locator('tr:has-text("E2E Return Item")').getByRole('button', { name: 'Record credit' }).click();
  await dlg.waitFor({ timeout: 5000 });
  await dlg.locator('input[type=number]').fill('30');
  await dlg.locator('input[type=checkbox]').check();
  await dlg.getByRole('textbox').last().fill('Supplier disputes condition');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForSelector('text=Closed short', { timeout: 8000 }).catch(() => {});
  const rets = (await api('GET', '/inventory/losses/returns')).body;
  const sr = rets.rows.find(x => x.item_name && /E2E Return Item/.test(x.item_name));
  check('short credit closes the return and records the unrecovered amount', sr && sr.status === 'short_credited' && Math.abs(sr.shortfall - 20) < 0.02, JSON.stringify(sr));

  // patterns + corrective action
  for (let i = 0; i < 3; i++) await adj(A, -1, 'damage');
  await modal.getByRole('button', { name: 'Patterns & actions', exact: true }).click();
  await modal.locator('text=/E2E Loss Item: \\d+ losses/').first().waitFor({ timeout: 10000 });
  check('repeated item loss shows with a recommendation', (await modal.innerText()).includes('Recommended:'));
  await modal.getByRole('button', { name: 'Create action' }).first().click();
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByRole('button', { name: 'Create', exact: true }).click();
  await modal.locator('tr:has-text("Address:")').waitFor({ timeout: 8000 });
  check('corrective action created from the pattern', (await api('GET', '/inventory/losses/actions')).body.some(a => a.status === 'open'));
  await modal.locator('tr:has-text("Address:")').getByRole('button', { name: 'Done' }).click();
  await dlg.getByPlaceholder('What was done (required)').fill('Repacked');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(800);
  check('action closed with outcome', (await api('GET', '/inventory/losses/actions?status=done')).body.length === 1);

  // settings
  await modal.getByRole('button', { name: 'Settings', exact: true }).click();
  const box = modal.locator('label:text-is("Manager write-offs above this value need approval") + input');
  await box.waitFor({ timeout: 8000 });
  await box.fill('250');
  await modal.getByRole('button', { name: 'Save settings' }).click();
  await page.waitForSelector('text=Settings saved', { timeout: 8000 });
  check('settings persisted', (await api('GET', '/inventory/losses/meta')).body.settings.loss_writeoff_approval_value === 250);
  await api('PUT', '/inventory/losses/settings', { loss_writeoff_approval_value: null });

  await modal.locator('button:has(svg.lucide-x)').first().click();
  await page.waitForSelector('button[title^="Waste, damage"]', { timeout: 5000 });
  check('no console or page errors', errors.length === 0, JSON.stringify(errors).slice(0, 300));
};
