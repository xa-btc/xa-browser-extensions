import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { openTerminal } from '../../extension/window.js';

const root = resolve(import.meta.dirname, '../..');
const executablePath = process.env.BRAVE_EXECUTABLE || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

test('real Brave: inventory, lifecycle events, pause gaps, imports, export, responsive UI and restart persistence', async ({}, testInfo) => {
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  const sandbox = await mkdtemp(resolve(root, 'test-results/brave-'));
  const fixtureOne = join(sandbox, 'fixture-one');
  const fixtureTwo = join(sandbox, 'fixture-two');
  await mkdir(fixtureOne);
  await mkdir(fixtureTwo);
  const manifest = {
    manifest_version: 3, name: 'Fixture Reader', version: '1.0', description: 'Synthetic test fixture. Never accesses a real website.',
    permissions: ['storage', 'tabs', 'scripting'], host_permissions: ['https://example.test/*'],
    background: { service_worker: 'worker.js' },
    commands: { inspect: { description: 'Inspect fixture', suggested_key: { default: 'Ctrl+Shift+Y', windows: 'Ctrl+Shift+K' } } },
    content_scripts: [{ matches: ['https://example.test/*'], exclude_matches: ['https://example.test/private/*'], js: ['content.js'], run_at: 'document_idle' }]
  };
  await writeFile(join(fixtureOne, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(fixtureOne, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  await writeFile(join(fixtureOne, 'content.js'), '// Inert local fixture.');
  await writeFile(join(fixtureTwo, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture Broad Access', version: '2.1', description: '<img src=x onerror=alert(1)>', permissions: ['cookies'], host_permissions: ['<all_urls>'], background: { service_worker: 'worker.js' } }));
  await writeFile(join(fixtureTwo, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {});');
  const extensions = [resolve(root, 'extension'), fixtureOne, fixtureTwo].join(',');
  const launch = () => chromium.launchPersistentContext(join(sandbox, 'profile'), {
    executablePath, headless: true, viewport: { width: 1460, height: 1060 },
    args: [`--disable-extensions-except=${extensions}`, `--load-extension=${extensions}`, '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--disable-background-networking']
  });
  let context = await launch();
  try {
    let worker = context.serviceWorkers().find(x => x.url().endsWith('/background.js'));
    if (!worker) worker = await context.waitForEvent('serviceworker', { predicate: x => x.url().endsWith('/background.js') });
    const extensionId = new URL(worker.url()).hostname;
    // Exercise the same standalone-window launcher used by the toolbar action.
    const popupPromise = context.waitForEvent('page');
    await worker.evaluate(openTerminal);
    const page = await popupPromise;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const workerErrors = [];
    worker.on('console', message => { if (message.type() === 'error') workerErrors.push(message.text()); });
    await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await expect(page.locator('#stat-installed')).toHaveText('2');
    await expect(page.locator('#stat-enabled')).toHaveText('2');
    await expect(page.locator('#stat-broad')).toHaveText('1');
    await expect(page.locator('#monitor-status')).toHaveText('Monitoring lifecycle');
    const beforeWindows = await worker.evaluate(() => chrome.windows.getAll());
    await worker.evaluate(openTerminal);
    expect((await worker.evaluate(() => chrome.windows.getAll())).length).toBe(beforeWindows.length);
    const inventory = await worker.evaluate(() => chrome.management.getAll());
    const readerId = inventory.find(x => x.name === 'Fixture Reader').id;
    const broadId = inventory.find(x => x.name === 'Fixture Broad Access').id;

    // The fixture description must stay literal text, never an HTML element.
    await page.getByRole('button', { name: 'Inspect Fixture Broad Access', exact: true }).click();
    await expect(page.locator('#extension-detail')).toContainText('<img src=x onerror=alert(1)>');
    await expect(page.locator('#extension-detail img')).toHaveCount(0);
    await page.locator('#extension-search').fill('scripting');
    await expect(page.locator('.extension-row')).toHaveCount(1);
    await expect(page.locator('.extension-row')).toContainText('Fixture Reader');
    await page.locator('#extension-search').fill('');
    await page.getByRole('button', { name: 'Inspect Fixture Reader', exact: true }).click();
    await page.getByRole('button', { name: 'Commands', exact: true }).click();
    await expect(page.locator('.detail-body')).toContainText('Commands are unknown, not zero');

    // Import only the explicit fixture file and inspect static commands/scripts.
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import manifest', exact: true }).click();
    await (await chooser).setFiles(join(fixtureOne, 'manifest.json'));
    await expect(page.locator('.command-card')).toContainText('Ctrl+Shift+K');
    await expect(page.locator('.command-card')).toContainText('logged command events');
    await page.getByRole('button', { name: 'Content scripts', exact: true }).click();
    await expect(page.locator('.script-card')).toContainText('https://example.test/private/*');

    // Bulk folder import matches IDs/versions and skips old version folders.
    const bulk = join(sandbox, 'Extensions');
    const broadManifest = JSON.parse(await readFile(join(fixtureTwo, 'manifest.json'), 'utf8'));
    for (const version of ['2.1', '1.0']) {
      const folder = join(bulk, broadId, `${version}_0`);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'manifest.json'), JSON.stringify({ ...broadManifest, version }));
    }
    await page.locator('[data-view="coverage"]').click();
    await page.locator('#folder-input').setInputFiles(bulk);
    await expect(page.locator('#import-result')).toContainText('Imported 1 extension manifest(s); skipped 1');
    await expect(page.locator('#import-result')).toContainText('does not match installed 2.1');
    await page.locator('[data-view="inventory"]').click();

    // Exercise real public management events only against synthetic fixtures.
    await worker.evaluate(id => chrome.management.setEnabled(id, false), broadId);
    await expect(page.locator('#stat-enabled')).toHaveText('1');
    await page.locator('[data-view="activity"]').click();
    await page.locator('#event-search').fill(broadId);
    await expect(page.locator('#event-list')).toContainText('DISABLED');
    await page.locator('#pause').click();
    await expect(page.locator('#monitor-status')).toHaveText('Monitoring paused');
    await worker.evaluate(id => chrome.management.setEnabled(id, true), broadId);
    await page.locator('#refresh').click();
    await expect(page.locator('#stat-enabled')).toHaveText('1');
    await page.locator('#pause').click();
    await expect(page.locator('#stat-enabled')).toHaveText('2');
    await expect(page.locator('#event-list')).toContainText('CHANGED');

    // Terminal routing, ambiguity, and the complete local export.
    await page.locator('#terminal-input').fill('inspect Fixture Reader');
    await page.locator('#terminal-input').press('Enter');
    await expect(page.locator('#inventory-view')).toBeVisible();
    await expect(page.locator('#extension-detail h2')).toHaveText('Fixture Reader');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloadPromise;
    const exportPath = testInfo.outputPath('export.json');
    await download.saveAs(exportPath);
    const exported = JSON.parse(await readFile(exportPath, 'utf8'));
    expect(exported.inventory.length).toBe(2);
    expect(exported.imports[readerId].commands[0].suggestedKey).toBe('Ctrl+Shift+K');
    expect(exported.events.some(x => x.kind === 'disabled' && x.extensionId === broadId)).toBe(true);
    expect(exported.events.some(x => x.kind === 'enabled' && x.extensionId === broadId)).toBe(false);
    expect(exported.coverage.find(x => x.name.includes('Live API calls')).status).toBe('Companion');
    await page.getByRole('button', { name: 'Access', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('dashboard-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 600, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('dashboard-narrow.png'), fullPage: true });
    await page.locator('[data-view="coverage"]').click();
    await expect(page.locator('#coverage-list')).toContainText('UNAVAILABLE');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    expect(workerErrors).toEqual([]);

    // Pausing persists across an actual browser shutdown and fresh worker.
    await page.locator('#pause').click();
    await expect(page.locator('#monitor-status')).toHaveText('Monitoring paused');
    await context.close();
    context = await launch();
    const restored = await context.newPage();
    await restored.goto(`chrome-extension://${extensionId}/dashboard.html`);
    await expect(restored.locator('#monitor-status')).toHaveText('Monitoring paused');
    await expect(restored.locator('#stat-installed')).toHaveText('2');
    await restored.getByRole('button', { name: 'Inspect Fixture Reader', exact: true }).click();
    await restored.getByRole('button', { name: 'Commands', exact: true }).click();
    await expect(restored.locator('.command-card')).toContainText('Ctrl+Shift+K');
    await restored.locator('[data-view="activity"]').click();
    await restored.locator('#clear-history').click();
    await restored.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(restored.locator('#event-list')).toContainText('DISABLED');
    await restored.locator('#clear-history').click();
    await restored.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(restored.locator('#stat-events')).toHaveText('1');
    await expect(restored.locator('#event-list')).toContainText('HISTORY-CLEARED');
  } finally { await context.close(); }
});
