import { assessEvent } from './diagnostic-core.js';

export function createDiagnosticsView({ request, run, notice, getInventoryState, confirmAction }) {
  const $ = id => document.getElementById(id);
  let state = { enabled: false, events: [], captures: [], droppedEvents: 0 };
  let refreshPending = null;
  let signature = '';
  let tabs = [];
  const node = (tag, className, value) => { const element = document.createElement(tag); if (className) element.className = className; if (value !== undefined) element.textContent = value; return element; };
  function chosenTab() { const id = Number($('diagnostic-target').value); if (!$('diagnostic-target').value || !Number.isInteger(id)) throw new Error('Choose a tab first.'); return id; }
  function render() {
    const monitoring = getInventoryState()?.monitoring !== false;
    $('diagnostic-status').textContent = !state.enabled ? 'Navigation monitoring is off.' : !monitoring ? 'Monitoring paused. Detailed captures have stopped.' : `Navigation monitoring enabled · ${state.captures?.length ?? 0} tab(s) in detailed capture`;
    $('diagnostic-enable').textContent = state.enabled ? 'Disable diagnostics' : 'Enable diagnostics';
    $('diagnostic-captures').replaceChildren(...(state.captures ?? []).map(tab => node('span', 'chip', `Capturing #${tab.tabId} · ${tab.title || tab.url}`)));
    $('diagnostic-errors').textContent = `${state.events.filter(event => ['error', 'warning'].includes(event.severity)).length} errors / warnings`;
    $('diagnostic-reloads').textContent = `${state.events.filter(event => event.kind === 'reload').length} observed reloads`;
    $('diagnostic-total').textContent = `${state.events.length} retained records`;
    const selectedFilter = $('diagnostic-tab-filter').value;
    const ids = [...new Set(state.events.map(event => event.tabId).filter(id => id !== null))].sort((a, b) => a - b);
    const tabFilter = $('diagnostic-tab-filter');
    const options = [['all', 'All tabs / browser process'], ['process', 'Browser process only'], ...ids.map(id => [String(id), `Tab #${id}`])];
    if ([...tabFilter.options].map(item => item.value).join(',') !== options.map(item => item[0]).join(',')) {
      tabFilter.replaceChildren(...options.map(([value, label]) => { const option = node('option', '', label); option.value = value; return option; }));
      tabFilter.value = options.some(item => item[0] === selectedFilter) ? selectedFilter : 'all';
    }
    const query = $('diagnostic-search').value.trim().toLowerCase();
    const kind = $('diagnostic-kind').value;
    const chosenFilter = tabFilter.value;
    const match = event => {
      if (query && !JSON.stringify(event).toLowerCase().includes(query)) return false;
      if (chosenFilter === 'process' && event.tabId !== null) return false;
      if (!['all', 'process'].includes(chosenFilter) && event.tabId !== Number(chosenFilter)) return false;
      if (kind === 'errors') return ['error', 'warning'].includes(event.severity);
      if (kind === 'navigation') return /navigation|document|reload|discard|restore/.test(event.kind);
      if (kind === 'network') return /network|http-|websocket/.test(event.kind);
      if (kind === 'capture') return /capture|diagnostics-status/.test(event.kind);
      return kind === 'all' || event.kind === kind;
    };
    const matched = state.events.filter(match).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    const shown = matched.slice(0, 150);
    $('diagnostic-summary').textContent = `Showing ${shown.length} / ${matched.length} matches · ${state.droppedEvents} older records discarded · Expand a row for evidence and possible explanations.`;
    const inventory = getInventoryState();
    const nextSignature = JSON.stringify([shown, inventory?.runtime?.events?.at(-1)?.id]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    const list = $('diagnostic-list');
    const open = new Set([...list.querySelectorAll('details[open]')].map(element => element.dataset.id));
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (!shown.length) { const empty = node('div', 'empty'); empty.append(node('h3', '', 'No matching diagnostic records'), node('p', '', 'Enable diagnostics and reproduce the problem. Capture the affected tab for console and network evidence.')); list.append(empty); }
    for (const event of shown) {
      const row = node('details', 'event'); row.dataset.id = event.id; row.open = open.has(event.id);
      const summary = node('summary');
      summary.append(node('time', '', new Date(event.time).toLocaleString()), node('span', `tag ${event.severity === 'info' ? '' : 'amber'}`, event.kind), node('span', 'event-name', event.tabId === null ? 'Browser / monitor' : `Tab #${event.tabId}`), node('span', 'event-brief', event.summary));
      const evidence = node('div', 'diagnostic-evidence');
      const assessment = assessEvent(event, state.events, inventory?.runtime?.events ?? [], inventory?.inventory ?? []);
      evidence.append(node('div', 'section-label', 'WHAT THIS RECORD SHOWS'));
      for (const observation of assessment.observations) evidence.append(node('p', '', observation));
      if (assessment.extensionCorrelations.length) {
        evidence.append(node('div', 'section-label', 'NEARBY EXTENSION CALLS / NOT AUTOMATIC ATTRIBUTION'));
        for (const candidate of assessment.extensionCorrelations) evidence.append(node('p', '', `${candidate.name} · ${candidate.api}: ${candidate.note}`));
      }
      if (assessment.nearby.length) {
        evidence.append(node('div', 'section-label', 'PRECEDING 10 SECONDS IN THIS TAB'));
        for (const nearby of assessment.nearby) evidence.append(node('p', 'muted', `${new Date(nearby.time).toLocaleTimeString()} · ${nearby.kind} · ${nearby.summary}`));
      }
      row.append(summary, evidence, node('pre', '', JSON.stringify(event, null, 2)));
      list.append(row);
    }
    list.scrollTop = scroll;
  }
  async function refresh() {
    if (refreshPending) return refreshPending;
    refreshPending = request('diagnosticSnapshot').then(result => { state = result; render(); }).finally(() => { refreshPending = null; });
    return refreshPending;
  }
  async function refreshTabs() {
    tabs = await request('diagnosticTabs');
    const selected = $('diagnostic-target').value;
    const target = $('diagnostic-target');
    target.replaceChildren();
    if (!tabs.length) { const option = node('option', '', 'No ordinary tabs available'); option.value = ''; target.append(option); }
    for (const tab of tabs) { const option = node('option', '', `#${tab.tabId} ${tab.captured ? '[capturing] ' : ''}${tab.title || tab.url}`); option.value = String(tab.tabId); target.append(option); }
    if (tabs.some(tab => String(tab.tabId) === selected)) target.value = selected;
  }
  $('diagnostic-enable').addEventListener('click', () => run(async () => {
    if (!state.enabled && !await chrome.permissions.request({ permissions: ['tabs', 'webNavigation'] })) throw new Error('Navigation permissions were not granted. Existing monitoring is unchanged.');
    await request('diagnosticEnabled', { enabled: !state.enabled }); await refresh(); await refreshTabs();
  }));
  $('diagnostic-refresh-tabs').addEventListener('click', () => run(refreshTabs));
  $('diagnostic-attach').addEventListener('click', () => run(async () => {
    const tabId = chosenTab();
    await request('diagnosticAttach', { tabId }); await refresh(); await refreshTabs();
  }));
  $('diagnostic-detach').addEventListener('click', () => run(async () => { await request('diagnosticDetach', { tabId: chosenTab() }); await refresh(); await refreshTabs(); }));
  for (const [id, bypassCache] of [['diagnostic-reload', false], ['diagnostic-hard-reload', true]]) $(id).addEventListener('click', () => run(async () => { await request('diagnosticReload', { tabId: chosenTab(), bypassCache }); await refresh(); notice(`Requested ${bypassCache ? 'cache-bypassing' : 'normal'} reload for the selected tab.`); }));
  $('diagnostic-clear').addEventListener('click', () => run(() => confirmAction('Clear diagnostic history?', 'This clears retained diagnostic records. Current capture settings and browser source logs are preserved.', 'clearDiagnostics')));
  for (const id of ['diagnostic-search', 'diagnostic-kind', 'diagnostic-tab-filter']) $(id).addEventListener('input', render);
  if (globalThis.chrome?.storage) chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.diagnostics) void run(refresh); });
  return { refresh, refreshTabs, render, snapshot: () => state };
}
