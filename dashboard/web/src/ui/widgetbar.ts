// Right side: 45px icon strip + 302px widget pages, as on TradingView (re/ui/ui_measurements.json):
// watchlist with sections and a details card, alerts (Alerts | Log), object tree / data window.
// Clicking the active strip icon collapses the pages.
import type { App } from '../main';
import { api, subscribe, type Alert, type Details, type Watchlist } from '../api';
import { TOOL_LABELS } from '../drawings/model';
import { fmtNum } from '../chart/view';
import { icon } from './icons';
import { KEY, openMenu, type MenuItem } from './menu';
import { esc, logo, promptText, toast } from './dialogs';

type PageKey = 'watchlist' | 'alerts' | 'objects';
type Quote = { lp?: number; ch?: number; chp?: number; volume?: number; current_session?: string; description?: string };

const SECTION = '###';
const fmtP = (x: number | undefined | null, d = 2) => (x === undefined || x === null || !Number.isFinite(x) ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const sign = (x: number) => (x > 0 ? '+' : x < 0 ? '−' : '');
const decimals = (x: number | undefined) => (x === undefined ? 2 : Math.abs(x) < 10 ? 3 : 2);
const pct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${sign(x)}${Math.abs(x * 100).toFixed(2)}%`);

export class WidgetBar {
  page: PageKey | null = 'watchlist';
  readonly watchlist: WatchlistPage;
  readonly alerts: AlertsPage;
  readonly objects: ObjectTreePage;

  constructor(private strip: HTMLElement, private pages: HTMLElement, private app: App) {
    const b = (key: string, ico: string, tip: string, hint = '') =>
      `<button class="rs-btn" data-page="${key}" data-tip="${tip}" data-side="left" ${hint ? `data-hint="${hint}"` : ''} aria-label="${tip}">${icon(ico)}</button>`;
    strip.innerHTML = `${b('watchlist', 'watchlist', 'Watchlist, details and news')}${b('alerts', 'alarm', 'Alerts')}
      ${b('objects', 'layers', 'Object tree and data window')}<span class="rs-fill"></span>
      ${b('strategy', 'strategy', 'Strategy report')}<span class="rs-sep"></span>${b('help', 'help', 'Help: keyboard shortcuts')}`;
    pages.innerHTML = '<div class="wpage" data-p="watchlist"></div><div class="wpage" data-p="alerts" hidden></div><div class="wpage" data-p="objects" hidden></div>';
    const pg = (k: string) => pages.querySelector<HTMLElement>(`[data-p="${k}"]`)!;
    this.watchlist = new WatchlistPage(pg('watchlist'), app);
    this.alerts = new AlertsPage(pg('alerts'), app);
    this.objects = new ObjectTreePage(pg('objects'), app);
    strip.addEventListener('click', e => {
      const k = (e.target as HTMLElement).closest<HTMLElement>('[data-page]')?.dataset.page;
      if (!k) return;
      if (k === 'strategy') { app.strategy.toggle(); this.sync(); return; }
      if (k === 'help') { app.showShortcuts(); return; }
      this.show(this.page === k ? null : k as PageKey);
    });
    let saved: string | null = null;
    try { saved = localStorage.getItem('widget_page'); } catch { /* ignore */ }
    if (saved === 'none') this.show(null); else if (saved === 'alerts' || saved === 'objects') this.show(saved); else this.show('watchlist');
  }

  show(page: PageKey | null) {
    this.page = page;
    this.pages.hidden = page === null;
    this.pages.querySelectorAll<HTMLElement>('[data-p]').forEach(p => { p.hidden = p.dataset.p !== page; });
    try { localStorage.setItem('widget_page', page ?? 'none'); } catch { /* ignore */ }
    if (page === 'objects') this.objects.render();
    this.sync();
  }

  sync() {
    this.strip.querySelectorAll<HTMLElement>('[data-page]').forEach(b => b.classList.toggle('active',
      b.dataset.page === this.page || (b.dataset.page === 'strategy' && this.app.strategy.open)));
  }

  /** Active chart changed symbol/data/studies/drawings. */
  onChartChange() {
    this.watchlist.onActiveSymbol();
    if (this.page === 'objects') this.objects.render();
  }
  onCrosshair() { if (this.page === 'objects') this.objects.renderDataWindow(); }
}

// ------------------------------------------------------------------------------------- watchlist + details
interface Cols { last: boolean; chg: boolean; chgp: boolean; vol: boolean; logo: boolean; name: boolean }

export class WatchlistPage {
  lists: Watchlist[] = [];
  current: Watchlist | null = null;
  details: Details | null = null;
  private quotes: Record<string, Quote> = {};
  private stop: (() => void) | null = null;
  private collapsed = new Set<string>();
  private cols: Cols = { last: true, chg: true, chgp: true, vol: false, logo: true, name: false };
  private detailsFor = '';
  private listH = 280;
  onChange: (id: number) => void = () => {};

  constructor(private el: HTMLElement, private app: App) {
    try { Object.assign(this.cols, JSON.parse(localStorage.getItem('wl_cols') ?? '{}')); } catch { /* ignore */ }
    try { this.listH = Number(localStorage.getItem('wl_height')) || 280; } catch { /* ignore */ }
    el.innerHTML = `<div class="wp-head"><button class="wp-title" data-a="lists"><span data-name>Watchlist</span>${icon('chevronDown')}</button>
        <span class="spacer"></span><button class="wbtn" data-a="add" data-tip="Add symbol" aria-label="Add symbol">${icon('plus')}</button>
        <button class="wbtn" data-a="settings" data-tip="Settings" aria-label="Watchlist settings">${icon('more')}</button></div>
      <div class="wl-cols"></div><div class="wl-list" tabindex="0"></div>
      <div class="splitter" data-a="split"></div><div class="details"></div>`;
    el.addEventListener('click', e => this.onClick(e));
    const list = el.querySelector<HTMLElement>('.wl-list')!;
    list.style.height = `${this.listH}px`;
    list.addEventListener('keydown', e => this.onKey(e));
    this.bindSplitter(el.querySelector<HTMLElement>('.splitter')!, list);
  }

  async init(preferredId?: number) {
    this.lists = await api.watchlists();
    this.current = this.lists.find(l => l.id === preferredId) ?? this.lists[0] ?? null;
    this.render();
    this.stream();
  }

  private symbols() { return (this.current?.symbols ?? []).filter(s => !s.startsWith(SECTION)); }

  private stream() {
    this.stop?.();
    const syms = [...new Set([...this.symbols(), ...(this.app.view?.symbol ? [this.app.view.symbol] : [])])];
    if (!syms.length) return;
    this.stop = subscribe(`/api/stream/quotes?symbols=${encodeURIComponent(syms.join(','))}`, {
      quote: (q: Quote & { symbol: string }) => {
        this.quotes[q.symbol] = { ...this.quotes[q.symbol], ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== null)) };
        this.renderRow(q.symbol);
        if (q.symbol === this.detailsFor) this.renderDetails();
      },
    });
  }

  private grid() {
    const c = this.cols;
    return ['minmax(0,1fr)', c.last ? '68px' : '', c.chg ? '62px' : '', c.chgp ? '58px' : '', c.vol ? '60px' : ''].filter(Boolean).join(' ');
  }

  private rowHtml(sym: string) {
    const q = this.quotes[sym] ?? {}, c = this.cols;
    const short = sym.split(':').pop()!;
    const name = c.name && q.description ? `<small>${esc(q.description)}</small>` : '';
    return `${c.logo ? logo(sym) : ''}<b title="${esc(sym)}">${esc(short)}</b>${name}`;
  }
  private cellsHtml(sym: string) {
    const q = this.quotes[sym] ?? {}, c = this.cols, d = decimals(q.lp);
    const cls = (q.ch ?? 0) > 0 ? 'up' : (q.ch ?? 0) < 0 ? 'down' : '';
    return [
      c.last ? `<span class="num">${fmtP(q.lp, d)}</span>` : '',
      c.chg ? `<span class="num ${cls}">${q.ch === undefined ? '—' : `${sign(q.ch)}${fmtP(Math.abs(q.ch), d)}`}</span>` : '',
      c.chgp ? `<span class="num ${cls}">${q.chp === undefined ? '—' : `${sign(q.chp)}${Math.abs(q.chp).toFixed(2)}%`}</span>` : '',
      c.vol ? `<span class="num">${q.volume === undefined ? '—' : fmtNum(q.volume)}</span>` : '',
    ].join('');
  }
  private renderRow(sym: string) {
    const r = this.el.querySelector<HTMLElement>(`.wl-row[data-sym="${CSS.escape(sym)}"]`);
    if (r) r.innerHTML = `<span class="s">${this.rowHtml(sym)}</span>${this.cellsHtml(sym)}<button class="rm" data-del="${esc(sym)}" title="Remove from watchlist">${icon('close', 16)}</button>`;
  }

  render() {
    const c = this.current, g = this.grid(), active = this.app.view?.symbol;
    this.el.querySelector('[data-name]')!.textContent = c?.name ?? 'Watchlist';
    const head = this.el.querySelector<HTMLElement>('.wl-cols')!;
    head.style.gridTemplateColumns = g;
    head.innerHTML = `<span>Symbol</span>${this.cols.last ? '<span class="num">Last</span>' : ''}${this.cols.chg ? '<span class="num">Chg</span>' : ''}
      ${this.cols.chgp ? '<span class="num">Chg%</span>' : ''}${this.cols.vol ? '<span class="num">Vol</span>' : ''}`;
    let section = '';
    const rows: string[] = [];
    for (const s of c?.symbols ?? []) {
      if (s.startsWith(SECTION)) {
        section = s.slice(3);
        rows.push(`<div class="wl-section ${this.collapsed.has(section) ? 'collapsed' : ''}" data-section="${esc(section)}">${icon('chevronDown')}${esc(section)}</div>`);
        continue;
      }
      if (section && this.collapsed.has(section)) continue;
      rows.push(`<div class="wl-row ${s === active ? 'sel' : ''}" data-sym="${esc(s)}" style="grid-template-columns:${g}"><span class="s">${this.rowHtml(s)}</span>
        ${this.cellsHtml(s)}<button class="rm" data-del="${esc(s)}" title="Remove from watchlist">${icon('close', 16)}</button></div>`);
    }
    this.el.querySelector('.wl-list')!.innerHTML = rows.join('') || '<div class="empty">Your watchlist is empty<button class="pill-btn light" data-a="add">Add symbol</button></div>';
    this.renderDetails();
  }

  onActiveSymbol() {
    const s = this.app.view?.symbol;
    this.el.querySelectorAll<HTMLElement>('.wl-row').forEach(r => r.classList.toggle('sel', r.dataset.sym === s));
    if (s && s !== this.detailsFor) {
      this.detailsFor = s;
      this.details = null;
      this.renderDetails();
      api.details(s).then(d => { if (d.symbol === this.detailsFor) { this.details = d; this.renderDetails(); } }).catch(() => this.renderDetails());
      if (!this.symbols().includes(s)) this.stream();
    }
  }

  renderDetails() {
    const box = this.el.querySelector<HTMLElement>('.details')!;
    const sym = this.detailsFor, d = this.details;
    if (!sym) { box.innerHTML = ''; return; }
    const q = this.quotes[sym] ?? {};
    const last = q.lp ?? d?.last ?? null, ch = q.ch ?? d?.change ?? null, chp = q.chp ?? d?.change_pct ?? null;
    const cls = (ch ?? 0) > 0 ? 'up' : (ch ?? 0) < 0 ? 'down' : '';
    const dec = decimals(last ?? undefined);
    const status = q.current_session ?? d?.session.status ?? null;
    const label = status ? ({ market: 'Market open', pre_market: 'Pre-market', post_market: 'Post-market' } as Record<string, string>)[status] ?? 'Market closed' : (d?.source === 'local' ? 'Local data (end of day)' : '');
    const st = d?.stats ?? {};
    const kv = (k: string, v: string) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
    const perf = st.performance ? Object.entries(st.performance).map(([k, v]) =>
      `<div class="${v === null ? '' : v >= 0 ? 'up' : 'down'}">${pct(v)}<small>${k}</small></div>`).join('') : '';
    box.innerHTML = `<div class="dt-head">${logo(sym, 24)}<span>${esc(sym.split(':').pop())}</span></div>
      <div class="dt-desc">${esc(d?.description ?? q.description ?? sym)} <span class="muted">·</span> ${esc(d?.exchange ?? sym.split(':')[0])}</div>
      ${d?.sector || d?.industry ? `<div class="dt-meta">${[d.sector, d.industry].filter(Boolean).map(esc).join(' • ')}</div>` : ''}
      <div class="dt-price"><span class="p ${cls}" data-k="last">${fmtP(last, dec)}</span>${d?.session.delayed_minutes ? '<sup title="Delayed data">D</sup>' : ''}
        <span class="c">${esc(d?.currency ?? '')}</span><span class="ch ${cls}">${ch === null ? '' : `${sign(ch)}${fmtP(Math.abs(ch), dec)}`}&nbsp;&nbsp;${chp === null ? '' : `${sign(chp)}${Math.abs(chp).toFixed(2)}%`}</span></div>
      <div class="dt-status" data-s="${status ?? ''}"><span class="mstatus" data-s="${status ?? ''}"></span>${esc(label)}${d?.session.delayed_minutes ? `<span class="muted">&nbsp;· delayed ${d.session.delayed_minutes} min</span>` : ''}</div>
      <div class="dt-h">Key stats</div>
      ${kv('Volume', q.volume ?? d?.volume ? fmtNum((q.volume ?? d?.volume)!) : '—')}
      ${kv('Average Volume (30D)', st.avg_volume_30d ? fmtNum(st.avg_volume_30d) : '—')}
      ${d?.market_cap ? kv('Market capitalization', fmtNum(d.market_cap)) : ''}
      ${kv('52 week high', fmtP(st.high_52w, dec))}${kv('52 week low', fmtP(st.low_52w, dec))}
      ${kv('Dividend yield (indicated)', d?.dividends_yield === null || d?.dividends_yield === undefined ? '—' : `${d.dividends_yield.toFixed(2)}%`)}
      ${d?.beta_1y ? kv('Beta (1Y)', d.beta_1y.toFixed(2)) : ''}${d?.pe_ttm ? kv('P/E (TTM)', d.pe_ttm.toFixed(2)) : ''}
      ${perf ? `<div class="dt-h">Performance</div><div class="perf">${perf}</div>` : ''}`;
  }

  private bindSplitter(split: HTMLElement, list: HTMLElement) {
    split.addEventListener('pointerdown', e => {
      const y0 = e.clientY, h0 = list.offsetHeight;
      const move = (ev: PointerEvent) => { this.listH = Math.max(60, Math.min(innerHeight - 220, h0 + ev.clientY - y0)); list.style.height = `${this.listH}px`; };
      const up = () => { document.removeEventListener('pointermove', move); try { localStorage.setItem('wl_height', String(this.listH)); } catch { /* ignore */ } };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
    });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = [...this.el.querySelectorAll<HTMLElement>('.wl-row')];
    const i = rows.findIndex(r => r.classList.contains('sel'));
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { this.app.view.load(next.dataset.sym!); next.scrollIntoView({ block: 'nearest' }); }
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
    if (del) { e.stopPropagation(); await this.remove(del); return; }
    const sec = t.closest<HTMLElement>('[data-section]')?.dataset.section;
    if (sec !== undefined) { this.collapsed.has(sec) ? this.collapsed.delete(sec) : this.collapsed.add(sec); this.render(); return; }
    const row = t.closest<HTMLElement>('.wl-row');
    if (row) { await this.app.view.load(row.dataset.sym!); return; }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'add') { const s = await this.app.pickSymbol('Add symbol'); if (s) await this.add(s); }
    if (a === 'lists') this.listsMenu(t.closest<HTMLElement>('[data-a]')!);
    if (a === 'settings') this.settingsMenu(t.closest<HTMLElement>('[data-a]')!);
  }

  private async save(patch: Partial<Watchlist>) {
    if (!this.current) return;
    this.current = await api.updateWatchlist(this.current.id, patch);
    this.lists = this.lists.map(l => (l.id === this.current!.id ? this.current! : l));
    this.render(); this.stream();
  }
  /** Add to the current list (at the end, like TradingView) and bring the row into view; a symbol that is already
   *  listed is just revealed, with a note, instead of the add silently doing nothing. */
  async add(symbol: string) {
    if (!this.current) return;
    const had = this.current.symbols.includes(symbol);
    if (!had) await this.save({ symbols: [...this.current.symbols, symbol] });
    this.reveal(symbol);
    if (had) toast(`${esc(symbol.split(':').pop())} is already in ${esc(this.current.name)}`, 3000);
  }
  private reveal(symbol: string) {
    const row = this.el.querySelector<HTMLElement>(`.wl-row[data-sym="${CSS.escape(symbol)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
  }
  async remove(symbol: string) { if (this.current) await this.save({ symbols: this.current.symbols.filter(s => s !== symbol) }); }
  private select(wl: Watchlist) { this.current = wl; this.render(); this.stream(); this.onChange(wl.id); }

  private listsMenu(anchor: HTMLElement) {
    const c = this.current;
    const items: MenuItem[] = [
      { label: 'Make a copy…', onClick: async () => {
        const name = await promptText('Copy watchlist', `${c?.name ?? 'Watchlist'} copy`); if (!name || !c) return;
        const wl = await api.createWatchlist(name, c.symbols); this.lists.push(wl); this.select(wl); } },
      { label: 'Rename', onClick: async () => { const name = await promptText('Rename watchlist', c?.name ?? ''); if (name) await this.save({ name }); } },
      { label: 'Add section', onClick: async () => {
        const name = await promptText('Section name', 'SECTION', 'Add'); if (name && c) await this.save({ symbols: [...c.symbols, SECTION + name.toUpperCase()] }); } },
      { label: 'Clear list', disabled: !c?.symbols.length, onClick: () => this.save({ symbols: [] }) },
      { separator: true },
      { label: 'Create new list…', onClick: async () => {
        const name = await promptText('New watchlist name', '', 'Create'); if (!name) return;
        const wl = await api.createWatchlist(name); this.lists.push(wl); this.select(wl); } },
      { label: 'Upload list…', onClick: () => this.upload() },
      { label: 'Download list', onClick: () => this.download() },
      { section: 'My watchlists' },
      ...this.lists.map(l => ({ label: l.name, selected: l.id === c?.id, removable: this.lists.length > 1 && l.id !== c?.id,
        onClick: () => this.select(l), onRemove: async () => { await api.deleteWatchlist(l.id); this.lists = this.lists.filter(x => x !== l); } })),
    ];
    openMenu(anchor, items, { name: 'watchlist-menu', minWidth: 210 });
  }

  private settingsMenu(anchor: HTMLElement) {
    const tg = (k: keyof Cols, label: string): MenuItem => ({ label, toggle: this.cols[k], keepOpen: true, onClick: () => {
      this.cols[k] = !this.cols[k];
      try { localStorage.setItem('wl_cols', JSON.stringify(this.cols)); } catch { /* ignore */ }
      this.render();
    } });
    openMenu(anchor, [{ section: 'Customize columns' }, tg('last', 'Last'), tg('chg', 'Change'), tg('chgp', 'Change %'), tg('vol', 'Volume'),
      { section: 'Symbol display' }, tg('logo', 'Logo'), tg('name', 'Name')], { name: 'watchlist-settings', align: 'end', minWidth: 222 });
  }

  /** TradingView's watchlist text format: comma/newline separated ids, sections as ###NAME. */
  private upload() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.txt,.csv';
    input.onchange = async () => {
      const text = await input.files?.[0]?.text();
      if (!text) return;
      const syms = text.split(/[,\n\r]+/).map(s => s.trim()).filter(Boolean);
      const name = input.files![0].name.replace(/\.\w+$/, '');
      const wl = await api.createWatchlist(name, syms);
      this.lists.push(wl); this.select(wl);
      toast(`Imported ${syms.filter(s => !s.startsWith(SECTION)).length} symbols into “${esc(name)}”`);
    };
    input.click();
  }
  private download() {
    if (!this.current) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([this.current.symbols.join(',')], { type: 'text/plain' }));
    a.download = `${this.current.name}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

// ------------------------------------------------------------------------------------- alerts
export class AlertsPage {
  alerts: Alert[] = [];
  private tab: 'alerts' | 'log' = 'alerts';

  constructor(private el: HTMLElement, private app: App) {
    el.innerHTML = `<div class="seg"><button data-tab="alerts" class="active">Alerts</button><button data-tab="log">Log</button></div>
      <div class="wp-head" style="height:42px"><button class="wbtn" data-a="create" data-tip="Create alert" data-hint="${KEY.alt}A" aria-label="Create alert">${icon('alarm')}</button>
        <span class="spacer"></span><button class="wbtn" data-a="check" data-check data-tip="Evaluate alerts now" aria-label="Evaluate alerts now">${icon('replay')}</button></div>
      <div class="list-scroll" data-list></div>`;
    el.addEventListener('click', e => this.onClick(e));
  }

  async init() {
    await this.refresh();
    subscribe('/api/alerts/stream', {
      alert: (ev: { log: { message: string; value: number; bar_time: number } }) => {
        const msg = `${esc(ev.log.message)} <span class="muted">@ ${ev.log.value?.toFixed?.(4)}</span>`;
        toast(`${icon('alarm', 18)} <b>Alert</b><br>${msg}`, 10000);
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Alert', { body: ev.log.message });
        this.refresh();
      },
    });
  }

  async refresh() {
    const [alerts, log] = await Promise.all([api.alerts(), api.alertLog()]);
    this.alerts = alerts;
    const box = this.el.querySelector<HTMLElement>('[data-list]')!;
    if (this.tab === 'alerts') {
      box.innerHTML = alerts.map(a => `<div class="al-row" data-id="${a.id}"><span style="color:var(--muted)">${icon('alarm', 22)}</span><div class="grow">
          <div class="t">${esc(a.message || a.description)}</div>
          <div class="m">${esc(a.symbol)} · ${esc(a.timeframe)} · ${esc(a.trigger.replace(/_/g, ' '))}${a.expires ? ` · expires ${new Date(a.expires * 1000).toLocaleDateString()}` : ''}</div>
          <div class="m"><span class="badge ${a.active ? 'on' : ''}">${a.active ? 'Active' : a.last_fired ? 'Triggered' : 'Stopped'}</span></div></div>
        <div class="acts"><button data-toggle="${a.id}" title="${a.active ? 'Stop' : 'Restart'}">${icon(a.active ? 'pause' : 'play', 20)}</button>
          <button data-del="${a.id}" title="Delete">${icon('trash', 20)}</button></div></div>`).join('')
        || `<div class="empty">Alerts notify you instantly when your conditions are met. Create one to get started.<button class="pill-btn" data-a="create">Create alert</button></div>`;
    } else {
      box.innerHTML = `<div class="log">${log.map(l => `<div class="al-row"><div class="grow"><div class="t">${esc(l.message)}</div>
        <div class="m">${new Date(l.fired_at * 1000).toLocaleString()} · value ${l.value?.toFixed?.(4)}</div></div></div>`).join('')
        || '<div class="empty">No alerts have fired yet.</div>'}</div>`;
    }
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab as 'alerts' | 'log' | undefined;
    if (tab) { this.tab = tab; this.el.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); this.refresh(); return; }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'create') { this.app.openAlert(); return; }
    if (a === 'check') { const r = await api.checkAlerts(); toast(`Checked alerts: ${r.fired.length} fired`); this.refresh(); return; }
    const tg = t.closest<HTMLElement>('[data-toggle]')?.dataset.toggle;
    if (tg) { const al = this.alerts.find(x => x.id === Number(tg))!; await api.updateAlert(al.id, { active: !al.active }); this.refresh(); return; }
    const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
    if (del) { await api.deleteAlert(Number(del)); this.refresh(); }
  }
}

// ------------------------------------------------------------------------------------- object tree + data window
export class ObjectTreePage {
  private tab: 'tree' | 'data' = 'tree';

  constructor(private el: HTMLElement, private app: App) {
    el.innerHTML = `<div class="seg"><button data-tab="tree" class="active">Object tree</button><button data-tab="data">Data window</button></div>
      <div class="list-scroll" data-body></div>`;
    el.addEventListener('click', e => this.onClick(e));
  }

  render() {
    if (this.tab === 'data') { this.renderDataWindow(); return; }
    const v = this.app.view, box = this.el.querySelector<HTMLElement>('[data-body]')!;
    if (!v) return;
    const t = v.title();
    const dl = v.drawingLayer;
    const btn = (act: string, id: string, ico: string, tip: string) => `<button data-act="${act}" data-id="${esc(id)}" title="${tip}">${icon(ico, 20)}</button>`;
    box.innerHTML = `<div class="ot-row">${icon('candles', 20)}<span class="grow"><b>${esc(v.symbol.split(':').pop())}</b> · ${esc(t.exchange)}, ${esc(t.interval)}</span></div>
      <div class="ot-row sub">${icon('columns', 20)}<span class="grow">Volume</span>${btn('vol', '', v.volumeVisible ? 'eye' : 'eyeoff', 'Show/hide')}</div>
      ${v.compares.map(c => `<div class="ot-row sub"><span class="logo" style="background:${c.color}"></span><span class="grow">${esc(c.symbol)}</span>${btn('cmp', c.symbol, 'trash', 'Remove')}</div>`).join('')}
      ${v.studies.map(s => `<div class="ot-row sub">${icon('indicators', 20)}<span class="grow">${esc(s.id)} ${esc(Object.values(s.inputs).join(' '))}</span>
        ${btn('study-vis', s.uid, s.visible ? 'eye' : 'eyeoff', 'Show/hide')}${btn('study-rm', s.uid, 'trash', 'Remove')}</div>`).join('')}
      ${v.drawings().map(d => `<div class="ot-row sub ${dl.selected === d.id ? 'sel' : ''}" data-drawing="${d.id}" style="${dl.selected === d.id ? 'background:var(--select)' : ''}">
        ${icon(d.type === 'hline' ? 'hline' : d.type, 20)}<span class="grow">${esc(TOOL_LABELS[d.type])}</span>
        ${btn('d-vis', d.id, d.hidden ? 'eyeoff' : 'eye', 'Show/hide')}${btn('d-lock', d.id, d.locked ? 'lock' : 'unlock', 'Lock/unlock')}${btn('d-rm', d.id, 'trash', 'Remove')}</div>`).join('')}
      ${!v.studies.length && !v.drawings().length ? '<div class="empty">No indicators or drawings on this chart.</div>' : ''}`;
  }

  renderDataWindow() {
    if (this.tab !== 'data') return;
    const v = this.app.view, box = this.el.querySelector<HTMLElement>('[data-body]')!;
    const x = v?.valuesAt();
    if (!v || !x) { box.innerHTML = '<div class="empty">No data</div>'; return; }
    const t = v.title(), f = (n: number) => v.fmtPrice(n), cls = x.up ? 'up' : 'down';
    const kv = (k: string, val: string, c = cls) => `<div class="kv"><span>${k}</span><b class="${c}">${val}</b></div>`;
    box.innerHTML = `<div class="dw-sec" style="border-top:0"><div class="kv"><span>Date</span><b>${esc(v.formatTime(x.time))}</b></div></div>
      <div class="dw-sec"><h5>${icon('candles', 20)}${esc(v.symbol.split(':').pop())} · ${esc(t.interval)} · ${esc(t.exchange)}</h5>
        ${kv('Open', f(x.bar.open))}${kv('High', f(x.bar.high))}${kv('Low', f(x.bar.low))}${kv('Close', f(x.bar.close))}
        ${kv('Change', `${x.change >= 0 ? '+' : '−'}${f(Math.abs(x.change))} (${x.change >= 0 ? '+' : '−'}${Math.abs(x.changePct).toFixed(2)}%)`)}${kv('Vol', fmtNum(x.bar.volume))}</div>
      ${x.studies.map(s => `<div class="dw-sec"><h5>${icon('indicators', 20)}${esc(s.name)}</h5>${s.outputs.map(o =>
        `<div class="kv"><span>${esc(o.key)}</span><b style="color:${o.color}">${Number.isFinite(o.value) ? fmtNum(o.value) : '∅'}</b></div>`).join('')}</div>`).join('')}`;
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement, v = this.app.view;
    const tab = t.closest<HTMLElement>('[data-tab]')?.dataset.tab as 'tree' | 'data' | undefined;
    if (tab) { this.tab = tab; this.el.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab)); this.render(); return; }
    const btn = t.closest<HTMLElement>('[data-act]');
    if (btn) {
      const id = btn.dataset.id!, dl = v.drawingLayer;
      const d = dl.drawings.find(x => x.id === id);
      switch (btn.dataset.act) {
        case 'vol': v.setVolumeVisible(!v.volumeVisible); break;
        case 'cmp': v.removeCompare(id); break;
        case 'study-vis': { const s = v.studies.find(x => x.uid === id); if (s) v.setStudyVisible(id, !s.visible); break; }
        case 'study-rm': v.removeStudy(id); break;
        case 'd-vis': if (d) dl.update({ ...d, hidden: !d.hidden }); break;
        case 'd-lock': if (d) dl.update({ ...d, locked: !d.locked }); break;
        case 'd-rm': dl.remove(id); break;
      }
      this.render();
      return;
    }
    const row = t.closest<HTMLElement>('[data-drawing]');
    if (row) { v.drawingLayer.selected = row.dataset.drawing!; v.drawingLayer.redraw(); this.render(); }
  }
}
