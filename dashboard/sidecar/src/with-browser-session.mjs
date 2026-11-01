// Start the sidecar authenticated as the TradingView account signed in to a debug-port Chrome.
// Reads the sessionid / sessionid_sign cookies over CDP and passes them to the sidecar through its
// environment only: they are never printed, logged or written to disk.
//   node src/with-browser-session.mjs [cdpEndpoint=http://127.0.0.1:9222]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tradingViewSession } from './browser-cookies.mjs';

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9222';
let session, signature;
try { ({ session, signature } = await tradingViewSession(endpoint)); } catch (e) { console.error(e.message); process.exit(1); }
console.log('Starting sidecar with the browser\'s TradingView session (credentials not shown).');
const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(here, 'server.mjs')], {
  stdio: 'inherit', env: { ...process.env, TV_SESSIONID: session, TV_SESSIONID_SIGN: signature },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', code => process.exit(code ?? 0));
