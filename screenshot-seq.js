const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1400 } });
  await page.goto('http://localhost:4321/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/seq-queue.png', fullPage: true });

  const rows = await page.$$('tbody tr');
  if (rows.length) {
    await rows[0].click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/seq-detail.png', fullPage: true });
  }
  await browser.close();
})();
