/*
 * One-off debug script: drives the IRCTC online-charts flow exactly like
 * irctcChart.js, but dumps a screenshot + trimmed HTML after each step so the
 * real markup (calendar, class tabs, vacancy grid) can be inspected without
 * guessing selectors blind.
 *
 * Usage: node src/debug/inspect.js <trainNumber> <YYYY-MM-DD>
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const OUT_DIR = path.join(__dirname, '../../debug-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function dump(page, label) {
  await page.screenshot({ path: path.join(OUT_DIR, `${label}.png`) });
  const html = await page.content();
  fs.writeFileSync(path.join(OUT_DIR, `${label}.html`), html);
  console.log(`dumped ${label}`);
}

(async () => {
  const [, , trainNumber = '12002', dateStr] = process.argv;
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'domcontentloaded' });
    await dump(page, '01-loaded');

    const trainField = page.locator('input[type="text"]').nth(0);
    await trainField.click({ force: true });
    await trainField.type(trainNumber, { delay: 30 });
    await page.waitForTimeout(500);
    await dump(page, '02-train-typed');

    const option = page.locator('div[id*="-option-"]').filter({ hasText: new RegExp(`^${trainNumber}\\s*-`) }).first();
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click();
    await dump(page, '03-train-selected');

    if (dateStr) {
      const dateField = page.locator('input[type="text"]').nth(1);
      await dateField.click();
      await dump(page, '04-calendar-open');
    }

    const boardingField = page.locator('input[type="text"]').nth(2);
    await boardingField.click({ force: true });
    await page.waitForTimeout(4000);
    await dump(page, '05-boarding-open');

    const options = page.locator('div[id*="-option-"]');
    const count = await options.count();
    const texts = [];
    for (let i = 0; i < count; i++) texts.push(await options.nth(i).textContent());
    fs.writeFileSync(path.join(OUT_DIR, '05-boarding-options.json'), JSON.stringify(texts, null, 1));
    console.log('boarding option count (as rendered in DOM):', count);

    if (count > 0) {
      await options.first().click();
      const submitBtn = page.getByRole('button', { name: /get train chart/i });
      await submitBtn.click();
      await page.waitForTimeout(4000);
      await dump(page, '06-chart-result');

      const buttons = await page.locator('button').all();
      const buttonTexts = [];
      for (const b of buttons) buttonTexts.push(await b.textContent());
      fs.writeFileSync(path.join(OUT_DIR, '06-buttons.json'), JSON.stringify(buttonTexts, null, 1));

      const gridRoles = await page.locator('[role]').evaluateAll((els) =>
        els.slice(0, 60).map((e) => ({ role: e.getAttribute('role'), text: e.textContent.slice(0, 40) }))
      );
      fs.writeFileSync(path.join(OUT_DIR, '06-roles.json'), JSON.stringify(gridRoles, null, 1));

      const tableCount = await page.locator('table').count();
      console.log('table elements found:', tableCount);
    }
  } catch (err) {
    console.error('ERROR', err.message);
    await dump(page, '99-error');
  } finally {
    await browser.close();
  }
})();
