// Drives one herdr-web browser over CDP: type an address in its URL bar + Enter, check the page
// moved and the bar shows it, then Back. Needs a browser already open, e.g. `bin/web` or
// `herdr-web open --pane <id> https://example.com/`.
const { chromium } = require('playwright-core');

const CDP_PORT = Number(process.env.HERDR_WEB_CDP_PORT || 9339);
const TARGET = 'data:text/html,<title>herdr-web-test</title>';

(async () => {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const pages = browser.contexts().flatMap((c) => c.pages());
  const bars = pages.filter((p) => p.url().endsWith('/toolbar.html'));
  const page = pages.find((p) => !p.url().endsWith('/toolbar.html'));
  if (!page) throw new Error('no browser page over CDP; open one first');
  const start = page.url();
  const values = await Promise.all(bars.map((b) => b.inputValue('#u')));
  const bar = bars[values.indexOf(start)];
  if (!bar) throw new Error(`no URL bar showing ${start}`);
  await bar.fill('#u', TARGET);
  await bar.press('#u', 'Enter');
  await page.waitForURL(TARGET, { timeout: 5000 });
  await bar.waitForFunction((t) => document.querySelector('#u').value === t, TARGET);
  console.log('typed + Enter ok:', page.url());
  await bar.click('#b');
  await page.waitForURL(start, { timeout: 5000 });
  await bar.waitForFunction((s) => document.querySelector('#u').value === s, start);
  console.log('back ok:', page.url());
  await browser.close(); // disconnects only; the app keeps running
})().catch((e) => { console.error(e.message); process.exit(1); });
