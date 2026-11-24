const { chromium, devices } = require(process.env.HUB_PLAYWRIGHT || 'playwright');
const run = require('./desktop-bridge-checks');

(async () => {
  const fixture = await require('./browser-fixture')({ list: () => [], hidden: () => new Set() });
  try {
    for (const channel of ['chrome', 'msedge']) {
      const browser = await chromium.launch({
        channel,
        args: ['--no-proxy-server', '--host-resolver-rules=MAP ach-fixture.test 127.0.0.1'],
      });
      try {
        await run(await browser.newPage(), fixture.url, false);
        if (channel === 'chrome') {
          await run(await browser.newPage({ deviceScaleFactor: 2 }), fixture.url, true);
          const mobile = await browser.newPage(devices['Pixel 7']);
          await run(mobile, fixture.url.replace('127.0.0.1', 'ach-fixture.test'), false);
        }
      } finally { await browser.close(); }
    }
    console.log('PASS Chrome, Edge, mobile remote origin, and native bridge adapter');
  } finally { await fixture.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
