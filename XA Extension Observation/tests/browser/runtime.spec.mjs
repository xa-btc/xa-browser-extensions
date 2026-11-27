import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, writeFile, readFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('real diagnostic API calls stream through a registered native companion into the terminal', async ({}, testInfo) => {
  const root = resolve(import.meta.dirname, '../..');
  await mkdir(join(root, 'test-results'), { recursive: true });
  const sandbox = await mkdtemp(join(root, 'test-results/runtime-'));
  const native = join(sandbox, 'native');
  const extension = join(sandbox, 'extension');
  const fixture = join(sandbox, 'fixture');
  const logPath = join(sandbox, 'activity.log');
  const hostName = `com.xa.extension_observatory.test_${Date.now()}`;
  await cp(join(root, 'native'), native, { recursive: true, filter: source => !/host\.(config|manifest)\.json|launch-host\.cmd|runtime-logs/.test(source) });
  await cp(join(root, 'extension'), extension, { recursive: true });
  // Only this isolated test copy pre-grants nativeMessaging and uses a unique host.
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.permissions.push('nativeMessaging', 'tabs', 'webNavigation');
  delete manifest.optional_permissions;
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'telemetry.js'), (await readFile(join(extension, 'telemetry.js'), 'utf8')).replace("'com.xa.extension_observatory'", JSON.stringify(hostName)));
  await mkdir(fixture);
  await writeFile(join(fixture, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Runtime Fixture', version: '1.0', permissions: ['storage'], background: { service_worker: 'worker.js' } }));
  await writeFile(join(fixture, 'worker.js'), 'setInterval(() => { chrome.storage.local.set({fixtureProbe: Date.now()}); chrome.commands.getAll(); }, 400);');
  const context = await chromium.launchPersistentContext(join(sandbox, 'profile'), {
    executablePath: process.env.BRAVE_EXECUTABLE || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    headless: true, viewport: { width: 1460, height: 1060 },
    args: [`--disable-extensions-except=${extension},${fixture}`, `--load-extension=${extension},${fixture}`, '--enable-extension-activity-logging', '--enable-extension-activity-log-testing', '--enable-logging', '--vmodule=activity_log=1', `--log-file=${logPath}`, '--no-first-run']
  });
  let registered = false;
  try {
    let worker = context.serviceWorkers().find(x => x.url().endsWith('/background.js'));
    if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: x => x.url().endsWith('/background.js') });
    const id = new URL(worker.url()).hostname;
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(native, 'Register-Host.ps1'), '-ExtensionId', id, '-NodePath', process.execPath, '-HostName', hostName], { windowsHide: true });
    registered = true;
    await writeFile(join(native, 'host.config.json'), JSON.stringify({ extensionId: id, logPath }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    await expect(page.locator('#stat-installed')).toHaveText('1');
    await page.locator('[data-view="runtime"]').click();
    await page.locator('#connect-runtime').click();
    await expect(page.locator('#runtime-status')).toContainText('Connected to diagnostic log', { timeout: 15000 });
    await expect(page.locator('#runtime-list')).toContainText('storage.set', { timeout: 15000 });
    await expect(page.locator('#runtime-list')).toContainText('Runtime Fixture');
    let stored = await worker.evaluate(async () => (await chrome.storage.local.get('observatory')).observatory);
    expect(stored.runtime.events.every(x => !Object.hasOwn(x, 'rawDetails'))).toBe(true);
    expect(stored.runtime.events.every(x => x.extensionId !== id)).toBe(true);
    await page.locator('#runtime-details').check();
    await page.locator('#connect-runtime').click();
    await expect.poll(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('observatory')).observatory.runtime.events)).some(x => x.rawDetails?.includes('fixtureProbe')), { timeout: 15000 }).toBe(true);
    await page.locator('#runtime-search').fill('fixtureProbe');
    await expect(page.locator('#runtime-list .event')).not.toHaveCount(0);
    await page.locator('#runtime-search').fill('');
    await page.locator('#runtime-list .event').first().locator('summary').click();
    await page.screenshot({ path: testInfo.outputPath('runtime-live.png'), fullPage: true });
    await page.locator('[data-view="diagnostics"]').click();
    await page.locator('#diagnostic-enable').click();
    await expect.poll(async () => (await worker.evaluate(async () => (await chrome.storage.local.get('observatory')).observatory.runtime.status))).toBe('connected');
    // Explicitly synthetic process warning; verifies framing and forwarding only.
    await appendFile(logPath, '\n[1:2:1122/120010.123:WARNING:fixture_component.cc:1] fixture browser warning\n');
    await expect(page.locator('#diagnostic-list')).toContainText('fixture browser warning', { timeout: 10000 });
    await page.locator('[data-view="runtime"]').click();
    await page.locator('#disconnect-runtime').click();
    await expect(page.locator('#runtime-status')).toContainText('disconnected');
    const frozen = (await worker.evaluate(async () => (await chrome.storage.local.get('observatory')).observatory.runtime.events)).length;
    // Wait for the next real fixture call and verify disconnected storage stays frozen.
    await expect.poll(async () => (await readFile(logPath, 'utf8')).length).toBeGreaterThan(0);
    stored = await worker.evaluate(async () => (await chrome.storage.local.get('observatory')).observatory);
    expect(stored.runtime.events.length).toBe(frozen);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    if (registered) execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(native, 'Unregister-Host.ps1'), '-HostName', hostName], { windowsHide: true });
  }
});
