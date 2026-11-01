// Top toolbar in TradingView's order (re/ui/ui_measurements.json): symbol pill (+ data-source switch),
// compare | interval | chart type | Indicators, templates | Alert, Replay | undo, redo ... layout setup,
// layout name/Save, manage layouts | quick search, settings, fullscreen, snapshot.
import type { App } from '../main';
import { CHART_TYPES, tfLabel } from '../chart/view';
import type { GridMode } from '../api';
import { icon } from './icons';
import { KEY, openMenu, type MenuItem } from './menu';
import { esc } from './dialogs';

const INTERVAL_SECTIONS: { title: string; items: [string, string][] }[] = [
  { title: 'Minutes', items: [['1', '1 minute'], ['2', '2 minutes'], ['3', '3 minutes'], ['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['30', '30 minutes'], ['45', '45 minutes']] },
  { title: 'Hours', items: [['60', '1 hour'], ['120', '2 hours'], ['180', '3 hours'], ['240', '4 hours']] },
  { title: 'Days', items: [['D', '1 day'], ['W', '1 week'], ['M', '1 month']] },
];
export const LAYOUT_ROWS: { n: number; modes: GridMode[] }[] = [
  { n: 1, modes: ['1'] }, { n: 2, modes: ['2h', '2v'] }, { n: 3, modes: ['3h', '3v'] }, { n: 4, modes: ['4'] },
];
const LAYOUT_ICON: Record<GridMode, string> = { '1': 'layout1', '2h': 'layout2h', '2v': 'layout2v', '3h': 'layout3h', '3v': 'layout2v', '4': 'layout4' };

const btn = (id: string, ico: string, tip: string, text = '', hint = '') =>
  `<button class="tbtn ${text ? '' : 'icon-only'}" id="${id}" data-tip="${tip}" ${hint ? `data-hint="${hint}"` : ''} aria-label="${tip}">${icon(ico)}${text ? `<span>${text}</span>` : ''}</button>`;
const sep = '<span class="tb-sep"></span>';

export class TopBar {
  constructor(private el: HTMLElement, private app: App) {
    el.innerHTML = `
      <div class="tb-avatar"><button id="app-menu" data-tip="Menu" aria-label="Menu">C</button></div>
      <div class="tb-group">
        <div class="symbol-pill"><button class="sym" id="symbol-btn" data-tip="Symbol search" aria-label="Symbol search"><span id="symbol-label">—</span></button>
          <button class="dtype" id="feed" data-tip="Data source" aria-label="Data source">${icon('datatype', 18)}</button></div>
        ${btn('compare-btn', 'plusCircle', 'Compare symbols')}${sep}
        <button class="tbtn text-only" id="interval-btn" data-tip="Interval" aria-label="Interval"><span id="interval-label">D</span></button>${sep}
        <button class="tbtn icon-only" id="charttype-btn" data-tip="Candles" aria-label="Chart type"></button>${sep}
        ${btn('indicators-btn', 'indicators', 'Indicators, metrics, and strategies', 'Indicators', '/')}${btn('templates-btn', 'templates', 'Indicator templates')}${sep}
        ${btn('alert-btn', 'alarm', 'Create alert', 'Alert', `${KEY.alt}A`)}${btn('replay-btn', 'replay', 'Bar replay', 'Replay')}${sep}
        ${btn('undo-btn', 'undo', 'Undo', '', `${KEY.mod}Z`)}${btn('redo-btn', 'redo', 'Redo', '', `${KEY.mod}${KEY.shift}Z`)}
      </div>
      <div class="tb-fill"></div>
      <div class="tb-group">
        <button class="tbtn icon-only" id="layout-btn" data-tip="Layout setup" aria-label="Layout setup"></button>
        <button class="tbtn save-btn" id="save-btn" data-tip="Save layout" data-hint="${KEY.mod}S" aria-label="Save layout"><span id="layout-name">Unnamed</span><small id="save-sub" hidden>Save</small></button>
        <button class="tbtn split-caret" id="layouts-btn" data-tip="Manage layouts" aria-label="Manage layouts">${icon('chevronDown')}</button>${sep}
        ${btn('quick-btn', 'quicksearch', 'Quick search', '', `${KEY.mod}K`)}${btn('settings-btn', 'hexgear', 'Settings')}
        ${btn('fullscreen-btn', 'fullscreen', 'Fullscreen mode', '', `${KEY.shift}F`)}${btn('snapshot-btn', 'camera', 'Take a snapshot')}
      </div>`;
    const $ = (id: string) => el.querySelector<HTMLElement>(`#${id}`)!;
    $('app-menu').onclick = () => this.appMenu($('app-menu'));
    $('symbol-btn').onclick = () => app.openSymbolSearch('');
    $('feed').onclick = () => this.sourceMenu($('feed'));
    $('compare-btn').onclick = () => app.openCompare();
    $('interval-btn').onclick = () => this.intervalMenu($('interval-btn'));
    $('charttype-btn').onclick = () => this.chartTypeMenu($('charttype-btn'));
    $('indicators-btn').onclick = () => app.openIndicators();
    $('templates-btn').onclick = () => this.templatesMenu($('templates-btn'));
    $('alert-btn').onclick = () => app.openAlert();
    $('replay-btn').onclick = () => app.toggleReplay();
    $('undo-btn').onclick = () => app.undo();
    $('redo-btn').onclick = () => app.redo();
    $('layout-btn').onclick = () => this.layoutMenu($('layout-btn'));
    $('save-btn').onclick = () => app.saveLayout();
    $('layouts-btn').onclick = () => this.layoutsMenu($('layouts-btn'));
    $('quick-btn').onclick = () => app.quickSearch();
    $('settings-btn').onclick = () => app.openSettings();
    $('fullscreen-btn').onclick = () => app.toggleFullscreen();
    $('snapshot-btn').onclick = () => this.snapshotMenu($('snapshot-btn'));
  }

  /** Reflect the active chart and app state. */
  sync() {
    const v = this.app.view, $ = (id: string) => this.el.querySelector<HTMLElement>(`#${id}`)!;
    if (!v) return;
    $('symbol-label').textContent = v.symbol.split(':').pop() || '—';
    $('symbol-btn').dataset.symbol = v.symbol;
    $('interval-label').textContent = tfLabel(v.timeframe);
    $('interval-btn').dataset.tf = v.timeframe;
    const ct = CHART_TYPES.find(c => c.id === v.chartType)!;
    $('charttype-btn').innerHTML = icon(ct.icon);
    $('charttype-btn').dataset.tip = ct.label;
    $('charttype-btn').dataset.type = ct.id;
    $('layout-btn').innerHTML = icon(LAYOUT_ICON[this.app.grid]);
    $('layout-name').textContent = this.app.layoutName;
    $('save-sub').hidden = !this.app.dirty || this.app.autosave;
    $('replay-btn').classList.toggle('on', !!(v.replay || v.replayPicking));
    const u = this.app.history();
    const undo = $('undo-btn') as HTMLButtonElement, redo = $('redo-btn') as HTMLButtonElement;
    undo.disabled = !u.undo; redo.disabled = !u.redo;
    undo.dataset.tip = u.undo ? `Undo ${u.undo}` : 'Undo';
    redo.dataset.tip = u.redo ? `Redo ${u.redo}` : 'Redo';
    const feed = $('feed');
    feed.dataset.source = this.app.feedState;
    feed.dataset.tip = this.app.feedState === 'tradingview' ? 'Data: TradingView feed (live)' : this.app.feedState === 'local' ? 'Data: local panels only' : 'Server offline';
  }

  private intervalMenu(anchor: HTMLElement) {
    const cur = this.app.view.timeframe;
    const items: MenuItem[] = [{ label: 'Add custom interval…', onClick: () => this.app.customInterval() }];
    const ticks = this.app.view.symbol.startsWith('QUANTIFI:')          // hackathon books: one bar per tick and up
      ? [{ title: 'Ticks', items: [['1S', '1 tick'], ['5S', '5 ticks'], ['15S', '15 ticks'], ['30S', '30 ticks']] as [string, string][] }] : [];
    for (const s of [...ticks, ...INTERVAL_SECTIONS]) {
      items.push({ section: s.title });
      for (const [tf, label] of s.items) items.push({ label, id: tf, selected: tf === cur, onClick: () => this.app.setInterval(tf) });
    }
    openMenu(anchor, items, { name: 'interval', minWidth: 195 });
  }

  private chartTypeMenu(anchor: HTMLElement) {
    const cur = this.app.view.chartType;
    openMenu(anchor, CHART_TYPES.map(c => ({ label: c.label, icon: c.icon, id: c.id, selected: c.id === cur, onClick: () => this.app.setChartType(c.id) })),
      { name: 'chart-type', variant: 'tall', minWidth: 268 });
  }

  private async templatesMenu(anchor: HTMLElement) {
    const tpl = await this.app.indicatorTemplates();
    openMenu(anchor, [
      { label: 'Save indicator template…', onClick: () => this.app.saveIndicatorTemplate() },
      ...(tpl.length ? [{ section: 'My templates' } as MenuItem] : []),
      ...tpl.map(t => ({ label: t.name, html: `${esc(t.name)}<span class="sub">${esc(t.studies.map(s => s.id).join(', '))}</span>`,
        removable: true, onClick: () => this.app.applyIndicatorTemplate(t), onRemove: () => this.app.deleteIndicatorTemplate(t.name) })),
    ], { name: 'indicator-templates', minWidth: 240 });
  }

  private layoutMenu(anchor: HTMLElement) {
    const content = document.createElement('div');
    const cur = this.app.grid, sync = this.app.sync;
    content.innerHTML = LAYOUT_ROWS.map(r => `<div class="layout-row"><span>${r.n}</span>${r.modes.map(m =>
      `<button data-grid="${m}" class="${m === cur ? 'selected' : ''}" title="${m}">${icon(LAYOUT_ICON[m])}</button>`).join('')}</div>`).join('') +
      `<div class="menu-section">Sync in layout</div>` +
      (['symbol', 'interval', 'crosshair', 'time'] as const).map(k => `<button class="menu-row" data-sync="${k}"><span class="label">${k[0].toUpperCase() + k.slice(1)}</span>
        <span class="toggle ${sync[k] ? 'on' : ''}"></span></button>`).join('');
    content.addEventListener('click', e => {
      const g = (e.target as HTMLElement).closest<HTMLElement>('[data-grid]')?.dataset.grid as GridMode | undefined;
      if (g) {
        this.app.setGrid(g);
        content.querySelectorAll<HTMLElement>('[data-grid]').forEach(b => b.classList.toggle('selected', b.dataset.grid === g));
      }
      const k = (e.target as HTMLElement).closest<HTMLElement>('[data-sync]')?.dataset.sync as keyof typeof sync | undefined;
      if (k) {
        this.app.setSync(k, !this.app.sync[k]);
        content.querySelector(`[data-sync="${k}"] .toggle`)!.classList.toggle('on', this.app.sync[k]);
      }
    });
    openMenu(anchor, [], { name: 'layout-setup', content, align: 'end', minWidth: 260 });
  }

  private async layoutsMenu(anchor: HTMLElement) {
    const layouts = await this.app.listLayouts();
    openMenu(anchor, [
      { label: 'Save layout', hint: `${KEY.mod}S`, onClick: () => this.app.saveLayout() },
      { label: 'Autosave', toggle: this.app.autosave, keepOpen: true, onClick: () => this.app.setAutosave(!this.app.autosave) },
      { label: 'Make a copy…', onClick: () => this.app.copyLayout() },
      { label: 'Rename…', onClick: () => this.app.renameLayout() },
      { label: 'Download chart data…', onClick: () => this.app.downloadData() },
      { label: 'Create new layout…', onClick: () => this.app.newLayout() },
      ...(layouts.length ? [{ section: 'Recently used' } as MenuItem] : []),
      ...layouts.slice(0, 6).map(l => ({ id: String(l.id), html: `${esc(l.name)}<span class="sub">${esc(l.summary ?? '')}</span>`,
        selected: l.id === this.app.layoutId, removable: l.id !== this.app.layoutId,
        onClick: () => this.app.loadLayout(l.id), onRemove: () => this.app.deleteLayout(l.id) })),
      { label: 'Open layout…', onClick: () => this.app.openLayoutDialog() },
    ], { name: 'manage-layouts', align: 'end', minWidth: 220 });
  }

  private snapshotMenu(anchor: HTMLElement) {
    openMenu(anchor, [
      { section: 'Chart snapshot' },
      { label: 'Download image', icon: 'download', hint: `${KEY.alt}${KEY.mod}S`, onClick: () => this.app.snapshot('download') },
      { label: 'Copy image', icon: 'camera', hint: `${KEY.shift}${KEY.mod}S`, onClick: () => this.app.snapshot('copy') },
      { label: 'Open in new tab', icon: 'link', onClick: () => this.app.snapshot('tab') },
    ], { name: 'snapshot', align: 'end', variant: 'tall', minWidth: 260 });
  }

  private sourceMenu(anchor: HTMLElement) {
    const s = this.app.view.source;
    openMenu(anchor, [
      { section: 'Data source' },
      { label: 'TradingView feed', hint: this.app.feedState === 'tradingview' ? 'online' : 'offline', checked: s === 'tradingview', disabled: true },
      { label: 'Local panels (fallback)', hint: 'daily, 前复权', checked: s === 'local', disabled: true },
    ], { name: 'data-source', minWidth: 260 });
  }

  private appMenu(anchor: HTMLElement) {
    const dark = document.documentElement.dataset.theme === 'dark';
    openMenu(anchor, [
      { label: 'Dark theme', icon: 'moon', toggle: dark, onClick: () => this.app.setTheme(dark ? 'light' : 'dark') },
      { label: 'Keyboard shortcuts', icon: 'keyboard', onClick: () => this.app.showShortcuts() },
      { separator: true },
      { label: 'Strategy report', icon: 'strategy', onClick: () => this.app.strategy.toggle(true) },
    ], { name: 'app-menu', variant: 'tall', minWidth: 240 });
  }
}
