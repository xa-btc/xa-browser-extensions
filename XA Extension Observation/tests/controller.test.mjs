import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../extension/controller.js';

const id = 'a'.repeat(32);
const selfId = 'b'.repeat(32);
const info = (changes = {}) => ({ id, name: 'Test extension', version: '1.0', enabled: true, type: 'extension', permissions: ['tabs'], hostPermissions: [], ...changes });

function fixture() {
  let store = {};
  let items = [info()];
  let getError = null;
  let failWrite = false;
  const api = {
    runtime: { id: selfId },
    storage: { local: {
      get: async () => structuredClone(store),
      set: async data => { await new Promise(resolve => setTimeout(resolve, 2)); if (failWrite) { failWrite = false; throw new Error('Write failed'); } store = structuredClone(data); }
    } },
    management: { getAll: async () => { if (getError) throw new Error(getError); return structuredClone(items); } }
  };
  return { api, controller: createController(api, () => '2026-11-22T12:00:00.000Z'), setItems: value => { items = value; }, setError: value => { getError = value; }, failWrite: () => { failWrite = true; } };
}

test('serialized transactions retain simultaneous lifecycle changes and imports', async () => {
  const { controller } = fixture();
  await controller.refresh();
  await Promise.all([
    controller.lifecycle('disabled', info({ enabled: false })),
    controller.importManifests([{ id, manifest: { manifest_version: 3, name: 'Test extension', version: '1.0' } }]),
    controller.lifecycle('enabled', info())
  ]);
  const result = await controller.snapshot();
  assert.equal(result.inventory[0].enabled, true);
  assert.ok(result.imports[id]);
  assert.deepEqual(result.events.map(x => x.kind), ['baseline', 'disabled', 'manifest-import', 'enabled']);
});

test('service worker restart restores history, imports, and pause setting', async () => {
  const { controller, api } = fixture();
  await controller.refresh();
  await controller.setMonitoring(false);
  const restarted = createController(api);
  const result = await restarted.snapshot();
  assert.equal(result.monitoring, false);
  assert.equal(result.inventory.length, 1);
  assert.equal(result.events.at(-1).kind, 'paused');
});

test('pause freezes inventory; resume reconciles changes without inventing missing lifecycle events', async () => {
  const f = fixture();
  await f.controller.refresh();
  await f.controller.setMonitoring(false);
  f.setItems([info({ enabled: false, version: '2.0' })]);
  await f.controller.lifecycle('disabled', info({ enabled: false }));
  assert.equal((await f.controller.refresh()).inventory[0].enabled, true);
  const result = await f.controller.setMonitoring(true);
  assert.equal(result.inventory[0].enabled, false);
  assert.equal(result.inventory[0].version, '2.0');
  assert.ok(result.events.some(x => x.kind === 'changed'));
  assert.ok(!result.events.some(x => x.kind === 'disabled'));
});

test('failed scans preserve last successful inventory, surface errors, and recover on retry', async () => {
  const f = fixture();
  const before = await f.controller.refresh();
  f.setError('Management unavailable');
  await assert.rejects(f.controller.refresh(), /Management unavailable/);
  const failed = await f.controller.snapshot();
  assert.deepEqual(failed.inventory, before.inventory);
  assert.equal(failed.lastScan, before.lastScan);
  assert.equal(failed.lastError, 'Management unavailable');
  f.setError(null);
  assert.equal((await f.controller.refresh()).lastError, null);
});

test('failed storage writes do not commit in-memory phantom changes or poison the queue', async () => {
  const f = fixture();
  await f.controller.refresh();
  f.failWrite();
  await assert.rejects(f.controller.lifecycle('disabled', info({ enabled: false })), /Write failed/);
  assert.equal((await f.controller.snapshot()).inventory[0].enabled, true);
  await f.controller.lifecycle('disabled', info({ enabled: false }));
  assert.equal((await f.controller.snapshot()).inventory[0].enabled, false);
});

test('clearing history retains inventory/imports and self/theme events are ignored', async () => {
  const { controller } = fixture();
  await controller.refresh();
  await controller.importManifests([{ id, manifest: { manifest_version: 3, name: 'Test extension', version: '1.0' } }]);
  await controller.lifecycle('enabled', info({ id: selfId }));
  await controller.lifecycle('enabled', info({ id: 'c'.repeat(32), type: 'theme' }));
  await controller.lifecycle('uninstalled', 'c'.repeat(32));
  assert.equal((await controller.snapshot()).events.length, 2);
  const result = await controller.clearHistory();
  assert.equal(result.inventory.length, 1);
  assert.ok(result.imports[id]);
  assert.deepEqual(result.events.map(x => x.kind), ['history-cleared']);
});
