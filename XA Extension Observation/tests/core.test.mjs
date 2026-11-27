import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, normalizeInfo, reconcile, recordLifecycle, appendEvents, applyImports, manifestStatus, accessFlags, filterInventory, parseTerminal, byteSize, MAX_EVENTS, MAX_EVENT_BYTES, normalizeManifest } from '../extension/core.js';

const id = 'a'.repeat(32);
const otherId = 'b'.repeat(32);
const selfId = 'c'.repeat(32);
const now = '2026-11-22T12:00:00.000Z';
const info = (changes = {}) => ({ id, name: 'Fixture', version: '1.0', type: 'extension', enabled: true, permissions: ['storage', 'tabs'], hostPermissions: ['https://example.test/*'], ...changes });
const state = () => reconcile(initialState(now), [info()], selfId, now);
const manifest = (changes = {}) => ({ manifest_version: 3, name: 'Fixture', version: '1.0', commands: { inspect: { description: 'Inspect fixture', suggested_key: { default: 'Ctrl+Shift+Y', windows: 'Ctrl+Shift+K' } } }, ...changes });

test('inventory excludes the monitor, apps, and themes; first snapshot is baseline, not fake installs', () => {
  const result = reconcile(initialState(now), [info(), info({ id: selfId }), info({ id: otherId, type: 'theme' })], selfId, now);
  assert.deepEqual(result.inventory.map(x => x.id), [id]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].kind, 'baseline');
});

test('permission reordering and duplicate permissions do not create changes', () => {
  const before = state();
  const result = reconcile(before, [info({ permissions: ['tabs', 'storage', 'tabs'] })], selfId, now);
  assert.equal(result.events.length, before.events.length);
});

test('reconciliation captures additions, removals, permissions, hosts, versions, and disabled state', () => {
  const before = reconcile(initialState(now), [info(), info({ id: otherId })], selfId, now);
  const result = reconcile(before, [info({ version: '2.0', enabled: false, permissions: ['cookies'], hostPermissions: ['<all_urls>'] }), info({ id: 'd'.repeat(32) })], selfId, now);
  const change = result.events.find(x => x.kind === 'changed');
  assert.deepEqual(change.details.permissions, { before: ['storage', 'tabs'], after: ['cookies'] });
  assert.deepEqual(change.details.hostPermissions, { before: ['https://example.test/*'], after: ['<all_urls>'] });
  assert.equal(change.details.version.after, '2.0');
  assert.equal(change.details.enabled.after, false);
  assert.ok(result.events.some(x => x.kind === 'removed' && x.extensionId === otherId));
  assert.ok(result.events.some(x => x.kind === 'discovered'));
});

test('rapid lifecycle events are kept even when snapshots would miss the transition', () => {
  let result = state();
  result = recordLifecycle(result, 'disabled', info({ enabled: false }), now);
  result = recordLifecycle(result, 'enabled', info(), now);
  result = reconcile(result, [info()], selfId, now);
  assert.deepEqual(result.events.map(x => x.kind), ['baseline', 'disabled', 'enabled']);
  assert.equal(result.inventory[0].enabled, true);
  assert.equal(result.events[1].source, 'management event');
});

test('paused monitoring ignores lifecycle events and preserves frozen inventory', () => {
  const before = { ...state(), monitoring: false };
  assert.equal(recordLifecycle(before, 'uninstalled', id, now), before);
});

test('uninstall preserves the name in history but removes the live item', () => {
  const result = recordLifecycle(state(), 'uninstalled', id, now);
  assert.equal(result.inventory.length, 0);
  assert.equal(result.events.at(-1).name, 'Fixture');
});

test('retention respects count and byte bounds and reports discarded history', () => {
  const entries = Array.from({ length: MAX_EVENTS + 20 }, (_, index) => ({ id: index, details: {} }));
  let result = appendEvents(initialState(now), entries);
  assert.equal(result.events.length, MAX_EVENTS);
  assert.equal(result.events[0].id, 20);
  assert.equal(result.droppedEvents, 20);
  result = appendEvents(result, [{ id: 'large', details: { content: 'é'.repeat(MAX_EVENT_BYTES) } }]);
  assert.ok(byteSize(result.events) <= MAX_EVENT_BYTES);
  assert.equal(result.droppedEvents, MAX_EVENTS + 21);
});

test('manifest imports require matching installed ID and version, preserve suggested keys and optional declarations', () => {
  const result = applyImports(state(), [
    { id, manifest: manifest({ optional_permissions: ['history'], optional_host_permissions: ['https://optional.test/*'] }) },
    { id: otherId, manifest: manifest() },
    { id, manifest: manifest({ version: '0.9' }) }
  ], now);
  assert.equal(result.accepted, 1);
  assert.equal(result.skipped.length, 2);
  const data = result.state.imports[id];
  assert.equal(data.commands[0].suggestedKey, 'Ctrl+Shift+K');
  assert.deepEqual(data.optionalPermissions, ['history']);
  assert.deepEqual(data.optionalHostPermissions, ['https://optional.test/*']);
  assert.equal(manifestStatus(info(), result.state.imports).status, 'current');
  assert.equal(manifestStatus(info({ version: '2.0' }), result.state.imports).status, 'stale');
  assert.equal(manifestStatus(info({ id: otherId }), result.state.imports).status, 'missing');
});

test('imports cannot prototype-pollute the map or overwrite an existing match with old data', () => {
  const first = applyImports(state(), [{ id, manifest: manifest() }], now).state;
  const second = applyImports(first, [{ id: '__proto__', manifest: manifest() }, { id, manifest: manifest({ version: '0.9' }) }], now);
  assert.equal(second.accepted, 0);
  assert.equal(second.state.imports[id].version, '1.0');
  assert.equal(Object.prototype.version, undefined);
});

test('invalid or oversized imports fail atomically', () => {
  const before = state();
  assert.throws(() => applyImports(before, [{ id, manifest: manifest() }, { id, manifest: {} }], now), /Expected an extension manifest/);
  assert.deepEqual(before.imports, {});
  assert.throws(() => applyImports(before, [{ id, manifest: manifest({ description: 'x'.repeat(2_000_001) }) }], now), /exceeds 2 MB/);
});

test('manifest projection preserves content-script matching restrictions and excludes unneeded raw data', () => {
  const result = normalizeManifest(manifest({
    content_scripts: [{ matches: ['https://*.test/*'], exclude_matches: ['https://private.test/*'], include_globs: ['*foo*'], exclude_globs: ['*bar*'], js: ['content.js'], all_frames: true, match_about_blank: true, match_origin_as_fallback: true, world: 'MAIN' }],
    background: { service_worker: 'worker.js', type: 'module' }, secretUnusedField: 'not copied'
  }));
  assert.equal(result.contentScripts[0].world, 'MAIN');
  assert.deepEqual(result.contentScripts[0].excludeGlobs, ['*bar*']);
  assert.equal(result.contentScripts[0].matchOriginAsFallback, true);
  assert.equal(result.background.serviceWorker, 'worker.js');
  assert.equal(result.secretUnusedField, undefined);
});

test('access flags and search do not label ordinary host access as broad or treat disabled as running', () => {
  const normal = normalizeInfo(info());
  const flagged = normalizeInfo(info({ id: otherId, enabled: false, permissions: ['nativeMessaging'], hostPermissions: ['<all_urls>'] }));
  assert.deepEqual(accessFlags(normal), []);
  assert.deepEqual(accessFlags(flagged), ['Broad host access', 'nativeMessaging']);
  assert.equal(filterInventory([normal, flagged], { search: 'nativeMessaging', state: 'enabled' }).length, 0);
  assert.equal(filterInventory([normal, flagged], { search: 'example.test' }).length, 1);
  assert.equal(filterInventory([normal, flagged], { broad: true })[0].id, otherId);
});

test('terminal parser treats input as plain tokens, never executable code', () => {
  assert.deepEqual(parseTerminal('  INSPECT My Extension '), { command: 'inspect', argument: 'My Extension' });
  assert.equal(parseTerminal('$(whoami)').command, '$(whoami)');
});
