const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ headless: false });
  const p = await b.newPage();
  try {
    const res = await p.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    console.log('status', res.status());
    await p.screenshot({ path: '/tmp/check.png' });
    const text = await p.evaluate(() => document.body.innerText.slice(0, 800));
    console.log('BODY TEXT:', text);
    const inputCount = await p.locator('input').count();
    console.log('input count:', inputCount);
  } catch (e) {
    console.log('ERR', e.message);
  }
  await b.close();
})();
