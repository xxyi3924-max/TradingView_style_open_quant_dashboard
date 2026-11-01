// Popup menus (TradingView style: white, 6px radius, 32px rows or 40px icon rows, uppercase section
// headers, hotkey hints) and hover tooltips. One menu is open at a time; Escape or an outside click closes it.
import { icon } from './icons';

export interface MenuItem {
  label?: string;
  html?: string;             // custom row content instead of label
  icon?: string;             // icon name
  hint?: string;             // right-aligned hotkey / note
  selected?: boolean;        // dark "current choice" row
  checked?: boolean;         // check-mark row (undefined = no check column)
  toggle?: boolean;          // switch on the right (true/false), undefined = none
  disabled?: boolean;
  section?: string;          // section header (no row)
  separator?: boolean;
  id?: string;
  title?: string;
  removable?: boolean;       // shows an x button that calls onRemove
  keepOpen?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}

export interface MenuOptions {
  name: string;
  side?: 'bottom' | 'right' | 'top' | 'left';
  align?: 'start' | 'end';
  variant?: 'flyout' | 'tall';
  minWidth?: number;
  content?: HTMLElement;     // custom body appended after the items
  search?: (q: string) => MenuItem[];   // filterable list (input at the top)
  onClose?: () => void;
}

let current: { el: HTMLElement; anchor: HTMLElement | null; close: () => void } | null = null;
const root = () => document.getElementById('popup-root')!;

export const isMenuOpen = () => current !== null;
export function closeMenu() { current?.close(); }

function rowHtml(it: MenuItem): string {
  if (it.section) return `<div class="menu-section">${it.section}</div>`;
  if (it.separator) return '<div class="menu-sep"></div>';
  const check = it.checked === undefined ? '' : `<span class="check">${it.checked ? icon('check', 18) : ''}</span>`;
  const ico = it.icon ? icon(it.icon) : '';
  const toggle = it.toggle === undefined ? '' : `<span class="toggle ${it.toggle ? 'on' : ''}"></span>`;
  const x = it.removable ? `<button class="x" data-x title="Remove">${icon('close', 18)}</button>` : '';
  return `<button class="menu-row ${it.selected ? 'selected' : ''}" role="menuitem" ${it.disabled ? 'aria-disabled="true"' : ''}
    ${it.id ? `data-id="${it.id}"` : ''} ${it.title ? `title="${it.title}"` : ''}>${check}${ico}<span class="label">${it.html ?? it.label ?? ''}</span>
    ${it.hint ? `<span class="hint">${it.hint}</span>` : ''}${toggle}${x}</button>`;
}

/** Open a menu anchored to `anchor` (or at a point). Returns a handle with close(). */
export function openMenu(anchor: HTMLElement | { x: number; y: number }, items: MenuItem[], opts: MenuOptions) {
  const anchorEl = anchor instanceof HTMLElement ? anchor : null;
  // a second click on the same anchor toggles the menu closed
  if (current && anchorEl && current.anchor === anchorEl) { closeMenu(); return null; }
  closeMenu();
  const el = document.createElement('div');
  el.className = `menu ${opts.variant ?? ''}`;
  el.dataset.menu = opts.name;
  el.setAttribute('role', 'menu');
  if (opts.minWidth) el.style.minWidth = `${opts.minWidth}px`;
  let shown = items;
  const list = document.createElement('div');
  const render = () => {
    list.innerHTML = shown.map(rowHtml).join('');
    const rows = shown.filter(i => !i.section && !i.separator);
    list.querySelectorAll<HTMLElement>('.menu-row').forEach((b, i) => {
      const it = rows[i];
      b.addEventListener('click', e => {
        if ((e.target as HTMLElement).closest('[data-x]')) { e.stopPropagation(); it.onRemove?.(); if (!it.keepOpen) close(); return; }
        if (it.disabled) return;
        if (!it.keepOpen) close();
        it.onClick?.();
        if (it.keepOpen && it.toggle !== undefined) { it.toggle = !it.toggle; render(); }
      });
    });
  };
  if (opts.search) {
    const input = document.createElement('input');
    input.className = 'menu-search';
    input.placeholder = 'Search';
    input.addEventListener('input', () => { shown = opts.search!(input.value); render(); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') close(); e.stopPropagation(); });
    el.appendChild(input);
    setTimeout(() => input.focus(), 0);
  }
  el.appendChild(list);
  if (opts.content) el.appendChild(opts.content);
  render();
  root().appendChild(el);
  place(el, anchor, opts.side ?? 'bottom', opts.align ?? 'start');
  anchorEl?.classList.add('open');
  const onDown = (e: PointerEvent) => {
    const t = e.target as Node;
    if (!el.contains(t) && !(anchorEl && anchorEl.contains(t))) close();
  };
  const close = () => {
    if (!current || current.el !== el) return;
    el.remove();
    anchorEl?.classList.remove('open');
    document.removeEventListener('pointerdown', onDown, true);
    current = null;
    opts.onClose?.();
  };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  current = { el, anchor: anchorEl, close };
  return { el, close };
}

function place(el: HTMLElement, anchor: HTMLElement | { x: number; y: number }, side: string, align: string) {
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : new DOMRect(anchor.x, anchor.y, 0, 0);
  const w = el.offsetWidth, h = el.offsetHeight, W = innerWidth, H = innerHeight;
  let x = 0, y = 0;
  if (side === 'bottom') { y = r.bottom + 2; x = align === 'end' ? r.right - w : r.left; }
  if (side === 'top') { y = r.top - h - 2; x = align === 'end' ? r.right - w : r.left; }
  if (side === 'right') { x = r.right + 1; y = r.top; }
  if (side === 'left') { x = r.left - w - 1; y = r.top; }
  x = Math.max(4, Math.min(x, W - w - 4));
  y = Math.max(4, Math.min(y, H - h - 4));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

// ------------------------------------------------------------------ tooltips
let tipEl: HTMLElement | null = null;
let tipTimer = 0;

/** Elements with data-tip="text" (+ optional data-hint, data-side) get a dark tooltip after a short hover. */
export function initTooltips() {
  document.addEventListener('pointerover', e => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    clearTimeout(tipTimer);
    tipEl?.remove(); tipEl = null;
    if (!t || isMenuOpenFor(t)) return;
    tipTimer = window.setTimeout(() => show(t), 450);
  });
  document.addEventListener('pointerdown', () => { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null; }, true);
}
const isMenuOpenFor = (t: HTMLElement) => !!current && current.anchor === t;

function show(t: HTMLElement) {
  if (!t.isConnected) return;
  const side = t.dataset.side ?? 'bottom';
  tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.dataset.side = side;
  tipEl.innerHTML = `${t.dataset.tip}${t.dataset.hint ? `<span class="hint">${t.dataset.hint}</span>` : ''}`;
  document.body.appendChild(tipEl);
  const r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  let x = r.left + r.width / 2 - w / 2, y = r.bottom + 8;
  if (side === 'right') { x = r.right + 8; y = r.top + r.height / 2 - h / 2; }
  if (side === 'left') { x = r.left - w - 8; y = r.top + r.height / 2 - h / 2; }
  if (side === 'top') { y = r.top - h - 8; }
  tipEl.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
  tipEl.style.top = `${Math.max(4, y)}px`;
}

/** Platform hotkey label: ⌥ / ⌘ on macOS, Alt / Ctrl elsewhere. */
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const KEY = { alt: isMac ? '⌥ ' : 'Alt + ', mod: isMac ? '⌘ ' : 'Ctrl + ', shift: isMac ? '⇧ ' : 'Shift + ' };
