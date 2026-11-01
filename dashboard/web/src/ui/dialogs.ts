// Modal dialogs: symbol search / compare, indicators, study inputs, alert, chart settings, go-to date,
// quick search, backtest settings, layouts, keyboard shortcuts, text input; plus toasts.
import { api, type InputSpec, type LayoutMeta, type QuantifiStrategy, type RunSummary, type SearchResult, type StrategyProps, type StrategyRef } from '../api';
import { INDICATORS, type Inputs } from '../indicators';
import type { ChartProps } from '../chart/view';
import { icon } from './icons';
import { KEY } from './menu';

const root = () => document.getElementById('dialog-root')!;
export const isDialogOpen = () => root().childElementCount > 0;
export function closeDialog() { root().innerHTML = ''; }

function modal(title: string, name: string, wide = false): { box: HTMLElement; body: HTMLElement; close: () => void } {
  closeDialog();
  const back = document.createElement('div');
  back.className = 'dialog-backdrop';
  back.innerHTML = `<div class="dialog ${wide ? 'wide' : ''}" role="dialog" data-dialog="${name}"><header>${title}<span class="spacer"></span>
    <button data-close title="Close">${icon('close', 24)}</button></header><div class="body"></div></div>`;
  root().appendChild(back);
  const close = () => back.remove();
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  back.querySelector('[data-close]')!.addEventListener('click', close);
  return { box: back.querySelector('.dialog')!, body: back.querySelector('.body')!, close };
}
function footer(box: HTMLElement, ok = 'Ok', cancel = 'Cancel') {
  const f = document.createElement('div');
  f.className = 'footer';
  f.innerHTML = `${cancel ? `<button data-cancel>${cancel}</button>` : ''}<button class="primary" data-ok>${ok}</button>`;
  box.appendChild(f);
  return { ok: f.querySelector<HTMLElement>('[data-ok]')!, cancel: f.querySelector<HTMLElement>('[data-cancel]') };
}

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Symbol search; resolves with the chosen TradingView id. Typing EXCHANGE:SYMBOL + Enter accepts it verbatim. */
export function symbolSearch(initial = '', title = 'Symbol search'): Promise<string | null> {
  return new Promise(resolve => {
    const { body, close } = modal(title, 'symbol-search', true);
    body.innerHTML = `<input class="search" placeholder="Symbol, ISIN, or description" autocomplete="off" /><div class="results"></div>`;
    const input = body.querySelector('input')!;
    const list = body.querySelector('.results')!;
    let results: SearchResult[] = [], sel = 0, seq = 0, t = 0;
    const done = (v: string | null) => { close(); resolve(v); };
    const render = () => {
      list.innerHTML = results.map((r, i) => `<div class="${i === sel ? 'sel' : ''}" data-i="${i}">${logo(r.symbol)}<span class="sym">${esc(r.symbol)}</span>
        <span>${esc(r.description ?? '')}</span><span class="spacer"></span><span class="muted">${esc(r.type ?? '')}</span>
        <span>${esc(r.exchange ?? '')}</span></div>`).join('');
    };
    let resultsFor = '';                       // query the current `results` belong to
    const run = () => {
      const q = input.value.trim(), my = ++seq;
      if (!q) { results = []; resultsFor = ''; render(); return Promise.resolve(); }
      return api.search(q).then(r => { if (my === seq) { results = r.slice(0, 50); resultsFor = q; sel = 0; render(); } })
        .catch(() => { /* offline */ });
    };
    input.addEventListener('input', () => { clearTimeout(t); t = window.setTimeout(run, 150); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, results.length - 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
      else if (e.key === 'Enter') {
        // Enter always resolves against the text as typed: wait for (or start) the search for it first
        e.preventDefault();
        const raw = input.value.trim();
        const ready = resultsFor === raw ? Promise.resolve() : (clearTimeout(t), run());
        ready.then(() => done(results[sel]?.id ?? (raw.includes(':') ? raw.toUpperCase() : null)));
      } else if (e.key === 'Escape') done(null);
      e.stopPropagation();
    });
    list.addEventListener('click', e => {
      const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i;
      if (i !== undefined) done(results[+i].id);
    });
    input.value = initial;
    input.focus();
    if (initial) run();
  });
}

/** Round letter logo (our stand-in for company logos). */
export function logo(symbol: string, size = 18): string {
  const s = (symbol.split(':').pop() ?? '?').replace(/^\d+/, m => m.slice(0, 1));
  let h = 0;
  for (const c of symbol) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const colors = ['#2962FF', '#089981', '#F23645', '#FF9800', '#9C27B0', '#00897B', '#5D4037', '#3949AB', '#C2185B', '#455A64'];
  return `<span class="logo" style="background:${colors[h % colors.length]};width:${size}px;height:${size}px">${esc(s[0] ?? '?')}</span>`;
}

export type PickResult = { kind: 'indicator'; id: string } | { kind: 'strategy'; ref: StrategyRef; name: string };

/** Indicators, metrics, and strategies: built-in indicators, TradingView's built-in strategy templates (run
 *  by our Pine engine), and the user's own Pine strategies ("New Pine script…" pastes one). */
/** Folder for a built-in strategy template, by what kind of rule it trades. */
const STRATEGY_GROUPS: [string, RegExp][] = [
  ['Trend following', /macd|moving average|supertrend|parabolic|momentum|technical ratings/i],
  ['Breakouts and channels', /channel|breakout|volatility|greedy|keltner/i],
  ['Mean reversion / oscillators', /rsi|stochastic|bollinger/i],
  ['Bar patterns and pivots', /bar|consecutive|pivot/i],
];
export const strategyGroup = (name: string) => STRATEGY_GROUPS.find(([, re]) => re.test(name))?.[0] ?? 'Other';

export function indicatorPicker(tab: 'indicators' | 'strategies' = 'indicators'): Promise<PickResult | null> {
  return new Promise(resolve => {
    const { body, close } = modal('Indicators, metrics, and strategies', 'indicators', true);
    body.classList.add('picker');
    body.innerHTML = `<input class="search" placeholder="Search" /><div class="picker-cols"><nav class="picker-nav">
      <button data-tab="indicators">${icon('indicators', 20)}Indicators</button><button data-tab="strategies">${icon('strategy', 20)}Strategies</button>
      <button data-tab="mine">${icon('code', 20)}My scripts</button></nav><div class="results"></div></div>`;
    const input = body.querySelector('input')!, list = body.querySelector<HTMLElement>('.results')!;
    type Row = { key: string; name: string; hint: string; muted?: boolean; group?: string; pick: () => PickResult | null | Promise<PickResult | null>; del?: () => Promise<void> };
    let openGroups = new Set<string>();
    try { openGroups = new Set(JSON.parse(localStorage.getItem('strategy_groups_open') ?? '[]')); } catch { /* none open */ }
    let cur: 'indicators' | 'strategies' | 'mine' = tab, rows: Row[] = [], shown: Row[] = [], matches: Row[] = [], sel = 0;
    let cat: Awaited<ReturnType<typeof api.strategies>> | null = null, catErr = '';
    const done = (v: PickResult | null) => { close(); resolve(v); };
    const build = () => {
      if (cur === 'indicators') {
        rows = Object.values(INDICATORS).map(d => ({ key: d.id, name: d.name, hint: `${d.id} · ${d.pane === 'overlay' ? 'on chart' : 'own pane'}`,
          pick: () => ({ kind: 'indicator', id: d.id }) }));
      } else if (!cat) {
        rows = [];
      } else if (cur === 'strategies') {
        rows = cat.builtin.map(b => ({ key: b.id, name: b.name, hint: b.supported === false ? 'not supported by the engine' : 'Strategy', muted: b.supported === false,
          group: strategyGroup(b.name),
          pick: () => (b.supported === false ? (toast(`${esc(b.name)} uses Pine features the engine does not run (library imports)`), null)
            : { kind: 'strategy', ref: { id: b.id }, name: b.name }) }));
      } else {
        rows = [{ key: '__new', name: 'New Pine script…', hint: 'paste a strategy', pick: async () => {
          const saved = await pineScriptDialog();
          return saved ? { kind: 'strategy', ref: { id: `user:${saved.id}` }, name: saved.name } : null;
        } }, ...cat.user.map(u => ({ key: `user:${u.id}`, name: u.name, hint: `My script · ${new Date(u.updated * 1000).toLocaleDateString()}`,
          pick: () => ({ kind: 'strategy' as const, ref: { id: `user:${u.id}` }, name: u.name }),
          del: async () => { await api.deleteScript(u.id); cat!.user = cat!.user.filter(x => x.id !== u.id); } }))];
      }
      filter();
    };
    const filter = () => {
      const q = input.value.toLowerCase();
      const hit = (r: Row) => r.key === '__new' || r.name.toLowerCase().includes(q) || r.key.toLowerCase().includes(q);
      shown = rows.filter(r => hit(r) && (q || !r.group || openGroups.has(r.group)));
      matches = rows.filter(hit);
      sel = 0; render();
    };
    const render = () => {
      body.querySelectorAll<HTMLElement>('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === cur));
      if (cur !== 'indicators' && !cat) { list.innerHTML = `<div class="muted" style="padding:16px">${catErr ? esc(catErr) : 'Loading…'}</div>`; return; }
      list.innerHTML = (cur === 'strategies' && cat?.error ? `<div class="note">${esc(cat.error)}</div>` : '')
        + (matches.length ? '' : '<div class="muted" style="padding:16px">No matches</div>')
        + (rows.some(r => r.group) ? groupedHtml() : shown.map(rowHtml).join(''));
    };
    const rowHtml = (d: Row) => {
      const i = shown.indexOf(d);
      return `<div class="${i === sel ? 'sel' : ''} ${d.muted ? 'muted' : ''} ${d.group ? 'in-folder' : ''}" data-i="${i}"><span>${esc(d.name)}</span>
        <span class="spacer"></span><span class="muted">${esc(d.hint)}</span>${d.del ? `<button class="row-del" data-del="${i}" title="Delete script">${icon('trash', 18)}</button>` : ''}</div>`;
    };
    const groupedHtml = () => {
      const q = input.value.trim();
      return [...STRATEGY_GROUPS.map(([g]) => g), 'Other'].map(g => {
        const inGroup = matches.filter(r => r.group === g);
        if (!inGroup.length) return '';
        const isOpen = !!q || openGroups.has(g);
        return `<div class="pick-folder ${isOpen ? 'open' : ''}" data-group="${esc(g)}"><span class="caret">▸</span>${icon('folder', 20)}<span>${esc(g)}</span>
          <span class="spacer"></span><span class="muted">${inGroup.length}</span></div>${isOpen ? inGroup.map(rowHtml).join('') : ''}`;
      }).join('');
    };
    const choose = async (r: Row | undefined) => { if (!r) return; const v = await r.pick(); if (v) done(v); else if (r.key === '__new') render(); };
    const switchTab = (t: typeof cur) => {
      cur = t; build();
      if (t !== 'indicators' && !cat) api.strategies().then(c => { cat = c; build(); }).catch(e => { catErr = (e as Error).message; render(); });
    };
    input.addEventListener('input', filter);
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); render(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); }
      else if (e.key === 'Enter') void choose(shown[sel]);
      else if (e.key === 'Escape') done(null);
      e.stopPropagation();
    });
    body.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const tb = t.closest<HTMLElement>('[data-tab]')?.dataset.tab;
      if (tb) { switchTab(tb as typeof cur); input.focus(); return; }
      const g = t.closest<HTMLElement>('[data-group]')?.dataset.group;
      if (g) {
        if (openGroups.has(g)) openGroups.delete(g); else openGroups.add(g);
        try { localStorage.setItem('strategy_groups_open', JSON.stringify([...openGroups])); } catch { /* ignore */ }
        filter(); input.focus(); return;
      }
      const d = t.closest<HTMLElement>('[data-del]')?.dataset.del;
      if (d !== undefined) { e.stopPropagation(); const r = shown[+d]; if (r.del && confirm(`Delete "${r.name}"?`)) void r.del().then(build); return; }
      const i = t.closest<HTMLElement>('[data-i]')?.dataset.i;
      if (i !== undefined) void choose(shown[+i]);
    });
    switchTab(tab);
    input.focus();
  });
}

/** Paste a Pine strategy; the server parses it and saves it to "My scripts". */
export function pineScriptDialog(initial = '', name = '', id?: number): Promise<{ id: number; name: string } | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal(id ? 'Edit Pine script' : 'New Pine script', 'pine-script', true);
    body.innerHTML = `<div class="form-grid"><label>Name</label><input name="name" placeholder="Taken from strategy() when empty" value="${esc(name)}" /></div>
      <textarea class="pine-src" spellcheck="false" placeholder="//@version=6&#10;strategy(&quot;My strategy&quot;, overlay = true)&#10;...">${esc(initial)}</textarea>
      <div class="pine-err down" hidden></div>`;
    const f = footer(box, 'Save');
    const err = body.querySelector<HTMLElement>('.pine-err')!;
    const done = (v: { id: number; name: string } | null) => { close(); resolve(v); };
    f.cancel!.addEventListener('click', () => done(null));
    f.ok.addEventListener('click', async () => {
      const src = body.querySelector<HTMLTextAreaElement>('textarea')!.value;
      const nm = body.querySelector<HTMLInputElement>('[name=name]')!.value.trim();
      try { done(await api.saveScript(nm, src, id)); } catch (e) { err.hidden = false; err.textContent = (e as Error).message; }
    });
    body.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); e.stopPropagation(); });
    body.querySelector<HTMLTextAreaElement>('textarea')!.focus();
  });
}

/** Strategy settings: TradingView's Inputs and Properties tabs. Returns only values that differ from the script's. */
export function strategySettings(name: string, specs: InputSpec[], props: StrategyProps, cur: { inputs: Record<string, unknown>; props: Partial<StrategyProps> },
  tab: 'inputs' | 'properties' = 'inputs'): Promise<{ inputs: Record<string, unknown>; props: Partial<StrategyProps> } | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal(esc(name), 'strategy-settings');
    const P = { ...props, ...cur.props };
    const val = (s: InputSpec) => (s.title in cur.inputs ? cur.inputs[s.title] : s.default);
    const input = (s: InputSpec, i: number) => {
      const v = val(s), n = `in${i}`;
      if (s.type === 'bool') return `<label class="chk-row"><input type="checkbox" name="${n}" ${v ? 'checked' : ''}/>${esc(s.title)}</label><span></span>`;
      const opts = s.options ?? (s.type === 'source' ? ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'] : null);
      if (opts) return `<label>${esc(s.title)}</label><select name="${n}">${opts.map(o => `<option ${String(o) === String(v) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      const num = s.type === 'int' || s.type === 'float';
      return `<label>${esc(s.title)}</label><input name="${n}" ${num ? `type="number" step="${s.type === 'int' ? 1 : 'any'}"` : ''}
        ${s.minval !== null ? `min="${s.minval}"` : ''} ${s.maxval !== null ? `max="${s.maxval}"` : ''} value="${esc(v)}"/>`;
    };
    const sel = (n: string, v: string, o: [string, string][]) => `<select name="${n}">${o.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
    const num = (n: string, v: number, step: number | 'any' = 'any') => `<input name="${n}" type="number" step="${step}" value="${v}"/>`;
    body.innerHTML = `<div class="tabs-pill" role="tablist"><button data-t="inputs">Inputs</button><button data-t="properties">Properties</button></div>
      <div data-pane="inputs" class="form-grid">${specs.length ? specs.map(input).join('') : '<span class="muted">This strategy has no inputs.</span><span></span>'}</div>
      <div data-pane="properties" class="form-grid">
        <label>Initial capital</label>${num('initial_capital', P.initial_capital)}
        <label>Order size</label><span class="pair">${num('default_qty_value', P.default_qty_value)}${sel('default_qty_type', P.default_qty_type,
          [['fixed', 'Contracts'], ['cash_per_order', 'Cash'], ['percent_of_equity', '% of equity']])}</span>
        <label>Pyramiding</label><span class="pair">${num('pyramiding', P.pyramiding, 1)}<span class="muted">orders</span></span>
        <label>Commission</label><span class="pair">${num('commission_value', P.commission_value)}${sel('commission_type', P.commission_type,
          [['percent', '%'], ['cash_per_contract', 'Cash per contract'], ['cash_per_order', 'Cash per order']])}</span>
        <label>Slippage</label><span class="pair">${num('slippage', P.slippage, 1)}<span class="muted">ticks</span></span>
        <label>Margin for long positions</label><span class="pair">${num('margin_long', P.margin_long)}<span class="muted">%</span></span>
        <label>Margin for short positions</label><span class="pair">${num('margin_short', P.margin_short)}<span class="muted">%</span></span>
        <label>Risk-free rate</label><span class="pair">${num('risk_free_rate', P.risk_free_rate)}<span class="muted">%</span></span>
        <label class="chk-row"><input type="checkbox" name="process_orders_on_close" ${P.process_orders_on_close ? 'checked' : ''}/>On bar close</label><span class="muted">fill orders at the signal bar's close</span>
      </div>`;
    const show = (t: string) => {
      body.querySelectorAll<HTMLElement>('[data-t]').forEach(b => b.classList.toggle('active', b.dataset.t === t));
      body.querySelectorAll<HTMLElement>('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== t; });
    };
    body.addEventListener('click', e => { const t = (e.target as HTMLElement).closest<HTMLElement>('[data-t]')?.dataset.t; if (t) show(t); });
    show(tab);
    const f = footer(box);
    const done = (v: Parameters<typeof resolve>[0]) => { close(); resolve(v); };
    f.cancel!.addEventListener('click', () => done(null));
    f.ok.addEventListener('click', () => {
      const inputs: Record<string, unknown> = {};
      specs.forEach((s, i) => {
        const el = body.querySelector<HTMLInputElement>(`[name=in${i}]`)!;
        const v = s.type === 'bool' ? el.checked : s.type === 'int' ? Math.round(Number(el.value)) : s.type === 'float' ? Number(el.value) : el.value;
        if (String(v) !== String(s.default)) inputs[s.title] = v;
      });
      const out: Partial<StrategyProps> = {};
      for (const k of Object.keys(props) as (keyof StrategyProps)[]) {
        const el = body.querySelector<HTMLInputElement>(`[name=${k}]`);
        if (!el) continue;
        const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
        if (v !== props[k]) (out as Record<string, unknown>)[k] = v;
      }
      done({ inputs, props: out });
    });
    body.addEventListener('keydown', e => { if (e.key === 'Enter') f.ok.click(); else if (e.key === 'Escape') done(null); e.stopPropagation(); });
  });
}

export function studySettings(id: string, inputs: Inputs): Promise<Inputs | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal(`${INDICATORS[id].name}`, 'study-settings');
    body.innerHTML = `<div class="form-grid">${Object.entries(inputs).map(([k, v]) => k === 'source'
      ? `<label>${k}</label><select name="${k}">${['open', 'high', 'low', 'close'].map(s => `<option ${s === v ? 'selected' : ''}>${s}</option>`).join('')}</select>`
      : `<label>${k}</label><input name="${k}" type="number" step="any" value="${v}" />`).join('')}</div>`;
    const f = footer(box);
    const done = (v: Inputs | null) => { close(); resolve(v); };
    f.cancel!.addEventListener('click', () => done(null));
    f.ok.addEventListener('click', () => {
      const out: Inputs = {};
      body.querySelectorAll<HTMLInputElement>('[name]').forEach(el => { out[el.name] = el.type === 'number' ? Number(el.value) : el.value; });
      done(out);
    });
    body.addEventListener('keydown', e => { if (e.key === 'Enter') f.ok.click(); e.stopPropagation(); });
  });
}

export interface AlertDraft { symbol: string; timeframe: string; condition: unknown; trigger: string; message: string; expires: number }

/** Alert dialog: left operand (price or a study on the chart) vs value/study, TradingView condition set. */
export function alertDialog(symbol: string, timeframe: string, price: number,
  studies: { id: string; inputs: Inputs }[]): Promise<AlertDraft | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal(`Create alert on ${esc(symbol)}`, 'alert');
    const operands = [{ label: `${symbol} (close)`, value: JSON.stringify({ kind: 'price', field: 'close' }) },
      ...studies.flatMap(s => INDICATORS[s.id].outputs.map(o => ({
        label: `${s.id} ${Object.values(s.inputs).join(',')} · ${o.key}`,
        value: JSON.stringify({ kind: 'indicator', type: s.id, inputs: s.inputs, output: o.key }) })))];
    const opt = (xs: { label: string; value: string }[]) => xs.map(x => `<option value='${x.value}'>${esc(x.label)}</option>`).join('');
    const ops = ['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than',
      'entering_channel', 'exiting_channel', 'inside_channel', 'outside_channel'];
    body.innerHTML = `<div class="form-grid">
      <label>Condition</label><select name="left">${opt(operands)}</select>
      <label></label><select name="op">${ops.map(o => `<option value="${o}">${o.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())}</option>`).join('')}</select>
      <label>Value</label><div class="row"><select name="rkind"><option value="value">Value</option>${operands.length > 1 ? '<option value="operand">Indicator</option>' : ''}</select>
        <input name="value" type="number" step="any" value="${+price.toFixed(4)}" /><select name="right" hidden>${opt(operands.slice(1))}</select></div>
      <label class="chan">Upper / lower</label><div class="row chan"><input name="upper" type="number" step="any" value="${(price * 1.02).toFixed(4)}" />
        <input name="lower" type="number" step="any" value="${(price * 0.98).toFixed(4)}" /></div>
      <label>Trigger</label><select name="trigger"><option value="once">Only once</option><option value="once_per_bar">Once per bar</option>
        <option value="once_per_bar_close">Once per bar close</option></select>
      <label>Expiration</label><input name="expires" type="datetime-local" />
      <label>Message</label><input name="message" />
    </div>`;
    const $ = <T extends HTMLElement>(n: string) => body.querySelector<T>(`[name="${n}"]`)!;
    const sync = () => {
      const chan = $<HTMLSelectElement>('op').value.includes('channel');
      body.querySelectorAll<HTMLElement>('.chan').forEach(el => { el.hidden = !chan; });
      $<HTMLSelectElement>('rkind').parentElement!.hidden = chan;
      body.querySelector<HTMLElement>('.form-grid > label:nth-of-type(3)')!.hidden = chan;
      const ind = $<HTMLSelectElement>('rkind').value === 'operand';
      $('value').hidden = ind;
      $('right').hidden = !ind;
    };
    // TradingView defaults: expiration about one month ahead; message "<SYMBOL> <Condition> <value>"
    const exp = new Date(Date.now() + 30 * 86400000);
    $<HTMLInputElement>('expires').value = new Date(exp.getTime() - exp.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const short = symbol.split(':').pop();
    let edited = false;
    $<HTMLInputElement>('message').addEventListener('input', () => { edited = true; });
    const autoMessage = () => {
      if (edited) return;
      const opText = $<HTMLSelectElement>('op').selectedOptions[0].text;
      const rhs = $<HTMLSelectElement>('op').value.includes('channel')
        ? `${$<HTMLInputElement>('lower').value}–${$<HTMLInputElement>('upper').value}`
        : $<HTMLSelectElement>('rkind').value === 'operand' ? $<HTMLSelectElement>('right').selectedOptions[0]?.text ?? '' : $<HTMLInputElement>('value').value;
      $<HTMLInputElement>('message').value = `${short} ${opText} ${rhs}`;
    };
    body.addEventListener('change', () => { sync(); autoMessage(); });
    body.addEventListener('input', e => { if ((e.target as HTMLElement).getAttribute('name') !== 'message') autoMessage(); });
    sync();
    autoMessage();
    const f = footer(box, 'Create');
    const done = (v: AlertDraft | null) => { close(); resolve(v); };
    f.cancel!.addEventListener('click', () => done(null));
    f.ok.addEventListener('click', () => {
      const op = $<HTMLSelectElement>('op').value;
      const left = JSON.parse($<HTMLSelectElement>('left').value);
      const val = (n: string) => ({ kind: 'value', value: Number($<HTMLInputElement>(n).value) });
      const condition = op.includes('channel')
        ? { left, op, upper: val('upper'), lower: val('lower') }
        : { left, op, right: $<HTMLSelectElement>('rkind').value === 'operand' ? JSON.parse($<HTMLSelectElement>('right').value) : val('value') };
      done({ symbol, timeframe, condition, trigger: $<HTMLSelectElement>('trigger').value, message: $<HTMLInputElement>('message').value,
        expires: Math.round(new Date($<HTMLInputElement>('expires').value).getTime() / 1000) });
    });
  });
}

export function promptText(title: string, value = '', okLabel = 'Save'): Promise<string | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal(esc(title), 'prompt');
    body.innerHTML = `<input class="search" value="${esc(value)}" />`;
    const input = body.querySelector('input')!;
    const f = footer(box, okLabel);
    const done = (v: string | null) => { close(); resolve(v); };
    f.cancel!.addEventListener('click', () => done(null));
    f.ok.addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
      e.stopPropagation();
    });
    input.focus();
    input.select();
  });
}

/** Bottom-bar "Go to": a date; resolves with 00:00 UTC of that day (epoch seconds). */
export function goToDialog(initial: number): Promise<number | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal('Go to', 'goto');
    body.innerHTML = `<div class="form-grid"><label>Date</label><input name="date" type="date" value="${new Date(initial * 1000).toISOString().slice(0, 10)}" /></div>`;
    const input = body.querySelector<HTMLInputElement>('input')!;
    const f = footer(box, 'Go to');
    const done = (v: number | null) => { close(); resolve(v); };
    f.cancel!.addEventListener('click', () => done(null));
    f.ok.addEventListener('click', () => done(input.value ? Date.parse(`${input.value}T00:00:00Z`) / 1000 : null));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') f.ok.click(); e.stopPropagation(); });
    input.focus();
  });
}

/** Chart settings (TradingView Settings dialog subset): Symbol, Status line, Scales, Canvas, Data. */
export function settingsDialog(props: ChartProps, timezones: { id: string; label: string }[]): Promise<Partial<ChartProps> | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal('Settings', 'settings', true);
    const tabs = ['Symbol', 'Status line', 'Scales and lines', 'Canvas', 'Data'];
    const tabBar = document.createElement('div');
    tabBar.className = 'dlg-tabs';
    tabBar.innerHTML = tabs.map((t, i) => `<button data-tab="${i}" class="${i ? '' : 'active'}">${t}</button>`).join('');
    box.insertBefore(tabBar, body);
    const chk = (k: keyof ChartProps, label: string) => `<label>${label}</label><input type="checkbox" name="${k}" ${props[k] ? 'checked' : ''} style="justify-self:start" />`;
    const col = (k: keyof ChartProps, label: string) => `<label>${label}</label><input type="color" class="color-in" name="${k}" value="${props[k] || '#ffffff'}" />`;
    const pages = [
      `<div class="form-grid">${col('upColor', 'Up color')}${col('downColor', 'Down color')}${chk('body', 'Body')}${chk('borders', 'Borders')}${chk('wick', 'Wick')}
        ${chk('prevClose', 'Color bars based on previous close')}</div>`,
      `<div class="form-grid">${chk('showOHLC', 'OHLC values')}${chk('showChange', 'Bar change values')}${chk('showVolume', 'Volume')}${chk('showStudyValues', 'Indicator values')}</div>`,
      `<div class="form-grid"><label>Price scale</label><select name="scaleMode">${[['normal', 'Regular'], ['log', 'Logarithmic'], ['percent', 'Percent']]
        .map(([v, l]) => `<option value="${v}" ${props.scaleMode === v ? 'selected' : ''}>${l}</option>`).join('')}</select>${chk('lastPriceLine', 'Symbol last price line')}</div>`,
      `<div class="form-grid"><label>Background</label><div class="row"><input type="color" class="color-in" name="bg" value="${props.bg || '#ffffff'}" />
        <label style="flex:none"><input type="checkbox" name="bgTheme" ${props.bg ? '' : 'checked'} /> follow theme</label></div>
        ${chk('vertGrid', 'Vert grid lines')}${chk('horzGrid', 'Horz grid lines')}</div>`,
      `<div class="form-grid"><label>Timezone</label><select name="timezone">${timezones.map(t => `<option value="${t.id}" ${props.timezone === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>`,
    ];
    body.innerHTML = pages.map((p, i) => `<div data-page="${i}" ${i ? 'hidden' : ''}>${p}</div>`).join('');
    tabBar.addEventListener('click', e => {
      const i = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
      if (i === undefined) return;
      tabBar.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.tab === i));
      body.querySelectorAll<HTMLElement>('[data-page]').forEach(p => { p.hidden = p.dataset.page !== i; });
    });
    const f = footer(box);
    const done = (v: Partial<ChartProps> | null) => { close(); resolve(v); };
    f.cancel!.addEventListener('click', () => done(null));
    f.ok.addEventListener('click', () => {
      const out: Record<string, unknown> = {};
      body.querySelectorAll<HTMLInputElement>('[name]').forEach(el => {
        if (el.name === 'bgTheme') return;
        out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      });
      if (body.querySelector<HTMLInputElement>('[name="bgTheme"]')!.checked) out.bg = '';
      done(out as Partial<ChartProps>);
    });
  });
}

export interface QuickAction { label: string; hint?: string; group: string; run: () => void }
/** Quick search (⌘K): type to search drawings, functions and settings. */
export function quickSearch(actions: QuickAction[]) {
  const { body, close } = modal('Search tool or function', 'quick-search', true);
  body.innerHTML = `<input class="search" placeholder="Type to search for drawings, functions and settings" /><div class="results"></div>`;
  const input = body.querySelector('input')!, list = body.querySelector('.results')!;
  let shown = actions.slice(0, 12), sel = 0;
  const render = () => {
    list.innerHTML = shown.map((a, i) => `<div class="qs-row ${i === sel ? 'sel' : ''}" data-i="${i}"><span>${esc(a.label)}</span>
      <span class="muted">${esc(a.group)}</span><span class="hint">${esc(a.hint ?? '')}</span></div>`).join('');
  };
  const run = (i: number) => { const a = shown[i]; if (!a) return; close(); a.run(); };
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    shown = (q ? actions.filter(a => `${a.label} ${a.group}`.toLowerCase().includes(q)) : actions).slice(0, 30);
    sel = 0; render();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') run(sel);
    else if (e.key === 'Escape') close();
    e.stopPropagation();
  });
  list.addEventListener('click', e => { const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i; if (i !== undefined) run(+i); });
  render();
  input.focus();
}

export interface BacktestParams { pool: string; signal?: string; signal_file?: string; topk: number; rebalance_days: number; start: string; end?: string; open_cost: number; close_cost: number; account?: number }
/** Strategy (qlib backtest) properties. Resolves with the parameters to run. */
export function backtestDialog(initial: Partial<BacktestParams> = {}): Promise<BacktestParams | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal('Backtest properties', 'backtest-settings', true);
    body.innerHTML = '<div class="muted">Loading pools…</div>';
    const f = footer(box, 'Run backtest');
    const done = (v: BacktestParams | null) => { close(); resolve(v); };
    f.cancel!.addEventListener('click', () => done(null));
    (async () => {
      const { pools, builtin_signals } = await api.btPools();
      const pool0 = initial.pool && pools.includes(initial.pool) ? initial.pool : pools.includes('momentum53') ? 'momentum53' : pools[0];
      const cost = ((initial.open_cost ?? 0.0006) * 10000).toString();
      body.innerHTML = `<div class="form-grid">
        <label>Pool</label><select name="pool">${pools.map(p => `<option ${p === pool0 ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        <label>Signal</label><select name="signal"></select>
        <label>Top K</label><input name="topk" type="number" min="1" value="${initial.topk ?? 5}" />
        <label>Rebalance every (days)</label><input name="rebalance_days" type="number" min="1" value="${initial.rebalance_days ?? 20}" />
        <label>Start date</label><input name="start" type="date" value="${initial.start ?? '2018-01-02'}" />
        <label>Commission (bp per side)</label><input name="cost" type="number" step="0.5" min="0" value="${cost}" />
        <label>Initial capital</label><input name="account" type="number" min="1" step="any" value="${initial.account ?? 100_000_000}" />
      </div>`;
      const $ = <T extends HTMLElement>(n: string) => body.querySelector<T>(`[name="${n}"]`)!;
      const loadSignals = async () => {
        const s = await api.btSignals($<HTMLSelectElement>('pool').value);
        const want = initial.signal_file ? `file:${initial.signal_file}` : `builtin:${initial.signal ?? 'MOM_12_1'}`;
        $<HTMLSelectElement>('signal').innerHTML = builtin_signals.map(x => `<option value="builtin:${x}" ${want === `builtin:${x}` ? 'selected' : ''}>${x}</option>`).join('') +
          s.files.map(x => `<option value="file:${esc(x)}" ${want === `file:${x}` ? 'selected' : ''}>${esc(x.split('/').pop())}</option>`).join('');
      };
      $<HTMLSelectElement>('pool').onchange = loadSignals;
      await loadSignals();
      f.ok.addEventListener('click', () => {
        const sig = $<HTMLSelectElement>('signal').value;
        const c = Number($<HTMLInputElement>('cost').value) / 10000;
        done({ pool: $<HTMLSelectElement>('pool').value, topk: Number($<HTMLInputElement>('topk').value),
          rebalance_days: Number($<HTMLInputElement>('rebalance_days').value), start: $<HTMLInputElement>('start').value,
          open_cost: c, close_cost: c, account: Number($<HTMLInputElement>('account').value), ...(sig.startsWith('file:') ? { signal_file: sig.slice(5) } : { signal: sig.slice(8) }) });
      });
    })().catch(e => { body.innerHTML = `<div class="down">${esc((e as Error).message)}</div>`; });
  });
}

/** Signal family used as a sub-folder: the name parts before the first parameter-like part, at most two
 *  (livecombowf_reb20 -> livecombowf, revision_null_common_d049 -> revision_null, MOM_12_1 -> MOM). */
export function signalFamily(signal: string | null | undefined): string {
  const parts = String(signal ?? '').split('_');
  const out = [parts[0]];
  for (const p of parts.slice(1, 2)) if (!/\d/.test(p)) out.push(p);
  return out.join('_') || 'other';
}

interface RunNode { key: string; label: string; folders: RunNode[]; runs: RunSummary[]; count: number; family?: boolean }
const MARKETS: Record<string, string> = { cn: 'CN ETFs', us: 'US stocks', quantifi: 'QuantiFi 2026' };

/** Saved runs as a folder tree: market / pool / namespace / signal family. A family becomes a folder only in a
 *  folder of more than 12 runs and only when it has 2+ runs, so small folders stay flat. */
export function runTree(runs: RunSummary[]): RunNode {
  const node = (key: string, label: string): RunNode => ({ key, label, folders: [], runs: [], count: 0 });
  const root = node('', '');
  const child = (parent: RunNode, key: string, label: string) => {
    let n = parent.folders.find(f => f.key === key);
    if (!n) { n = node(key, label); parent.folders.push(n); }
    return n;
  };
  for (const r of runs) {
    const m = child(root, r.market ?? 'cn', MARKETS[r.market ?? 'cn'] ?? r.market);
    let f = child(m, `${m.key}/${r.pool}`, r.pool);
    for (const part of (r.folder ?? '').split('/').filter(Boolean)) f = child(f, `${f.key}/${part}`, part);
    f.runs.push(r);
  }
  const finish = (n: RunNode): number => {
    if (n.runs.length > 12 && !n.family) {            // a family folder is a leaf: regrouping it would recurse
      const fam = new Map<string, RunSummary[]>();
      for (const r of n.runs) { const k = signalFamily(r.signal); fam.set(k, [...(fam.get(k) ?? []), r]); }
      const loose: RunSummary[] = [];
      for (const [k, rs] of fam) {
        if (rs.length < 2) { loose.push(...rs); continue; }
        n.folders.push({ key: `${n.key}/~${k}`, label: k, folders: [], runs: rs, count: rs.length, family: true });
      }
      n.runs = loose;
    }
    n.folders.sort((a, b) => a.label.localeCompare(b.label));
    n.runs.sort((a, b) => a.name.localeCompare(b.name));
    n.count = n.runs.length + n.folders.reduce((s, f) => s + finish(f), 0);
    return n.count;
  };
  finish(root);
  return root;
}

/** "Open strategy report": every saved qlib run (CN ETF and US stock studies) as a searchable folder tree. */
export function runsDialog(runs: RunSummary[], current: string | null): Promise<{ open?: string; action?: 'new' | 'pine' | 'quantifi' } | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal('Open strategy report', 'runs', true);
    let open = new Set<string>();
    try { open = new Set(JSON.parse(localStorage.getItem('runs_open') ?? '[]')); } catch { /* defaults */ }
    if (!open.size) open = new Set(['cn', 'us', 'quantifi']);
    if (current) {                                  // reveal the run on screen
      const r = runs.find(x => x.id === current);
      if (r) { const parts = [r.market, r.pool, ...(r.folder ? r.folder.split('/') : [])]; parts.forEach((_, i) => open.add(parts.slice(0, i + 1).join('/'))); }
    }
    const tree = runTree(runs);
    body.classList.add('runs-dialog');
    body.innerHTML = `<input class="search" placeholder="Search runs, signals, folders" autocomplete="off" />
      <div class="runs-actions"><button class="pill-btn light" data-act="pine">${icon('strategy', 18)}Add Pine strategy…</button>
        <button class="pill-btn light" data-act="new">${icon('plus', 18)}New backtest…</button>
        <button class="pill-btn light" data-act="quantifi">${icon('plus', 18)}New QuantiFi run…</button><span class="spacer"></span>
        <span class="muted">${runs.length} runs</span></div><div class="run-tree"></div>`;
    const input = body.querySelector('input')!, list = body.querySelector<HTMLElement>('.run-tree')!;
    const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}%`);
    const coins = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? '—'
      : `${x < 0 ? '−' : ''}${Math.abs(x) >= 1000 ? `${(Math.abs(x) / 1000).toFixed(1)}K` : Math.abs(x).toFixed(0)}`);
    // QuantiFi runs have no capital base: PnL and drawdown in coins instead of annual return and drawdown %
    const runRow = (r: RunSummary, depth: number) => `<div class="run-row ${r.id === current ? 'sel' : ''}" data-run="${esc(r.id)}" style="padding-left:${12 + depth * 18}px" title="${esc(r.id)}">
      <span class="rname">${esc(r.name)}</span><span class="spacer"></span>
      ${r.market === 'quantifi'
        ? `<span class="rstat ${(r.pnl ?? 0) >= 0 ? 'up' : 'down'}" title="PnL in coins, website fill rules">${coins(r.pnl)}</span>`
        : `<span class="rstat ${(r.annual_return ?? 0) >= 0 ? 'up' : 'down'}">${pct(r.annual_return)}</span>`}<span class="rstat">${r.sharpe?.toFixed(2) ?? '—'}</span>
      <span class="rstat down">${r.market === 'quantifi' ? coins(r.max_drawdown_coins) : pct(r.max_drawdown)}</span><span class="rdate muted">${esc(r.start ?? '')} → ${esc(r.end ?? '')}</span></div>`;
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const match = (r: RunSummary) => !q || `${r.id} ${r.signal ?? ''}`.toLowerCase().includes(q);
      const walk = (n: RunNode, depth: number): string => {
        let html = '';
        for (const f of n.folders) {
          const inner = walk(f, depth + 1);
          if (q && !inner) continue;
          const isOpen = q ? true : open.has(f.key);
          html += `<div class="run-folder ${isOpen ? 'open' : ''}" data-folder="${esc(f.key)}" style="padding-left:${8 + depth * 18}px">
            <span class="caret">▸</span>${icon('folder', 20)}<span class="fname">${esc(f.label)}</span><span class="muted fcount">${f.count}</span></div>`;
          if (isOpen) html += inner;
        }
        for (const r of n.runs) if (match(r)) html += runRow(r, depth);
        return html;
      };
      const html = walk(tree, 0);
      list.innerHTML = `<div class="run-head"><span>Run</span><span class="spacer"></span><span class="rstat">Annual</span><span class="rstat">Sharpe</span><span class="rstat">Max DD</span><span class="rdate">Period</span></div>`
        + (html || '<div class="muted" style="padding:16px">No runs match</div>');
    };
    const done = (v: Parameters<typeof resolve>[0]) => { close(); resolve(v); };
    const save = () => { try { localStorage.setItem('runs_open', JSON.stringify([...open])); } catch { /* ignore */ } };
    body.addEventListener('click', e => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act) { done({ action: act as 'new' | 'pine' | 'quantifi' }); return; }
      const f = t.closest<HTMLElement>('[data-folder]')?.dataset.folder;
      if (f !== undefined) { if (open.has(f)) open.delete(f); else open.add(f); save(); render(); return; }
      const r = t.closest<HTMLElement>('[data-run]')?.dataset.run;
      if (r) done({ open: r });
    });
    let tmr = 0;
    input.addEventListener('input', () => { clearTimeout(tmr); tmr = window.setTimeout(render, 120); });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); e.stopPropagation(); });
    box.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); });
    render();
    list.querySelector('.run-row.sel')?.scrollIntoView({ block: 'center' });
    input.focus();
  });
}

/** "Open layout…": pick or delete a saved layout. */
export function layoutsDialog(layouts: LayoutMeta[], current?: number): Promise<{ open?: number; delete?: number } | null> {
  return new Promise(resolve => {
    const { body, close } = modal('Open layout', 'layouts');
    const render = (ls: LayoutMeta[]) => {
      body.innerHTML = `<div class="results">${ls.map(l => `<div class="${l.id === current ? 'sel' : ''}" data-id="${l.id}"><span>${esc(l.name)}</span>
        <span class="spacer"></span><span class="muted">${new Date(l.updated * 1000).toLocaleString()}</span>
        <button data-del="${l.id}" title="Delete layout">${icon('trash', 22)}</button></div>`).join('') || '<div class="muted">No saved layouts</div>'}</div>`;
    };
    render(layouts);
    body.addEventListener('click', e => {
      const del = (e.target as HTMLElement).closest<HTMLElement>('[data-del]')?.dataset.del;
      if (del) { close(); resolve({ delete: Number(del) }); return; }
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
      if (id) { close(); resolve({ open: Number(id) }); }
    });
  });
}

export function shortcutsDialog() {
  const { body } = modal('Keyboard shortcuts', 'shortcuts', true);
  const rows: [string, string][] = [
    ['Symbol search', 'type a letter on the chart'], ['Change interval', 'type digits (5, 1h, 1D) + Enter'], ['Indicators', '/'],
    ['Create alert', `${KEY.alt}A`], ['Trendline', `${KEY.alt}T`], ['Horizontal line at cursor', `${KEY.alt}H`], ['Horizontal ray', `${KEY.alt}J`],
    ['Vertical line', `${KEY.alt}V`], ['Crossline', `${KEY.alt}C`], ['Fib retracement', `${KEY.alt}F`], ['Rectangle', `${KEY.alt}${KEY.shift}R`],
    ['Measure', `${KEY.shift}click`], ['Reset chart view', `${KEY.alt}R`], ['Undo / redo', `${KEY.mod}Z / ${KEY.mod}${KEY.shift}Z`],
    ['Save layout', `${KEY.mod}S`], ['Quick search', `${KEY.mod}K`], ['Fullscreen', `${KEY.shift}F`], ['Download snapshot', `${KEY.alt}${KEY.mod}S`],
    ['Delete selected drawing', 'Delete'], ['Cancel drawing', 'Esc'],
  ];
  body.innerHTML = `<table class="kbd-table">${rows.map(([a, k]) => `<tr><td>${a}</td><td><kbd>${esc(k)}</kbd></td></tr>`).join('')}</table>`;
}

/** Pick a QuantiFi strategy file to replay with tools/backtest.py (website fill rules). */
export function quantifiDialog(strategies: QuantifiStrategy[]): Promise<QuantifiStrategy | null> {
  return new Promise(resolve => {
    const { box, body, close } = modal('New QuantiFi run', 'qf-run', true);
    const groups = [...new Set(strategies.map(s => s.group))];
    body.classList.add('qf-dialog');
    body.innerHTML = `<div class="muted qf-note">Replays the file over training days −2, −1 and 0 (a fresh Trader each day, as the website runs them).
        Orders that cross the book fill against its displayed levels; the rest fill at their own price on same-tick market trades;
        a batch that could breach a position limit is cancelled. Stress scenarios with extra slippage are in the run's Stress view.</div>
      ${groups.map(g => `<div class="qf-group">${esc(g)}</div>${strategies.filter(s => s.group === g).map(s =>
        `<div class="qf-row" data-path="${esc(s.path)}" tabindex="0">${icon('strategy', 20)}<span class="qf-label">${esc(s.label)}</span>
          <span class="muted qf-path">${esc(s.path)}</span><span class="spacer"></span><span class="qf-run">Run</span></div>`).join('')}`).join('')}`;
    const done = (v: QuantifiStrategy | null) => { close(); resolve(v); };
    body.addEventListener('click', e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
      if (row) done(strategies.find(s => s.path === row.dataset.path) ?? null);
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') done(null);
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
      if (e.key === 'Enter' && row) done(strategies.find(s => s.path === row.dataset.path) ?? null);
    });
    box.querySelector<HTMLElement>('.qf-row')?.focus();
  });
}

export function toast(html: string, ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = html;
  document.getElementById('toasts')!.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
