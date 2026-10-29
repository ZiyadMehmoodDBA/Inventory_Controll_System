const path = require('path');
// Inventory dashboard & reports: exceptions, KPI tiles, drill-down to a report, filters, exports, role scoping.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: path.join(ctx.SHOTS, 'e2e-insights-fail.png') }); throw e; } };
const body = async ({ page, check, api, SHOTS, label }) => {
  const d = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const sup = (await api('POST', '/suppliers', { name: 'E2E Ins Supplier' })).body.id;
  const A = (await api('POST', '/inventory', { model: 'E2E Ins Dated', cost_price: 10, sale_price: 20, supplier_id: sup, stock: 0, tracking: 'batch', track_expiry: true })).body.id;
  const B = (await api('POST', '/inventory', { model: 'E2E Ins Low', cost_price: 10, sale_price: 20, supplier_id: sup, stock: 0, reorder_level: 20 })).body.id;
  await api('POST', '/purchases', { supplier_id: sup, date: d(0), status: 'received', items: [{ tire_id: A, tire_name: 'x', qty: 6, unit_price: 10, batch_no: 'EI1', expiry_date: d(7) }] });
  await api('POST', '/purchases', { supplier_id: sup, date: d(0), status: 'received', items: [{ tire_id: B, tire_name: 'x', qty: 3, unit_price: 10 }] });

  await page.getByRole('button', { name: /^Inventory/ }).first().click();
  await page.locator('button[title^="Exceptions that need a decision"]').click();
  const modal = page.locator('div.fixed:has(h3:text-is("Inventory Dashboard & Reports"))');
  await modal.waitFor({ timeout: 8000 });
  await modal.locator('text=Needs attention').first().waitFor({ timeout: 15000 });
  let txt = await modal.innerText();
  check('dashboard shows exceptions first', /Needs attention/.test(txt) && /Near expiry/.test(txt) && /Low stock/.test(txt), txt.slice(0, 400));
  check('dashboard shows key figures', /Stock on hand/.test(txt) && /Inventory value/.test(txt) && /Pending receipts/.test(txt) && /Pending transfers/.test(txt) && /Discrepancies/.test(txt) && /Recent stock movements/.test(txt));
  const firstChip = await modal.locator('ul li span.uppercase').first().innerText();
  check('most severe exception listed first', /critical|warning/i.test(firstChip), firstChip);
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-insights-dashboard.png`) });

  // drill down: near-expiry exception -> batch & expiry report
  await modal.locator('li:has-text("Near expiry")').getByRole('button', { name: 'View report' }).click();
  await modal.locator('h4:text-is("Batch and Expiry Report")').waitFor({ timeout: 10000 });
  await modal.locator('td:text-is("EI1")').waitFor({ timeout: 10000 });
  check('exception opens the matching report with its data', /EI1/.test(await modal.innerText()) && /Expiring/.test(await modal.innerText()));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-insights-report.png`) });

  // report switch + filter
  await modal.getByRole('tab', { name: 'Current Stock' }).click();
  await modal.locator('h4:text-is("Current Stock Report")').waitFor({ timeout: 10000 });
  await modal.getByPlaceholder('Name, SKU or barcode').fill('E2E Ins Low');
  await modal.getByRole('button', { name: 'Run report' }).click();
  await page.waitForFunction(() => { const t = document.body.innerText; return /E2E Ins Low/.test(t) && !/E2E Ins Dated/.test(t.split('Current Stock Report')[1] || ''); }, null, { timeout: 8000 });
  check('item filter narrows the report', true);
  txt = await modal.innerText();
  check('report shows totals row and notes', /Total/.test(txt) && /Available = on hand/.test(txt));

  // date-range report with presets
  await modal.getByRole('tab', { name: 'Inventory Movement Ledger' }).click();
  await modal.locator('h4:text-is("Inventory Movement Ledger")').waitFor({ timeout: 10000 });
  await modal.getByRole('button', { name: '7 days' }).click();
  await modal.locator('td:has-text("Purchase")').first().waitFor({ timeout: 10000 }).catch(() => {});
  check('ledger lists the period movements', /E2E Ins/.test(await modal.innerText()));

  // export
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), modal.getByRole('button', { name: 'CSV' }).click()]);
  check('CSV export downloads a file', /^movement_ledger-\d{4}-\d{2}-\d{2}\.csv$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  const [dx] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), modal.getByRole('button', { name: 'Excel' }).click()]);
  check('Excel export downloads a file', /\.xlsx$/.test(dx.suggestedFilename()), dx.suggestedFilename());
  const [dp] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), modal.getByRole('button', { name: 'PDF' }).click()]);
  check('PDF export downloads a file', /\.pdf$/.test(dp.suggestedFilename()), dp.suggestedFilename());

  // empty state
  await modal.getByRole('tab', { name: 'Damage and Write Off' }).click();
  await modal.locator('h4:text-is("Damage and Write Off Report")').waitFor({ timeout: 10000 });
  check('damage report explains physical vs valuation', /Physical loss/.test(await modal.innerText()));

  // open an action from the dashboard
  await modal.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await modal.locator('text=Needs attention').first().waitFor({ timeout: 10000 });
  await modal.locator('li:has-text("Replenishment recommended")').getByRole('button', { name: 'Open' }).click().catch(() => {});
  await page.waitForTimeout(800);
  check('dashboard action closes it and opens the target screen', (await page.locator('div.fixed:has(h3:text-is("Inventory Dashboard & Reports"))').count()) === 0);
};
