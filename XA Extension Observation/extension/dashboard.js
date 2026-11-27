import { CAPABILITIES, PERMISSION_DETAILS, accessFlags, broadHost, filterInventory, manifestStatus, parseTerminal, MAX_IMPORT_BYTES } from './core.js';
import { createDiagnosticsView } from './diagnostics-ui.js';

const $ = id => document.getElementById(id);
let snapshot = null;
let selectedId = null;
let detailTab = 'access';
let importTargetId = null;
let inventorySignature = '';
let detailSignature = '';
let eventSignature = '';
let runtimeSignature = '';
let runtimeOptionsSignature = '';
let pending = 0;
let commandHistory = [];
let historyIndex = 0;
const diagnosticsView = createDiagnosticsView({ request, run, notice, getInventoryState: () => snapshot, confirmAction });

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function add(parent, ...children) { parent.append(...children); return parent; }
function button(label, callback, className = '') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', () => run(callback));
  return node;
}
function tag(content, kind = '') { return element('span', `tag ${kind}`, content); }
function date(value) { return value ? new Date(value).toLocaleString() : 'Not yet scanned'; }
function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = !message;
}
function log(message) {
  const lines = `${$('terminal-output').textContent}\n${message}`.split('\n');
  $('terminal-output').textContent = lines.slice(-160).join('\n');
  $('terminal-output').scrollTop = $('terminal-output').scrollHeight;
}
async function run(callback) {
  try { return await callback(); } catch (error) { notice(error.message, true); log(`ERROR: ${error.message}`); return null; }
}
async function request(type, extra = {}) {
  if (!globalThis.chrome?.runtime?.id) throw new Error('Load the extension in Brave, then click its toolbar icon. This page needs an extension context.');
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error ?? 'The background monitor did not respond. Reload the extension in Brave.');
  return response.data;
}
async function refresh() {
  $('refresh').disabled = true;
  try {
    update(await request('refresh'));
    notice(snapshot.monitoring ? 'Inventory refreshed.' : 'Monitoring is paused. Resume it to refresh the frozen inventory.');
  } finally { $('refresh').disabled = false; }
}
async function monitoring(enabled) { update(await request('monitoring', { enabled })); notice(enabled ? 'Monitoring resumed. Changes during the gap are reconciled from snapshots.' : 'Monitoring paused. Lifecycle events during this gap will not be captured.'); }

function update(state) {
  snapshot = state;
  const enabled = state.inventory.filter(info => info.enabled);
  $('stat-installed').textContent = state.inventory.length;
  $('stat-enabled').textContent = enabled.length;
  $('stat-broad').textContent = enabled.filter(info => info.hostPermissions.some(broadHost)).length;
  $('stat-events').textContent = state.events.length;
  $('nav-count').textContent = state.inventory.length;
  $('retention-label').textContent = state.droppedEvents ? `${state.droppedEvents.toLocaleString()} older events discarded by retention` : 'Local lifecycle & snapshot history';
  $('pause').textContent = state.monitoring ? 'Pause monitoring' : 'Resume monitoring';
  $('monitor-status').textContent = state.lastError ? 'Scan error' : state.monitoring ? 'Monitoring lifecycle' : 'Monitoring paused';
  $('monitor-dot').classList.toggle('paused', !state.monitoring);
  $('monitor-dot').classList.toggle('error', Boolean(state.lastError));
  $('scan-status').textContent = `Last inventory scan: ${date(state.lastScan)}${state.monitoring ? '' : ' · PAUSED / inventory frozen'}`;
  if (state.lastError) notice(`Inventory scan failed: ${state.lastError}. Showing the last successful snapshot.`, true);
  else if ($('notice').classList.contains('error') && $('notice').textContent.startsWith('Inventory scan failed:')) notice('Inventory monitoring recovered.');
  renderInventory();
  renderEvents();
  renderRuntime();
  diagnosticsView.render();
}

function showView(view) {
  const labels = { inventory: ['Extensions', 'Extension overview', 'Permissions, changes, and declarations across your browser.'], activity: ['Activity log', 'Follow the changes', 'A local record of what the browser lets this monitor observe.'], runtime: ['Runtime calls', 'Watch recorded API calls', 'Browser diagnostic events streamed through your local companion.'], diagnostics: ['Browser diagnostics', 'Find the evidence behind issues', 'Trace errors, failed requests, and page reloads without guessing at a cause.'], coverage: ['Coverage & imports', 'Understand your visibility', 'See what is observed, what is imported, and what the browser does not expose.'] };
  document.querySelectorAll('.nav-button').forEach(node => { node.classList.toggle('selected', node.dataset.view === view); node.setAttribute('aria-current', node.dataset.view === view ? 'page' : 'false'); });
  for (const name of Object.keys(labels)) $(`${name}-view`).hidden = name !== view;
  [$('view-name').textContent, $('page-title').textContent, $('page-subtitle').textContent] = labels[view];
  if (view === 'diagnostics') void run(async () => { await diagnosticsView.refresh(); await diagnosticsView.refreshTabs(); });
}

function renderInventory(force = false) {
  if (!snapshot) return;
  const filters = { search: $('extension-search').value, state: $('state-filter').value, broad: $('sensitive-filter').checked };
  const filtered = filterInventory(snapshot.inventory, filters);
  if (!filtered.some(info => info.id === selectedId)) selectedId = filtered[0]?.id ?? null;
  $('visible-count').textContent = ` / ${filtered.length}`;
  const signature = JSON.stringify([filtered, selectedId]);
  if (force || signature !== inventorySignature) {
    inventorySignature = signature;
    const list = $('extension-list');
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (!filtered.length) add(list, add(element('div', 'empty'), element('h3', '', 'No matching extensions'), element('p', '', snapshot.inventory.length ? 'Change the search or state filters to see more extensions.' : 'No other extensions were returned by this profile.')));
    for (const info of filtered) {
      const row = button('', () => { selectedId = info.id; renderInventory(); }, `extension-row${info.id === selectedId ? ' selected' : ''}`);
      row.setAttribute('aria-label', `Inspect ${info.name}`);
      row.setAttribute('aria-pressed', String(info.id === selectedId));
      const initials = info.name.split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase();
      const label = add(element('div', 'extension-label'), element('span', 'extension-name', info.name), add(element('div', 'extension-meta'), element('span', '', `v${info.version}`), element('span', '', info.enabled ? '● enabled' : '○ disabled')));
      const count = element('div', 'access-count', `${info.permissions.length} APIs`);
      const flags = accessFlags(info);
      add(count, element('small', '', flags.length ? `${flags.length} notable` : `${info.hostPermissions.length} hosts`));
      add(row, element('div', 'extension-avatar', initials || '?'), label, count);
      list.append(row);
    }
    list.scrollTop = scroll;
  }
  renderDetail();
}

function section(parent, title) { parent.append(element('div', 'section-label', title)); }
function chips(parent, values, empty = 'None reported') {
  if (!values.length) parent.append(element('p', 'muted', empty));
  else parent.append(add(element('div', 'chips'), ...values.map(value => element('code', 'chip', value))));
}
function permissions(parent, values) {
  if (!values.length) parent.append(element('p', 'muted', 'None reported.'));
  for (const value of values) parent.append(add(element('div', 'permission-row'), element('code', '', value), element('span', '', PERMISSION_DETAILS[value] ?? 'Browser permission. Its presence describes capability, not observed use.')));
}
function importedLabel(parent, imported) {
  parent.append(element('p', imported.status === 'stale' ? 'notice' : 'muted', imported.status === 'stale' ? `Outdated import: v${imported.data.version}. Reimport the currently installed version. These declarations are not current.` : `Static manifest imported ${date(imported.data.importedAt)}. Same-version source edits are not detected.`));
}
function renderDetail() {
  const info = snapshot?.inventory.find(item => item.id === selectedId);
  const signature = JSON.stringify([info, detailTab, snapshot?.imports[info?.id]]);
  if (signature === detailSignature) return;
  detailSignature = signature;
  const root = $('extension-detail');
  root.replaceChildren();
  if (!info) { add(root, add(element('div', 'empty'), element('span', 'empty-icon', '◎'), element('h3', '', 'Select an extension'), element('p', '', 'Its reported access and imported declarations will appear here.'))); return; }
  const header = element('div', 'detail-header');
  add(header, add(element('div', 'detail-title-row'), element('h2', '', info.name), tag(info.enabled ? 'ENABLED' : 'DISABLED', info.enabled ? '' : 'muted')), element('code', 'extension-id', info.id), element('p', '', info.description));
  add(header, add(element('div', 'detail-chips'), tag(`v${info.version}`, 'muted'), tag(info.installType.toUpperCase(), 'muted'), ...accessFlags(info).map(flag => tag(flag, 'amber'))));
  root.append(header);
  const tabs = element('div', 'detail-tabs');
  for (const [name, label] of [['access', 'Access'], ['commands', 'Commands'], ['scripts', 'Content scripts'], ['details', 'Details']]) {
    const tab = button(label, () => { detailTab = name; renderDetail(); }, detailTab === name ? 'selected' : '');
    tab.setAttribute('aria-pressed', String(detailTab === name));
    tabs.append(tab);
  }
  root.append(tabs);
  const body = element('div', 'detail-body');
  const imported = manifestStatus(info, snapshot.imports);
  if (detailTab === 'access') {
    section(body, 'REPORTED API PERMISSIONS');
    permissions(body, info.permissions);
    section(body, 'REPORTED HOST PATTERNS');
    chips(body, info.hostPermissions);
    body.append(element('p', 'muted', 'Host patterns do not resolve site-level restrictions, incognito or file-access switches. Enabled state does not prove execution or access to a particular page.'));
    if (imported.data) {
      section(body, 'OPTIONAL DECLARATIONS / IMPORTED');
      importedLabel(body, imported);
      chips(body, [...imported.data.optionalPermissions, ...imported.data.optionalHostPermissions], 'No optional permissions declared in the imported manifest.');
      body.append(element('p', 'muted', 'Optional declarations are not evidence that permission was granted.'));
    }
  } else if (detailTab === 'commands') {
    section(body, 'DECLARED COMMANDS');
    body.append(element('p', '', 'Brave only exposes an extension’s commands to that extension itself. Import its manifest to inspect declared commands. Suggested keys can differ from the shortcuts assigned in Brave.'));
    body.append(add(element('div', 'button-row'), button('Import manifest', () => { importTargetId = info.id; $('manifest-input').click(); }, 'primary'), button('Assigned shortcuts ↗', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))));
    if (!imported.data) body.append(element('p', 'muted', 'No manifest imported. Commands are unknown, not zero.'));
    else {
      importedLabel(body, imported);
      if (!imported.data.commands.length) body.append(element('p', '', 'No commands declared in this imported manifest.'));
      for (const command of imported.data.commands) body.append(add(element('div', 'command-card'), element('strong', '', command.name), element('p', '', command.description || 'No description declared'), element('kbd', '', command.suggestedKey || 'No suggested key'), element('p', 'muted', `Suggested Windows shortcut · ${command.global ? 'Global command declared' : 'Browser command'} · Check Runtime calls for logged command events`)));
    }
  } else if (detailTab === 'scripts') {
    section(body, 'DECLARED CONTENT SCRIPTS / IMPORTED');
    body.append(element('p', '', 'Static declarations only. Dynamically registered scripts, programmatic injections, and runtime DOM operations are not visible here.'));
    if (!imported.data) body.append(element('p', 'muted', 'Import a manifest from the Commands tab or Coverage & imports.'));
    else {
      importedLabel(body, imported);
      if (!imported.data.contentScripts.length) body.append(element('p', '', 'No static content scripts declared in this imported manifest.'));
      for (const [index, script] of imported.data.contentScripts.entries()) {
        const card = element('div', 'script-card');
        add(card, element('h3', '', `Script group ${index + 1}`), element('p', '', `${script.runAt} · ${script.world} · ${script.allFrames ? 'all frames' : 'top frame'}`));
        for (const [label, values] of [['MATCHES', script.matches], ['EXCLUDE MATCHES', script.excludeMatches], ['INCLUDE GLOBS', script.includeGlobs], ['EXCLUDE GLOBS', script.excludeGlobs], ['JAVASCRIPT', script.js], ['CSS', script.css]]) { if (values.length) { section(card, label); chips(card, values); } }
        card.append(element('p', 'muted', `about:blank: ${script.matchAboutBlank} · origin fallback: ${script.matchOriginAsFallback}`));
        body.append(card);
      }
    }
  } else {
    section(body, 'BROWSER INVENTORY');
    const list = element('dl', 'kv');
    for (const [label, value] of [['Extension ID', info.id], ['Version', info.version], ['Install type', info.installType], ['Enabled', String(info.enabled)], ['Disabled reason', info.disabledReason ?? 'Not reported'], ['Runtime state', 'Unavailable'], ['API execution', 'See Runtime calls; companion required'], ['Manifest import', imported.status]]) add(list, element('dt', '', label), element('dd', '', value));
    body.append(list);
    body.append(add(element('div', 'button-row'), button('Extension settings ↗', () => chrome.tabs.create({ url: `chrome://extensions/?id=${info.id}` })), button('View recorded changes', () => { $('event-search').value = info.id; $('event-kind').value = 'all'; renderEvents(); showView('activity'); })));
    if (imported.data) {
      section(body, 'BACKGROUND DECLARATION / IMPORTED');
      importedLabel(body, imported);
      chips(body, [imported.data.background.serviceWorker, imported.data.background.page, ...imported.data.background.scripts].filter(Boolean), 'No background entry point declared.');
      section(body, 'EXTERNAL CONNECTIONS / IMPORTED');
      if (imported.data.externallyConnectable) chips(body, [...imported.data.externallyConnectable.ids, ...imported.data.externallyConnectable.matches]);
      else body.append(element('p', 'muted', 'No externally_connectable declaration. Browser defaults apply; this does not mean all extension-to-extension messages are blocked.'));
    }
  }
  root.append(body);
}

function eventBrief(event) {
  if (event.kind === 'changed') return Object.keys(event.details).join(', ');
  if (event.details.changes) return Object.keys(event.details.changes).join(', ') || event.source;
  return event.details.note ?? (event.kind === 'manifest-import' ? `${event.details.accepted} accepted, ${event.details.skipped.length} skipped` : event.source);
}
function renderEvents() {
  if (!snapshot) return;
  const query = $('event-search').value.trim().toLowerCase();
  const kind = $('event-kind').value;
  const filtered = [...snapshot.events].reverse().filter(event => (!query || JSON.stringify(event).toLowerCase().includes(query)) && (kind === 'all' || (kind === 'monitor' ? !event.extensionId : event.kind === kind)));
  const shown = filtered.slice(0, 250);
  const signature = JSON.stringify(shown);
  $('event-summary').textContent = `Showing ${shown.length} of ${filtered.length} matching retained events. Export JSON for the complete retained log.`;
  if (signature === eventSignature) return;
  eventSignature = signature;
  const list = $('event-list');
  const open = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.eventId));
  const scroll = list.scrollTop;
  list.replaceChildren();
  if (!shown.length) list.append(add(element('div', 'empty'), element('h3', '', 'No matching events'), element('p', '', 'Lifecycle events and snapshot differences appear here as they are observed.')));
  for (const event of shown) {
    const row = element('details', 'event');
    row.dataset.eventId = event.id;
    row.open = open.has(event.id);
    const time = element('time', '', date(event.time));
    time.dateTime = event.time;
    add(row, add(element('summary'), time, tag(event.kind.toUpperCase(), ['changed', 'disabled', 'uninstalled'].includes(event.kind) ? 'amber' : ''), element('span', 'event-name', event.name), element('span', 'event-brief', eventBrief(event))), element('pre', '', JSON.stringify(event, null, 2)));
    list.append(row);
  }
  list.scrollTop = scroll;
}

function exportSnapshot() {
  if (!snapshot) throw new Error('Wait for inventory before exporting.');
  const data = { application: 'Extension Observatory', exportedAt: new Date().toISOString(), coverage: CAPABILITIES, ...snapshot, diagnostics: diagnosticsView.snapshot() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = element('a');
  anchor.href = url;
  anchor.download = `extension-observatory-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  log('Export prepared: current inventory, static imports, coverage, and retained event history.');
}

function renderRuntime() {
  const runtime = snapshot?.runtime;
  if (!runtime) return;
  const states = { off: 'Local companion is disconnected.', paused: 'Collection paused. Brave diagnostic logging may still be running.', connecting: 'Connecting to local companion…', connected: 'Connected to diagnostic log. Waiting for or receiving browser-emitted events.', error: `Collector error: ${runtime.error}` };
  $('runtime-status').textContent = states[runtime.status] ?? runtime.status;
  $('connect-runtime').textContent = runtime.enabled ? 'Reconnect runtime log' : 'Connect runtime log';
  $('disconnect-runtime').disabled = !runtime.enabled;
  if (runtimeOptionsSignature !== String(runtime.includeDetails)) {
    runtimeOptionsSignature = String(runtime.includeDetails);
    $('runtime-details').checked = runtime.includeDetails;
  }
  const query = $('runtime-search').value.trim().toLowerCase();
  const kind = $('runtime-kind').value;
  const filtered = [...runtime.events].reverse().filter(event => (kind === 'all' || event.category === kind) && (!query || JSON.stringify(event).toLowerCase().includes(query)));
  const shown = filtered.slice(0, 250);
  $('runtime-summary').textContent = `${shown.length} / ${filtered.length} matching calls · ${runtime.events.length} retained · ${runtime.droppedEvents} discarded · Last received: ${date(runtime.lastReceived)}${runtime.backlogBytes ? ` · ${runtime.backlogBytes.toLocaleString()} bytes queued` : ''}`;
  const signature = JSON.stringify(shown);
  if (signature === runtimeSignature) return;
  runtimeSignature = signature;
  const list = $('runtime-list');
  const open = new Set([...list.querySelectorAll('details[open]')].map(node => node.dataset.eventId));
  const scroll = list.scrollTop;
  list.replaceChildren();
  if (!shown.length) list.append(add(element('div', 'empty'), element('h3', '', 'No matching runtime records'), element('p', '', 'Connect the companion and use an extension. No records does not mean no activity occurred.')));
  for (const event of shown) {
    const row = element('details', 'event');
    row.dataset.eventId = event.id;
    row.open = open.has(event.id);
    add(row, add(element('summary'), element('time', '', date(event.receivedAt)), tag(event.category, 'amber'), element('span', 'event-name', event.name), element('span', 'event-brief', event.api)), element('pre', '', JSON.stringify(event, null, 2)));
    list.append(row);
  }
  list.scrollTop = scroll;
}

async function connectRuntime() {
  const includeDetails = $('runtime-details').checked;
  const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
  if (!granted) throw new Error('Native messaging permission was not granted. Inventory monitoring is still available.');
  update(await request('runtime', { enabled: true, includeDetails }));
  notice('Runtime collection starts at the current end of the diagnostic log. Check collector status here.');
}

async function confirmAction(title, description, action) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  dialog.returnValue = 'cancel';
  dialog.showModal();
  const confirmed = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
  if (confirmed) { const result = await request(action); if (action === 'clearDiagnostics') await diagnosticsView.refresh(); else update(result); notice(`${title.replace('?', '')}: complete.`); }
}

async function importFiles(files, targetId = null) {
  if (!snapshot) throw new Error('Wait for inventory before importing.');
  const candidates = [];
  let total = 0;
  for (const file of files) {
    if (file.name !== 'manifest.json') continue;
    const match = file.webkitRelativePath?.replaceAll('\\', '/').match(/(?:^|\/)([a-p]{32})\/[^/]+\/manifest\.json$/);
    const id = targetId ?? match?.[1];
    if (!id || !snapshot.inventory.some(info => info.id === id)) continue;
    total += file.size;
    candidates.push({ file, id });
  }
  if (!candidates.length) throw new Error('No manifest.json files matched this profile. Choose its Extensions folder, or import a single manifest for a selected extension.');
  if (total > MAX_IMPORT_BYTES || candidates.length > 1000) throw new Error('Selected manifests exceed 2 MB or 1,000 files. Import smaller subfolders or individual manifests.');
  const entries = [];
  for (const { file, id } of candidates) {
    try { entries.push({ id, manifest: JSON.parse((await file.text()).replace(/^\uFEFF/, '')) }); }
    catch { throw new Error(`Could not parse manifest.json for ${id}. No files in this batch were imported.`); }
  }
  const result = await request('import', { entries });
  update(await request('snapshot'));
  const summary = `Imported ${result.accepted} extension manifest(s); skipped ${result.skipped.length} nonmatching version(s).`;
  $('import-result').replaceChildren(element('p', '', summary), ...result.skipped.map(item => element('p', 'muted', `${item.id}: ${item.reason}`)));
  notice(summary);
  log(summary);
}

async function execute(input) {
  const { command, argument } = parseTerminal(input);
  if (!command) return;
  log(`› ${input}`);
  if (command === 'help') log('help                     Show this command list\nlist [enabled|disabled]  List extensions in this profile\ninspect <name or id>      Select an extension\nsearch <text>             Search names, permissions, or hosts\nevents [text]             Filter recorded lifecycle / change events\nruntime [text]            Filter browser-logged runtime calls\ndiagnostics [text]        Inspect browser errors and reloads\nrefresh                   Reconcile inventory now\npause / resume            Stop / start monitoring\ncoverage                  Explain telemetry coverage\nexport                    Download retained data as JSON\nclear                     Clear only this console output');
  else if (command === 'list') {
    const state = ['enabled', 'disabled'].includes(argument) ? argument : 'all';
    const list = filterInventory(snapshot.inventory, { state });
    log(list.map(info => `${info.enabled ? 'ON ' : 'OFF'} ${info.name}  v${info.version}\n    ${info.id}  ${info.permissions.length} APIs / ${info.hostPermissions.length} host patterns`).join('\n') || 'No extensions match.');
  } else if (command === 'inspect') {
    if (!argument) throw new Error('Usage: inspect <name or id>');
    const matches = snapshot.inventory.filter(info => info.id === argument || info.name.toLowerCase().includes(argument.toLowerCase()));
    if (!matches.length) throw new Error('No extension matches that name or ID.');
    if (matches.length > 1) { log(`Multiple matches; use the full ID:\n${matches.map(info => `${info.name}  ${info.id}`).join('\n')}`); return; }
    $('extension-search').value = '';
    $('state-filter').value = 'all';
    $('sensitive-filter').checked = false;
    selectedId = matches[0].id;
    renderInventory(); showView('inventory');
    log(JSON.stringify(matches[0], null, 2));
  } else if (command === 'search') { $('extension-search').value = argument; $('state-filter').value = 'all'; $('sensitive-filter').checked = false; renderInventory(); showView('inventory'); log(`Inventory search: ${argument || '(all)'}`); }
  else if (command === 'events') { $('event-search').value = argument; $('event-kind').value = 'all'; renderEvents(); showView('activity'); log(`Event search: ${argument || '(all)'}`); }
  else if (command === 'runtime') { $('runtime-search').value = argument; renderRuntime(); showView('runtime'); log('Runtime records come from the optional local diagnostic log companion. Missing records do not prove inactivity.'); }
  else if (command === 'diagnostics') { $('diagnostic-search').value = argument; showView('diagnostics'); log('Browser diagnostics: enable navigation monitoring, then capture the affected tab for console and network evidence.'); }
  else if (command === 'coverage') { showView('coverage'); log('Inventory and lifecycle are observable. Manifest imports are static. Runtime API events need the optional local companion and Brave diagnostic logging.'); }
  else if (command === 'refresh') { await refresh(); log(snapshot.monitoring ? `Inventory reconciled: ${snapshot.inventory.length} extensions.` : 'Monitoring paused; inventory is frozen.'); }
  else if (command === 'pause' || command === 'resume') { await monitoring(command === 'resume'); log(`Monitoring ${command === 'resume' ? 'resumed' : 'paused'}.`); }
  else if (command === 'export') exportSnapshot();
  else if (command === 'clear') $('terminal-output').textContent = '';
  else throw new Error(`Unknown command “${command}”. Type help. No shell commands are executed.`);
}

document.querySelectorAll('[data-view]').forEach(node => node.addEventListener('click', () => showView(node.dataset.view)));
$('show-coverage').addEventListener('click', () => showView('coverage'));
$('refresh').addEventListener('click', () => run(refresh));
$('pause').addEventListener('click', () => run(() => monitoring(!snapshot?.monitoring)));
$('export').addEventListener('click', () => run(exportSnapshot));
$('open-settings').addEventListener('click', () => run(() => chrome.tabs.create({ url: 'chrome://extensions/' })));
$('open-shortcuts').addEventListener('click', () => run(() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })));
for (const id of ['extension-search', 'state-filter', 'sensitive-filter']) $(id).addEventListener('input', () => renderInventory());
for (const id of ['event-search', 'event-kind']) $(id).addEventListener('input', renderEvents);
$('clear-history').addEventListener('click', () => run(() => confirmAction('Clear retained history?', 'This removes retained events from this profile. Export first if you want a copy. Inventory and manifest imports are kept.', 'clearHistory')));
$('remove-imports').addEventListener('click', () => run(() => confirmAction('Remove imported manifests?', 'This removes stored static declarations from Observatory. The installed extensions and their original files are unchanged.', 'clearImports')));
$('connect-runtime').addEventListener('click', () => run(connectRuntime));
$('disconnect-runtime').addEventListener('click', () => run(async () => { update(await request('runtime', { enabled: false, includeDetails: $('runtime-details').checked })); notice('Collector disconnected. Stop Brave diagnostic logging by exiting Brave fully and launching it normally.'); }));
$('runtime-details').addEventListener('change', () => notice('Click Connect or Reconnect runtime log to apply the details setting. Existing retained details stay until cleared.'));
$('clear-runtime').addEventListener('click', () => run(() => confirmAction('Clear retained runtime calls?', 'This clears Observatory’s retained runtime calls. Brave diagnostic logs on disk are preserved and logging may continue.', 'clearRuntime')));
for (const id of ['runtime-search', 'runtime-kind']) $(id).addEventListener('input', renderRuntime);
$('register-command').textContent = `.\\native\\Register-Host.ps1 -ExtensionId '${globalThis.chrome?.runtime?.id ?? '<monitor-extension-id>'}'`;
$('import-folder').addEventListener('click', () => $('folder-input').click());
$('folder-input').addEventListener('change', () => { const files = [...$('folder-input').files]; $('folder-input').value = ''; void run(() => importFiles(files)); });
$('manifest-input').addEventListener('change', () => { const files = [...$('manifest-input').files]; const id = importTargetId; $('manifest-input').value = ''; void run(() => importFiles(files, id)); });
$('terminal-help').addEventListener('click', () => run(() => execute('help')));
$('terminal-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('terminal-input').value.trim();
  $('terminal-input').value = '';
  if (input) { commandHistory.push(input); commandHistory = commandHistory.slice(-50); historyIndex = commandHistory.length; }
  void run(() => execute(input));
});
$('terminal-input').addEventListener('keydown', event => {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  historyIndex = Math.max(0, Math.min(commandHistory.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
  $('terminal-input').value = commandHistory[historyIndex] ?? '';
});
for (const capability of CAPABILITIES) $('coverage-list').append(add(element('div', 'coverage-row'), element('strong', '', capability.name), tag(capability.status.toUpperCase(), ['Unavailable', 'Import'].includes(capability.status) ? 'amber' : ''), element('p', '', capability.detail)));

if (globalThis.chrome?.storage) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.observatory?.newValue) update(changes.observatory.newValue); });
void run(async () => { update(await request('snapshot')); if (!snapshot.lastScan && snapshot.monitoring) update(await request('refresh')); await diagnosticsView.refresh(); });
// Read status periodically to reconnect after a worker reload; this does not force scans.
setInterval(() => {
  if (document.hidden || pending) return;
  pending++;
  void run(async () => { try { update(await request('snapshot')); await diagnosticsView.refresh(); } finally { pending--; } });
}, 15_000);
