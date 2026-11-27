// Development probe: only a new temporary Brave profile and an inert fixture.
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
await mkdir(join(root, 'test-results'), { recursive: true });
const temp = await mkdtemp(join(root, 'test-results/activity-probe-'));
const fixture = join(temp, 'fixture');
await mkdir(fixture);
await writeFile(join(fixture, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Activity Probe', version: '1.0', permissions: ['storage'], background: { service_worker: 'worker.js' } }));
await writeFile(join(fixture, 'worker.js'), 'setInterval(() => chrome.storage.local.set({probe: Date.now()}), 800);');
const context = await chromium.launchPersistentContext(join(temp, 'profile'), {
  executablePath: process.env.BRAVE_EXECUTABLE || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', headless: true,
  args: [`--disable-extensions-except=${fixture}`, `--load-extension=${fixture}`, '--enable-extension-activity-logging', '--enable-extension-activity-log-testing', '--enable-logging', '--vmodule=activity_log=1', `--log-file=${join(temp, 'activity.log')}`, '--no-first-run']
});
try {
  await new Promise(resolve => setTimeout(resolve, 3_000));
  const lines = (await readFile(join(temp, 'activity.log'), 'utf8')).split('\n').filter(line => line.includes('EXTENSION ID='));
  console.log({ logPath: join(temp, 'activity.log'), activityLines: lines.length, samples: lines.slice(0, 3) });
} finally { await context.close(); }
