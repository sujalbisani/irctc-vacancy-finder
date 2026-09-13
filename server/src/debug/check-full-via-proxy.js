process.env.IRCTC_PROXY_SERVER = 'socks5://10.200.201.2:1080';
const { fetchChart } = require('../lib/irctcChart');

fetchChart('12002', '2026-09-14', 'NDLS')
  .then((r) => {
    console.log('routeCodes:', r.routeCodes.join(','));
    console.log('classes:', r.classes.map((c) => `${c.code}:${c.rows.length}`).join(' '));
    process.exit(0);
  })
  .catch((e) => {
    console.log('ERR', e.code, e.message);
    process.exit(1);
  });
