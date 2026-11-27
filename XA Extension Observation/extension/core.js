export const SCHEMA_VERSION = 1;
export const MAX_EVENTS = 2000;
export const MAX_EVENT_BYTES = 3_000_000;
export const MAX_IMPORT_BYTES = 2_000_000;
export const EXTENSION_ID = /^[a-p]{32}$/;

export const CAPABILITIES = [
  { name: 'Browser errors, reloads & navigation', status: 'Optional', detail: 'Enable navigation monitoring, then capture selected tabs for console errors, failed requests, document initiators, and WebSocket failures. The companion can add browser-process warnings/errors. Evidence is partial; nearby extension activity is not automatic attribution.' },
  { name: 'Installed extensions & enabled state', status: 'Observed', detail: 'Brave management API, in this profile. Enabled does not mean a background worker is currently running.' },
  { name: 'API permissions & host patterns', status: 'Reported', detail: 'Permissions reported by Brave. Site restrictions, incognito access, file access toggles, and actual use are not resolved by this API.' },
  { name: 'Install, enable, disable & removal events', status: 'Observed', detail: 'Lifecycle events while monitoring is on. Periodic reconciliation detects differences after gaps; it cannot reconstruct every action during a gap.' },
  { name: 'Versions & access changes', status: 'Sampled', detail: 'Snapshot comparison every minute, on lifecycle events, and on refresh. Timing is when a change was observed.' },
  { name: 'Declared commands & content scripts', status: 'Import', detail: 'Import manifest.json files. Imported declarations are static, version matched, and not execution evidence. Suggested shortcuts are not current assigned shortcuts.' },
  { name: 'Live API calls & logged runtime activity', status: 'Companion', detail: 'The optional local companion tails Brave’s diagnostic activity log. It reports API calls/events and DOM, script, or web-request records the browser emits. It is not a complete network capture or audit of every operation.' },
  { name: 'Profile attribution for runtime events', status: 'Limited', detail: 'Diagnostic logs cover a Brave process. IDs are matched to this profile’s inventory, but an identical extension ID in another open profile cannot be distinguished.' },
  { name: 'Per-extension CPU, memory & runtime state', status: 'Unavailable', detail: 'Not provided by the public APIs used here. Use Brave Task Manager (Shift+Esc) for a separate resource view.' }
];

export const PERMISSION_DETAILS = {
  activeTab: 'Temporary access to a tab after a user gesture.',
  tabs: 'Read sensitive tab metadata such as URL and title.',
  scripting: 'Inject scripts when the extension also has applicable host or activeTab access.',
  cookies: 'Access cookies on permitted hosts.',
  history: 'Read and change browsing history.',
  bookmarks: 'Read and change bookmarks.',
  downloads: 'Manage downloads.',
  downloadsOpen: 'Open downloaded files.',
  clipboardRead: 'Read clipboard data.',
  clipboardWrite: 'Write clipboard data.',
  debugger: 'Attach to permitted debugging targets; grants extensive inspection capabilities.',
  management: 'Read installed extensions and manage their enabled or installed state. This monitor only reads.',
  nativeMessaging: 'Communicate with separately installed native messaging hosts.',
  webRequest: 'Observe permitted network requests, subject to browser restrictions.',
  webRequestBlocking: 'Modify permitted requests where the browser allows blocking listeners.',
  declarativeNetRequest: 'Apply declarative network rules. This is a capability, not proof of a request being modified.',
  declarativeNetRequestWithHostAccess: 'Apply declarative network rules on permitted hosts.',
  storage: 'Store this extension’s own data.',
  unlimitedStorage: 'Relax the quota for this extension’s local data.',
  alarms: 'Schedule background callbacks.',
  notifications: 'Display desktop notifications.',
  privacy: 'Change supported browser privacy settings.',
  proxy: 'Change the browser proxy configuration.',
  browsingData: 'Remove supported browsing data.',
  contentSettings: 'Change supported site content settings.',
  tabCapture: 'Capture a tab when allowed by the browser.',
  desktopCapture: 'Request screen or window capture.',
  offscreen: 'Create an offscreen extension document.'
};

const sensitive = new Set(['debugger', 'nativeMessaging', 'proxy', 'history', 'cookies', 'clipboardRead', 'management', 'privacy', 'browsingData', 'contentSettings', 'desktopCapture']);
export const strings = value => Array.isArray(value) ? [...new Set(value.filter(x => typeof x === 'string'))].sort() : [];
export const byteSize = value => new TextEncoder().encode(JSON.stringify(value)).length;
export const broadHost = pattern => ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*'].includes(pattern);
export function accessFlags(info) {
  return [
    ...(info.hostPermissions.some(broadHost) ? ['Broad host access'] : []),
    ...info.permissions.filter(x => sensitive.has(x))
  ];
}

export function normalizeInfo(info) {
  return {
    id: String(info.id), name: String(info.name ?? info.id), description: String(info.description ?? ''),
    version: String(info.version ?? ''), enabled: Boolean(info.enabled), type: info.type ?? 'extension',
    installType: info.installType ?? 'other', disabledReason: info.disabledReason ?? null,
    permissions: strings(info.permissions), hostPermissions: strings(info.hostPermissions)
  };
}

export function initialState(now) {
  return { schemaVersion: SCHEMA_VERSION, monitoring: true, startedAt: now, lastScan: null, lastError: null, inventory: [], events: [], imports: {}, droppedEvents: 0 };
}

export function makeEvent(kind, info, details, now, source = 'snapshot') {
  return { id: crypto.randomUUID(), time: now, kind, extensionId: info?.id ?? null, name: info?.name ?? 'Observatory', source, details };
}

export function differences(before, after) {
  const changes = {};
  for (const field of ['name', 'version', 'enabled', 'disabledReason', 'installType', 'permissions', 'hostPermissions']) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) changes[field] = { before: before[field], after: after[field] };
  }
  return changes;
}

export function compareInventory(previous, current, now, baseline = false) {
  if (baseline) return [makeEvent('baseline', null, { extensions: current.length, note: 'Initial inventory; not installation history.' }, now)];
  const old = new Map(previous.map(info => [info.id, info]));
  const next = new Map(current.map(info => [info.id, info]));
  const events = [];
  for (const info of current) {
    const before = old.get(info.id);
    if (!before) events.push(makeEvent('discovered', info, { note: 'New since the previous snapshot.', version: info.version, permissions: info.permissions, hostPermissions: info.hostPermissions }, now));
    else {
      const changes = differences(before, info);
      if (Object.keys(changes).length) events.push(makeEvent('changed', info, changes, now));
    }
  }
  for (const info of previous) if (!next.has(info.id)) events.push(makeEvent('removed', info, { note: 'Absent from the latest snapshot.' }, now));
  return events;
}

export function appendEvents(state, events) {
  const all = [...state.events, ...events];
  let removed = Math.max(0, all.length - MAX_EVENTS);
  let kept = all.slice(removed);
  // A byte bound also handles extensions with thousands of host patterns.
  let size = byteSize(kept);
  while (kept.length && size > MAX_EVENT_BYTES) {
    size -= byteSize(kept[0]) + 1;
    kept.shift();
    removed++;
  }
  return { ...state, events: kept, droppedEvents: state.droppedEvents + removed };
}

export function reconcile(state, raw, selfId, now) {
  const inventory = raw.filter(info => info.id !== selfId && info.type === 'extension').map(normalizeInfo).sort((a, b) => a.name.localeCompare(b.name));
  return appendEvents({ ...state, inventory, lastScan: now, lastError: null }, compareInventory(state.inventory, inventory, now, !state.lastScan));
}

export function recordLifecycle(state, kind, raw, now) {
  if (!state.monitoring) return state;
  const info = typeof raw === 'string' ? state.inventory.find(x => x.id === raw) ?? { id: raw, name: raw } : normalizeInfo(raw);
  const before = state.inventory.find(x => x.id === info.id);
  let inventory = state.inventory.filter(x => x.id !== info.id);
  if (kind !== 'uninstalled') inventory.push(info);
  inventory.sort((a, b) => a.name.localeCompare(b.name));
  const details = kind === 'uninstalled' ? { previousVersion: before?.version ?? null } : { version: info.version, changes: before ? differences(before, info) : null, permissions: info.permissions, hostPermissions: info.hostPermissions };
  return appendEvents({ ...state, inventory }, [makeEvent(kind, info, details, now, 'management event')]);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
}
function text(value, max = 4000) { return typeof value === 'string' ? value.slice(0, max) : ''; }

export function normalizeManifest(manifest) {
  requireObject(manifest, 'Manifest');
  if (![2, 3].includes(manifest.manifest_version) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('Expected an extension manifest with name, version, and manifest_version 2 or 3.');
  const commands = Object.entries(manifest.commands ?? {}).map(([name, command]) => {
    requireObject(command, `Command ${name}`);
    const suggested = typeof command.suggested_key === 'string' ? command.suggested_key : command.suggested_key?.windows ?? command.suggested_key?.default ?? '';
    return { name: text(name), description: text(command.description), suggestedKey: text(suggested), global: command.global === true };
  });
  const scripts = (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []).map(script => ({
    matches: strings(script.matches), excludeMatches: strings(script.exclude_matches), includeGlobs: strings(script.include_globs), excludeGlobs: strings(script.exclude_globs),
    js: strings(script.js), css: strings(script.css), runAt: text(script.run_at) || 'document_idle', allFrames: script.all_frames === true,
    matchAboutBlank: script.match_about_blank === true, matchOriginAsFallback: script.match_origin_as_fallback === true, world: text(script.world) || 'ISOLATED'
  }));
  return {
    name: text(manifest.name), version: text(manifest.version), manifestVersion: manifest.manifest_version,
    permissions: strings(manifest.permissions), hostPermissions: strings(manifest.host_permissions),
    optionalPermissions: strings(manifest.optional_permissions), optionalHostPermissions: strings(manifest.optional_host_permissions),
    commands, contentScripts: scripts, background: {
      serviceWorker: text(manifest.background?.service_worker), scripts: strings(manifest.background?.scripts),
      page: text(manifest.background?.page), persistent: manifest.background?.persistent ?? null, type: text(manifest.background?.type)
    },
    externallyConnectable: manifest.externally_connectable ? { ids: strings(manifest.externally_connectable.ids), matches: strings(manifest.externally_connectable.matches) } : null
  };
}

export function applyImports(state, entries, now) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw new Error('Choose between 1 and 1000 manifest files.');
  if (byteSize(entries) > MAX_IMPORT_BYTES) throw new Error('Manifest batch exceeds 2 MB. Import smaller batches.');
  const imports = { ...state.imports };
  const accepted = new Set();
  const skipped = [];
  for (const entry of entries) {
    const current = state.inventory.find(x => x.id === entry.id);
    if (!EXTENSION_ID.test(entry.id ?? '') || !current) { skipped.push({ id: text(entry.id), reason: 'Not in this profile’s inventory.' }); continue; }
    const manifest = normalizeManifest(entry.manifest);
    if (current.version !== manifest.version) { skipped.push({ id: entry.id, reason: `Version ${manifest.version} does not match installed ${current.version}.` }); continue; }
    imports[entry.id] = { ...manifest, importedAt: now };
    accepted.add(entry.id);
  }
  if (byteSize(imports) > MAX_IMPORT_BYTES) throw new Error('Stored manifest details exceed 2 MB. Remove old imports first.');
  return {
    state: appendEvents({ ...state, imports }, [makeEvent('manifest-import', null, { accepted: accepted.size, skipped }, now, 'manual import')]),
    accepted: accepted.size, skipped
  };
}

export function manifestStatus(info, imports) {
  const data = imports[info.id];
  if (!data) return { status: 'missing', data: null };
  return { status: data.version === info.version ? 'current' : 'stale', data };
}

export function filterInventory(inventory, { search = '', state = 'all', broad = false } = {}) {
  const query = search.trim().toLowerCase();
  return inventory.filter(info => (state === 'all' || info.enabled === (state === 'enabled')) && (!broad || accessFlags(info).length > 0) && (!query || [info.name, info.id, info.description, ...info.permissions, ...info.hostPermissions].join(' ').toLowerCase().includes(query)));
}

export function parseTerminal(input) {
  const [command = '', ...rest] = input.trim().split(/\s+/);
  return { command: command.toLowerCase(), argument: rest.join(' ') };
}
