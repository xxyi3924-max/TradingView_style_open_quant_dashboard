// Bottom range bar (TradingView: 1D 5D 1M 3M 6M YTD 1Y 5Y All | Go to ... clock/timezone | ADJ).
// Each range switches the interval exactly as TradingView's tooltips state (re/ui/menus probe):
// "1 day in 1 minute intervals", "5 days in 5 minutes", ..., "5 years in 1 week", "All data in 1 month".
import type { App } from '../main';
import { icon } from './icons';
import { openMenu } from './menu';

export const RANGES: { label: string; tf: string; days: number | 'ytd' | null; tip: string }[] = [
  { label: '1D', tf: '1', days: 1, tip: '1 day in 1 minute intervals' },
  { label: '5D', tf: '5', days: 5, tip: '5 days in 5 minutes intervals' },
  { label: '1M', tf: '30', days: 30, tip: '1 month in 30 minutes intervals' },
  { label: '3M', tf: '60', days: 91, tip: '3 months in 1 hour intervals' },
  { label: '6M', tf: '120', days: 182, tip: '6 months in 2 hours intervals' },
  { label: 'YTD', tf: 'D', days: 'ytd', tip: 'Year to day in 1 day intervals' },
  { label: '1Y', tf: 'D', days: 365, tip: '1 year in 1 day intervals' },
  { label: '5Y', tf: 'W', days: 1826, tip: '5 years in 1 week intervals' },
  { label: 'All', tf: 'M', days: null, tip: 'All data in 1 month intervals' },
];

const ZONES = ['Pacific/Honolulu', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Toronto', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Zurich', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney', 'Pacific/Auckland'];

/** "UTC+8" style offset of a zone right now. */
export function utcOffset(tz: string, at = new Date()): string {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at).find(x => x.type === 'timeZoneName')?.value ?? 'GMT';
    return p.replace('GMT', 'UTC').replace(/^UTC$/, 'UTC');
  } catch { return 'UTC'; }
}
export const TIMEZONES = (): { id: string; label: string }[] => [
  { id: 'UTC', label: 'UTC' }, { id: 'exchange', label: 'Exchange' },
  ...ZONES.map(z => ({ id: z, label: `(${utcOffset(z)}) ${z.split('/').pop()!.replace(/_/g, ' ')}` })),
];

export class BottomBar {
  private timer = 0;

  constructor(private el: HTMLElement, private app: App) {
    el.innerHTML = `${RANGES.map(r => `<button class="rbtn" data-range="${r.label}" data-tip="${r.tip}" data-side="top">${r.label}</button>`).join('')}
      <span class="rsep"></span><button class="rbtn" id="goto-btn" data-tip="Go to" data-side="top" aria-label="Go to">${icon('goto')}</button>
      <span style="flex:1"></span>
      <button class="rbtn clock" id="tz-btn" data-tip="Timezone" data-side="top" aria-label="Timezone"></button><span class="rsep"></span>
      <button class="rbtn" id="adj-btn" data-tip="Adjust data for dividends" data-side="top" aria-label="Adjust data for dividends">ADJ</button>`;
    el.addEventListener('click', e => {
      const r = (e.target as HTMLElement).closest<HTMLElement>('[data-range]')?.dataset.range;
      if (r) app.setRange(r);
    });
    el.querySelector<HTMLElement>('#goto-btn')!.onclick = () => app.goTo();
    el.querySelector<HTMLElement>('#adj-btn')!.onclick = () => app.toggleAdjustment();
    el.querySelector<HTMLElement>('#tz-btn')!.onclick = e => this.tzMenu(e.currentTarget as HTMLElement);
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  private tick() {
    const v = this.app.view;
    const tz = v ? v.timezone : 'UTC';
    let time = '';
    try { time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date()); }
    catch { time = new Date().toISOString().slice(11, 19); }
    const off = utcOffset(tz);
    this.el.querySelector('#tz-btn')!.textContent = off === 'UTC' ? `${time} UTC` : `${time} (${off})`;
  }

  sync() {
    const v = this.app.view;
    if (!v) return;
    this.el.querySelectorAll<HTMLElement>('[data-range]').forEach(b => b.classList.toggle('on', b.dataset.range === this.app.activeRange));
    const adj = this.el.querySelector<HTMLButtonElement>('#adj-btn')!;
    adj.classList.toggle('on', v.adjustment === 'dividends');
    const local = v.source === 'local';
    adj.disabled = local;
    adj.dataset.tip = local ? 'Local data is already dividend-adjusted (前复权)' : 'Adjust data for dividends';
    this.tick();
  }

  private tzMenu(anchor: HTMLElement) {
    const cur = this.app.view.props.timezone;
    openMenu(anchor, TIMEZONES().map(z => ({ label: z.label, selected: z.id === cur, onClick: () => this.app.setTimezone(z.id) })),
      { name: 'timezone', side: 'top', minWidth: 264 });
  }

  destroy() { clearInterval(this.timer); }
}
