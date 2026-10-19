// herdr-web app: one frameless Chromium window per browser id, placed over a
// herdr pane, controlled over HTTP on 127.0.0.1 and over CDP for Playwright.
const { app, BrowserWindow, WebContentsView } = require('electron');
const net = require('net');
const { execFile, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CONTROL_PORT = Number(process.env.HERDR_WEB_PORT || 9338);
const CDP_PORT = Number(process.env.HERDR_WEB_CDP_PORT || 9339);
const HERDR = process.env.HERDR_BIN || 'herdr'; // found on PATH unless set
const FALLBACK_POLL_MS = 1000; // events and hostwatch drive placement; this only catches misses
const SLEEP_AFTER_MS = Number(process.env.HERDR_WEB_SLEEP_AFTER_MS || 60000); // a page hidden this long is closed to free its renderer, reopened when shown
const HERDR_SOCK = process.env.HERDR_SOCKET_PATH || path.join(process.env.HOME, '.config/herdr/herdr.sock');

app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
// Same-site pages share one renderer: less memory, but one crash takes down every page of that site.
app.commandLine.appendSwitch('process-per-site');

const browsers = new Map(); // id -> { paneId, win, view, page, hiddenAt, asleep, lock }
let host = null; // { clientPid, tty, appPid }
let screen = { front: 0, wins: [], grid: [] };
let watcher = null;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, out) => resolve(err ? '' : out));
  });
}

/** Finds the attached herdr client, its tty and the GUI app that hosts it. */
async function findHost() {
  const rows = (await run('/bin/ps', ['-axo', 'pid=,ppid=,tty=,comm='])).trim().split('\n')
    .map((l) => l.trim().split(/\s+/)).map(([pid, ppid, tty, ...c]) => ({ pid: +pid, ppid: +ppid, tty, comm: c.join(' ') }));
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const client = rows.find((r) => /(^|\/)herdr$/.test(r.comm) && r.tty !== '??');
  if (!client) return null;
  for (let p = byPid.get(client.ppid); p; p = byPid.get(p.ppid)) {
    if (p.comm.includes('.app/Contents/MacOS/')) return { clientPid: client.pid, tty: `/dev/${client.tty}`, appPid: p.pid };
  }
  return null;
}

function restartWatcher() {
  if (watcher) watcher.kill();
  watcher = spawn(path.join(__dirname, 'bin/hostwatch'), [host.tty], { stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = '';
  watcher.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    if (lines.length) { screen = JSON.parse(lines[lines.length - 1]); schedulePlace(); }
  });
}

/** Pixel rect of a pane in screen points, or null when it should be hidden. */
function paneRect(paneId, layout) {
  const pane = layout.panes.find((p) => p.pane_id === paneId);
  if (!pane || (layout.zoomed && layout.focused_pane_id !== paneId)) return null;
  if (![host.appPid, process.pid].includes(screen.front)) return null;
  const hostWin = screen.wins.find(([pid, , , w, h]) => pid === host.appPid && w > 200 && h > 100);
  if (!hostWin || screen.grid.length !== 4) return null;
  const [, wx, wy, ww, wh] = hostWin;
  const [rows, cols, xpx, ypx] = screen.grid;
  // ponytail: Ghostty reports grid pixels at 2x, Terminal in points; assumes a 2x display.
  const scale = xpx > ww ? 2 : 1;
  const gw = xpx / scale, gh = ypx / scale, pad = (ww - gw) / 2;
  const gx = wx + pad, gy = wy + wh - gh - pad; // grid sits at the bottom, title bar above
  const cw = gw / cols, ch = gh / rows;
  // ponytail: sidebar on the left and tab bar on top (herdr defaults); read config.toml if changed.
  const offX = cols - layout.area.width, offY = rows - layout.area.height;
  const r = pane.rect;
  return {
    x: Math.round(gx + (offX + r.x) * cw), y: Math.round(gy + (offY + r.y) * ch),
    width: Math.round(r.width * cw), height: Math.round(r.height * ch),
  };
}

let placing = false;
let placeAgain = false;

/** Runs place() now, or once more right after the current run, never in parallel. */
async function schedulePlace() {
  if (placing) { placeAgain = true; return; }
  placing = true;
  try { await place(); } finally { placing = false; }
  if (placeAgain) { placeAgain = false; schedulePlace(); }
}

/** Re-places on every herdr tab, workspace or layout change, so switching tabs needs no poll. */
function subscribeHerdr() {
  const sock = net.connect(HERDR_SOCK);
  sock.on('connect', () => sock.write(`${JSON.stringify({
    id: 'herdr-web', method: 'events.subscribe',
    params: { subscriptions: ['tab.focused', 'workspace.focused', 'layout.updated', 'pane.focused'].map((type) => ({ type })) },
  })}\n`));
  sock.on('data', schedulePlace);
  sock.on('error', () => {});
  sock.on('close', () => setTimeout(subscribeHerdr, 2000));
}

/** Closes every browser whose herdr pane no longer exists; keeps all of them when herdr cannot be asked. */
async function closeOrphans() {
  const out = await run(HERDR, ['pane', 'list']);
  if (!out) return;
  const live = new Set(JSON.parse(out).result.panes.map((p) => p.pane_id));
  for (const b of browsers.values()) if (!live.has(b.paneId)) b.win.destroy();
}

async function place() {
  if (!browsers.size) return;
  await closeOrphans();
  const out = await run(HERDR, ['pane', 'layout']);
  const layout = out ? JSON.parse(out).result.layout : null;
  for (const b of browsers.values()) {
    const { paneId, win } = b;
    if (win.isDestroyed()) continue;
    const rect = layout && host ? paneRect(paneId, layout) : null;
    if (!rect) {
      // Opacity 0 first: macOS fades an ordered-out window over ~300 ms, this makes it vanish at once.
      if (win.isVisible()) { win.setOpacity(0); win.hide(); }
      b.hiddenAt = b.hiddenAt || Date.now();
      if (!b.asleep && Date.now() - b.hiddenAt > SLEEP_AFTER_MS) sleepPage(b);
      continue;
    }
    b.hiddenAt = 0;
    if (b.asleep) wakePage(b);
    const bounds = win.getBounds();
    if (bounds.x !== rect.x || bounds.y !== rect.y || bounds.width !== rect.width || bounds.height !== rect.height) win.setBounds(rect);
    if (!win.isVisible()) { win.showInactive(); win.setOpacity(1); }
  }
}

async function refreshHost() {
  const h = await findHost();
  if (h && (!host || h.tty !== host.tty || h.appPid !== host.appPid)) { host = h; restartWatcher(); }
  if (!h) host = null;
}

const TOOLBAR_PX = 30; // must match the body height in toolbar.html

function layoutPage(win, view) {
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: TOOLBAR_PX, width: w, height: Math.max(0, h - TOOLBAR_PX) });
}

/** Puts a new page view under the toolbar and runs load(page) on it. */
function attachPage(b, load) {
  b.view = new WebContentsView();
  b.win.contentView.addChildView(b.view);
  layoutPage(b.win, b.view);
  b.page = b.view.webContents;
  const showUrl = () => b.win.webContents.send('url', b.page.getURL());
  b.page.on('did-navigate', showUrl);
  b.page.on('did-navigate-in-page', showUrl);
  return load(b.page);
}

/** Runs fn after any sleep or wake already running for this browser. */
function serial(b, fn) {
  b.lock = b.lock.then(fn, fn);
  return b.lock;
}

/** Closes a hidden page to free its renderer, keeping its history and scroll position. */
function sleepPage(b) {
  return serial(b, async () => {
    if (b.asleep || !b.hiddenAt) return;
    const scroll = await b.page.executeJavaScript('[scrollX, scrollY]').catch(() => [0, 0]);
    const history = b.page.navigationHistory;
    b.asleep = { entries: history.getAllEntries(), index: history.getActiveIndex(), scroll };
    b.win.contentView.removeChildView(b.view);
    b.page.close();
  });
}

/** Reopens a sleeping page at the same history entry and scroll position. */
function wakePage(b) {
  return serial(b, async () => {
    if (!b.asleep) return;
    const started = Date.now();
    const { entries, index, scroll } = b.asleep;
    b.asleep = null;
    if (b.hiddenAt) b.hiddenAt = Date.now(); // woken by a command while hidden: a fresh 60 s before it sleeps again
    await attachPage(b, (page) => page.navigationHistory.restore({ entries, index })).catch(() => {});
    await b.page.executeJavaScript(`scrollTo(${scroll[0]}, ${scroll[1]})`).catch(() => {});
    console.log(`woke ${b.id} in ${Date.now() - started} ms`);
  });
}

function openBrowser(id, paneId, url) {
  const win = new BrowserWindow({
    // Not resizable: macOS takes clicks a few points outside a resizable window for its resize edge,
    // which swallowed clicks on herdr's tab bar row just above the pane.
    resizable: false, movable: false, frame: false, show: false, hasShadow: false, skipTaskbar: true, width: 400, height: 300, enableLargerThanScreen: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  win.setAlwaysOnTop(true, 'floating'); // only ever shown while the host app is frontmost
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Our own local toolbar (never remote content), so node access is safe; a file so all toolbars share one renderer.
  win.loadFile(path.join(__dirname, 'toolbar.html'));
  const b = { id, paneId, win, hiddenAt: 0, asleep: null, lock: Promise.resolve() };
  attachPage(b, (page) => page.loadURL(url).catch(() => {}));
  win.on('resize', () => layoutPage(win, b.view));
  win.webContents.on('did-finish-load', () => win.webContents.send('url', currentUrl(b)));
  win.webContents.on('ipc-message', async (_e, channel, action, value) => {
    if (channel !== 'nav') return;
    const page = await awakePage(b);
    if (action === 'b' && page.navigationHistory.canGoBack()) page.navigationHistory.goBack();
    if (action === 'f' && page.navigationHistory.canGoForward()) page.navigationHistory.goForward();
    if (action === 'r') page.reload();
    if (action === 'go' && value) page.loadURL(/^[a-z]+:/i.test(value) ? value : `http://${value}`);
  });
  win.on('closed', () => {
    browsers.delete(id);
    if (!b.asleep && !b.page.isDestroyed()) b.page.close(); // a child view's page outlives its window
  });
  browsers.set(id, b);
}

/** The page URL, also while the page sleeps. */
function currentUrl(b) {
  return b.asleep ? b.asleep.entries[b.asleep.index].url : b.page.getURL();
}

/** The browser's page, woken first if it was asleep. */
async function awakePage(b) {
  await wakePage(b);
  return b.page;
}

function nextId() {
  let n = 1;
  while (browsers.has(`b${n}`)) n += 1;
  return `b${n}`;
}

const commands = {
  async open({ pane, id, url }) {
    if (!pane || !url) throw new Error('open needs pane and url');
    const bid = id || nextId();
    if (browsers.has(bid)) throw new Error(`browser ${bid} exists`);
    openBrowser(bid, pane, url);
    return { id: bid, pane };
  },
  async goto({ id, url }) { const p = await page(id); await p.loadURL(url); return { id, url: p.getURL() }; },
  async eval({ id, js }) { return { value: await (await page(id)).executeJavaScript(js, true) }; },
  async screenshot({ id, out }) {
    const img = await (await page(id)).capturePage();
    fs.writeFileSync(out, img.toPNG());
    return { out };
  },
  async list() {
    return [...browsers].map(([bid, b]) => ({
      id: bid, pane: b.paneId, url: currentUrl(b), visible: b.win.isVisible(), asleep: !!b.asleep, bounds: b.win.getBounds(),
    }));
  },
  async close({ id }) { pick(id).win.destroy(); return { closed: id }; },
  async 'cdp-url'() { return { url: `http://127.0.0.1:${CDP_PORT}` }; },
  async quit() { setTimeout(() => app.quit(), 50); return { quitting: true }; },
};

function pick(id) {
  const b = browsers.get(id || [...browsers.keys()][0]);
  if (!b) throw new Error(`no browser ${id || ''}`.trim());
  return b;
}

function page(id) { return awakePage(pick(id)); }

function serve() {
  http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const name = req.url.slice(1);
      try {
        if (!commands[name]) throw new Error(`unknown command ${name}`);
        res.end(JSON.stringify({ ok: true, result: await commands[name](body ? JSON.parse(body) : {}) }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
  }).listen(CONTROL_PORT, '127.0.0.1');
}

app.on('window-all-closed', () => {}); // keep running with zero browsers
app.on('will-quit', () => { if (watcher) watcher.kill(); });
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  serve();
  await refreshHost();
  setInterval(refreshHost, 2000);
  subscribeHerdr();
  setInterval(schedulePlace, FALLBACK_POLL_MS);
});
