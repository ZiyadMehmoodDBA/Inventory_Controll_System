const path = require('path');
// Replenishment: recommendations by supplier, approve -> PO, over-order reason, parameters, requirements, settings, approvals log, item form.
module.exports = async ({ page, check, api, errors, SHOTS, label }) => {
  const poll = async (fn, tries = 30) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await page.waitForTimeout(300); } return false; };
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const sup = (await api('POST', '/suppliers', { name: 'E2E Rep Supplier' })).body.id;
  const item = (await api('POST', '/inventory', { model: 'E2E Rep Item', cost_price: 10, sale_price: 20, stock: 10, supplier_id: sup, lead_time_days: 5, safety_stock: 0 })).body.id;
  await api('POST', '/sales', { date: d(0), items: [{ tire_id: item, qty: 8, unit_price: 20 }], tax_rate: 0 });
  const rec = async () => ((await api('GET', '/inventory/replenishment/plan')).body.items || []).find(i => i.tire_id === item);
  const r0 = await rec();
  check('API recommends an order for the low item', r0 && r0.suggested_qty > 0 && r0.supplier_id === sup, JSON.stringify(r0));

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Replenishment:"]').click();
  const modal = page.locator('div.fixed:has(h3:text-is("Replenishment"))');
  await modal.waitFor({ timeout: 8000 });
  await page.waitForSelector(`section[data-supplier="${sup}"]`, { timeout: 10000 });
  const grp = modal.locator(`section[data-supplier="${sup}"]`);
  let txt = await grp.innerText();
  check('recommendations grouped under the supplier with the item and status', txt.includes('E2E Rep Item') && /Low|Critical/.test(txt) && /lead time up to 5 days/.test(txt), txt.slice(0, 300));
  const qtyBox = grp.getByLabel('Order quantity for E2E Rep Item');
  check('order quantity pre-filled with the recommendation', Number(await qtyBox.inputValue()) === r0.suggested_qty, await qtyBox.inputValue());
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-replenish-plan.png`) });

  // ordering more than recommended needs a reason
  const approveBtn = grp.getByRole('button', { name: /Approve & create PO/ });
  await qtyBox.fill(String(r0.suggested_qty + 10));
  await grp.getByLabel('Reason for ordering more of E2E Rep Item').waitFor({ timeout: 5000 });
  check('approve disabled until a reason is given for a larger order', await approveBtn.isDisabled());
  await qtyBox.fill(String(r0.suggested_qty));
  check('reason box goes away at the recommended quantity and approve is enabled', (await grp.getByLabel('Reason for ordering more of E2E Rep Item').count()) === 0 && !(await approveBtn.isDisabled()));

  const poBefore = ((await api('GET', '/purchases')).body || []).length;
  page.once('dialog', dl => dl.accept());
  await approveBtn.click();
  await page.waitForSelector('text=/Purchase order .* created for E2E Rep Supplier/', { timeout: 10000 });
  const pos = (await api('GET', '/purchases')).body;
  const newPo = pos.find(p => p.supplier_id === sup);
  check('approval creates exactly one pending PO', pos.length === poBefore + 1 && newPo && newPo.status === 'pending' && /Replenishment/.test(newPo.notes || ''), JSON.stringify(newPo));
  const r1 = await rec();
  check('recommendation disappears once the PO is incoming', r1.suggested_qty === 0 && r1.on_order === r0.suggested_qty, JSON.stringify([r1.suggested_qty, r1.on_order]));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-replenish-approved.png`) });

  // status board + parameter editor
  await modal.getByRole('button', { name: 'Stock status', exact: true }).click();
  await modal.getByLabel('Status filter').selectOption('all');
  await page.waitForSelector('tr:has-text("E2E Rep Item")', { timeout: 8000 });
  txt = await modal.locator('tr:has-text("E2E Rep Item")').innerText();
  check('board shows the item as on order with its reorder point and lead time', /On order/.test(txt) && /5 d/.test(txt), txt);
  await modal.locator('tr:has-text("E2E Rep Item") button:has-text("Settings")').click();
  const ed = modal.locator(`[data-editor="${item}"]`);
  await ed.waitFor({ timeout: 5000 });
  await ed.getByLabel('Safety stock', { exact: true }).first().fill('3');
  await ed.getByLabel('Min. order qty', { exact: true }).first().fill('12');
  await ed.getByLabel('Order multiple', { exact: true }).first().fill('6');
  await ed.getByLabel('Seasonality Dec').fill('2');
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-replenish-editor.png`) });
  await ed.getByRole('button', { name: 'Save settings' }).click();
  check('item parameters saved from the editor', await poll(async () => { const r = await rec(); return r.safety_stock === 3 && r.safety_basis === 'set' && r.moq === 12 && r.order_multiple === 6; }));
  let seas;   // the seasonality is saved by a second request after the item parameters, so wait for it
  const seasOk = await poll(async () => { seas = (await api('GET', '/inventory/replenishment/seasonality')).body.items.find(x => x.id === item); return !!seas && seas.seasonality[11] === 2; });
  check('seasonality saved', seasOk, JSON.stringify(seas));

  // incoming, requirements, supplier lead time
  await modal.getByRole('button', { name: 'Incoming & requirements' }).click();
  await page.waitForSelector(`text=${newPo.po_no}`, { timeout: 8000 });
  check('incoming PO listed with its expected date', (await modal.innerText()).includes(d(5)));
  await modal.getByLabel('Requirement item').selectOption({ label: 'E2E Rep Item' });
  await modal.getByLabel('Requirement quantity').fill('5');
  await modal.getByLabel('Needed by').fill(d(3));
  await modal.getByLabel('Requirement note').fill('E2E production run');
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForSelector('td:has-text("E2E production run")', { timeout: 8000 });
  check('requirement recorded', (await api('GET', '/inventory/replenishment/requirements')).body.some(r => r.note === 'E2E production run' && r.status === 'open'));
  await modal.locator('tr:has-text("E2E production run") button:has-text("Close")').click();
  check('requirement closed', await poll(async () => (await api('GET', '/inventory/replenishment/requirements')).body.every(r => r.status === 'closed')));
  await page.waitForTimeout(1200); // let the post-close reload finish so it cannot clear the inputs
  await modal.getByLabel('Lead time for E2E Rep Supplier').fill('9');
  await modal.getByLabel('Minimum order value for E2E Rep Supplier').fill('250');
  await modal.locator('tr:has-text("E2E Rep Supplier") button:has-text("Save")').click();
  check('supplier lead time and minimum order saved', await poll(async () => { const s = (await api('GET', '/inventory/replenishment/suppliers')).body.find(x => x.id === sup); return s.lead_time_days === 9 && s.min_order_value === 250; }));

  // company settings
  await modal.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForSelector('text=Service level (%)', { timeout: 8000 });
  txt = await modal.innerText();
  check('settings tab states the reorder-point and order-quantity rules', /expected demand during lead time \+ safety stock/.test(txt) && /target stock/i.test(txt));
  await modal.getByLabel('Working capital limit').fill('1234');
  await modal.getByLabel('Order cycle (days)').fill('21');
  await modal.getByRole('button', { name: 'Save settings' }).click();
  check('company settings saved', await poll(async () => { const s = (await api('GET', '/inventory/replenishment/settings')).body; return s.budget === 1234 && s.cover_days === 21; }));
  await modal.getByLabel('Working capital limit').fill('');
  await modal.getByLabel('Order cycle (days)').fill('30');
  await modal.getByRole('button', { name: 'Save settings' }).click();
  check('budget cleared', await poll(async () => (await api('GET', '/inventory/replenishment/settings')).body.budget === null));
  await modal.getByLabel('Seasonality category').waitFor({ timeout: 5000 });

  // approvals log
  await modal.getByRole('button', { name: 'Approvals', exact: true }).click();
  await page.waitForSelector(`td:has-text("${newPo.po_no}")`, { timeout: 8000 });
  txt = await modal.locator(`tr:has-text("${newPo.po_no}")`).innerText();
  check('approvals log shows suggested vs ordered', txt.includes('E2E Rep Item') && txt.includes(String(r0.suggested_qty)), txt);
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-replenish-log.png`) });
  await modal.locator('button:has(svg.lucide-x)').first().click();

  // item form
  await page.locator('button[title^="Add new"]').click();
  await page.waitForSelector('text=Stock tracking', { timeout: 8000 });
  await page.locator('summary:has-text("Replenishment")').click();
  const form = page.locator('form').last();
  await form.getByText('Safety stock', { exact: true }).locator('xpath=..').locator('input').fill('4');
  await form.getByText('Lead time (days)').locator('xpath=..').locator('input').fill('6');
  await form.getByText('Min. order qty').locator('xpath=..').locator('input').fill('12');
  await form.getByText('Storage capacity').locator('xpath=..').locator('input').fill('200');
  await form.locator('label:has(span.text-red-500)').first().locator('xpath=..').locator('input').first().fill('E2E Rep Form Item');
  await page.getByRole('button', { name: 'Add SKU' }).click();
  let made;
  for (let i = 0; i < 20 && !made; i++) { await page.waitForTimeout(400); made = (await api('GET', '/inventory')).body.find(x => x.model === 'E2E Rep Form Item'); }
  check('item saved with replenishment settings', made && made.safety_stock === 4 && made.lead_time_days === 6 && made.moq === 12 && made.capacity_units === 200, JSON.stringify(made && [made.safety_stock, made.lead_time_days, made.moq, made.capacity_units]));
  check('no page errors', errors.length === 0, errors.join(' | ').slice(0, 300));
};
