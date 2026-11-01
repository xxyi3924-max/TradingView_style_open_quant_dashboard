// Our own outline icon set, drawn on a 28x28 grid with 1px strokes (the same metrics as the TradingView
// chrome we measured: 28px glyphs inside 38-52px buttons). No TradingView artwork is used.
const svg = (body: string, size = 28, vb = 28) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const dot = (x: number, y: number, r = 1.6) => `<circle cx="${x}" cy="${y}" r="${r}"/>`;

const P: Record<string, string> = {
  // ---- cursors
  cross: '<path d="M14 5v6M14 17v6M5 14h6M17 14h6"/>',
  dot: '<circle cx="14" cy="14" r="2.2" fill="currentColor"/>',
  arrow: '<path d="M9 5.5v15.5l4.2-4.1 3 6.6 2.6-1.2-3-6.5 5.9-.4z"/>',
  eraser: '<path d="M12.5 21.5h10M6.4 16.6l9.9-9.9a1.5 1.5 0 0 1 2.1 0l3.9 3.9a1.5 1.5 0 0 1 0 2.1l-8.8 8.8h-3.6l-3.5-3.5a1 1 0 0 1 0-1.4zM10.6 12.4l6 6"/>',
  // ---- lines
  trend: `<path d="M8.2 19.8 19.8 8.2"/>${dot(7, 21)}${dot(21, 7)}`,
  ray: `<path d="M8.2 19.8 22.5 5.5M22.5 5.5h-4M22.5 5.5v4"/>${dot(7, 21)}${dot(14, 14)}`,
  extended: `<path d="M4.5 23.5 23.5 4.5"/>${dot(10, 18)}${dot(18, 10)}`,
  hline: `<path d="M4 14h8.4M15.6 14H24"/>${dot(14, 14)}`,
  hray: `<path d="M8.6 14H24"/>${dot(7, 14)}`,
  vline: `<path d="M14 4v8.4M14 15.6V24"/>${dot(14, 14)}`,
  crossline: `<path d="M14 4v8.4M14 15.6V24M4 14h8.4M15.6 14H24"/>${dot(14, 14)}`,
  // ---- fib / gann group
  fib: `<path d="M9 7h15M9 12h15M9 17h15M9 22h15"/>${dot(6.5, 7)}${dot(6.5, 22)}<path d="M6.5 8.6v11.8" stroke-dasharray="1.5 1.5"/>`,
  // ---- forecasting / measurement
  long: '<path d="M5.5 5.5h17v17h-17zM5.5 14h17"/><path d="M9 8.5v3h3" />',
  short: '<path d="M5.5 5.5h17v17h-17zM5.5 14h17"/><path d="M12 16.5h-3v3" />',
  pricerange: '<path d="M6 6.5h16M6 21.5h16M14 9v10M11.5 11.5 14 9l2.5 2.5M11.5 16.5 14 19l2.5-2.5"/>',
  daterange: '<path d="M6.5 6v16M21.5 6v16M9 14h10M11.5 11.5 9 14l2.5 2.5M16.5 11.5 19 14l-2.5 2.5"/>',
  datepricerange: '<path d="M5.5 5.5h17v17h-17z" stroke-dasharray="2 2"/><path d="M9 19 19 9M19 9h-4M19 9v4"/>',
  // ---- shapes
  rect: `<path d="M7 7h14v14H7z"/>${dot(7, 7)}${dot(21, 21)}`,
  circle: `<circle cx="14" cy="14" r="8.5"/>${dot(14, 14, 1.2)}`,
  // ---- annotation
  text: '<path d="M8 7.5h12M14 7.5v14M11.5 21.5h5"/>',
  pricelabel: '<path d="M6.5 8.5h11l5 5.5-5 5.5h-11z"/><path d="M9.5 14h6"/>',
  // ---- toolbar actions
  ruler: '<path d="m4.7 18.6 13.9-13.9 4.7 4.7-13.9 13.9z"/><path d="m8.3 15 1.8 1.8M10.8 12.5l2.6 2.6M13.3 10l1.8 1.8M15.8 7.5l2.6 2.6"/>',
  zoomin: '<circle cx="12.5" cy="12.5" r="6.5"/><path d="m17.2 17.2 5.3 5.3M12.5 9.5v6M9.5 12.5h6"/>',
  zoomout: '<circle cx="12.5" cy="12.5" r="6.5"/><path d="m17.2 17.2 5.3 5.3M9.5 12.5h6"/>',
  magnet: '<path d="M8 5.5h4v9a2 2 0 0 0 4 0v-9h4v9a6 6 0 0 1-12 0z"/><path d="M8 9.5h4M16 9.5h4"/>',
  magnetStrong: '<path d="M8 5.5h4v9a2 2 0 0 0 4 0v-9h4v9a6 6 0 0 1-12 0z"/><path d="M8 5.5h4v4H8zM16 5.5h4v4h-4z" fill="currentColor"/>',
  keepdraw: '<path d="m6 19.5 10.5-10.5 2.5 2.5L8.5 22H6zM15 10.5l2.5 2.5"/><path d="M18.5 17.5h5v5h-5zM19.5 17.5v-1.5a1.5 1.5 0 0 1 3 0"/>',
  lock: '<path d="M8.5 13.5h11v9h-11zM10.5 13.5v-3a3.5 3.5 0 0 1 7 0v3"/><path d="M14 16.5v3"/>',
  unlock: '<path d="M8.5 13.5h11v9h-11zM10.5 13.5v-3a3.5 3.5 0 0 1 6.8-1.2"/><path d="M14 16.5v3"/>',
  eye: '<path d="M4 14s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z"/><circle cx="14" cy="14" r="3"/>',
  eyeoff: '<path d="M4 14s3.6-6 10-6c1.8 0 3.3.5 4.6 1.1M24 14s-3.6 6-10 6c-1.8 0-3.3-.5-4.6-1.1"/><path d="m5.5 22.5 17-17"/>',
  folder: '<path d="M5.5 8.5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/>',
  star: '<path d="m14 5.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  tune: '<path d="M6 9h9M19 9h3M6 19h3M13 19h9"/><circle cx="17" cy="9" r="2"/><circle cx="11" cy="19" r="2"/>',
  code: '<path d="m10.5 9.5-4.5 4.5 4.5 4.5M17.5 9.5l4.5 4.5-4.5 4.5M15.5 7.5l-3 13"/>',
  trash: '<path d="M7 8.5h14M11.5 8.5V6.5h5v2M8.5 8.5l1 14h9l1-14"/>',
  // ---- top bar
  plusCircle: '<circle cx="14" cy="14" r="8.5"/><path d="M14 10v8M10 14h8"/>',
  bars: '<path d="M9 6v16M6.5 9H9M9 18h2.5M19 7v14M16.5 17H19M19 10h2.5"/>',
  candles: '<path d="M9.5 5.5v3M9.5 19.5v3M18.5 5.5v3M18.5 17.5v3"/><path d="M7.5 8.5h4v11h-4z"/><path d="M16.5 8.5h4v9h-4z" fill="currentColor"/>',
  hollow: '<path d="M9.5 5.5v3M9.5 19.5v3M18.5 5.5v3M18.5 17.5v3"/><path d="M7.5 8.5h4v11h-4zM16.5 8.5h4v9h-4z"/>',
  line: '<path d="m5 19 5.5-6 4 3.5L23 7"/>',
  linemarkers: `<path d="m5 19 5.5-6 4 3.5L23 7"/>${dot(10.5, 13)}${dot(14.5, 16.5)}`,
  stepline: '<path d="M5 19h4.5v-6h5v4h4V8H23"/>',
  area: '<path d="m5 18 5.5-6 4 3.5L23 7"/><path d="M5 22.5 5 18l5.5-6 4 3.5L23 7v15.5z" fill="currentColor" fill-opacity=".18" stroke="none"/>',
  baseline: '<path d="M4.5 14.5h19" stroke-dasharray="2 2"/><path d="m5 19 4.5-4.5M14 10l4.5 4.5 4.5-6"/><path d="M9.5 14.5 14 10"/>',
  columns: '<path d="M6.5 22.5v-6h3v6M12.5 22.5V9.5h3v13M18.5 22.5v-9h3v9M5 22.5h18"/>',
  heikin: '<path d="M9.5 5.5v3M9.5 19.5v3M18.5 5.5v3M18.5 17.5v3M7.5 8.5h4v11h-4zM16.5 8.5h4v9h-4z"/><path d="M7.5 12.5h4M16.5 12.5h4"/>',
  indicators: '<path d="M5 22.5h18M7 19.5V16M11 19.5v-6M15 19.5v-4M19 19.5v-8"/><path d="m6 11 4.5-4 4 3 5-4.5"/><path d="M17 5.5h2.5V8"/>',
  templates: '<rect x="5.5" y="5.5" width="7" height="7" rx="1.5"/><rect x="15.5" y="5.5" width="7" height="7" rx="1.5"/><rect x="5.5" y="15.5" width="7" height="7" rx="1.5"/><rect x="15.5" y="15.5" width="7" height="7" rx="1.5"/>',
  alarm: '<circle cx="13" cy="15" r="7"/><path d="M13 11v4.3l2.6 1.6M6 7.5l2.8-2.4M20 7.5l-2.8-2.4M20.5 20.5v5M18 23h5"/>',
  replay: '<path d="M12.5 8.5v11l-7-5.5zM21.5 8.5v11l-7-5.5z"/><path d="M23.5 8.5v11" />',
  undo: '<path d="M10 9.5 6.5 13l3.5 3.5"/><path d="M6.5 13h10a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="m18 9.5 3.5 3.5-3.5 3.5"/><path d="M21.5 13h-10a5 5 0 0 0 0 10h3"/>',
  layout1: '<rect x="6.5" y="7.5" width="15" height="13" rx="1.5"/>',
  layout2h: '<rect x="5.5" y="7.5" width="7.5" height="13" rx="1.5"/><rect x="15" y="7.5" width="7.5" height="13" rx="1.5"/>',
  layout2v: '<rect x="6.5" y="5.5" width="15" height="7.5" rx="1.5"/><rect x="6.5" y="15" width="15" height="7.5" rx="1.5"/>',
  layout3h: '<rect x="4.5" y="7.5" width="5.5" height="13" rx="1.2"/><rect x="11.25" y="7.5" width="5.5" height="13" rx="1.2"/><rect x="18" y="7.5" width="5.5" height="13" rx="1.2"/>',
  layout4: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><rect x="15" y="5.5" width="7.5" height="7.5" rx="1.5"/><rect x="5.5" y="15" width="7.5" height="7.5" rx="1.5"/><rect x="15" y="15" width="7.5" height="7.5" rx="1.5"/>',
  quicksearch: '<circle cx="12.5" cy="12.5" r="6.5"/><path d="m17.2 17.2 5.3 5.3M13.5 8.5l-2.5 4h3l-2.5 4"/>',
  hexgear: '<path d="m14 4.5 8.2 4.75v9.5L14 23.5l-8.2-4.75v-9.5z"/><circle cx="14" cy="14" r="3"/>',
  fullscreen: '<path d="M6.5 11V6.5H11M17 6.5h4.5V11M21.5 17v4.5H17M11 21.5H6.5V17"/>',
  camera: '<path d="M5.5 10.5a2 2 0 0 1 2-2h2.5l1.8-2.5h4.4l1.8 2.5h2.5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><circle cx="14" cy="14.5" r="3.8"/>',
  datatype: '<path d="M7 14h3l2-5 4 10 2-5h3"/>',
  // ---- right strip
  watchlist: '<path d="M7.5 5.5h13v17l-6.5-4-6.5 4z"/><path d="M10.5 10h7M10.5 13.5h7"/>',
  layers: '<path d="m14 6 9 4.8-9 4.8-9-4.8z"/><path d="m5 15 9 4.8 9-4.8"/>',
  strategy: '<path d="M5 22.5h18"/><path d="m6.5 18.5 5-5.5 3.5 3 6.5-8"/><path d="M17.5 8h4v4"/>',
  help: '<circle cx="14" cy="14" r="9"/><path d="M11.2 11.2a2.8 2.8 0 1 1 3.8 2.6c-.6.3-1 .8-1 1.5v.7"/><circle cx="14" cy="19" r=".6" fill="currentColor"/>',
  // ---- small glyphs
  chevronDown: '<path d="m1 1 3 3 3-3"/>',
  chevronRight: '<path d="m1 1 3 3-3 3"/>',
  chevronLeft: '<path d="M4 1 1 4l3 3"/>',
  plus: '<path d="M14 7v14M7 14h14"/>',
  more: '<circle cx="7.5" cy="14" r="1.6"/><circle cx="14" cy="14" r="1.6"/><circle cx="20.5" cy="14" r="1.6"/>',
  close: '<path d="m8 8 12 12M20 8 8 20"/>',
  check: '<path d="m7.5 14.5 4 4 9-9"/>',
  calendar: '<rect x="5.5" y="7.5" width="17" height="15" rx="2"/><path d="M5.5 12h17M10 5.5v4M18 5.5v4"/>',
  goto: '<rect x="5.5" y="7.5" width="17" height="15" rx="2"/><path d="M5.5 12h17M10 5.5v4M18 5.5v4M10 17h8M15.5 14.5 18 17l-2.5 2.5"/>',
  dollar: '<circle cx="14" cy="14" r="8.5"/><path d="M16.8 10.8c-.4-1-1.5-1.6-2.8-1.6-1.6 0-2.8.9-2.8 2.2 0 3 5.6 1.6 5.6 4.6 0 1.3-1.2 2.3-2.8 2.3-1.4 0-2.5-.7-2.9-1.8M14 7.5v1.7M14 18.3v2"/>',
  pool: '<path d="M6.5 8.5h15M6.5 14h15M6.5 19.5h9"/>',
  download: '<path d="M14 5.5v12M9.5 13l4.5 4.5 4.5-4.5M6.5 18.5v4h15v-4"/>',
  minimize: '<path d="M7 18.5h14"/>',
  maximize: '<path d="M6.5 15v6.5H13M15 6.5h6.5V13"/>',
  restore: '<path d="M13 21.5V15H6.5M21.5 13H15V6.5"/>',
  sortDown: '<path d="M14 7v14M9.5 16.5 14 21l4.5-4.5"/>',
  sortUp: '<path d="M14 21V7M9.5 11.5 14 7l4.5 4.5"/>',
  play: '<path d="M10 7.5v13l10-6.5z"/>',
  pause: '<path d="M10 7.5v13M18 7.5v13"/>',
  stepfwd: '<path d="M8 7.5v13l9-6.5zM20 7.5v13"/>',
  jumpend: '<path d="M6 7.5v13l7-6.5zM14 7.5v13l7-6.5zM22.5 7.5v13"/>',
  pickbar: '<path d="M14 4.5v19" stroke-dasharray="2 2"/><path d="m9 9 5 5 5-5"/>',
  edit: '<path d="m6.5 18.5 11-11 3 3-11 11h-3zM15.5 9.5l3 3"/>',
  link: '<path d="M12.5 7.5h-5v13h13v-5M16 5.5h6.5V12M22.5 5.5 13 15"/>',
  sun: '<circle cx="14" cy="14" r="4.5"/><path d="M14 4.5v2.5M14 21v2.5M4.5 14H7M21 14h2.5M7.3 7.3l1.8 1.8M18.9 18.9l1.8 1.8M7.3 20.7l1.8-1.8M18.9 9.1l1.8-1.8"/>',
  moon: '<path d="M20.5 17.2A8 8 0 0 1 10.8 7.5a8 8 0 1 0 9.7 9.7z"/>',
  keyboard: '<rect x="4.5" y="8.5" width="19" height="11" rx="2"/><path d="M8 12h1M11.5 12h1M15 12h1M18.5 12h1M9 15.5h10"/>',
  csv: '<path d="M8.5 4.5h8l4 4v15h-12z"/><path d="M16.5 4.5v4h4M11 14h6M11 17.5h6"/>',
};

/** Icon by name. `size` scales the 28px drawing; small glyphs (chevrons) use an 8px viewBox. */
export function icon(name: string, size = 28): string {
  if (name === 'chevronDown') return svg(P.chevronDown, size === 28 ? 8 : size, 8).replace('viewBox="0 0 8 8"', 'viewBox="0 0 8 5"').replace(/height="\d+"/, `height="${size === 28 ? 5 : size}"`);
  if (name === 'chevronRight' || name === 'chevronLeft') return svg(P[name], size === 28 ? 5 : size, 8).replace('viewBox="0 0 8 8"', 'viewBox="0 0 5 8"').replace(/height="\d+"/, `height="${size === 28 ? 8 : size}"`);
  return svg(P[name] ?? P.cross, size);
}

export const ICON_NAMES = Object.keys(P);
