const path = require('path');
// Hazmat: items register, check tool, hold/lift, class + segregation, location permits, incident block/close, item form section.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: require('path').join(ctx.SHOTS, 'e2e-hazmat-fail.png') }); throw e; } };
const body = async ({ page, check, api, errors, SHOTS, label }) => {
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const sup = (await api('POST', '/suppliers', { name: 'E2E H Supplier' })).body.id;
  await api('POST', '/inventory/hazmat/classes/seed-standard');
  const classes = (await api('GET', '/inventory/hazmat/classes')).body.classes;
  const c3 = classes.find(c => c.code === '3').id;
  const defLoc = (await api('GET', '/inventory/locations')).body.find(l => l.is_default).id;
  await api('PUT', `/inventory/hazmat/locations/${defLoc}`, { permits: [{ hazard_class_id: c3 }] });
  const fl = (await api('POST', '/inventory', { model: 'E2E Solvent', cost_price: 10, sale_price: 20, hazard_class_id: c3, sds_ref: 'SDS-E2E', sds_date: d(-10) })).body.id;
  await api('POST', '/purchases', { supplier_id: sup, date: d(0), status: 'received', items: [{ tire_id: fl, tire_name: 'x', qty: 10, unit_price: 10 }] });
  const plain = (await api('POST', '/inventory', { model: 'E2E Plain Hz', cost_price: 1, sale_price: 2, stock: 5 })).body.id;
  let n = 0;
  const sell = id => api('POST', '/sales', { date: d(0), items: [{ tire_id: id, qty: 1, unit_price: 20 + (++n) / 100 }], tax_rate: 0 });
  check('API: hazardous receipt into the approved default location works', (await api('GET', `/inventory/position/${fl}`)).body.on_hand === 10);

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Hazardous materials"]').click();
  const modal = page.locator('div.fixed:has(h3:text-is("Hazardous Materials"))');
  await modal.waitFor({ timeout: 8000 });
  await page.waitForSelector('text=/No findings|Hazard|Safety/', { timeout: 10000 });
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-hazmat-compliance.png`) });

  await modal.getByRole('button', { name: 'Items', exact: true }).click();
  const row = modal.locator('tr:has-text("E2E Solvent")');
  await row.waitFor({ timeout: 8000 });
  check('register shows class, SDS and storage location', /3 Flammable liquid/.test(await row.innerText()) && /SDS-E2E/.test(await row.innerText()), await row.innerText());
  check('plain item is not listed', (await modal.locator('tr:has-text("E2E Plain Hz")').count()) === 0);

  // hold via UI
  const dlg = page.locator('div.fixed.z-\\[60\\]');
  await row.getByRole('button', { name: 'Hold', exact: true }).click();
  await dlg.waitFor({ timeout: 5000 });
  const confirm = dlg.getByRole('button', { name: 'Confirm' });
  check('confirm disabled without a reason', await confirm.isDisabled());
  await dlg.locator('textarea').fill('Label under review');
  await confirm.click();
  await modal.locator('tr:has-text("E2E Solvent"):has-text("ON HOLD")').waitFor({ timeout: 8000 });
  const s1 = await sell(fl);
  check('held item cannot be sold', s1.status === 409 && s1.body.code === 'HAZMAT_HOLD', JSON.stringify([s1.status, s1.body]));
  await modal.locator('tr:has-text("E2E Solvent")').getByRole('button', { name: 'Lift hold' }).click();
  await dlg.waitFor({ timeout: 5000 });
  await dlg.locator('textarea').fill('Label corrected');
  await dlg.getByRole('button', { name: 'Confirm' }).click();
  await modal.locator('tr:has-text("E2E Solvent"):has-text("ON HOLD")').waitFor({ state: 'detached', timeout: 8000 });
  check('lifted hold lets it sell again', (await sell(fl)).status === 201);

  // check tool
  const tool = modal.locator('div:has(> div > label:text-is("Can this move happen?"))').first();
  await modal.locator('select:has(option:text-is("Item…"))').selectOption({ label: 'E2E Solvent' });
  await modal.getByRole('button', { name: 'Check', exact: true }).click();
  await page.waitForSelector('text=/Allowed\\./', { timeout: 8000 });
  check('check tool answers for an approved move', true);

  // classes tab
  await modal.getByRole('button', { name: 'Classes & segregation' }).click();
  await modal.getByRole('button', { name: 'New class' }).click();
  await dlg.getByPlaceholder('Code').fill('E2EC');
  await dlg.getByPlaceholder('Name').fill('E2E Cold chain');
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.locator('td:text-is("E2EC")').waitFor({ timeout: 8000 });
  check('class created through the UI', (await api('GET', '/inventory/hazmat/classes')).body.classes.some(c => c.code === 'E2EC'));
  const c8 = classes.find(c => c.code === '8').id;
  await modal.locator('input[title="Flammable liquid / Corrosive"]').click();
  await page.waitForTimeout(800);
  const pairs = (await api('GET', '/inventory/hazmat/classes')).body.incompatibilities;
  check('segregation pair removed through the matrix', !pairs.some(p => p.class_a === Math.min(c3, c8) && p.class_b === Math.max(c3, c8)));
  await modal.locator('input[title="Flammable liquid / Corrosive"]').click();
  await page.waitForTimeout(800);
  check('and restored', (await api('GET', '/inventory/hazmat/classes')).body.incompatibilities.some(p => p.class_a === Math.min(c3, c8) && p.class_b === Math.max(c3, c8)));

  // locations tab: permit class 8 at default
  await modal.getByRole('button', { name: 'Locations', exact: true }).click();
  const lrow = modal.locator('tr:has-text("Main Store"), tr:has-text("Main")').first();
  await lrow.getByRole('button', { name: 'Edit' }).click();
  await dlg.locator('label:has-text("8 — Corrosive") input[type=checkbox], div:has-text("8 — Corrosive") > input[type=checkbox]').first().check();
  await dlg.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForSelector('text=/Location saved|Saved\\./', { timeout: 8000 });
  const perms = (await api('GET', '/inventory/hazmat/locations')).body.find(l => l.id === defLoc).permits.map(p => p.hazard_class_id);
  check('location permits updated through the UI', perms.includes(c8) && perms.includes(c3), JSON.stringify(perms));

  // incident
  await modal.getByRole('button', { name: 'Incidents', exact: true }).click();
  await modal.getByRole('button', { name: 'Report incident' }).first().click();
  await dlg.locator('select:has(option:text-is("Item (optional)…"))').selectOption({ label: 'E2E Solvent' });
  await dlg.locator('select').nth(1).selectOption('high');
  await dlg.getByPlaceholder('What happened (required)').fill('Drum leaking');
  await dlg.getByRole('button', { name: 'Report', exact: true }).click();
  await modal.locator('tr:has-text("Drum leaking")').waitFor({ timeout: 8000 });
  const s2 = await sell(fl);
  check('open high-severity incident blocks sale', s2.status === 409 && s2.body.code === 'HAZMAT_INCIDENT_OPEN', JSON.stringify([s2.status, s2.body]));
  await modal.locator('tr:has-text("Drum leaking")').getByRole('button', { name: 'Close' }).click();
  await dlg.getByPlaceholder('Resolution (required)').fill('Cleaned and repacked');
  await dlg.getByRole('button', { name: 'Close incident' }).click();
  await modal.locator('tr:has-text("Drum leaking"):has-text("closed")').waitFor({ timeout: 8000 });
  check('closing the incident lifts the block', (await sell(fl)).status === 201);
  check('non-hazardous stock unaffected throughout', (await sell(plain)).status === 201);

  // item form
  await modal.locator('button:has(svg.lucide-x)').first().click();
  await page.locator('input[placeholder*="Search"]').first().fill('E2E Plain Hz');
  await page.waitForTimeout(700);
  await page.locator('button[title="Edit"], button:has(svg.lucide-pencil)').first().click();
  await page.locator('summary:has-text("Hazard & special handling")').waitFor({ timeout: 8000 });
  await page.locator('summary:has-text("Hazard & special handling")').click();
  await page.locator('select:has(option:text-is("Not hazardous"))').selectOption({ label: '3 — Flammable liquid' });
  await page.getByPlaceholder('UN1203').fill('1993');
  await page.getByRole('button', { name: /Update|Save/ }).last().click();
  await page.waitForTimeout(1500);
  const list = (await api('GET', '/inventory')).body;
  const it = (Array.isArray(list) ? list : list.items || []).find(t => t.id === plain);
  check('item form saves hazard class and UN number', it && it.hazard_class_id === c3 && it.un_number === 'UN1993', JSON.stringify(it).slice(0, 200));
  check('no console or page errors', errors.length === 0, JSON.stringify(errors).slice(0, 300));
};
