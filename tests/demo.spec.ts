import { test, expect, Page, Locator } from '@playwright/test';

/**
 * TuneGEN — comprehensive end-to-end demo for client presentation.
 *
 * 9 acts, 30 steps, ~6m30s runtime.
 *
 *   Act 1  — First run         (forgot-password walk-through, login)
 *   Act 2  — Setup the business (Settings: company, lookups, services)
 *   Act 3  — Org structure      (Organizations tour, walk-through user form)
 *   Act 4  — Stock the shop     (supplier, inventory, GRN receive stock)
 *   Act 5  — Sell to a customer (customer, POS sale, print invoice)
 *   Act 6  — Money tracking     (Receivables + Payables ledger)
 *   Act 7  — Reports            (P&L, Sales PDF, Stock Excel, Low Stock)
 *   Act 8  — Trust & safety     (Audit log filtering, notifications)
 *   Act 9  — Close              (Dashboard, logout)
 *
 * Decisions per user request:
 *   - 1 OK with full 30-step flow
 *   - 2 NO — do not create a second branch
 *   - 3 Walk through "Add User" form and CANCEL (don't create)
 *   - 4 Walk through "Forgot password" form (don't actually reset)
 *   - 5 Default 800 ms beat
 *
 * Data is REAL and persists. Each run uses RUN_TAG to namespace its rows.
 *
 * Pre-conditions:
 *   - Backend at http://localhost:3001
 *   - Frontend at http://localhost:5173
 *   - DEMO_PASSWORD env var set
 *
 * Output: tests/demo-output/<run-id>/video.webm
 *
 * Run:   $env:DEMO_PASSWORD="..."; npm run demo
 */

const DEMO_EMAIL    = process.env.DEMO_EMAIL    || 'zmehmood@tunegen.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || '';

const RUN_TAG = (() => {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
})();

const DEMO = {
  announcement: `New tire brands now in stock — opening hours 9-9 daily (Demo ${RUN_TAG})`,
  tireType: `Demo-Type-${RUN_TAG}`,
  service: {
    name:  `Demo Wheel Polish ${RUN_TAG}`,
    unit:  'job',
    cost:  '50',
    sale:  '500',
  },
  supplier: {
    name:    `Bridgestone Demo Co. ${RUN_TAG}`,
    phone:   `+92-21-${RUN_TAG.replace('-', '')}`.slice(0, 17),
    email:   `supply.${RUN_TAG.toLowerCase()}@demo.tunegen`,
    address: 'SITE Industrial Area, Karachi',
  },
  customer: {
    name:    `Ahmed Khan (Demo ${RUN_TAG})`,
    phone:   `+92-300-${RUN_TAG.replace('-', '')}`.slice(0, 17),
    email:   `ahmed.${RUN_TAG.toLowerCase()}@demo.tunegen`,
    address: 'DHA Phase 5, Lahore',
    plate:   `DEMO-${RUN_TAG.replace('-', '').slice(-4)}`,
    make:    'Toyota',
    model:   'Corolla',
    year:    '2023',
  },
  tire: {
    brand:    `DemoBrand-${RUN_TAG}`,
    model:    'Ecopia EP150',
    size:     '205/55R16',
    stock:    '5',     // intentionally low so GRN visibly bumps it
    cost:     '8500',
    sale:     '12500',
  },
  grn: {
    refNo: `GRN-DEMO-${RUN_TAG}`,
    qty:   '20',
    cost:  '8500',
  },
  sale: {
    qty:        '2',
    cashGiven:  '30000',
  },
  fakeUser: {
    name:     `Walk-Through User ${RUN_TAG}`,
    email:    `walkthrough.${RUN_TAG.toLowerCase()}@demo.tunegen`,
    phone:    '+92-301-1234567',
    password: 'temppass123',
  },
};

// 600 ms beat keeps the demo readable but trims ~25 % off the runtime.
const BEAT_MS = Number(process.env.DEMO_BEAT_MS ?? 600);
const beat = (page: Page, count = 1) => page.waitForTimeout(BEAT_MS * count);

// Helper — slow-type to make form filling readable on screen
async function typeSlow(loc: Locator, text: string, perChar = 25) {
  await loc.click();
  await loc.fill('');
  await loc.pressSequentially(text, { delay: perChar });
}

test.describe.configure({ mode: 'serial' });

test('TuneGEN full client demo', async ({ page, context }) => {
  // 20-min budget. Real flow runs ~10-11 min with BEAT_MS=600 — extra
  // headroom covers slower machines and any per-step variance.
  test.setTimeout(20 * 60 * 1000);

  if (!DEMO_PASSWORD) {
    throw new Error('Set DEMO_PASSWORD env var. Example (PowerShell):\n  $env:DEMO_PASSWORD="..."; npm run demo');
  }

  const pdfPages: Page[] = [];
  context.on('page', p => pdfPages.push(p));

  // Helper: scope tab-bar clicks to the Settings tab strip so they don't
  // collide with sidebar buttons (e.g. "Services" exists in both places).
  const settingsTabBar = page.locator(
    'div.bg-slate-100.rounded-2xl:has(button:has-text("Company Profile"))'
  );
  const settingsTab = (label: string | RegExp) =>
    settingsTabBar.locator('button').filter({ hasText: label });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 1 — FIRST RUN
  // ════════════════════════════════════════════════════════════════════

  await test.step('1.1 Open the app', async () => {
    await page.goto('/');
    await expect(page).toHaveTitle(/tire.?pro|Vite/i);
    await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible({ timeout: 15_000 });
    await beat(page, 2);
  });

  await test.step('1.2 Walk through "Forgot password" — fill but DO NOT submit', async () => {
    await page.getByRole('button', { name: /Forgot password\?/i }).click();
    await beat(page, 2);
    await expect(page.getByRole('heading', { name: /Forgot password/i })).toBeVisible({ timeout: 5_000 });
    // Fill the email so the viewer sees the field accepting input
    await typeSlow(page.getByPlaceholder('ahmed@company.pk').first(), DEMO_EMAIL);
    await beat(page, 2);
    // Go BACK — don't submit (that would invalidate active sessions)
    await page.getByRole('button', { name: /Sign in/i }).first().click();
    await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible({ timeout: 5_000 });
    await beat(page);
  });

  await test.step('1.3 Login', async () => {
    await typeSlow(page.getByPlaceholder('ahmed@company.pk').first(), DEMO_EMAIL);
    await beat(page);
    await page.locator('input[type="password"]').first().fill(DEMO_PASSWORD);
    await beat(page);
    await page.getByRole('button', { name: /^Sign In$/i }).click();
    await expect(page.getByRole('button', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 });
    await beat(page, 3); // dashboard reveal
  });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 2 — SETUP THE BUSINESS
  // ════════════════════════════════════════════════════════════════════

  await test.step('2.1 Settings → Company Profile (set announcement)', async () => {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await beat(page, 2);

    // Default tab is "Company Profile"
    await expect(page.getByRole('button', { name: /Company Profile/i }).first()).toBeVisible();

    // Find the announcement textarea by placeholder substring
    const announcementBox = page.locator('textarea').filter({ hasText: '' }).last()
      .or(page.locator('textarea[placeholder*="Office closed"]'));
    await page.locator('textarea[placeholder*="Office closed"]').fill(DEMO.announcement);
    await beat(page, 2);

    // Save changes (manual save tab)
    await page.getByRole('button', { name: /^Save Changes$/i }).click().catch(async () => {
      // Alternative label
      await page.getByRole('button', { name: /^Save$/i }).first().click();
    });
    await beat(page, 2);
  });

  await test.step('2.2 Settings → Lookup Tables (add a Tire Type — auto-saves)', async () => {
    await page.getByRole('button', { name: /Lookup Tables/i }).click();
    await beat(page, 2);
    await page.getByPlaceholder('New tire type name...').fill(DEMO.tireType);
    await beat(page);
    // The "Add" button is right next to the input (not the page-level Add buttons)
    await page.locator('button:has-text("Add")').filter({ has: page.locator('svg') }).first().click();
    await beat(page, 3);
  });

  await test.step('2.3 Settings → Services (add a new service)', async () => {
    // Scope to the Settings tab bar — there's also a top-level "Services"
    // sidebar nav, and `getByRole` would happily click that one instead.
    await settingsTab(/Services/).click();
    await beat(page, 2);

    // Open the inline "New Service" form
    await page.getByRole('button', { name: /^Add Service$/i }).click();
    await beat(page, 2);

    // Fill the form (placeholders are unique inside this form)
    await typeSlow(page.getByPlaceholder('e.g. Tyre Fitting'), DEMO.service.name);
    await beat(page);
    await page.getByPlaceholder('job').first().fill(DEMO.service.unit);
    await beat(page);
    await page.getByPlaceholder('Optional description').fill('Demo service for client walkthrough');
    await beat(page);

    // Cost + Sale price — inputs of type=number with placeholder "0".
    // There are two such inputs in the form; fill the first (cost) then second (sale).
    const numInputs = page.locator('input[placeholder="0"][type="number"]');
    await numInputs.nth(0).fill(DEMO.service.cost);
    await beat(page);
    await numInputs.nth(1).fill(DEMO.service.sale);
    await beat(page, 2);

    // Submit — the in-form "Add Service" button (different from the page-level one
    // which we already used to OPEN the form, but at this point the page-level
    // button is hidden because `showForm` is true). To be safe, scope to the form.
    const submitBtn = page
      .locator('div:has-text("New Service") button:has-text("Add Service")')
      .last();
    await submitBtn.click();
    await beat(page, 3);
  });

  await test.step('2.4 Settings → Invoice & PO Defaults (tour only)', async () => {
    await settingsTab(/Invoice & PO Defaults/).click();
    await beat(page, 3);
  });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 3 — ORG STRUCTURE
  // ════════════════════════════════════════════════════════════════════

  await test.step('3.1 Organizations — show structure (read-only tour)', async () => {
    await page.getByRole('button', { name: 'Organization' }).first().click();
    await beat(page, 4); // let the viewer see the org tree
  });

  await test.step('3.2 Settings → Users — walk through "Add User" form, then CANCEL', async () => {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await beat(page);
    // Use substring match (not anchored): each Settings tab button renders the
    // label twice via responsive sm:inline + sm:hidden spans, so the textContent
    // is e.g. "UsersUsers" — anchored /^Users$/ never matches.
    await settingsTab('Users').click();
    await beat(page, 2);

    // Open add user form
    await page.getByRole('button', { name: /^Add User$/i }).click();
    await beat(page, 2);

    // Fill the form so the viewer sees how user creation works
    await typeSlow(page.getByPlaceholder('Muhammad Ahmed'), DEMO.fakeUser.name);
    await beat(page);
    await typeSlow(page.getByPlaceholder('ahmed@company.pk').first(), DEMO.fakeUser.email);
    await beat(page);
    await page.getByPlaceholder('+92-300-1234567').fill(DEMO.fakeUser.phone);
    await beat(page);
    await page.getByPlaceholder('Min 8 characters').fill(DEMO.fakeUser.password);
    await beat(page);

    // Pick a role — Branch Manager
    const roleSelect = page.locator('select').filter({ has: page.locator('option') }).first();
    await roleSelect.selectOption({ label: /Branch Manager|branch_manager/i }).catch(async () => {
      // Fallback by value
      await roleSelect.selectOption('branch_manager').catch(() => {});
    });
    await beat(page, 2);

    // Pick the branch (will use the existing single Main Branch)
    const branchSelect = page.locator('select').nth(1);
    if (await branchSelect.count()) {
      // Pick the first non-empty option
      const opts = await branchSelect.locator('option').allTextContents();
      const targetLabel = opts.find(o => o && !/All branches/.test(o));
      if (targetLabel) await branchSelect.selectOption({ label: targetLabel }).catch(() => {});
    }
    await beat(page, 2);

    // CANCEL — per user instruction, do not create
    await page.getByRole('button', { name: /^Cancel$/i }).first().click();
    await beat(page, 2);
  });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 4 — STOCK THE SHOP
  // ════════════════════════════════════════════════════════════════════

  await test.step('4.1 Add a supplier', async () => {
    await page.getByRole('button', { name: 'Suppliers' }).click();
    await beat(page, 2);
    await page.getByRole('button', { name: /Add Supplier|^Add$/i }).first().click();
    await beat(page);

    await typeSlow(page.getByPlaceholder('Bridgestone Pakistan Ltd.'), DEMO.supplier.name);
    await beat(page);
    await page.getByPlaceholder('+92-21-3456789').fill(DEMO.supplier.phone);
    await beat(page);
    await page.getByPlaceholder('supply@company.pk').fill(DEMO.supplier.email);
    await beat(page);
    await page.getByPlaceholder('Karachi, Sindh').fill(DEMO.supplier.address);
    await beat(page);
    await page.getByRole('button', { name: /^Save Supplier$/i }).click();
    await beat(page, 3);
  });

  await test.step('4.2 Add a tire SKU to inventory', async () => {
    await page.getByRole('button', { name: 'Inventory' }).click();
    await beat(page, 2);
    await page.getByRole('button', { name: /Add SKU|^Add$/i }).first().click();
    await beat(page);

    await typeSlow(page.getByPlaceholder('e.g. Bridgestone'), DEMO.tire.brand);
    await beat(page);
    await typeSlow(page.getByPlaceholder('e.g. Ecopia EP150'), DEMO.tire.model);
    await beat(page);
    await typeSlow(page.getByPlaceholder('e.g. 205/55R16'), DEMO.tire.size);
    await beat(page);

    const modalRoot = page.locator('div[class*="z-50"]:has-text("Add Tire SKU")').first();
    await modalRoot.locator('input[type="number"]').nth(0).fill(DEMO.tire.stock);   // stock
    await beat(page);
    await modalRoot.locator('input[type="number"]').nth(2).fill(DEMO.tire.cost);    // cost
    await beat(page);
    await modalRoot.locator('input[type="number"]').nth(3).fill(DEMO.tire.sale);    // sale
    await beat(page, 2); // margin chip animates in

    await page.locator('form button[type="submit"]:has-text("Add SKU")').click();
    await expect(page.locator('form button[type="submit"]:has-text("Add SKU")')).toHaveCount(0, { timeout: 10_000 });
    await beat(page, 2);
  });

  await test.step('4.3 Purchases → Receive Stock (GRN) from the supplier', async () => {
    await page.getByRole('button', { name: 'Purchases' }).click();
    await beat(page, 2);
    await page.getByRole('button', { name: /Receive Stock \(GRN\)|^New$/i }).first().click();
    await beat(page, 2);

    const grn = page.locator('div[class*="z-50"]:has-text("Receive Stock")').first()
      .or(page.locator('div[class*="z-50"]:has-text("GRN")').first())
      .or(page.locator('div[class*="z-50"]').first());

    // Pick supplier from the GRN modal
    await grn.locator('select').first().selectOption({ label: DEMO.supplier.name });
    await beat(page);

    // Reference / GRN number
    await grn.getByPlaceholder('e.g. GRN-001').fill(DEMO.grn.refNo);
    await beat(page);

    // First line item — Product mode by default. Search for our tire.
    const itemSearch = grn.getByPlaceholder('Search tire or product...').first();
    await itemSearch.click();
    await typeSlow(itemSearch, DEMO.tire.brand, 30);
    await beat(page, 2);
    // Click the first match
    await grn.locator('button', { hasText: DEMO.tire.brand }).first().click();
    await beat(page, 2);

    // Set qty (the first qty input inside the GRN modal)
    const qtyInputs = grn.locator('input[type="number"]');
    await qtyInputs.first().fill(DEMO.grn.qty);
    await beat(page);

    // Cost (second number input on this row)
    if ((await qtyInputs.count()) > 1) {
      await qtyInputs.nth(1).fill(DEMO.grn.cost);
      await beat(page, 2);
    }

    // Submit the GRN — button label is "Receive Stock"
    await grn.getByRole('button', { name: /^Receive Stock$/i }).click();
    // Wait for the modal to disappear (the GRN modal removes itself ~800ms
    // after success). We assert via the modal's submit button no longer existing.
    await expect(grn.getByRole('button', { name: /Receive Stock|Stock Received/i }))
      .toHaveCount(0, { timeout: 10_000 });
    await beat(page, 3);
  });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 5 — SELL TO A CUSTOMER
  // ════════════════════════════════════════════════════════════════════

  await test.step('5.1 Add a customer (with vehicle info)', async () => {
    await page.getByRole('button', { name: 'Customers' }).click();
    await beat(page, 2);
    await page.getByRole('button', { name: /Add Customer|^Add$/i }).first().click();
    await beat(page);

    await typeSlow(page.getByPlaceholder('e.g. Ahmed Hassan'), DEMO.customer.name);
    await beat(page);
    await page.getByPlaceholder('+92-300-1234567').fill(DEMO.customer.phone);
    await beat(page);
    await page.getByPlaceholder('ahmed@company.pk').first().fill(DEMO.customer.email);
    await beat(page);
    await page.getByPlaceholder('City, area or full address').fill(DEMO.customer.address);
    await beat(page);
    await page.getByPlaceholder('e.g. LEA-1234').fill(DEMO.customer.plate);
    await beat(page);
    await page.getByPlaceholder('e.g. Toyota').fill(DEMO.customer.make);
    await beat(page);
    await page.getByPlaceholder('e.g. Corolla').fill(DEMO.customer.model);
    await beat(page);
    await page.locator('input[type="number"]').first().fill(DEMO.customer.year);
    await beat(page);

    await page.locator('form button[type="submit"]:has-text("Add Customer")').click();
    await expect(page.locator('form button[type="submit"]:has-text("Add Customer")')).toHaveCount(0, { timeout: 10_000 });
    await beat(page, 2);
  });

  await test.step('5.2 Sales → POS — make a real sale with cash payment', async () => {
    await page.getByRole('button', { name: 'Sales' }).click();
    await beat(page, 2);
    await page.getByRole('button', { name: /POS \/ New Sale|^New$/i }).first().click();
    await beat(page, 2);

    const pos = page.locator('div.fixed.inset-0:has-text("POS Terminal")').first();
    await expect(pos).toBeVisible({ timeout: 5_000 });

    await pos.locator('select').first().selectOption({ label: DEMO.customer.name });
    await beat(page);

    const searchInput = pos.getByPlaceholder('Search tires & services... (F2)');
    await searchInput.click();
    await typeSlow(searchInput, DEMO.tire.brand, 30);
    await beat(page, 2);
    await pos.locator('button', { hasText: DEMO.tire.brand }).first().click();
    await beat(page);

    // Bump qty
    await pos.locator('table input[type="number"]').first().fill(DEMO.sale.qty);
    await beat(page, 2);

    // Open the discount panel (F4) and apply a 5% order-level discount
    await page.keyboard.press('F4');
    await beat(page);
    const discountInput = pos.locator('input[type="number"]').filter({ hasNot: pos.locator('table input[type="number"]') }).first();
    // Simpler: find by placeholder "0" or look at the panel
    const discPanelInput = pos.locator('div:has-text("Discount (F4)") input[type="number"]').last();
    if (await discPanelInput.count()) {
      await discPanelInput.fill('5');
      await beat(page, 2);
    }

    await pos.getByRole('button', { name: /^Cash$/i }).first().click();
    await beat(page);

    await pos
      .locator('label:has-text("Cash Given")')
      .locator('xpath=following::input[1]')
      .fill(DEMO.sale.cashGiven);
    await beat(page, 2);

    await page.keyboard.press('F8');
    await expect(page.getByRole('heading', { name: /Sale Complete/i })).toBeVisible({ timeout: 15_000 });
    await beat(page, 3);
  });

  await test.step('5.3 Print A4 invoice', async () => {
    const newPagePromise = context.waitForEvent('page', { timeout: 8_000 }).catch(() => null);
    await page.getByRole('button', { name: /Print A4 Invoice/i }).click();
    const pdfPage = await newPagePromise;
    if (pdfPage) {
      await pdfPage.waitForLoadState('domcontentloaded').catch(() => {});
      await beat(pdfPage, 4); // hold the invoice on screen
      await pdfPage.close();
    } else {
      await beat(page, 2);
    }
    // Close success modal
    await page.getByRole('button', { name: /^Close$/i }).click();
    await beat(page, 2);
  });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 6 — MONEY TRACKING
  // ════════════════════════════════════════════════════════════════════

  await test.step('6.1 Ledger → Receivables', async () => {
    await page.getByRole('button', { name: 'Ledger' }).click();
    await beat(page, 3);
    // Receivables tab is default — click the customer card to open statement
    const customerRow = page.locator('button:has-text("Ahmed Khan"), div:has-text("Ahmed Khan")').first();
    if (await customerRow.count()) {
      await customerRow.click();
      await beat(page, 4); // statement
    }
  });

  await test.step('6.2 Ledger → Payables (suppliers)', async () => {
    await page.getByRole('button', { name: /^Payables$/i }).first().click();
    await beat(page, 3);
    const supplierRow = page.locator('button:has-text("Bridgestone Demo"), div:has-text("Bridgestone Demo")').first();
    if (await supplierRow.count()) {
      await supplierRow.click();
      await beat(page, 4);
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 7 — REPORTS
  // ════════════════════════════════════════════════════════════════════

  await test.step('7.1 Reports → P&L Summary', async () => {
    await page.getByRole('button', { name: 'Reports' }).click();
    await beat(page, 4);
  });

  await test.step('7.2 Reports → Sales Report → Export PDF', async () => {
    await page.getByRole('button', { name: /^Sales Report$/i }).click();
    await beat(page, 3);
    const pdfBtn = page.locator('button[title="Export to PDF"]').first();
    if (await pdfBtn.count()) {
      const newPagePromise = context.waitForEvent('page', { timeout: 6_000 }).catch(() => null);
      await pdfBtn.click();
      const pdfPage = await newPagePromise;
      if (pdfPage) {
        await pdfPage.waitForLoadState('domcontentloaded').catch(() => {});
        await beat(pdfPage, 3);
        await pdfPage.close();
      }
    }
    await beat(page, 2);
  });

  await test.step('7.3 Reports → Stock Report → Export Excel', async () => {
    await page.getByRole('button', { name: /^Stock Report$/i }).click();
    await beat(page, 3);
    const excelBtn = page.locator('button[title="Export to Excel"]').first();
    if (await excelBtn.count()) {
      // Excel exports trigger a download — listen for the event
      const downloadPromise = page.waitForEvent('download', { timeout: 5_000 }).catch(() => null);
      await excelBtn.click();
      const dl = await downloadPromise;
      if (dl) {
        // Save it to the demo-output dir for visual proof, then move on
        await dl.saveAs(`tests/demo-output/${RUN_TAG}-stock-report.xlsx`).catch(() => {});
      }
    }
    await beat(page, 2);
  });

  await test.step('7.4 Reports → Low Stock', async () => {
    await page.getByRole('button', { name: /^Low Stock$/i }).click();
    await beat(page, 3);
  });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 8 — TRUST & SAFETY
  // ════════════════════════════════════════════════════════════════════

  await test.step('8.1 Audit Log — filter by entity', async () => {
    await page.getByRole('button', { name: 'Audit Log' }).click();
    await beat(page, 4);
    // Pick "sales" from the Entity filter to focus the log
    const entitySelect = page.locator('select').first();
    if (await entitySelect.count()) {
      await entitySelect.selectOption({ label: /Sale/i }).catch(() => {});
      await beat(page, 4);
    }
  });

  await test.step('8.2 Notification bell (best-effort, never blocks)', async () => {
    // The notifications popover renders with an invisible overlay backdrop
    // that intercepts subsequent clicks. To stay safe, we open it for the
    // camera, then dismiss with Escape (popovers respond to it natively).
    // Wrapped in try/catch so any unexpected behaviour can't stall the demo.
    try {
      const bell = page.locator('header button[aria-label="Notifications"]').first();
      if (await bell.count()) {
        await bell.click({ timeout: 3_000 });
        await beat(page, 2);
        await page.keyboard.press('Escape').catch(() => {});
        await beat(page);
      }
    } catch {
      // best-effort only — never block the demo
    }
  });

  // ════════════════════════════════════════════════════════════════════
  //                     ACT 9 — CLOSE
  // ════════════════════════════════════════════════════════════════════

  await test.step('9.1 Back to Dashboard — populated stats', async () => {
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await beat(page, 4); // closing money shot
  });

  await test.step('9.2 Sign out', async () => {
    const logoutBtn = page
      .getByRole('button', { name: /^(Logout|Sign out|Log out)$/i })
      .first();
    if (await logoutBtn.count()) {
      await logoutBtn.click();
      await beat(page, 2);
      await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible({ timeout: 10_000 });
      await beat(page);
    }
  });

  // Cleanup PDF tabs
  for (const p of pdfPages) if (!p.isClosed()) await p.close().catch(() => {});
});
