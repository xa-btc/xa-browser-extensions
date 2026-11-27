import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, safeStack, assessEvent, diagnosticEvent, appendDiagnostics, diagnosticDefaults, runtimeArguments, networkHint } from '../extension/diagnostic-core.js';
import { parseBrowserError } from '../native/log-reader.mjs';

const id = 'a'.repeat(32);
const time = '2026-11-22T12:00:10.000Z';
const event = (kind, details = {}, tabId = 42, at = time) => diagnosticEvent(kind, tabId, 'https://example.test/page?secret=1#secret', kind, details, 'info', 'fixture', at);

test('structured URLs and stacks strip credentials, queries and fragments', () => {
  assert.equal(safeUrl('https://user:pass@example.test/path?token=secret#fragment'), 'https://example.test/path');
  assert.equal(safeUrl('data:text/html,private'), 'data:[not recorded]');
  assert.equal(safeStack({ callFrames: [{ url: 'https://example.test/script.js?token=secret' }] }).callFrames[0].url, 'https://example.test/script.js');
});

test('generic reloads and nearby errors do not become an invented extension cause', () => {
  const reload = event('reload');
  const error = event('console-error', {}, 42, '2026-11-22T12:00:09.000Z');
  const runtime = [{ id: 'runtime', category: 'api_call', api: 'tabs.reload', receivedAt: time, extensionId: id, name: 'Fixture' }];
  const report = assessEvent(reload, [error, reload], runtime);
  assert.match(report.observations[0], /unknown/);
  assert.equal(report.extensionCorrelations[0].targetMatched, false);
  assert.match(report.extensionCorrelations[0].note, /Receipt-time proximity only/);
  assert.equal(report.nearby.length, 1);
});

test('explicit other-tab extension calls are excluded; this-tab calls still do not prove success', () => {
  const runtime = [7, 42].map(tab => ({ id: String(tab), category: 'api_call', api: 'tabs.reload', receivedAt: time, extensionId: id, name: 'Fixture', rawDetails: `ARGS=[${tab},{"bypassCache":true}] COUNT=0` }));
  const report = assessEvent(event('reload'), [], runtime);
  assert.equal(report.extensionCorrelations.length, 1);
  assert.equal(report.extensionCorrelations[0].targetMatched, true);
  assert.match(report.extensionCorrelations[0].note, /unverified/);
});

test('runtime argument parsing handles nested strings/brackets and rejects truncated JSON', () => {
  assert.deepEqual(runtimeArguments('ARGS=[42,{"text":"] \\\" ARGS=[evil]"}] COUNT=0'), [42, { text: '] \" ARGS=[evil]' }]);
  assert.equal(runtimeArguments('ARGS=[42,{"unfinished":'), null);
});

test('document stack, monitor reload request, and repeated reloads provide distinct evidence', () => {
  const reload = event('reload');
  const request = event('document-request', { topFrame: true, initiator: { type: 'script', stack: { callFrames: [{ url: `chrome-extension://${id}/script.js` }] } } }, 42, '2026-11-22T12:00:09.000Z');
  const manual = event('reload-requested', { bypassCache: true }, 42, '2026-11-22T12:00:08.000Z');
  const history = [event('reload', {}, 42, '2026-11-22T11:59:45.000Z'), event('reload', {}, 42, '2026-11-22T12:00:01.000Z'), manual, request, reload];
  const report = assessEvent(reload, history, [], [{ id, name: 'Fixture' }]);
  assert.ok(report.observations.some(value => value.includes('initiator stack names Fixture')));
  assert.ok(report.observations.some(value => value.includes('cache-bypassing')));
  assert.ok(report.observations.some(value => value.includes('3 reloads')));
});

test('errors distinguish blocked-client, cancellation, DNS and server evidence without naming a culprit', () => {
  assert.match(networkHint('net::ERR_BLOCKED_BY_CLIENT'), /does not identify/);
  assert.match(networkHint('net::ERR_ABORTED'), /not by itself a fault/);
  assert.match(networkHint('net::ERR_NAME_NOT_RESOLVED'), /DNS/);
  assert.match(networkHint('', 503), /server returned an error/);
});

test('initiators from the preceding reload are not attributed to the next committed loader', () => {
  const firstRequest = event('document-request', { loaderId: 'first', topFrame: true, initiator: { type: 'script', stack: { callFrames: [{ url: `chrome-extension://${id}/script.js` }] } } }, 42, '2026-11-22T12:00:08.000Z');
  const firstCommit = event('reload', { loaderId: 'first' }, 42, '2026-11-22T12:00:09.000Z');
  const current = event('reload', { loaderId: 'second', navigationType: 'reloadBypassingCache' });
  const report = assessEvent(current, [firstRequest, firstCommit, current], [], [{ id, name: 'Old initiator' }]);
  assert.ok(report.observations.some(item => item.includes('cache-bypassing reload')));
  assert.ok(!report.observations.some(item => item.includes('Old initiator')));
});

test('diagnostic retention is independent and bounded by bytes and count', () => {
  const records = Array.from({ length: 1100 }, () => event('console-error', { message: 'x'.repeat(2000) }));
  const result = appendDiagnostics(diagnosticDefaults(), records);
  assert.ok(result.events.length < 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(result.events)) <= 1_000_000);
  assert.equal(result.droppedEvents, 1100 - result.events.length);
});

test('browser-process parser preserves source/level without inventing tab or extension identity', () => {
  const parsed = parseBrowserError('[1:2:1122/120010.123:ERROR:net/socket/ssl_client_socket_impl.cc:900] handshake failed');
  assert.equal(parsed.level, 'ERROR');
  assert.equal(parsed.component, 'net/socket/ssl_client_socket_impl.cc:900');
  assert.equal(parsed.extensionId, undefined);
  assert.equal(parseBrowserError('console spoof [1:2:1122/120010.123:ERROR:fake] message'), null);
});
