// Read the TradingView session cookies from a debug-port Chrome over CDP. Callers pass them on through
// process memory/environment only: they are never printed, logged or written to disk.
export async function tradingViewSession(endpoint = 'http://127.0.0.1:9222') {
  const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cookies = await new Promise((res, rej) => {
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id === 1) (m.error ? rej(new Error(m.error.message)) : res(m.result.cookies)); };
    ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
  });
  ws.close();
  const pick = name => cookies.find(c => c.name === name && c.domain.endsWith('tradingview.com'))?.value;
  const session = pick('sessionid'), signature = pick('sessionid_sign');
  if (!session || !signature) throw new Error('No TradingView session cookies in that browser: sign in at tradingview.com first.');
  return { session, signature };
}
