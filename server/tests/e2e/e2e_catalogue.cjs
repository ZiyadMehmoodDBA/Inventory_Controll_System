const path = require('path');
const { getPool, sql } = require('../../db');
const Shop = require('../fixtures/shop');
// Settings > Catalogue Scraper in a real browser: choose a business type, start a scrape of the fixture shop, watch it finish, review the grid
// (columns, statuses, duplicate reasons), preview, edit, ignore/restore, approve and import, export, and a refused source shows its reason.
module.exports = async (ctx) => { try { await body(ctx); } catch (e) { await ctx.page.screenshot({ path: path.join(ctx.SHOTS, 'e2e-catalogue-fail.png') }); throw e; } };

const body = async ({ page, check, SHOTS, label }) => {
  const orgId = Number(await page.evaluate(() => localStorage.getItem('orgId')));
  const pool = await getPool();
  const shop = await Shop.start(3056);
  const SHOP = 'http://127.0.0.1:3056';
  const poll = async (fn, tries = 60) => { for (let i = 0; i < tries; i++) { if (await fn()) return true; await page.waitForTimeout(500); } return false; };
  try {
    await pool.request().input('o', sql.Int, orgId).query("MERGE settings AS t USING (SELECT @o AS organization_id, 'business_type' AS [key]) AS s ON t.organization_id = s.organization_id AND t.[key] = s.[key] WHEN MATCHED THEN UPDATE SET value = 'general_store' WHEN NOT MATCHED THEN INSERT (organization_id, [key], value) VALUES (@o, 'business_type', 'general_store');");
    await pool.request().input('o', sql.Int, orgId).input('b', sql.Int, Number(await page.evaluate(() => localStorage.getItem('branchId') || '1')))
      .query("IF NOT EXISTS (SELECT 1 FROM tires WHERE organization_id = @o AND sku = 'RICE-5KG') INSERT INTO tires (organization_id, branch_id, brand, model, size, stock, cost_price, sale_price, reorder_level, sku) VALUES (@o, (SELECT MIN(id) FROM branches WHERE organization_id = @o), 'Guard', 'Basmati Rice', '5kg', 0, 1500, 1999, 10, 'RICE-5KG')");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.getByRole('button', { name: /^Settings/ }).first().click({ timeout: 20000 });
    await page.locator('[data-testid="settings-tabs"]').getByRole('button', { name: /^Catalogue/ }).click({ timeout: 15000 });
    await page.locator('[data-testid="catalogue-scraper"]').waitFor({ timeout: 15000 });
    check('Catalogue Scraper is available to a non-tyre business', true);
    check('the business type defaults to the organisation\'s own', (await page.getByLabel('Business type').inputValue()) === 'general_store');
    check('all 15 business types are offered', (await page.getByLabel('Business type').locator('option').count()) === 15);

    // profile follows the business type
    await page.getByLabel('Business type').selectOption('electronics');
    await page.locator('[data-testid="profile-summary"]:has-text("Storage capacity")').waitFor({ timeout: 8000 });
    check('choosing Electronics shows electronics attributes', /Warranty/.test(await page.locator('[data-testid="profile-summary"]').innerText()) && !/OEM number/.test(await page.locator('[data-testid="profile-summary"]').innerText()));
    await page.getByLabel('Business type').selectOption('auto_parts');
    await page.locator('[data-testid="profile-summary"]:has-text("OEM number")').waitFor({ timeout: 8000 });
    check('choosing Auto Parts shows OEM number and vehicle fitment', /Vehicle make/.test(await page.locator('[data-testid="profile-summary"]').innerText()));
    await page.getByLabel('Business type').selectOption('grocery');
    await page.locator('[data-testid="profile-summary"]:has-text("Ingredients")').waitFor({ timeout: 8000 });
    check('choosing Grocery shows barcode and ingredients', /Barcode/.test(await page.locator('[data-testid="profile-summary"]').innerText()));

    // start disabled until the form is filled; bad source refused with the reason
    check('Start is disabled until name and URL are given', await page.getByRole('button', { name: 'Start scraping' }).isDisabled());
    await page.getByLabel('Source name').fill('Fixture grocery');
    await page.getByLabel('Catalogue source URL').fill('http://169.254.169.254/latest/meta-data');
    await page.getByRole('button', { name: 'Start scraping' }).click();
    await page.locator('text=cloud-metadata').first().waitFor({ timeout: 8000 });
    check('a private / metadata address is refused with a clear reason', true);

    // real scrape
    await page.getByLabel('Catalogue source URL').fill(`${SHOP}/shop/page1`);
    await page.getByLabel('Product category').fill('Grocery');
    await page.getByRole('button', { name: 'Start scraping' }).click();
    await page.locator('[data-testid="catalogue-results"]').waitFor({ timeout: 20000 });
    check('results open for the new scrape', true);
    check('the scrape finishes and lists seven products', await poll(async () => (await page.locator('[data-testid="catalogue-records"] tbody tr[data-record]').count()) === 7), String(await page.locator('[data-testid="catalogue-records"] tbody tr[data-record]').count()));
    const head = (await page.locator('[data-testid="catalogue-records"] thead').innerText()).replace(/\s+/g, ' ');
    check('the grid has product, SKU, brand, category, attributes, price, image, source, status and actions', ['Product', 'SKU', 'Brand', 'Category', 'Attributes', 'Price', 'Image', 'Source', 'Status', 'Actions'].every(h => new RegExp(h, 'i').test(head)), head);
    await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-catalogue-results.png`), fullPage: true });
    let rice = page.locator('tr[data-record="Guard Basmati Rice 5kg"]');
    check('the existing-SKU product is marked Duplicate with the reason', /Duplicate/.test(await rice.innerText()) && /Same SKU/.test(await rice.innerText()), await rice.innerText());
    check('the duplicate cannot be selected for import', await rice.getByRole('checkbox').isDisabled());
    check('a valid product shows Validated', /Validated/.test(await page.locator('tr[data-record="Tapal Danedar Tea 190g"]').innerText()));
    check('the page itself has no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    // status filter and search
    await page.getByRole('button', { name: /^Duplicate/ }).click();
    check('the Duplicate filter shows only duplicates', await poll(async () => (await page.locator('tr[data-record]').count()) === 2));
    await page.getByRole('button', { name: /^All/ }).click();
    await page.getByLabel('Search results').fill('tapal');
    check('search narrows the grid', await poll(async () => (await page.locator('tr[data-record]').count()) === 1));
    await page.getByLabel('Search results').fill('');
    await poll(async () => (await page.locator('tr[data-record]').count()) === 7);

    // preview
    await page.getByRole('button', { name: 'Preview Tapal Danedar Tea 190g' }).click();
    const pv = page.getByRole('dialog', { name: 'Preview product' });
    await pv.locator('text=Open source page').waitFor({ timeout: 8000 });
    check('preview shows the product, its source and the raw extraction', /TAPAL-190/.test(await pv.innerText()) && /Open source page/.test(await pv.innerText()) && /Raw extraction/.test(await pv.innerText()));
    await pv.getByRole('button', { name: 'Close' }).first().click();

    // edit: make the duplicate unique
    await page.getByRole('button', { name: 'Edit Guard Basmati Rice 5kg' }).click();
    const ed = page.getByRole('dialog', { name: 'Edit product' });
    await ed.waitFor({ timeout: 8000 });
    await ed.getByLabel('Barcode / GTIN').fill('12345');
    await ed.getByRole('button', { name: 'Save changes' }).click();
    await ed.locator('text=not a valid barcode').waitFor({ timeout: 8000 });
    check('an invalid barcode is refused in the dialog', true);
    await ed.getByLabel('Barcode / GTIN').fill('');
    await ed.getByLabel('SKU / Part number').first().fill('RICE-5KG-E2E');
    await ed.getByLabel('Product name').fill('Guard Super Kernel Basmati Rice 5kg');   // same brand + name + size as the existing product is still a duplicate
    await ed.getByRole('button', { name: 'Save changes' }).click();
    await ed.waitFor({ state: 'detached', timeout: 8000 });
    rice = page.locator('tr[data-record="Guard Super Kernel Basmati Rice 5kg"]');
    check('after editing the SKU the record is Validated', await poll(async () => /Validated/.test(await rice.innerText())));

    // ignore + restore
    await page.getByRole('button', { name: 'Ignore Tapal Danedar Tea 190g' }).click();
    check('ignoring a record marks it Ignored', await poll(async () => /Ignored/.test(await page.locator('tr[data-record="Tapal Danedar Tea 190g"]').innerText())));
    await page.getByRole('button', { name: 'Restore Tapal Danedar Tea 190g' }).click();
    check('restoring brings it back', await poll(async () => /Validated|Pending/.test(await page.locator('tr[data-record="Tapal Danedar Tea 190g"]').innerText())));

    // import two
    await rice.getByRole('checkbox').check();
    await page.locator('tr[data-record="Olpers Full Cream Milk 1L"]').getByRole('checkbox').check();
    await page.locator('[data-testid="bulk-bar"]').waitFor({ timeout: 5000 });
    check('selecting rows shows the bulk bar with the count', /2 selected/.test(await page.locator('[data-testid="bulk-bar"]').innerText()));
    await page.getByRole('button', { name: /Approve & import/ }).click();
    await page.locator('[role="status"]:has-text("2 products added")').waitFor({ timeout: 15000 });
    check('Approve & import adds them and says so', true);
    const items = (await pool.request().input('o', sql.Int, orgId).query("SELECT sku, sale_price, stock FROM tires WHERE organization_id = @o AND sku IN ('RICE-5KG-E2E', 'OLP-1L') ORDER BY sku")).recordset;
    check('both are in the product master with their price and zero stock', items.length === 2 && items.every(i => i.stock === 0 && Number(i.sale_price) > 0), JSON.stringify(items));
    check('the original product with the same SKU was not touched', Number((await pool.request().input('o', sql.Int, orgId).query("SELECT sale_price FROM tires WHERE organization_id = @o AND sku = 'RICE-5KG'")).recordset[0].sale_price) === 1999);
    check('imported rows show Imported and lose their edit/import actions', await poll(async () => /Imported/.test(await rice.innerText())) && (await rice.getByRole('button', { name: /^Import / }).count()) === 0);

    // export
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'CSV' }).click()]);
    const csv = require('fs').readFileSync(await dl.path(), 'utf8');
    check('CSV export downloads every record with its status and source', /^﻿?Product name,SKU/.test(csv) && csv.trim().split(/\r?\n/).length >= 8 && /Imported/.test(csv) && /127\.0\.0\.1:3056/.test(csv), csv.slice(0, 200));
    check('a formula-looking scraped name is neutralised in the export', /'=HYPERLINK/.test(csv) && !/(^|\n)=HYPERLINK/.test(csv));
    const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'Excel' }).click()]);
    check('Excel export downloads an .xlsx file', /\.xlsx$/.test(dl2.suggestedFilename()));

    // a refused source shows its reason in the list
    await page.getByLabel('Source name').fill('Private area');
    await page.getByLabel('Catalogue source URL').fill(`${SHOP}/private/p4`);
    await page.getByRole('button', { name: 'Start scraping' }).click();
    await page.locator('tr[data-job="Private area"]:has-text("robots.txt")').waitFor({ timeout: 25000 });
    check('a page robots.txt forbids fails with that reason in the list', true);

    // profile editing
    await page.getByRole('button', { name: 'Edit profile' }).click();
    const pd = page.getByRole('dialog', { name: 'Edit catalogue profile' });
    await pd.getByLabel('Profile keywords').fill('rice, flour');
    await pd.getByRole('button', { name: 'Save profile' }).click();
    await pd.waitFor({ state: 'detached', timeout: 8000 });
    check('a profile can be customised from the screen', /customis|saved/i.test(await page.locator('[role="status"]').innerText()) && (await page.locator('[data-testid="profile-summary"]').count()) === 1);
    await page.getByRole('button', { name: 'Edit profile' }).click();
    await pd.getByRole('button', { name: /Reset to defaults/ }).click();
    await pd.waitFor({ state: 'detached', timeout: 8000 });
    check('and reset to the defaults', true);

    // delete the finished scrape
    await page.getByRole('button', { name: 'Delete Private area' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    check('a scrape can be deleted after confirming', await poll(async () => (await page.locator('tr[data-job="Private area"]').count()) === 0));
    await page.screenshot({ path: path.join(SHOTS, `e2e-${label}-catalogue-final.png`), fullPage: true });
  } finally {
    await shop.close().catch(() => {});
    for (const q of ['DELETE FROM catalogue_records WHERE organization_id=@o', 'DELETE FROM catalogue_raw WHERE organization_id=@o', 'DELETE FROM catalogue_jobs WHERE organization_id=@o', 'DELETE FROM catalogue_profiles WHERE organization_id=@o']) {
      await pool.request().input('o', sql.Int, orgId).query(q).catch(() => {});
    }
  }
};
