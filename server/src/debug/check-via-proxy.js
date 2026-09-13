const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ headless: false });
  const context = await b.newContext({ proxy: { server: 'socks5://10.200.201.2:1080' } });
  const p = await context.newPage();
  try {
    const res = await p.goto('https://www.irctc.co.in/online-charts/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('status', res.status());
    const inputCount = await p.locator('input').count();
    console.log('input count:', inputCount);
  } catch (e) {
    console.log('ERR', e.message);
  }
  await b.close();
})();
