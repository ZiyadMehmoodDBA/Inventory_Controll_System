const path = require('path');
module.exports = async ({ page, check, api, ids, errors, SHOTS, label }) => {
  // Expiry report + trace
  await page.locator('button[title="Expired and soon-to-expire stock"]').click();
  await page.waitForSelector('text=Expiry Report', { timeout: 8000 });
  await page.waitForSelector('text=Expiring soon', { timeout: 8000 });
  check('expiry report lists the expiring batch', (await page.locator('text=M-SOON').count()) > 0);
  await page.getByPlaceholder('Trace a batch or serial number').fill('IMEI2');
  await page.getByRole('button', { name: /^Trace$/ }).click();
  await page.waitForSelector('text=/1 on hand/', { timeout: 8000 });
  const body = await page.locator('body').innerText();
  check('trace shows the serial\'s history', /IMEI2/.test(body) && /grn received/i.test(body), body.slice(-300));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-trace.png`) });
  await page.getByPlaceholder('Trace a batch or serial number').fill('NOPE-123');
  await page.getByRole('button', { name: /^Trace$/ }).click();
  await page.waitForSelector('text=/No batch or serial number/', { timeout: 8000 });
  check('unknown serial reports not found', true);
  await page.locator('div.fixed button:has(svg.lucide-x)').first().click();

  // Dashboard alert
  await page.getByRole('button', { name: /^Dashboard/ }).first().click();
  await page.waitForSelector('text=Expiry alert', { timeout: 10000 });
  const dash = await page.locator('body').innerText();
  check('dashboard shows expiry alert with expiring units', /10\s*expiring within 30 days/.test(dash.replace(/\n/g, ' ')), dash.slice(0, 200));
  await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-dashboard.png`) });
  check('no page errors in extra flow', errors.filter(e => e.startsWith('pageerror')).length === 0, errors.slice(0, 3).join(' | '));
};
