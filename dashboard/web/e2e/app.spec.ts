// End-to-end tests, one per scenario in re/BEHAVIOR_SPEC.md (ids B1..B41).
import { expect, test, type Page } from '@playwright/test';

type Snapshot = {
  symbol: string; timeframe: string; source: string; nBars: number; firstTime: number; lastTime: number; chartType: string;
  studies: { uid: string; id: string; inputs: Record<string, unknown>; pane: number }[]; panes: number;
  drawings: { id: string; type: string; points: { time: number; price: number }[] }[]; tool: string; selected: string | null;
  grid: string; active: number; charts: number; times: number[];
};

async function snap(page: Page, i?: number): Promise<Snapshot> {
  return page.evaluate(idx => {
    const a = (window as any).app;
    const v = idx === undefined ? a.view : a.charts[idx];
    return {
      symbol: v.symbol, timeframe: v.timeframe, source: v.source, nBars: v.bars.length, chartType: v.chartType,
      firstTime: v.bars[0]?.time, lastTime: v.bars[v.bars.length - 1]?.time, times: v.bars.slice(-30).map((b: any) => b.time),
      studies: v.studies.map((s: any) => ({ uid: s.uid, id: s.id, inputs: s.inputs, pane: s.pane })),
      panes: v.chart.panes().length,
      drawings: v.drawingLayer.drawings.map((d: any) => ({ id: d.id, type: d.type, points: d.points })),
      tool: v.drawingLayer.tool, selected: v.drawingLayer.selected,
      grid: a.grid, active: a.active, charts: a.charts.length,
    };
  }, i);
}

async function ready(page: Page, symbol?: string) {
  await expect.poll(async () => page.evaluate(sym => {
    const v = (window as any).app?.view;
    return !!v && !v.loading && v.bars.length > 0 && (!sym || v.symbol === sym);
  }, symbol), { timeout: 30_000 }).toBe(true);
}

const DEFAULT_WATCHLIST = ['###CN ETFS', 'SSE:510300', 'SSE:510500', 'SZSE:159915', 'SSE:588000', '###US STOCKS', 'NASDAQ:AAPL',
  'NASDAQ:NVDA', 'NASDAQ:QQQ', 'AMEX:SPY', '###CRYPTO', 'BINANCE:BTCUSDT'];
const RUN = 'mom_12_1_(masked)';

/** Every test starts from a clean server state (the e2e server has its own temp DB). */
async function resetServer(page: Page) {
  const r = page.request;
  for (const l of await (await r.get('/api/layouts')).json()) await r.delete(`/api/layouts/${l.id}`);
  for (const a of await (await r.get('/api/alerts')).json()) await r.delete(`/api/alerts/${a.id}`);
  for (const u of (await (await r.get('/api/strategies')).json()).user) await r.delete(`/api/strategies/scripts/${u.id}`);
  const wls = await (await r.get('/api/watchlists')).json();
  for (const w of wls.slice(1)) await r.delete(`/api/watchlists/${w.id}`);
  await r.patch(`/api/watchlists/${wls[0].id}`, { data: { name: 'Watchlist', symbols: DEFAULT_WATCHLIST } });
  for (const k of ['last_layout', 'chart_props', 'indicator_templates', 'autosave']) await r.put(`/api/settings/${k}`, { data: { value: null } });
}

/** Main-pane box of the active chart (excludes price axis and time axis). */
async function paneBox(page: Page, cell = 0) {
  const host = page.locator('.chart-host').nth(cell);
  const b = (await host.boundingBox())!;
  return { x: b.x, y: b.y, w: b.width - 70, h: b.height - 30, at(fx: number, fy: number) { return { x: b.x + (b.width - 70) * fx, y: b.y + (b.height - 30) * fy }; } };
}

async function pointAt(page: Page, abs: { x: number; y: number }, cell = 0) {
  const b = (await page.locator('.chart-host').nth(cell).boundingBox())!;
  return page.evaluate(({ x, y, cell }) => (window as any).app.charts[cell].drawingLayer.pointAt({ x, y }), { x: abs.x - b.x, y: abs.y - b.y, cell });
}

async function pickInterval(page: Page, tf: string) {
  await page.locator('#interval-btn').click();
  await page.locator(`[data-menu="interval"] [data-id="${tf}"]`).click();
  await expect.poll(async () => (await snap(page)).timeframe).toBe(tf);
  await ready(page);
}

async function flyoutPick(page: Page, group: string, label: string) {
  await page.locator(`.dt-item[data-item="${group}"]`).hover();
  await page.locator(`[data-more="${group}"]`).click();
  await page.locator(`[data-menu="flyout-${group}"] .menu-row`, { hasText: label }).first().click();
}

async function openRun(page: Page, query = RUN) {
  await page.locator('#rightbar [data-page="strategy"]').click();
  await expect(page.locator('#dock')).toBeVisible();
  const id = await page.evaluate(async q => (await fetch(`/api/backtest/runs?q=${encodeURIComponent(q)}`).then(r => r.json()))[0].id, query);
  await page.locator('#dock .dk-tab [data-a="runs"]').click();
  await page.locator('[data-dialog="runs"] input.search').fill(query);
  await page.locator(`[data-dialog="runs"] .run-row[data-run="${id}"]`).click();
  await expect(page.locator('#dock [data-keystats]')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(async rid => ({ id: rid, report: await fetch(`/api/backtest/report/${rid}`).then(r => r.json()) }), id);
}

test.beforeEach(async ({ page }) => {
  await resetServer(page);
  await page.goto('/');
  await ready(page);
});

// ------------------------------------------------------------------------------------- symbols & intervals
test('B1 symbol by typing keeps studies', async ({ page }) => {
  await page.keyboard.press('/');
  await page.keyboard.type('EMA');
  await page.keyboard.press('Enter');
  await page.locator('.chart-host').first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.type('AAPL', { delay: 50 });
  const dlg = page.locator('[data-dialog="symbol-search"]');
  await expect(dlg.locator('input')).toHaveValue('AAPL');
  await expect(dlg.locator('.results > div').first()).toBeVisible();
  await page.keyboard.press('Enter');
  await ready(page, 'NASDAQ:AAPL');
  await expect(page.locator('#symbol-label')).toHaveText('AAPL');
  await expect(page.locator('#symbol-btn')).toHaveAttribute('data-symbol', 'NASDAQ:AAPL');
  await expect(page.locator('.legend-title').first()).toHaveAttribute('title', 'NASDAQ:AAPL');
  await expect(page.locator('.legend-title').first()).toContainText('Apple');
  expect((await snap(page)).studies.map(s => s.id)).toEqual(['EMA']);
});

test('B2 interval by typing digits + Enter', async ({ page }) => {
  await page.locator('.chart-host').first().click({ position: { x: 300, y: 300 } });
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await snap(page)).timeframe).toBe('5');
  await ready(page);
  const s = await snap(page);
  const gaps = s.times.slice(1).map((t, i) => t - s.times[i]);
  expect(gaps.filter(g => g === 300).length).toBeGreaterThan(gaps.length / 2);
  await expect(page.locator('#interval-label')).toHaveText('5m');
  await page.keyboard.type('1D');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await snap(page)).timeframe).toBe('D');
});

test('B3 weekly from the interval menu: Monday-stamped bars, toolbar shows W', async ({ page }) => {
  await page.locator('#interval-btn').click();
  const menu = page.locator('[data-menu="interval"]');
  await expect(menu).toContainText('Minutes');
  await expect(menu.locator('[data-id="D"]')).toHaveClass(/selected/);
  await menu.locator('[data-id="W"]').click();
  await expect.poll(async () => (await snap(page)).timeframe).toBe('W');
  await ready(page);
  for (const t of (await snap(page)).times) expect(new Date(t * 1000).getUTCDay()).toBe(1);
  await expect(page.locator('#interval-label')).toHaveText('W');
});

test('B4 state persists across reload', async ({ page }) => {
  await pickInterval(page, 'W');
  await page.keyboard.press('/');
  await page.keyboard.type('RSI');
  await page.keyboard.press('Enter');
  const box = await paneBox(page);
  const p = box.at(0.5, 0.3);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('Alt+KeyH');
  const before = await snap(page);
  expect(before.drawings).toHaveLength(1);
  await page.waitForFunction(() => document.body.dataset.saved);
  await page.waitForTimeout(800);
  await page.reload();
  await ready(page);
  const after = await snap(page);
  expect(after.timeframe).toBe('W');
  expect(after.studies.map(s => s.id)).toEqual(['RSI']);
  expect(after.drawings.map(d => d.points)).toEqual(before.drawings.map(d => d.points));
});

test('B5 scroll-back loads older history', async ({ page }) => {
  const s0 = await snap(page);
  await page.evaluate(() => (window as any).app.view.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 80 }));
  await expect.poll(async () => (await snap(page)).nBars, { timeout: 20_000 }).toBeGreaterThan(s0.nBars);
  const s1 = await snap(page);
  expect(s1.firstTime).toBeLessThan(s0.firstTime);
  expect(s1.lastTime).toBe(s0.lastTime);
});

// ------------------------------------------------------------------------------------- studies
test('B6 add RSI: own pane, legend value equals reference', async ({ page }) => {
  const panes0 = (await snap(page)).panes;
  await page.keyboard.press('/');
  await expect(page.locator('[data-dialog="indicators"]')).toBeVisible();
  await page.keyboard.type('Relative');
  await page.keyboard.press('Enter');
  const s = await snap(page);
  expect(s.studies.map(x => x.id)).toEqual(['RSI']);
  expect(s.panes).toBe(panes0 + 1);
  const row = page.locator('.legend-row[data-study="RSI"]');
  await expect(row).toContainText('RSI 14 close');
  // reference: server-side Python implementation on the same bars
  const ref = await page.evaluate(async () => {
    const v = (window as any).app.view;
    const r = await fetch(`/api/indicator?symbol=${encodeURIComponent(v.symbol)}&type=RSI&count=${v.bars.length}&source=${v.source}`).then(x => x.json());
    return { server: r.values.rsi.at(-1), client: v.studyValues(v.studies[0]).rsi, sameLast: r.time.at(-1) === v.bars.at(-1).time };
  });
  if (ref.sameLast) expect(Math.abs(ref.client - ref.server)).toBeLessThan(1e-6);
  await expect(row).toContainText(ref.client.toFixed(2));
});

test('B7 edit, hide and remove a study from the legend', async ({ page }) => {
  await page.evaluate(() => (window as any).app.view.addStudy('RSI'));
  const v0 = await page.evaluate(() => { const v = (window as any).app.view; return v.studyValues(v.studies[0]).rsi; });
  const row = page.locator('.legend-row[data-study="RSI"]');
  await row.hover();
  await row.locator('[data-act="settings"]').click();
  const dlg = page.locator('[data-dialog="study-settings"]');
  await dlg.locator('[name="length"]').fill('21');
  await dlg.locator('[data-ok]').click();
  await expect(row).toContainText('RSI 21 close');
  const v1 = await page.evaluate(() => { const v = (window as any).app.view; return v.studyValues(v.studies[0]).rsi; });
  expect(v1).not.toBeCloseTo(v0, 6);
  await row.hover();
  await row.locator('[data-act="toggle"]').click();
  await expect(row).toHaveClass(/hidden-study/);
  expect(await page.evaluate(() => (window as any).app.view.studies[0].visible)).toBe(false);
  const panes = (await snap(page)).panes;
  await row.hover();
  await row.locator('[data-act="remove"]').click();
  const s = await snap(page);
  expect(s.studies).toHaveLength(0);
  expect(s.panes).toBe(panes - 1);
});

test('B8 overlay study stays on the price pane', async ({ page }) => {
  const panes0 = (await snap(page)).panes;
  await page.evaluate(() => (window as any).app.view.addStudy('EMA', { length: 20 }));
  const s = await snap(page);
  expect(s.panes).toBe(panes0);
  expect(s.studies[0].pane).toBe(0);
});

// ------------------------------------------------------------------------------------- drawings
test('B9 Alt+H horizontal line at cursor price; Delete removes', async ({ page }) => {
  const box = await paneBox(page);
  const p = box.at(0.6, 0.35);
  await page.mouse.move(p.x, p.y);
  const expected = await pointAt(page, p);
  await page.keyboard.press('Alt+KeyH');
  let s = await snap(page);
  expect(s.drawings).toHaveLength(1);
  expect(s.drawings[0].type).toBe('hline');
  expect(s.drawings[0].points[0].price).toBeCloseTo(expected.price, 6);
  expect(s.selected).toBe(s.drawings[0].id);
  await page.keyboard.press('Delete');
  s = await snap(page);
  expect(s.drawings).toHaveLength(0);
});

test('B10 trend line: two clicks, tool resets to cursor', async ({ page }) => {
  await page.locator('#drawbar [data-main="trend"]').click();
  const box = await paneBox(page);
  const a = box.at(0.3, 0.6), b = box.at(0.7, 0.3);
  const pa = await pointAt(page, a), pb = await pointAt(page, b);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  const s = await snap(page);
  expect(s.drawings).toHaveLength(1);
  expect(s.drawings[0].type).toBe('trend');
  expect(s.drawings[0].points[0].price).toBeCloseTo(pa.price, 6);
  expect(s.drawings[0].points[1].price).toBeCloseTo(pb.price, 6);
  expect(Math.abs(s.drawings[0].points[0].time - pa.time)).toBeLessThan(86400);
  expect(s.tool).toBe('cursor');
  await expect(page.locator('#drawbar [data-main="cursors"]')).toHaveClass(/active/);
});

test('B11 drag body moves both anchors; drag anchor moves one', async ({ page }) => {
  await page.locator('#drawbar [data-main="trend"]').click();
  const box = await paneBox(page);
  const a = box.at(0.3, 0.6), b = box.at(0.6, 0.3);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  const d0 = (await snap(page)).drawings[0];
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 60, mid.y + 40, { steps: 8 });
  await page.mouse.up();
  const d1 = (await snap(page)).drawings[0];
  const dp0 = d1.points[0].price - d0.points[0].price, dp1 = d1.points[1].price - d0.points[1].price;
  const dt0 = d1.points[0].time - d0.points[0].time, dt1 = d1.points[1].time - d0.points[1].time;
  expect(dp0).toBeLessThan(0);
  expect(dp0).toBeCloseTo(dp1, 6);
  expect(dt0).toBeGreaterThan(0);
  expect(Math.abs(dt0 - dt1)).toBeLessThan(86400 * 3);
  const b2 = { x: b.x + 60, y: b.y + 40 };
  await page.mouse.move(b2.x, b2.y);
  await page.mouse.down();
  await page.mouse.move(b2.x, b2.y - 80, { steps: 8 });
  await page.mouse.up();
  const d2 = (await snap(page)).drawings[0];
  expect(d2.points[0]).toEqual(d1.points[0]);
  expect(d2.points[1].price).toBeGreaterThan(d1.points[1].price);
});

test('B12 fib: level 0 at second anchor, 1 at first', async ({ page }) => {
  await page.keyboard.press('Alt+KeyF');
  const box = await paneBox(page);
  const a = box.at(0.35, 0.7), b = box.at(0.65, 0.25);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
  const lv = await page.evaluate(async () => {
    const v = (window as any).app.view;
    const d = v.drawingLayer.drawings[0];
    const { fibPrices } = await import('/src/drawings/model.ts');
    return { d, levels: fibPrices(d) };
  });
  expect(lv.d.type).toBe('fib');
  const at = (l: number) => lv.levels.find((x: any) => x.level === l).price;
  expect(at(0)).toBeCloseTo(lv.d.points[1].price, 9);
  expect(at(1)).toBeCloseTo(lv.d.points[0].price, 9);
  expect(at(0.618)).toBeCloseTo(lv.d.points[1].price + 0.618 * (lv.d.points[0].price - lv.d.points[1].price), 9);
});

test('B13 drawings belong to their symbol and survive interval change', async ({ page }) => {
  const box = await paneBox(page);
  const p = box.at(0.5, 0.4);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('Alt+KeyH');
  const sym = (await snap(page)).symbol;
  await page.evaluate(() => (window as any).app.view.load('SSE:510500'));
  await ready(page, 'SSE:510500');
  expect((await snap(page)).drawings).toHaveLength(0);
  await page.evaluate(s => (window as any).app.view.load(s), sym);
  await ready(page, sym);
  expect((await snap(page)).drawings).toHaveLength(1);
  await pickInterval(page, 'W');
  expect((await snap(page)).drawings).toHaveLength(1);
});

// ------------------------------------------------------------------------------------- alerts
test('B14 + B15 alert: create, fire on check, once deactivates', async ({ page }) => {
  const box = await paneBox(page);
  const p = box.at(0.5, 0.4);
  await page.mouse.click(p.x, p.y);
  const cross = await pointAt(page, p);
  await page.keyboard.press('Alt+KeyA');
  const dlg = page.locator('[data-dialog="alert"]');
  await expect(dlg).toBeVisible();
  expect(Number(await dlg.locator('[name="value"]').inputValue())).toBeCloseTo(cross.price, 3);
  await expect(dlg.locator('[name="message"]')).toHaveValue(/^510300 Crossing \d/);
  const exp = Date.parse(await dlg.locator('[name="expires"]').inputValue());
  expect(Math.abs(exp - (Date.now() + 30 * 86400000))).toBeLessThan(86400000);
  const last = await page.evaluate(() => (window as any).app.view.bars.at(-1).close);
  await dlg.locator('[name="op"]').selectOption('greater_than');
  await dlg.locator('[name="value"]').fill(String(last * 0.5));      // already true on the current bar
  await dlg.locator('[data-ok]').click();
  await page.locator('#rightbar [data-page="alerts"]').click();
  const pageEl = page.locator('[data-p="alerts"]');
  await expect(pageEl).toContainText(/greater than/i);
  const checked = page.waitForResponse(r => r.url().endsWith('/api/alerts/check'));
  await pageEl.locator('[data-check]').click();
  expect((await (await checked).json()).fired).toHaveLength(1);
  await expect(page.locator('.toast').filter({ hasText: 'Checked alerts: 1 fired' })).toBeVisible();
  await pageEl.locator('[data-tab="log"]').click();
  await expect(pageEl.locator('.log')).toContainText(/510300 Greater than [0-9.]+/);
  await expect(pageEl.locator('[data-tab="alerts"]')).not.toHaveClass(/active/);
  const alerts = await page.evaluate(() => fetch('/api/alerts').then(r => r.json()));
  expect(alerts[0].active).toBe(false);
});

// ------------------------------------------------------------------------------------- layout & watchlist
test('B16 grid from layout setup: second chart independent and activatable', async ({ page }) => {
  await page.locator('#layout-btn').click();
  await page.locator('[data-menu="layout-setup"] [data-grid="2h"]').click();
  await expect(page.locator('.chart-cell')).toHaveCount(2);
  await expect.poll(async () => (await snap(page, 1)).nBars).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await page.locator('.chart-host').nth(1).click({ position: { x: 200, y: 200 } });
  expect((await snap(page)).active).toBe(1);
  await page.evaluate(() => (window as any).app.view.load('SZSE:159915'));
  await ready(page, 'SZSE:159915');
  expect((await snap(page, 0)).symbol).not.toBe('SZSE:159915');
  await expect(page.locator('.chart-cell').nth(1)).toHaveClass(/active/);
});

test('B17 watchlist: sections, click loads symbol; add/remove persists', async ({ page }) => {
  const wl = page.locator('[data-p="watchlist"]');
  await expect(wl.locator('.wl-section')).toHaveCount(3);
  await wl.locator('.wl-row[data-sym="SZSE:159915"]').click();
  await ready(page, 'SZSE:159915');
  await expect(wl.locator('.wl-row[data-sym="SZSE:159915"]')).toHaveClass(/sel/);
  await expect(wl.locator('.details')).toContainText('159915');
  await wl.locator('[data-a="add"]').first().click();
  await page.locator('[data-dialog="symbol-search"] input').fill('SSE:512880');
  await page.keyboard.press('Enter');
  await expect(wl.locator('.wl-row[data-sym="SSE:512880"]')).toBeVisible();
  const row = wl.locator('.wl-row[data-sym="SSE:588000"]');
  await row.hover();
  await row.locator('[data-del]').click();
  await expect(wl.locator('.wl-row[data-sym="SSE:588000"]')).toHaveCount(0);
  await wl.locator('.wl-section', { hasText: 'US STOCKS' }).click();     // collapse a section
  await expect(wl.locator('.wl-row[data-sym="NASDAQ:AAPL"]')).toHaveCount(0);
  await page.reload();
  await ready(page);
  await expect(wl.locator('.wl-row[data-sym="SSE:512880"]')).toBeVisible();
  await expect(wl.locator('.wl-row[data-sym="SSE:588000"]')).toHaveCount(0);
});

test('B18 save, copy and load layouts', async ({ page }) => {
  await page.evaluate(() => (window as any).app.view.addStudy('MACD'));
  await page.keyboard.press('Control+KeyS');
  const dlg = page.locator('[data-dialog="prompt"] input');
  await dlg.fill('E2E layout');
  await dlg.press('Enter');
  await expect(page.locator('#layout-name')).toHaveText('E2E layout');
  await page.locator('#layouts-btn').click();
  await page.locator('[data-menu="manage-layouts"] .menu-row', { hasText: 'Make a copy' }).click();
  await page.locator('[data-dialog="prompt"] input').fill('E2E copy');
  await page.keyboard.press('Enter');
  await expect(page.locator('#layout-name')).toHaveText('E2E copy');
  await page.evaluate(() => { const v = (window as any).app.view; v.removeStudy(v.studies[0].uid); });   // autosaves into the copy
  await page.waitForTimeout(900);
  await page.locator('#layouts-btn').click();
  await page.locator('[data-menu="manage-layouts"] .menu-row', { hasText: 'E2E layout' }).click();
  await expect.poll(async () => (await snap(page)).studies.map(s => s.id)).toEqual(['MACD']);
  await expect(page.locator('#layout-name')).toHaveText('E2E layout');
  const copy = await page.evaluate(async () => {
    const ls = await fetch('/api/layouts').then(r => r.json());
    const c = ls.find((l: any) => l.name === 'E2E copy');
    return (await fetch(`/api/layouts/${c.id}`).then(r => r.json())).state.charts[0].studies;
  });
  expect(copy).toEqual([]);
});

// ------------------------------------------------------------------------------------- strategy report
test('B19 + B20 strategy report for a saved run; trades on chart', async ({ page }) => {
  const { report } = await openRun(page);
  const money = (x: number) => `${x < 0 ? '−' : ''}${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await expect(page.locator('#dock [data-k="total_pnl"]')).toHaveText(money(report.key_stats.total_pnl));
  await expect(page.locator('#dock .dk-tab [data-name]')).toHaveText(report.meta.name);
  await expect(page.locator('#dock .perf-chart canvas').first()).toBeVisible();
  const row = page.locator('#dock .pnl-table tr[data-inst]').first();
  const instrument = (await row.getAttribute('data-inst'))!;
  await row.click();                                                      // opens the instrument view + its chart
  const d = await page.evaluate(async ([rid, i]) => fetch(`/api/backtest/instrument?run=${encodeURIComponent(rid)}&instrument=${i}`).then(r => r.json()),
    [(await page.evaluate(() => (window as any).app.strategy.runId)) as string, instrument]);
  await ready(page, d.symbol);
  await expect(page.locator('#dock .inst-title')).toContainText(d.symbol.split(':').pop());
  const got = await page.evaluate(() => { const v = (window as any).app.view; return { n: v.markers.markers().length, first: v.bars[0].time }; });
  const firstDate = new Date(got.first * 1000).toISOString().slice(0, 10);
  const expected = d.operations.filter((o: any) => o.action !== 'open' && o.date >= firstDate).length;
  expect(expected).toBeGreaterThan(0);
  expect(got.n).toBe(expected);                                            // one marker per buy / add / trim / sell
  expect(report.breakdown.profits_by_instrument[0].instrument).toBe(instrument);
});

test('B21 run a qlib backtest from the strategy report', async ({ page }) => {
  test.setTimeout(180_000);
  await page.locator('#rightbar [data-page="strategy"]').click();
  await page.locator('#dock [data-a="new"]').first().click();
  const dlg = page.locator('[data-dialog="backtest-settings"]');
  await expect(dlg.locator('[name="signal"]')).toBeVisible();
  await dlg.locator('[name="signal"]').selectOption('builtin:ROC20');
  await dlg.locator('[name="topk"]').fill('3');
  await dlg.locator('[name="start"]').fill('2024-01-02');
  await dlg.locator('[data-ok]').click();
  await expect(page.locator('#dock .dk-tab [data-name]')).toContainText('roc20_top3', { timeout: 170_000 });
  await expect(page.locator('#dock [data-keystats]')).toContainText('Total PnL');
});

test('B22 strategy report tabs and list of trades', async ({ page }) => {
  const { report } = await openRun(page);
  const dock = page.locator('#dock');
  const tab = (name: string) => dock.locator('.tabs-pill button', { hasText: name });
  await tab('Periodical').click();
  await expect(dock).toContainText('Annualized return (CAGR)');
  await expect(dock.locator('[data-perf-body] svg.bars-svg')).toBeVisible();
  await tab('Benchmarking').click();
  await expect(dock).toContainText('Strategy outperformance');
  await tab('Growth and decline').click();
  await expect(dock).toContainText('Average run-up duration');
  await tab('Streaks').click();
  await expect(dock).toContainText(`${report.streaks.max_win} trades`);
  await tab('Time patterns').click();
  await expect(dock).toContainText('Average trade return by entry weekday');
  await dock.locator('[data-view="trades"]').click();
  await expect(dock.locator('tbody.trade')).toHaveCount(report.trades.length);
  await expect(dock.locator('tbody.trade').first()).toHaveAttribute('data-trade', String(report.trades.length));   // newest first
});

// ------------------------------------------------------------------------------------- chrome: new behaviors
test('B23 tool flyout: group button remembers the chosen tool', async ({ page }) => {
  await flyoutPick(page, 'trend', 'Horizontal ray');
  await expect(page.locator('#drawbar [data-main="trend"]')).toHaveAttribute('data-tool', 'hray');
  expect((await snap(page)).tool).toBe('hray');
  const p = (await paneBox(page)).at(0.4, 0.5);
  await page.mouse.click(p.x, p.y);
  const s = await snap(page);
  expect(s.drawings.map(d => d.type)).toEqual(['hray']);
  expect(s.tool).toBe('cursor');
  await page.locator('#drawbar [data-main="trend"]').click();                // the button now draws a horizontal ray
  expect((await snap(page)).tool).toBe('hray');
});

test('B24 range bar switches interval and span like TradingView', async ({ page }) => {
  await page.locator('#bottombar [data-range="5Y"]').click();
  await expect.poll(async () => (await snap(page)).timeframe).toBe('W');
  await ready(page);
  const span = async () => page.evaluate(() => { const r = (window as any).app.view.chart.timeScale().getVisibleRange(); return (r.to - r.from) / 86400; });
  expect(await span()).toBeGreaterThan(5 * 365 - 14);
  expect(await span()).toBeLessThan(5 * 365 + 14);
  await expect(page.locator('#bottombar [data-range="5Y"]')).toHaveClass(/on/);
  await page.locator('#bottombar [data-range="1Y"]').click();
  await expect.poll(async () => (await snap(page)).timeframe).toBe('D');
  await ready(page);
  expect(await span()).toBeGreaterThan(355);
  expect(await span()).toBeLessThan(372);
});

test('B25 chart types: Heikin Ashi candles and line', async ({ page }) => {
  await page.locator('#charttype-btn').click();
  await page.locator('[data-menu="chart-type"] [data-id="heikin"]').click();
  expect((await snap(page)).chartType).toBe('heikin');
  const ha = await page.evaluate(async () => {
    const v = (window as any).app.view;
    const { heikinAshi } = await import('/src/chart/util.ts');
    const want = heikinAshi(v.bars).at(-1);
    const got = v.main.data().at(-1);
    return { want, got };
  });
  expect(ha.got.open).toBeCloseTo(ha.want.open, 9);
  expect(ha.got.close).toBeCloseTo(ha.want.close, 9);
  await expect(page.locator('#charttype-btn')).toHaveAttribute('data-type', 'heikin');
  await page.locator('#charttype-btn').click();
  await page.locator('[data-menu="chart-type"] [data-id="line"]').click();
  const line = await page.evaluate(() => { const v = (window as any).app.view; return { t: v.main.seriesType(), last: v.main.data().at(-1).value, close: v.bars.at(-1).close }; });
  expect(line.t).toBe('Line');
  expect(line.last).toBe(line.close);
});

test('B26 undo / redo studies and drawings', async ({ page }) => {
  await page.evaluate(() => (window as any).app.view.addStudy('EMA'));
  const p = (await paneBox(page)).at(0.5, 0.5);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('Alt+KeyH');
  expect((await snap(page)).drawings).toHaveLength(1);
  await expect(page.locator('#undo-btn')).toHaveAttribute('data-tip', 'Undo create drawing');
  await page.keyboard.press('Control+KeyZ');
  expect((await snap(page)).drawings).toHaveLength(0);
  await page.keyboard.press('Control+KeyZ');
  expect((await snap(page)).studies).toHaveLength(0);
  await page.locator('#redo-btn').click();
  expect((await snap(page)).studies.map(s => s.id)).toEqual(['EMA']);
  await page.keyboard.press('Control+Shift+KeyZ');
  expect((await snap(page)).drawings).toHaveLength(1);
});

test('B27 compare symbol switches the scale to percent', async ({ page }) => {
  await page.locator('#compare-btn').click();
  await page.locator('[data-dialog="symbol-search"] input').fill('SSE:510500');
  await page.keyboard.press('Enter');
  await expect.poll(async () => page.evaluate(() => (window as any).app.view.compares.map((c: any) => [c.symbol, c.bars.length > 0]))).toEqual([['SSE:510500', true]]);
  expect(await page.evaluate(() => (window as any).app.view.chart.priceScale('right').options().mode)).toBe(2);
  const row = page.locator('.legend-row[data-compare="SSE:510500"]');
  await row.hover();
  await row.locator('[data-act="remove"]').click();
  expect(await page.evaluate(() => (window as any).app.view.chart.priceScale('right').options().mode)).toBe(0);
});

test('B28 measure (Shift+click) is transient; ranges and positions are drawings', async ({ page }) => {
  const box = await paneBox(page);
  const a = box.at(0.3, 0.6), b = box.at(0.6, 0.3);
  await page.keyboard.down('Shift');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.up('Shift');
  await page.mouse.click(b.x, b.y);
  const m = await page.evaluate(() => (window as any).app.view.drawingLayer.measurement);
  expect(m.type).toBe('datepricerange');
  expect((await snap(page)).drawings).toHaveLength(0);
  await flyoutPick(page, 'forecast', 'Long position');
  const e = box.at(0.5, 0.5);
  await page.mouse.click(e.x, e.y);
  const d = (await snap(page)).drawings[0];
  expect(d.type).toBe('long');
  expect(d.points[1].price).toBeGreaterThan(d.points[0].price);
  expect(d.points[2].price).toBeLessThan(d.points[0].price);
});

test('B29 object tree and data window', async ({ page }) => {
  await page.evaluate(() => (window as any).app.view.addStudy('RSI'));
  const p = (await paneBox(page)).at(0.5, 0.5);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('Alt+KeyH');
  await page.locator('#rightbar [data-page="objects"]').click();
  const pg = page.locator('[data-p="objects"]');
  await expect(pg).toContainText('RSI 14 close');
  await expect(pg).toContainText('Horizontal line');
  await pg.locator('[data-act="d-lock"]').click();
  expect(await page.evaluate(() => (window as any).app.view.drawingLayer.drawings[0].locked)).toBe(true);
  await pg.locator('[data-tab="data"]').click();
  await page.mouse.move(10, 10);
  const open = await page.evaluate(() => { const v = (window as any).app.view; return v.fmtPrice(v.bars.at(-1).open); });
  await expect(pg.locator('.kv', { hasText: 'Open' })).toContainText(open);
});

test('B30 ADJ toggles dividend adjustment on the TradingView feed', async ({ page }) => {
  const s = await snap(page);
  test.skip(s.source !== 'tradingview', 'needs the TradingView sidecar');
  const first = await page.evaluate(() => (window as any).app.view.bars[0]);
  await page.locator('#adj-btn').click();
  await expect.poll(async () => page.evaluate(() => (window as any).app.view.adjustment)).toBe('dividends');
  await ready(page);
  await expect(page.locator('#adj-btn')).toHaveClass(/on/);
  const adj = await page.evaluate(t => (window as any).app.view.bars.find((b: any) => b.time === t), first.time);
  expect(adj.close).toBeLessThan(first.close);        // 510300 has paid dividends since; adjusted history is lower
});

test('B31 bar replay: pick a bar, step forward, exit', async ({ page }) => {
  const n = (await snap(page)).nBars;
  await page.locator('#replay-btn').click();
  await expect(page.locator('.replay-bar')).toBeVisible();
  const p = (await paneBox(page)).at(0.5, 0.5);
  await page.mouse.click(p.x, p.y);
  const idx = await page.evaluate(() => (window as any).app.view.replay.index);
  expect(idx).toBeLessThan(n - 1);
  expect(await page.evaluate(() => (window as any).app.view.main.data().length)).toBe(idx + 1);
  await page.locator('.replay-bar [data-r="step"]').click();
  expect(await page.evaluate(() => (window as any).app.view.replay.index)).toBe(idx + 1);
  expect(await page.evaluate(() => (window as any).app.view.main.data().length)).toBe(idx + 2);
  await page.locator('.replay-bar [data-r="exit"]').click();
  expect(await page.evaluate(() => (window as any).app.view.main.data().length)).toBe(n);
});

test('B32 lock, hide and remove from the toolbar', async ({ page }) => {
  const p = (await paneBox(page)).at(0.5, 0.5);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press('Alt+KeyH');
  await page.locator('#drawbar [data-main="lock"]').click();
  expect(await page.evaluate(() => (window as any).app.view.drawingLayer.locked)).toBe(true);
  await page.locator('#drawbar [data-main="hide"]').click();
  expect(await page.evaluate(() => (window as any).app.view.drawingLayer.hidden)).toBe(true);
  await page.locator('#drawbar [data-main="hide"]').click();
  await page.evaluate(() => (window as any).app.view.addStudy('EMA'));
  await page.locator('.dt-item[data-item="remove"]').hover();
  await page.locator('[data-more="remove"]').click();
  await page.locator('[data-menu="flyout-remove"] .menu-row', { hasText: 'Remove 1 drawing & 1 indicator' }).click();
  const s = await snap(page);
  expect([s.drawings.length, s.studies.length]).toEqual([0, 0]);
});

test('B33 indicator templates save and apply', async ({ page }) => {
  await page.evaluate(() => { const v = (window as any).app.view; v.addStudy('EMA', { length: 50 }); v.addStudy('RSI'); });
  await page.locator('#templates-btn').click();
  await page.locator('[data-menu="indicator-templates"] .menu-row', { hasText: 'Save indicator template' }).click();
  await page.locator('[data-dialog="prompt"] input').fill('Trend kit');
  await page.keyboard.press('Enter');
  await page.evaluate(() => { const v = (window as any).app.view; for (const s of [...v.studies]) v.removeStudy(s.uid); });
  await page.locator('#templates-btn').click();
  await page.locator('[data-menu="indicator-templates"] .menu-row', { hasText: 'Trend kit' }).click();
  const s = await snap(page);
  expect(s.studies.map(x => [x.id, x.inputs.length])).toEqual([['EMA', 50], ['RSI', 14]]);
});

// ------------------------------------------------------------------------------------- Pine strategies
async function strategyRun(page: Page) {
  return page.evaluate(() => {
    const v = (window as any).app.view, r = v.strategyRun;
    return r ? { name: r.meta.name, trades: r.trades.length, props: r.props, inputs: v.strategy.inputs, commission: r.breakdown.commission,
      markers: v.markers.markers().length } : null;
  });
}

test('B34 add a built-in strategy: chart labels, legend, Strategy Tester report, persists', async ({ page }) => {
  await page.keyboard.press('/');
  await page.locator('[data-dialog="indicators"] [data-tab="strategies"]').click();
  await page.locator('[data-dialog="indicators"] input').fill('MACD');
  await page.locator('[data-dialog="indicators"] .results > div', { hasText: 'MACD strategy' }).click();
  await expect.poll(() => strategyRun(page).then(r => r?.trades ?? 0)).toBeGreaterThan(10);
  const r = (await strategyRun(page))!;
  expect(r.markers).toBeGreaterThan(10);
  await expect(page.locator('.legend-row[data-study="strategy"] .lname')).toContainText('MACD strategy 12 26 9');
  await expect(page.locator('#dock .dk-head [data-name]')).toHaveText('MACD strategy');
  await expect(page.locator('#dock .dk-chip', { hasText: '% of equity' })).toBeVisible();
  await page.locator('#dock [data-view="trades"]').click();
  await expect(page.locator('#dock table.trades th', { hasText: 'Signal' })).toBeVisible();
  await expect(page.locator('#dock table.trades .sig', { hasText: /^Macd(LE|SE)$/ }).first()).toBeVisible();
  // the strategy is part of the layout: survives a reload
  await expect.poll(() => page.evaluate(() => !(window as any).app.dirty)).toBe(true);
  await page.reload();
  await ready(page);
  await expect.poll(() => strategyRun(page).then(x => x?.trades)).toBe(r.trades);
  await page.locator('.legend-row[data-study="strategy"]').hover();
  await page.locator('.legend-row[data-study="strategy"] [data-act="remove"]').click();
  expect(await strategyRun(page)).toBeNull();
  await expect(page.locator('.legend-row[data-study="strategy"]')).toHaveCount(0);
});

test('B35 strategy Inputs and Properties rerun the strategy', async ({ page }) => {
  await page.evaluate(() => (window as any).app.view.setStrategy({ script: { id: 'STD;MACD%1Strategy' }, name: '', inputs: {}, props: {} }));
  await expect.poll(() => strategyRun(page).then(r => r?.trades ?? 0)).toBeGreaterThan(0);
  await page.locator('.legend-row[data-study="strategy"]').hover();
  await page.locator('.legend-row[data-study="strategy"] [data-act="settings"]').click();
  const dlg = page.locator('[data-dialog="strategy-settings"]');
  await dlg.locator('.form-grid label', { hasText: 'Fast Length' }).locator('xpath=following-sibling::input[1]').fill('8');
  await dlg.locator('[data-t="properties"]').click();
  await dlg.locator('[name="commission_value"]').fill('0.1');
  await dlg.locator('[data-ok]').click();
  await expect.poll(() => strategyRun(page).then(r => r?.props.commission_value)).toBe(0.1);
  const r = (await strategyRun(page))!;
  expect(r.inputs).toEqual({ 'Fast length': 8 });
  expect(r.commission).toBeGreaterThan(0);
  await expect(page.locator('.legend-row[data-study="strategy"] .lname')).toContainText('8 26 9');
  await expect(page.locator('#dock .dk-chip', { hasText: '0.1%' })).toBeVisible();
});

test('B36 My scripts: paste a Pine strategy, errors are shown, saved script runs', async ({ page }) => {
  await page.keyboard.press('/');
  await page.locator('[data-dialog="indicators"] [data-tab="mine"]').click();
  await page.locator('[data-dialog="indicators"] .results > div', { hasText: 'New Pine script' }).click();
  const dlg = page.locator('[data-dialog="pine-script"]');
  await dlg.locator('textarea').fill('//@version=6\nindicator("x")\nplot(close)\n');
  await dlg.locator('[data-ok]').click();
  await expect(dlg.locator('.pine-err')).toContainText('strategy');
  await dlg.locator('textarea').fill([
    '//@version=6', 'strategy("SMA cross e2e", overlay = true)', 'f = ta.sma(close, 5)', 's = ta.sma(close, 20)',
    'if ta.crossover(f, s)', '    strategy.entry("L", strategy.long)', 'if ta.crossunder(f, s)', '    strategy.close("L")', ''].join('\n'));
  await dlg.locator('[data-ok]').click();
  await expect.poll(() => strategyRun(page).then(r => r?.name)).toBe('SMA cross e2e');
  expect((await strategyRun(page))!.trades).toBeGreaterThan(0);
  const saved = await (await page.request.get('/api/strategies')).json();
  expect(saved.user.map((u: { name: string }) => u.name)).toEqual(['SMA cross e2e']);
});

test('B37 optimize strategy inputs: leaderboard with out-of-sample, apply, export Pine', async ({ page }) => {
  await page.evaluate(() => (window as any).app.view.setStrategy({ script: { id: 'STD;MACD%1Strategy' }, name: '', inputs: {}, props: {} }));
  await expect.poll(() => strategyRun(page).then(r => r?.trades ?? 0)).toBeGreaterThan(0);
  await page.locator('.legend-row[data-study="strategy"]').hover();
  await page.locator('.legend-row[data-study="strategy"] [data-act="report"]').click();
  await page.locator('#dock [data-view="optimize"]').click();
  await expect(page.locator('#dock .opt-space [data-row]')).toHaveCount(3);
  await page.locator('#dock [data-o="trials"]').fill('16');
  await page.locator('#dock [data-o="min_trades"]').fill('5');
  await page.locator('#dock [data-a="opt-run"]').click();
  await expect(page.locator('#dock .opt-table tbody tr, #dock .opt-table tr').nth(1)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => page.evaluate(() => (window as any).app.strategy.opt?.job?.status), { timeout: 60_000 }).toBe('done');
  await expect(page.locator('#dock .opt-table th', { hasText: 'OOS return' })).toBeVisible();
  const best = await page.evaluate(() => (window as any).app.strategy.opt.job.leaderboard[0].params);
  expect(Object.keys(best).sort()).toEqual(['Fast length', 'MACD length', 'Slow length']);
  await page.locator('#dock [data-a="opt-apply"]').first().click();
  await expect.poll(() => strategyRun(page).then(r => r?.inputs)).toEqual(best);
  await page.locator('#dock [data-view="optimize"]').click();
  await page.locator('#dock [data-a="opt-export"]').first().click();
  await expect(page.locator('[data-dialog="pine-script"] textarea')).toHaveValue(new RegExp(`input\\(${best['Fast length']}, "Fast length"\\)`));
});

test('B38 saved runs as a folder tree: market / pool / namespace / signal family, US study runs included', async ({ page }) => {
  await page.locator('#rightbar [data-page="strategy"]').click();
  await page.locator('#dock .dk-tab [data-a="runs"]').click();
  const dlg = page.locator('[data-dialog="runs"]');
  await expect(dlg.locator('.run-folder[data-folder="cn"]')).toContainText('CN ETFs');
  await expect(dlg.locator('.run-folder[data-folder="us"]')).toContainText('US stocks');
  await expect(dlg.locator('.run-row')).toHaveCount(0);                 // every run sits in a folder
  // open US stocks / sector_leaders55 and pick a run at the pool's top level
  if (!(await dlg.locator('.run-folder[data-folder="us"]').getAttribute('class'))!.includes('open')) await dlg.locator('.run-folder[data-folder="us"]').click();
  await dlg.locator('.run-folder[data-folder="us/sector_leaders55"]').click();
  await dlg.locator('.run-folder[data-folder="us/sector_leaders55/~cmm_dmn"]').click();   // signal-family folder
  const row = dlg.locator('.run-row[data-run^="us:sector_leaders55/backtest/cmm_dmn_top10"]').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator('#dock [data-keystats]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#dock .dk-chip .cur').first()).toHaveText('USD');
  await expect(page.locator('#dock [data-a="range"]')).toHaveCount(0);  // US study runs are read-only here
  // search flattens the tree to matching runs, folders expanded
  await page.locator('#dock .dk-tab [data-a="runs"]').click();
  await dlg.locator('input.search').fill('revision_spy');
  const all: { id: string; signal: string | null }[] = await (await page.request.get('/api/backtest/runs')).json();
  const want = all.filter(r => `${r.id} ${r.signal ?? ''}`.toLowerCase().includes('revision_spy')).map(r => r.id).sort();
  // matches on run path or signal name (the search re-renders after a short debounce)
  await expect.poll(async () => (await dlg.locator('.run-row').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.run!))).sort()).toEqual(want);
});

test('B39 strategy templates are grouped in folders', async ({ page }) => {
  await page.keyboard.press('/');
  const dlg = page.locator('[data-dialog="indicators"]');
  await dlg.locator('[data-tab="strategies"]').click();
  await expect(dlg.locator('.pick-folder')).toHaveCount(4);
  const trend = dlg.locator('.pick-folder', { hasText: 'Trend following' });
  if (!(await trend.getAttribute('class'))!.includes('open')) await trend.click();
  await expect(dlg.locator('.results > div.in-folder', { hasText: 'MACD strategy' })).toBeVisible();
  await expect(dlg.locator('.results > div.in-folder', { hasText: 'RSI strategy' })).toHaveCount(0);   // its folder is closed
  await dlg.locator('input.search').fill('rsi');
  await expect(dlg.locator('.results > div.in-folder', { hasText: 'RSI strategy' })).toBeVisible();
});

test('B40 instruments: what the run earned and lost per name; a name opens its operations, holding periods and chart', async ({ page }) => {
  const { id, report } = await openRun(page);
  await page.locator('#dock [data-view="instruments"]').click();
  await expect(page.locator('#dock .kstat', { hasText: 'Earned on' })).toBeVisible();
  await page.locator('#dock [data-instf="lost"]').click();
  const first = page.locator('#dock .inst-table tbody tr').first();
  const inst = (await first.getAttribute('data-inst'))!;
  const worst = report.breakdown.profits_by_instrument.at(-1);
  expect(inst).toBe(worst.instrument);                                   // Lost: biggest loser first
  await first.click();
  await expect(page.locator('#dock .inst-perf canvas').first()).toBeVisible({ timeout: 30_000 });   // Overview: P&L chart
  const d = await page.evaluate(async ([rid, i]) => fetch(`/api/backtest/instrument?run=${encodeURIComponent(rid)}&instrument=${i}`).then(r => r.json()), [id, inst]);
  expect(d.summary.pnl).toBeCloseTo(worst.pnl, 4);                      // detail reconciles with the breakdown
  expect(d.operations.at(-1).cum_pnl).toBeCloseTo(d.summary.pnl, 4);     // operations add up to the total
  await expect(page.locator('#dock .metrics-table')).toContainText('Net profit');
  await page.locator('#dock .tabs-pill [data-itab="trips"]').click();
  await expect(page.locator('#dock table.trades tbody.trade')).toHaveCount(d.trips.length);
  await page.locator('#dock .tabs-pill [data-itab="ops"]').click();
  await expect(page.locator('#dock table.orders tbody tr')).toHaveCount(d.operations.length);
  await expect(page.locator('#dock table.orders .side-buy').first()).toHaveText('Buy');
  // the chart switches to the instrument with a marker per operation in view
  await ready(page, d.symbol);                                           // symbol is set when loading starts; wait for the bars
  const texts = await page.evaluate(() => (window as any).app.view.markers.markers().map((m: any) => m.text));
  expect(texts.some((t: string) => t === 'Buy')).toBe(true);
  expect(texts.some((t: string) => t.startsWith('Sell '))).toBe(true);
  await page.locator('#dock [data-a="inst-back"]').click();
  await expect(page.locator('#dock .inst-table tbody tr').first()).toBeVisible();
});

test('B41 a strategy on the chart does not take over an opened instrument page; watchlist add reveals the row', async ({ page }) => {
  await page.evaluate(() => (window as any).app.view.setStrategy({ script: { id: 'STD;MACD%1Strategy' }, name: '', inputs: {}, props: {} }));
  await expect.poll(() => page.evaluate(() => (window as any).app.view.strategyRun?.trades.length ?? 0)).toBeGreaterThan(0);
  await openRun(page);
  await page.locator('#dock [data-view="instruments"]').click();
  await page.locator('#dock .inst-table tbody tr').first().click();
  // the chart switches symbol, its MACD strategy re-runs, and the instrument page must stay
  await expect.poll(() => page.evaluate(() => { const v = (window as any).app.view;
    return !v.loading && !v.strategyBusy && v.strategyRun?.meta.symbol === v.symbol && v.symbol !== 'SSE:510300'; }), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.locator('#dock .inst-title')).toBeVisible();
  expect(await page.evaluate(() => (window as any).app.strategy.kind)).toBe('qlib');
  // watchlist: a new symbol at the end is scrolled into view; adding it again says so instead of doing nothing
  const add = async () => {
    await page.locator('#widget-pages [data-a="add"]').first().click();
    await page.locator('[data-dialog="symbol-search"] input').fill('NASDAQ:ASTS');
    await page.keyboard.press('Enter');
  };
  await add();
  const row = page.locator('.wl-row[data-sym="NASDAQ:ASTS"]');
  await expect(row).toBeInViewport();
  await add();
  await expect(page.locator('.toast', { hasText: 'already in' })).toBeVisible();
  await expect(row).toHaveCount(1);
});
