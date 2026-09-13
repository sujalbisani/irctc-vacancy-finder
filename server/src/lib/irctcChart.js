const { chromium } = require('playwright');

const BASE_URL = 'https://www.irctc.co.in/online-charts/';
const NAV_TIMEOUT_MS = 30000;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

class ChartError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    // IRCTC's anti-bot layer resets the connection (ERR_HTTP2_PROTOCOL_ERROR)
    // for headless Chromium specifically -- confirmed by testing headless
    // vs headed with otherwise-identical requests. A normal (headed) browser
    // window is required; this needs a display (real or virtual, e.g. Xvfb)
    // wherever this runs.
    browserPromise = chromium.launch({ headless: false });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

function extractCode(text) {
  const m = /\(([A-Z0-9]{2,6})\)\s*$/.exec((text || '').trim());
  return m ? m[1] : null;
}

/** Selects `dateStr` (YYYY-MM-DD) in the MUI date-picker popup opened from the journey-date field. */
async function selectJourneyDate(page, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const targetMonthIndex = m - 1;

  const dateField = page.locator('input[type="text"]').nth(1);
  await dateField.click({ force: true });

  const header = page.locator('button + div, div').filter({ hasText: /^[A-Za-z]+ \d{4}$/ }).first();
  await header.waitFor({ state: 'visible', timeout: 5000 });

  const prevBtn = page.locator('button').nth(1);
  const nextBtn = page.locator('button').nth(2);

  for (let i = 0; i < 24; i++) {
    const headerText = (await header.textContent() || '').trim();
    const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(headerText);
    if (!match) throw new ChartError('DATE_PICKER_UNEXPECTED', `Unexpected calendar header: "${headerText}"`);
    const curMonthIndex = MONTHS.indexOf(match[1]);
    const curYear = Number(match[2]);
    const diff = (y * 12 + targetMonthIndex) - (curYear * 12 + curMonthIndex);
    if (diff === 0) break;
    const btn = diff > 0 ? nextBtn : prevBtn;
    if (await btn.isDisabled()) {
      throw new ChartError('DATE_OUT_OF_RANGE', `IRCTC does not allow selecting ${dateStr} (outside the tool's supported date window).`);
    }
    await btn.click();
    await page.waitForTimeout(200);
  }

  const dayButton = page.locator('button', { hasText: new RegExp(`^${d}$`) }).first();
  if ((await dayButton.count()) === 0 || (await dayButton.isDisabled())) {
    throw new ChartError('DATE_OUT_OF_RANGE', `IRCTC does not allow selecting ${dateStr} (outside the tool's supported date window).`);
  }
  await dayButton.click();
}

/** Selects a train number in the "Train Name/Number" react-select field. */
async function selectTrain(page, trainNumber) {
  const trainField = page.locator('input[type="text"]').nth(0);
  await trainField.click({ force: true });
  await trainField.fill('');
  await trainField.type(String(trainNumber), { delay: 30 });

  const option = page
    .locator('div[id*="-option-"]')
    .filter({ hasText: new RegExp(`^${trainNumber}\\s*-`) })
    .first();
  try {
    await option.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    throw new ChartError('TRAIN_NOT_FOUND', `Train ${trainNumber} was not found in IRCTC's train list.`);
  }
  await option.click();
}

/**
 * Selects `boardingCode` in the "Boarding Station" react-select field and
 * returns the train's ordered route (station codes).
 *
 * Important: IRCTC's "Journey Date" means the date the train started from
 * its own origin, not the date at an arbitrary station. If we forced boarding
 * station = train origin while still passing the *passenger's* boarding date,
 * any train that starts a calendar day (or more) earlier than the requested
 * station would look like "chart not prepared" -- a false negative, not a
 * real unavailability. Selecting the passenger's actual boarding station
 * instead lets IRCTC resolve the correct day/instance itself.
 */
async function selectBoardingStationAndReadRoute(page, boardingCode) {
  const boardingField = page.locator('input[type="text"]').nth(2);
  // A floating placeholder label visually overlaps this input, so a mouse
  // click (even forced) can be swallowed by the label instead of the field.
  // Focus it directly and open the menu with the keyboard instead.
  await boardingField.focus();
  await boardingField.press('ArrowDown');

  const noOptions = page.getByText('No options', { exact: true });
  const anyOption = page.locator('div[id*="-option-"]');

  const result = await Promise.race([
    noOptions.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'none'),
    anyOption.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'has'),
  ]).catch(() => 'timeout');

  if (result !== 'has') {
    if (process.env.IRCTC_DEBUG) {
      await page.screenshot({ path: 'debug-out/boarding-fail.png' }).catch(() => {});
    }
    throw new ChartError(
      'SCHEDULE_UNAVAILABLE',
      `IRCTC did not return a route/schedule for this train and date (result=${result}).`
    );
  }

  const options = page.locator('div[id*="-option-"]');
  const count = await options.count();
  const routeCodes = [];
  let matchIndex = -1;
  for (let i = 0; i < count; i++) {
    const text = await options.nth(i).textContent();
    const code = extractCode(text);
    if (code) routeCodes.push(code);
    if (code === boardingCode) matchIndex = i;
  }

  if (matchIndex === -1) {
    throw new ChartError(
      'BOARDING_STATION_NOT_ON_ROUTE',
      `${boardingCode} is not a boarding option for this train on this date.`
    );
  }

  await options.nth(matchIndex).click();
  return routeCodes;
}

async function submitAndWaitForChart(page) {
  const submitBtn = page.getByRole('button', { name: /get train chart/i });
  await submitBtn.click();

  const maintenance = page.getByText(/maintenance downtime/i);
  // The traincomposition page always renders at least one "CLASS NAME (CODE)" header.
  const classHeader = page.locator('*').filter({ hasText: /^[A-Z0-9 .]+\([A-Z0-9]{1,3}\)$/ }).first();
  const chartNotPrepared = page.getByText(/chart.*not.*prepared/i);

  const outcome = await Promise.race([
    maintenance.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'maintenance'),
    classHeader.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'chart'),
    chartNotPrepared.waitFor({ state: 'visible', timeout: 20000 }).then(() => 'not_prepared'),
  ]).catch(() => 'timeout');

  if (outcome === 'maintenance') {
    throw new ChartError('MAINTENANCE', 'IRCTC online-charts is currently under scheduled maintenance downtime.');
  }
  if (outcome === 'not_prepared') {
    const text = await page.getByText(/chart.*not.*prepared/i).first().textContent();
    throw new ChartError('CHART_NOT_PREPARED', text || 'Chart not prepared yet for this train/date.');
  }
  if (outcome === 'timeout') {
    throw new ChartError('TIMEOUT', 'Timed out waiting for IRCTC to return a chart.');
  }
}

/**
 * Reads the per-class summary on the "traincomposition" page: one header per
 * class (e.g. "CHAIR CAR (CC)") and one "Berth Details" link per class, in
 * the same left-to-right order. Note: the number shown here is *end-to-end*
 * vacancy only -- classes showing 0 can still have partial-segment vacancies,
 * so every class must still be opened via its "Berth Details" link.
 */
async function readClassHeaders(page) {
  const headerLocator = page.locator('*').filter({ hasText: /^[A-Z0-9 .]+\([A-Z0-9]{1,3}\)$/ });
  const count = await headerLocator.count();
  const classes = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const text = (await headerLocator.nth(i).textContent() || '').trim();
    const code = extractCode(text);
    // hasText matches ancestors too; keep only the innermost (leaf) match per code.
    if (!code || seen.has(code)) continue;
    const childCount = await headerLocator.nth(i).locator('*').count();
    if (childCount > 0) continue;
    seen.add(code);
    classes.push({ label: text, code });
  }
  return classes;
}

async function readChartMeta(page) {
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const firstChartMatch = /First Chart Creation:\s*([^\n]+?)(?:\s{2,}|\n|$)/i.exec(bodyText || '');
  const vacantStatusMatch = /Vacant Berth Status\W{0,3}at\s*([^\n]+?)(?:\s{2,}|\n|$)/i.exec(bodyText || '');
  return {
    firstChartCreation: firstChartMatch ? firstChartMatch[1].trim() : null,
    chartStatusAt: vacantStatusMatch ? vacantStatusMatch[1].trim() : null,
    fetchedAt: new Date().toISOString(),
  };
}

/** Reads the rows currently visible in the "Vacant Berth Details" table (one page of results). */
async function readVisibleTableRows(page) {
  const trs = page.locator('table tbody tr');
  const trCount = await trs.count();
  const rows = [];
  for (let i = 0; i < trCount; i++) {
    const tds = trs.nth(i).locator('td');
    const tdCount = await tds.count();
    if (tdCount < 4) continue;
    const texts = [];
    for (let c = 0; c < tdCount; c++) {
      texts.push((await tds.nth(c).textContent() || '').trim());
    }
    rows.push(texts);
  }
  return rows;
}

/**
 * Reads the full "Vacant Berth Details" table for the class page currently
 * open, paging through IRCTC's MUI table pagination (default 10 rows/page --
 * bumped to 50 to minimise page count) until every row has been collected.
 */
async function readAllVacantBerthRows(page) {
  await page.getByText('Vacant Berth Details', { exact: false }).first().waitFor({ timeout: 10000 }).catch(() => {});

  // Bump rows-per-page to the max (50) if the control is present.
  try {
    const rowsPerPageControl = page.locator('div[role="button"][aria-haspopup="true"]').first();
    if (await rowsPerPageControl.count()) {
      await rowsPerPageControl.click();
      const option50 = page.locator('[role="option"]', { hasText: /^50$/ });
      if (await option50.count()) {
        await option50.click();
        await page.waitForTimeout(300);
      } else {
        await page.keyboard.press('Escape');
      }
    }
  } catch {
    // Non-fatal -- fall back to whatever page size is already set.
  }

  const allRows = [];
  for (let page_i = 0; page_i < 200; page_i++) {
    const pageRows = await readVisibleTableRows(page);
    allRows.push(...pageRows);

    const nextBtn = page.locator('button').filter({ hasText: 'chevron_right' }).first();
    if ((await nextBtn.count()) === 0) break;
    if (await nextBtn.isDisabled()) break;
    await nextBtn.click();
    await page.waitForTimeout(250);
  }

  return allRows
    .filter((cells) => cells.length >= 4)
    .map((cells) => ({
      fromStationText: cells[0],
      toStationText: cells[1],
      coach: cells[2],
      berthNo: cells[3],
      berthType: cells[4] || null,
      cabin: cells[5] || null,
      cabinNo: cells[6] || null,
      fromStationCode: extractCode(cells[0]),
      toStationCode: extractCode(cells[1]),
    }))
    .filter((r) => r.fromStationCode && r.toStationCode);
}

/**
 * Fetches the live IRCTC reservation chart for one train/date/boarding
 * station. `dateStr` is the passenger's boarding date at `boardingCode` --
 * IRCTC resolves the correct underlying trip instance (and its true origin
 * start date) once the boarding station is selected, so callers don't need
 * to compute day-offsets themselves. Returns
 * { routeCodes, chartMeta, classes: [{code, label, rows}] }.
 */
async function fetchChart(trainNumber, dateStr, boardingCode) {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);

  try {
    try {
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    } catch (navErr) {
      throw new ChartError('SITE_UNAVAILABLE', `Could not reach IRCTC online-charts: ${navErr.message.split('\n')[0]}`);
    }

    const maintenanceBanner = page.getByText(/maintenance downtime/i);
    if (await maintenanceBanner.count()) {
      throw new ChartError('MAINTENANCE', 'IRCTC online-charts is currently under scheduled maintenance downtime.');
    }

    await selectTrain(page, trainNumber);
    await selectJourneyDate(page, dateStr);
    const routeCodes = await selectBoardingStationAndReadRoute(page, boardingCode);
    await submitAndWaitForChart(page);

    const chartMeta = await readChartMeta(page);
    const classHeaders = await readClassHeaders(page);
    if (classHeaders.length === 0) {
      throw new ChartError('NO_CLASSES_FOUND', 'IRCTC returned a chart page but no class/berth data could be parsed from it.');
    }

    // Two page layouts exist for the post-submit screen: one lists each class
    // with an "N(Berth Details)" link; the other renders the class header
    // itself as a directly-clickable button with no separate link at all.
    const hasBerthDetailsLinks = (await page.getByText('Berth Details', { exact: true }).count()) > 0;

    const classes = [];
    for (let i = 0; i < classHeaders.length; i++) {
      const urlBefore = page.url();
      if (hasBerthDetailsLinks) {
        await page.getByText('Berth Details', { exact: true }).nth(i).click();
      } else {
        await page.getByRole('button', { name: classHeaders[i].label }).click();
      }

      // A class with zero vacant berths shows a "No Record Found" toast and
      // stays on this same page instead of navigating -- must not treat that
      // as a real navigation, or the next class's button would never be found.
      const noRecordToast = page.getByText('No Record Found', { exact: false });
      const waitForNavigation = (async () => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (page.url() !== urlBefore) return 'navigated';
          await page.waitForTimeout(150);
        }
        return 'timeout';
      })();

      const outcome = await Promise.race([
        noRecordToast.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'no_record'),
        waitForNavigation,
      ]).catch(() => 'timeout');

      let rows = [];
      if (outcome === 'navigated') {
        rows = await readAllVacantBerthRows(page);
        await page.goBack({ waitUntil: 'domcontentloaded' });
      } else {
        // 'no_record' or 'timeout' -- either way we're still on this page.
        await page.waitForTimeout(500);
      }
      classes.push({ code: classHeaders[i].code, label: classHeaders[i].label, rows });
    }

    return { routeCodes, chartMeta, classes };
  } finally {
    await context.close();
  }
}

module.exports = { fetchChart, closeBrowser, ChartError };
