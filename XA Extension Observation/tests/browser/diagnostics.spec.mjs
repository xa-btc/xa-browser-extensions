import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';

test('Brave captures real tab errors, failed requests and reload evidence without changing other tabs', async ({}, testInfo) => {
  const root = resolve(import.meta.dirname, '../..');
  await mkdir(join(root, 'test-results'), { recursive: true });
  const sandbox = await mkdtemp(join(root, 'test-results/diagnostics-'));
  const extension = join(sandbox, 'extension');
  await cp(join(root, 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.permissions.push('tabs', 'webNavigation');
  manifest.optional_permissions = ['nativeMessaging'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  const server = createServer((request, response) => {
    if (request.url.startsWith('/fail')) { response.writeHead(503); response.end('Fixture unavailable'); return; }
    if (request.url.startsWith('/disconnect')) { request.socket.destroy(); return; }
    if (request.url.startsWith('/favicon')) { response.writeHead(204); response.end(); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Diagnostic fixture</title><button id="error" onclick="console.error(\'fixture console error\'); setTimeout(()=>{throw new Error(\'fixture uncaught exception\')},0)">Errors</button><button id="network" onclick="fetch(\'/fail?secret=redacted\'); fetch(\'/disconnect\').catch(()=>{})">Network</button><button id="reload" onclick="location.reload()">Script reload</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await chromium.launchPersistentContext(join(sandbox, 'profile'), {
    executablePath: process.env.BRAVE_EXECUTABLE || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', headless: true,
    viewport: { width: 1460, height: 1060 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-first-run']
  });
  try {
    let worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js'));
    if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: item => item.url().endsWith('/background.js') });
    const id = new URL(worker.url()).hostname;
    worker.on('console', message => { if (message.type() === 'error') console.log('Worker error:', message.text()); });
    const page = await context.newPage();
    const uiErrors = [];
    page.on('pageerror', error => uiErrors.push(error.message));
    await page.goto(`chrome-extension://${id}/dashboard.html`);
    const target = await context.newPage(); await target.goto(`${origin}/problem?token=hidden`);
    const unrelated = await context.newPage(); await unrelated.goto(`${origin}/other`);
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const tabId = tabs.find(tab => tab.url.includes('/problem')).id;
    const otherId = tabs.find(tab => tab.url.includes('/other')).id;
    await page.locator('[data-view="diagnostics"]').click();
    await page.locator('#diagnostic-enable').click();
    await expect(page.locator('#diagnostic-status')).toContainText('Navigation monitoring enabled');
    await page.locator('#diagnostic-target').selectOption(String(tabId));
    await page.locator('#diagnostic-attach').click();
    await expect(page.locator('#diagnostic-captures')).toContainText(`#${tabId}`, { timeout: 10000 });
    await target.locator('#error').click();
    await target.locator('#network').click();
    await expect(page.locator('#diagnostic-list')).toContainText('fixture console error', { timeout: 10000 });
    await expect(page.locator('#diagnostic-list')).toContainText('fixture uncaught exception');
    await expect(page.locator('#diagnostic-list')).toContainText('HTTP 503');
    await expect(page.locator('#diagnostic-list')).toContainText('net::ERR_EMPTY_RESPONSE');
    await target.locator('#reload').click();
    await expect(page.locator('#diagnostic-reloads')).toHaveText('1 observed reloads', { timeout: 10000 });
    await expect(page.locator('#diagnostic-list')).toContainText('document request');
    await page.locator('#diagnostic-hard-reload').click();
    await expect(page.locator('#diagnostic-reloads')).toHaveText('2 observed reloads');
    const data = await worker.evaluate(async () => (await chrome.storage.local.get('diagnostics')).diagnostics);
    expect(data.events.some(event => event.kind === 'reload-requested' && event.details.bypassCache)).toBe(true);
    expect(data.events.some(event => event.kind === 'reload' && event.details.navigationType === 'reloadBypassingCache')).toBe(true);
    expect(data.events.some(event => event.kind === 'http-error' && event.url.endsWith('/fail'))).toBe(true);
    expect(data.events.every(event => !event.url.includes('?'))).toBe(true);
    expect(data.events.some(event => event.tabId === otherId && event.kind === 'reload')).toBe(false);
    const reload = page.locator('#diagnostic-list details').filter({ has: page.locator('.tag', { hasText: /^reload$/ }) }).first();
    await reload.locator('summary').click();
    await expect(reload).toContainText('Browser explicitly classified this committed load');
    await page.screenshot({ path: testInfo.outputPath('browser-diagnostics.png'), fullPage: true });
    const downloadPromise = page.waitForEvent('download'); await page.locator('#export').click();
    const path = testInfo.outputPath('diagnostics-export.json'); await (await downloadPromise).saveAs(path);
    expect(JSON.parse(await readFile(path, 'utf8')).diagnostics.events.some(event => event.kind === 'reload')).toBe(true);
    await page.locator('#pause').click();
    await expect(page.locator('#diagnostic-status')).toContainText('Monitoring paused');
    await expect(page.locator('#diagnostic-captures .chip')).toHaveCount(0);
    const frozen = (await worker.evaluate(async () => (await chrome.storage.local.get('diagnostics')).diagnostics)).events.length;
    await target.reload();
    await target.locator('#error').click();
    expect((await worker.evaluate(async () => (await chrome.storage.local.get('diagnostics')).diagnostics)).events.length).toBe(frozen);
    await page.locator('#pause').click();
    await expect(page.locator('#diagnostic-status')).toContainText('0 tab(s) in detailed capture');
    await page.setViewportSize({ width: 600, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(uiErrors).toEqual([]);
  } finally { await context.close(); await new Promise(resolve => server.close(resolve)); }
});
