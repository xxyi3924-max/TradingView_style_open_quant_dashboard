// Left drawing toolbar in TradingView's structure (re/ui/menus): tool groups whose button shows the last
// tool used in that group and whose chevron opens a flyout; then measure/zoom; magnet, keep drawing,
// lock, hide; remove. Only tools we implement are listed.
import type { App } from '../main';
import type { Tool } from '../drawings/layer';
import type { CursorStyle } from '../chart/view';
import { icon } from './icons';
import { KEY, openMenu, type MenuItem } from './menu';

type Choice = { id: string; label: string; icon: string; hint?: string };
interface Group { key: string; title: string; sections: { title?: string; items: Choice[] }[] }

const A = KEY.alt;
export const GROUPS: Group[] = [
  { key: 'cursors', title: 'Cursors', sections: [{ items: [
    { id: 'cross', label: 'Cross', icon: 'cross' }, { id: 'dot', label: 'Dot', icon: 'dot' }, { id: 'arrow', label: 'Arrow', icon: 'arrow' },
    { id: 'eraser', label: 'Eraser', icon: 'eraser' }] }] },
  { key: 'trend', title: 'Trend tools', sections: [{ title: 'Lines', items: [
    { id: 'trend', label: 'Trendline', icon: 'trend', hint: `${A}T` }, { id: 'ray', label: 'Ray', icon: 'ray' },
    { id: 'extended', label: 'Extended line', icon: 'extended' }, { id: 'hline', label: 'Horizontal line', icon: 'hline', hint: `${A}H` },
    { id: 'hray', label: 'Horizontal ray', icon: 'hray', hint: `${A}J` }, { id: 'vline', label: 'Vertical line', icon: 'vline', hint: `${A}V` },
    { id: 'crossline', label: 'Crossline', icon: 'crossline', hint: `${A}C` }] }] },
  { key: 'fib', title: 'Gann and Fibonacci tools', sections: [{ title: 'Fibonacci', items: [
    { id: 'fib', label: 'Fib retracement', icon: 'fib', hint: `${A}F` }] }] },
  { key: 'forecast', title: 'Forecasting and measurement tools', sections: [
    { title: 'Forecasting', items: [{ id: 'long', label: 'Long position', icon: 'long' }, { id: 'short', label: 'Short position', icon: 'short' }] },
    { title: 'Measurers', items: [{ id: 'pricerange', label: 'Price range', icon: 'pricerange' }, { id: 'daterange', label: 'Date range', icon: 'daterange' },
      { id: 'datepricerange', label: 'Date and price range', icon: 'datepricerange' }] }] },
  { key: 'shapes', title: 'Geometric shapes', sections: [{ title: 'Shapes', items: [
    { id: 'rect', label: 'Rectangle', icon: 'rect', hint: `${A}${KEY.shift}R` }, { id: 'circle', label: 'Circle', icon: 'circle' }] }] },
  { key: 'annotation', title: 'Annotation tools', sections: [{ title: 'Text and notes', items: [
    { id: 'text', label: 'Text', icon: 'text' }, { id: 'pricelabel', label: 'Price label', icon: 'pricelabel' }] }] },
];
const CURSOR_STYLES = new Set(['cross', 'dot', 'arrow']);
const groupOf = (id: string) => GROUPS.find(g => g.sections.some(s => s.items.some(i => i.id === id)));
const choice = (id: string) => GROUPS.flatMap(g => g.sections.flatMap(s => s.items)).find(i => i.id === id)!;

export class DrawBar {
  /** Tool currently shown on each group button (TradingView remembers the last one used). */
  private shown: Record<string, string>;

  constructor(private el: HTMLElement, private app: App) {
    let saved: Record<string, string> = {};
    try { saved = JSON.parse(localStorage.getItem('drawbar') ?? '{}'); } catch { /* storage unavailable */ }
    this.shown = Object.fromEntries(GROUPS.map(g => [g.key, saved[g.key] && groupOf(saved[g.key])?.key === g.key ? saved[g.key] : g.sections[0].items[0].id]));
    this.render();
    el.addEventListener('click', e => this.onClick(e));
  }

  private item(key: string, ico: string, tip: string, hint = '', more = false, extra = '') {
    return `<div class="dt-item" data-item="${key}"><button class="dt-btn" data-main="${key}" data-tip="${tip}" data-side="right" ${hint ? `data-hint="${hint}"` : ''}
      aria-label="${tip}" ${extra}>${icon(ico)}</button>${more ? `<button class="dt-more" data-more="${key}" aria-label="${tip} options">${icon('chevronRight')}</button>` : ''}</div>`;
  }

  render() {
    const groups = GROUPS.map(g => {
      const c = choice(this.shown[g.key]);
      return this.item(g.key, c.icon, c.label, c.hint, true, `data-tool="${c.id}"`);
    }).join('');
    const a = this.app;
    this.el.innerHTML = `<div style="height:6px"></div>${groups}<div class="dt-sep"></div>
      ${this.item('measure', 'ruler', 'Measure', `${KEY.shift}Click on the chart`, false, 'data-tool="measure"')}
      ${this.item('zoom', 'zoomin', 'Zoom in', '', false, 'data-tool="zoom"')}<div class="dt-sep"></div>
      ${this.item('magnet', a.magnetMode === 'strong' ? 'magnetStrong' : 'magnet', a.magnetMode === 'strong' ? 'Strong magnet' : 'Weak magnet', '', true)}
      ${this.item('keepdraw', 'keepdraw', 'Keep drawing')}
      ${this.item('lock', a.lockAll ? 'lock' : 'unlock', a.lockAll ? 'Unlock all drawings' : 'Lock all drawings', '', true)}
      ${this.item('hide', a.hideDrawings || a.hideStudies ? 'eyeoff' : 'eye', 'Hide all drawings', '', true)}<div class="dt-sep"></div>
      ${this.item('remove', 'trash', 'Remove drawings', '', true)}`;
    this.sync();
  }

  /** Active/toggled states from the app. */
  sync() {
    const a = this.app, tool = a.view?.drawingLayer.tool ?? 'cursor';
    this.el.querySelectorAll<HTMLElement>('[data-main]').forEach(b => {
      const k = b.dataset.main!;
      let on = false;
      if (k === 'cursors') on = tool === 'cursor' || tool === 'eraser';
      else if (groupOf(this.shown[k] ?? '')?.key === k) on = b.dataset.tool === tool;
      if (k === 'measure' || k === 'zoom') on = tool === k;
      if (k === 'magnet') on = a.magnetMode !== 'off';
      if (k === 'keepdraw') on = a.keepDrawing;
      if (k === 'lock') on = a.lockAll;
      if (k === 'hide') on = a.hideDrawings || a.hideStudies;
      b.classList.toggle('active', on);
    });
    const cur = this.el.querySelector<HTMLElement>('[data-main="cursors"]');
    if (cur) {
      const id = tool === 'eraser' ? 'eraser' : a.cursorStyle;
      cur.innerHTML = icon(choice(id).icon);
      cur.dataset.tool = id;
      cur.dataset.tip = choice(id).label;
    }
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const more = t.closest<HTMLElement>('[data-more]');
    if (more) { this.flyout(more.dataset.more!, more); return; }
    const main = t.closest<HTMLElement>('[data-main]');
    if (!main) return;
    const k = main.dataset.main!, a = this.app;
    if (k === 'measure' || k === 'zoom') { a.selectTool(a.view.drawingLayer.tool === k ? 'cursor' : k); return; }
    if (k === 'magnet') { a.setMagnet(a.magnetMode === 'off' ? a.lastMagnet : 'off'); return; }
    if (k === 'keepdraw') { a.setKeepDrawing(!a.keepDrawing); return; }
    if (k === 'lock') { a.setLockAll(!a.lockAll); return; }
    if (k === 'hide') { a.setHidden('drawings', !a.hideDrawings); return; }
    if (k === 'remove') { a.removeAll('drawings'); return; }
    this.pick(main.dataset.tool!);
  }

  /** Select a tool/cursor from a group (button or flyout); the group button then shows it. */
  pick(id: string) {
    const g = groupOf(id);
    if (g) { this.shown[g.key] = id; try { localStorage.setItem('drawbar', JSON.stringify(this.shown)); } catch { /* ignore */ } }
    if (CURSOR_STYLES.has(id)) { this.app.setCursorStyle(id as CursorStyle); this.app.selectTool('cursor'); }
    else this.app.selectTool(id as Tool);
    this.render();
  }

  private flyout(key: string, anchor: HTMLElement) {
    const a = this.app, ds = a.view.drawings().length, ss = a.view.studies.length;
    let items: MenuItem[] = [];
    const g = GROUPS.find(x => x.key === key);
    if (g) {
      const tool = a.view.drawingLayer.tool;
      for (const s of g.sections) {
        if (s.title) items.push({ section: s.title });
        for (const c of s.items) {
          const sel = key === 'cursors' ? (c.id === 'eraser' ? tool === 'eraser' : tool !== 'eraser' && c.id === a.cursorStyle) : tool === c.id;
          items.push({ label: c.label, icon: c.icon, hint: c.hint, id: c.id, selected: sel, onClick: () => this.pick(c.id) });
        }
      }
    } else if (key === 'magnet') {
      items = [
        { label: 'Weak magnet', icon: 'magnet', selected: a.magnetMode === 'weak', onClick: () => a.setMagnet(a.magnetMode === 'weak' ? 'off' : 'weak') },
        { label: 'Strong magnet', icon: 'magnetStrong', selected: a.magnetMode === 'strong', onClick: () => a.setMagnet(a.magnetMode === 'strong' ? 'off' : 'strong') },
      ];
    } else if (key === 'lock') {
      items = [{ label: 'Lock drawings', toggle: a.lockAll, keepOpen: true, onClick: () => a.setLockAll(!a.lockAll) }];
    } else if (key === 'hide') {
      items = [
        { label: 'Hide drawings', toggle: a.hideDrawings, keepOpen: true, onClick: () => a.setHidden('drawings', !a.hideDrawings) },
        { label: 'Hide indicators', toggle: a.hideStudies, keepOpen: true, onClick: () => a.setHidden('indicators', !a.hideStudies) },
        { label: 'Hide all', onClick: () => a.setHidden('all', !(a.hideDrawings && a.hideStudies)) },
      ];
    } else if (key === 'remove') {
      const pl = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
      items = [
        { label: `Remove ${pl(ds, 'drawing')}`, disabled: !ds, onClick: () => a.removeAll('drawings') },
        { label: `Remove ${pl(ss, 'indicator')}`, disabled: !ss, onClick: () => a.removeAll('indicators') },
        { label: `Remove ${pl(ds, 'drawing')} & ${pl(ss, 'indicator')}`, disabled: !ds && !ss, onClick: () => a.removeAll('all') },
      ];
    }
    openMenu(anchor.closest('.dt-item') as HTMLElement, items, { name: `flyout-${key}`, side: 'right', variant: g ? 'flyout' : undefined, minWidth: g ? 268 : 207 });
  }
}
