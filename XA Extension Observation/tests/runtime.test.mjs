import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseActivityLine, LogReader, MAX_LINE_BYTES } from '../native/log-reader.mjs';
import { appendRuntime, runtimeDefaults } from '../extension/telemetry.js';

const id = 'a'.repeat(32);
const other = 'b'.repeat(32);
const line = (extensionId = id, details = ' ARGS=["local",{"probe":1}] COUNT=0') => `[123:456:1122/183916.321:VERBOSE1:chrome\\browser\\extensions\\activity_log\\activity_log.cc:781] ACTION ID=-1 EXTENSION ID=${extensionId} CATEGORY=api_call API=storage.set${details}\n`;

test('log parser validates the source prefix and identity, with details omitted by default', () => {
  const parsed = parseActivityLine(line().trim(), new Set([id]));
  assert.equal(parsed.api, 'storage.set');
  assert.equal(parsed.rawDetails, undefined);
  assert.ok(parseActivityLine(line().trim(), new Set([id]), true).rawDetails.includes('probe'));
  assert.equal(parseActivityLine(line(other).trim(), new Set([id])), null);
  assert.equal(parseActivityLine(`spoof ${line().trim()}`, new Set([id])), null);
  assert.equal(parseActivityLine(line().replace('activity_log.cc', 'console.cc').trim(), new Set([id])), null);
});

test('tail starts at end, handles partial lines and UTF-8, and does not replay records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'observatory-reader-'));
  const path = join(dir, 'activity.log');
  await writeFile(path, line());
  const reader = new LogReader(path, [id], true);
  assert.equal((await reader.poll()).events.length, 0);
  const next = line(id, ' ARGS=["é✓"] COUNT=0');
  const buffer = Buffer.from(next);
  await appendFile(path, buffer.subarray(0, buffer.length - 5));
  assert.equal((await reader.poll()).events.length, 0);
  await appendFile(path, buffer.subarray(buffer.length - 5));
  assert.match((await reader.poll()).events[0].rawDetails, /é✓/);
  assert.equal((await reader.poll()).events.length, 0);
});

test('tail detects a rewritten same-size file and resumes after rotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'observatory-rotation-'));
  const path = join(dir, 'activity.log');
  await writeFile(path, line());
  const reader = new LogReader(path, [id], true);
  await reader.poll();
  await writeFile(path, line(id).replace('probe', 'other'));
  const result = await reader.poll();
  assert.equal(result.reset, true);
  assert.equal(result.events.length, 1);
  await truncate(path, 0);
  assert.equal((await reader.poll()).reset, true);
});

test('oversized log lines are skipped without blocking later activity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'observatory-longline-'));
  const path = join(dir, 'activity.log');
  await writeFile(path, '');
  const reader = new LogReader(path, [id]);
  await reader.poll();
  await appendFile(path, 'x'.repeat(MAX_LINE_BYTES + 500) + '\n' + line());
  await reader.poll();
  const result = await reader.poll();
  assert.equal(result.skippedLines, 1);
  assert.equal(result.events.length, 1);
});

test('runtime record storage has separate retention and refuses unrelated IDs or details while off', () => {
  const current = runtimeDefaults();
  const incoming = [{ extensionId: id, api: 'storage.set', category: 'api_call', rawDetails: 'secret' }, { extensionId: other, api: 'tabs.query' }];
  let result = appendRuntime(current, { events: incoming }, [{ id, name: 'Fixture' }], new Date().toISOString());
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].rawDetails, undefined);
  for (let i = 0; i < 12; i++) result = appendRuntime(result, { events: Array(100).fill(incoming[0]) }, [{ id, name: 'Fixture' }], new Date().toISOString());
  assert.equal(result.events.length, 1000);
  assert.equal(result.droppedEvents, 201);
});

test('native process warnings are opt-in and retain their separate unattributed record type', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'observatory-browser-errors-'));
  const path = join(dir, 'activity.log');
  await writeFile(path, '');
  const enabled = new LogReader(path, [id], false, true);
  const disabled = new LogReader(path, [id]);
  await enabled.poll(); await disabled.poll();
  await appendFile(path, '[1:2:1122/120010.123:ERROR:fixture.cc:1] test warning\n' + line());
  const result = await enabled.poll();
  assert.equal(result.events.length, 1);
  assert.equal(result.browserErrors.length, 1);
  assert.equal((await disabled.poll()).browserErrors.length, 0);
});
