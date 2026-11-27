import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LogReader } from './log-reader.mjs';

const config = JSON.parse((await readFile(resolve(import.meta.dirname, 'host.config.json'), 'utf8')).replace(/^\uFEFF/, ''));
if (!/^[a-p]{32}$/.test(config.extensionId) || process.argv[2] !== `chrome-extension://${config.extensionId}/`) throw new Error('Native host origin does not match its configured extension.');
if (typeof config.logPath !== 'string' || !config.logPath) throw new Error('No diagnostic log configured. Run Start-BraveLogging.ps1 first.');

let input = Buffer.alloc(0);
let reader = null;
let busy = false;
let lastStatus = '';
let blockedOutput = false;
function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > 900_000) throw new Error('Native response exceeds the frame limit.');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  blockedOutput = !process.stdout.write(Buffer.concat([header, body]));
}
process.stdout.on('drain', () => { blockedOutput = false; });
process.stdout.on('error', () => process.exit(0));
async function poll() {
  if (!reader || busy || blockedOutput) return;
  busy = true;
  try {
    const result = await reader.poll();
    const status = { state: 'connected', logPath: config.logPath, fileBytes: result.fileBytes, backlogBytes: result.backlogBytes };
    if (result.events.length || result.browserErrors.length || result.started || result.reset || result.skippedLines || lastStatus !== 'connected') send({ type: 'batch', ...result, status });
    lastStatus = 'connected';
  } catch (error) {
    const message = error.code === 'ENOENT' ? 'Diagnostic log not found. Exit Brave fully and start it with Start-BraveLogging.ps1.' : error.message;
    if (lastStatus !== message) send({ type: 'status', state: 'error', error: message });
    lastStatus = message;
  } finally { busy = false; }
}
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 1_100_000) process.exit(1);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length < 2 || length > 100_000) process.exit(1);
    if (input.length < length + 4) break;
    const frame = input.subarray(4, 4 + length);
    input = input.subarray(4 + length);
    try {
      const message = JSON.parse(frame.toString('utf8'));
      if (message.type !== 'start') throw new Error('Only the start request is supported.');
      if (reader) throw new Error('A collector is already running. Reconnect to change options.');
      reader = new LogReader(config.logPath, message.extensionIds.filter(id => id !== config.extensionId), message.includeDetails === true, message.includeBrowserErrors === true);
      void poll();
    } catch (error) { send({ type: 'status', state: 'error', error: error.message }); }
  }
});
const timer = setInterval(() => { void poll(); }, 1000);
process.stdin.on('end', () => { clearInterval(timer); process.exit(0); });
