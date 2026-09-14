// One-off probe: finds the real max day-offset IRCTC's online-charts date
// picker will accept, by trying to select increasing offsets from today and
// checking whether the date field's value actually changes.
process.env.IRCTC_PROXY_SERVER = process.env.IRCTC_PROXY_SERVER || 'socks5://10.200.201.2:1080';
const { chromium } = require('playwright');

function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ proxy: { server: process.env.IRCTC_PROXY_SERVER } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  await page.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'domcontentloaded' });

  const trainField = page.locator('input[type="text"]').nth(0);
  await trainField.click({ force: true });
  await trainField.fill('');
  await trainField.type('12952', { delay: 30 });
  const option = page.locator('div[id*="-option-"]').filter({ hasText: /^12952\s*-/ }).first();
  await option.waitFor({ state: 'visible', timeout: 5000 });
  await option.click();

  const dateField = page.locator('input[type="text"]').nth(1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const results = [];
  for (const offset of [-3, -2, -1, 0, 1, 2, 3, 4, 5, 7, 10, 14, 21, 30, 60, 120]) {
    const target = new Date(today);
    target.setDate(target.getDate() + offset);
    const dateStr = toISO(target);
    const [y, m, d] = dateStr.split('-').map(Number);
    const expected = `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${y}`;

    await dateField.click({ force: true });
    const header = page.locator('button + div, div').filter({ hasText: /^[A-Za-z]+ \d{4}$/ }).first();
    await header.waitFor({ state: 'visible', timeout: 5000 });

    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const prevBtn = page.locator('button').nth(1);
    const nextBtn = page.locator('button').nth(2);
    for (let i = 0; i < 6; i++) {
      const headerText = (await header.textContent() || '').trim();
      const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(headerText);
      const curMonthIndex = MONTHS.indexOf(match[1]);
      const curYear = Number(match[2]);
      const diff = (y * 12 + (m - 1)) - (curYear * 12 + curMonthIndex);
      if (diff === 0) break;
      const btn = diff > 0 ? nextBtn : prevBtn;
      if (await btn.isDisabled()) { console.log(`offset ${offset} (${dateStr}): NEXT-MONTH BUTTON DISABLED`); break; }
      await btn.click();
      await page.waitForTimeout(200);
    }

    const dayButton = page.locator('button', { hasText: new RegExp(`^${d}$`) }).first();
    const dayDisabled = (await dayButton.count()) === 0 || (await dayButton.isDisabled());
    if (dayDisabled) {
      console.log(`offset ${offset} (${dateStr}): DAY BUTTON DISABLED/MISSING`);
      results.push({ offset, ok: false });
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    await dayButton.click({ force: true });
    await page.waitForTimeout(300);
    const okButton = page.getByRole('button', { name: 'OK', exact: true });
    if (await okButton.isVisible().catch(() => false)) {
      await okButton.click({ force: true }).catch(() => {});
      await header.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    }
    const actual = (await dateField.inputValue().catch(() => '')).trim();
    const ok = actual === expected;
    console.log(`offset ${offset} (${dateStr}): expected=${expected} actual=${actual} ${ok ? 'OK' : 'REJECTED'}`);
    results.push({ offset, ok });
    if (!ok) await page.keyboard.press('Escape').catch(() => {});
  }

  const okOffsets = results.filter((r) => r.ok).map((r) => r.offset);
  console.log(`\n>>> Accepted offsets: [${okOffsets.join(', ')}]  min=${Math.min(...okOffsets)} max=${Math.max(...okOffsets)}`);
  await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
