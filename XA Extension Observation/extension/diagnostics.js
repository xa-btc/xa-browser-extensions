import { diagnosticDefaults, diagnosticEvent, appendDiagnostics, networkHint, safeUrl, safeStack, text } from './diagnostic-core.js';

export function createDiagnostics(api, controller) {
  let state;
  let queue = Promise.resolve();
  const sessions = new Map();
  let operation = Promise.resolve();
  let capturedBuffer = [];
  let droppedBuffered = 0;
  let flushTimer = null;
  const report = error => console.error('Browser diagnostics:', error);
  async function load() {
    if (!state) state = { ...diagnosticDefaults(), ...(await api.storage.local.get('diagnostics')).diagnostics };
    return state;
  }
  function transaction(task) {
    const result = queue.then(async () => task(await load()));
    queue = result.catch(report);
    return result;
  }
  async function save(next) { await api.storage.local.set({ diagnostics: next }); state = next; return state; }
  async function active() { return (await load()).enabled && (await controller.snapshot()).monitoring; }
  function record(events, force = false) {
    return transaction(async current => {
      if (!force && !(await active())) return current;
      return save(appendDiagnostics(current, events));
    });
  }
  function bufferEvent(event) {
    capturedBuffer.push(event);
    if (capturedBuffer.length > 200) { capturedBuffer.shift(); droppedBuffered++; }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const batch = capturedBuffer;
      capturedBuffer = [];
      if (droppedBuffered) { batch.push(diagnosticEvent('capture-overflow', null, '', `${droppedBuffered} diagnostic records dropped during a burst.`, { dropped: droppedBuffered }, 'warning', 'monitor')); droppedBuffered = 0; }
      void record(batch).catch(report);
    }, 250);
  }
  async function rememberSessions() { await api.storage.session.set({ diagnosticTabs: [...sessions.keys()] }); }
  async function ordinaryTab(id) {
    if (!Number.isInteger(id) || id < 0) throw new Error('Choose an ordinary browser tab.');
    const tab = await api.tabs.get(id);
    if (tab.incognito || !/^https?:\/\//.test(tab.url ?? '')) throw new Error('Capture supports normal HTTP/HTTPS tabs only, outside incognito.');
    return tab;
  }
  function tabOperation(task) {
    const result = operation.then(task);
    operation = result.catch(() => {});
    return result;
  }
  async function detachInternal(id, reason) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try { await api.debugger.detach({ tabId: id }); } catch { /* Already detached/closed. */ }
    await rememberSessions();
    await record([diagnosticEvent('capture-stopped', id, session.url, `Detailed capture stopped: ${reason}.`, {}, 'info', 'monitor')], true);
  }
  async function stopAll(reason) {
    capturedBuffer = [];
    droppedBuffered = 0;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    for (const id of [...sessions.keys()]) await detachInternal(id, reason);
  }
  async function enableDomains(id, session) {
    const target = { tabId: id };
    for (const method of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await api.debugger.sendCommand(target, method, {});
    const tree = await api.debugger.sendCommand(target, 'Page.getFrameTree', {});
    session.mainFrameId = tree.frameTree?.frame?.id ?? null;
    session.url = tree.frameTree?.frame?.url ?? session.url;
  }
  function newSession(tab) { return { tabId: tab.id, title: tab.title ?? '', url: tab.url, mainFrameId: null, requests: new Map(), navigations: new Map() }; }
  async function attachInternal(id) {
    if (!await active()) throw new Error('Enable browser diagnostics and resume monitoring before capturing a tab.');
    const tab = await ordinaryTab(id);
    if (sessions.has(id)) return;
    if (sessions.size >= 5) throw new Error('Capture supports up to five tabs at a time. Stop one before adding another.');
    const session = newSession(tab);
    try {
      await api.debugger.attach({ tabId: id }, '1.3');
      sessions.set(id, session);
      await enableDomains(id, session);
      await rememberSessions();
      await record([diagnosticEvent('capture-started', id, tab.url, 'Detailed tab capture started. Existing errors are not complete history.', { title: text(tab.title, 200) }, 'info', 'monitor')]);
    } catch (error) {
      if (sessions.has(id)) await detachInternal(id, 'initialization failed');
      await record([diagnosticEvent('capture-error', id, tab.url, error.message, {}, 'error', 'debugger')], true);
      throw new Error(`Cannot capture tab: ${error.message}. Close its DevTools or other debugger, then try again.`);
    }
  }

  async function navigation(kind, data) {
    if (data.frameId !== 0 || !/^https?:\/\//.test(data.url ?? '') || !await active()) return;
    try { if ((await api.tabs.get(data.tabId)).incognito) return; } catch { return; }
    // Captured tabs use a loader-matched CDP commit for reload classification.
    // Preserve webNavigation metadata separately, avoiding double-counted reloads.
    const eventKind = kind === 'committed' ? data.transitionType === 'reload' && !sessions.has(data.tabId) ? 'reload' : 'navigation' : 'navigation-error';
    const summary = kind === 'committed' ? eventKind === 'reload' ? 'Top-level page reload observed' : 'Top-level document navigation committed' : `Navigation failed: ${data.error}`;
    await record([diagnosticEvent(eventKind, data.tabId, data.url, summary, { transitionType: data.transitionType ?? null, transitionQualifiers: data.transitionQualifiers ?? [], documentId: data.documentId ?? null, error: data.error ?? null, ...(data.error ? { hint: networkHint(data.error) } : {}) }, data.error ? 'error' : 'info', 'webNavigation', new Date(data.timeStamp).toISOString())]);
  }

  function cdpEvent(source, method, params) {
    const session = sessions.get(source.tabId);
    if (!session || source.sessionId) return;
    const id = source.tabId;
    const emit = (kind, summary, details = {}, severity = 'info', url = session.url) => bufferEvent(diagnosticEvent(kind, id, url, summary, details, severity, 'debugger'));
    const requests = session.requests;
    if (method === 'Page.frameStartedNavigating' && params.frameId === session.mainFrameId) {
      session.navigations.set(params.loaderId, { navigationType: params.navigationType, loaderId: params.loaderId, frameId: params.frameId });
      if (session.navigations.size > 10) session.navigations.delete(session.navigations.keys().next().value);
      emit('navigation-started', `Navigation started: ${params.navigationType}`, { navigationType: params.navigationType, loaderId: params.loaderId, frameId: params.frameId }, 'info', params.url);
    } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
      session.mainFrameId = params.frame.id; session.url = params.frame.url;
      const navigation = session.navigations.get(params.frame.loaderId);
      const reload = ['reload', 'reloadBypassingCache'].includes(navigation?.navigationType);
      emit(reload ? 'reload' : 'document-committed', reload ? navigation.navigationType === 'reloadBypassingCache' ? 'Cache-bypassing page reload committed' : 'Page reload committed' : 'Captured document navigation committed', { ...navigation, loaderId: params.frame.loaderId, classification: navigation ? 'CDP navigation start matched to committed loader' : 'No matching navigation-start record captured' });
      session.navigations.delete(params.frame.loaderId);
    }
    else if (method === 'Page.frameRequestedNavigation' || method === 'Page.frameScheduledNavigation') {
      if (params.frameId === session.mainFrameId) emit('navigation-requested', `Navigation requested: ${params.reason}`, { reason: params.reason, delay: params.delay ?? null, protocolEvent: method }, 'info', params.url);
    } else if (method === 'Page.frameClearedScheduledNavigation' && params.frameId === session.mainFrameId) emit('navigation-schedule-cleared', 'Scheduled navigation cleared; it may have executed or been canceled.', { frameId: params.frameId });
    else if (method === 'Runtime.exceptionThrown') {
      const error = params.exceptionDetails;
      emit('javascript-error', text(error.exception?.description ?? error.text), { text: text(error.text), lineNumber: error.lineNumber, columnNumber: error.columnNumber, stack: safeStack(error.stackTrace), executionContextId: error.executionContextId }, 'error', error.url || session.url);
    } else if (method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(params.type)) {
      emit('console-error', (params.args ?? []).slice(0, 6).map(arg => text(arg.value ?? arg.description ?? `[${arg.type}]`, 500)).join(' '), { level: params.type, stack: safeStack(params.stackTrace), executionContextId: params.executionContextId }, params.type === 'warning' ? 'warning' : 'error');
    } else if (method === 'Log.entryAdded' && ['error', 'warning'].includes(params.entry.level)) {
      const entry = params.entry;
      emit('browser-entry', text(entry.text), { level: entry.level, source: entry.source, lineNumber: entry.lineNumber, stack: safeStack(entry.stackTrace) }, entry.level, entry.url || session.url);
    } else if (method === 'Network.requestWillBeSent') {
      const request = { url: safeUrl(params.request.url), method: params.request.method, type: params.type, frameId: params.frameId, loaderId: params.loaderId, topFrame: params.frameId === session.mainFrameId, initiator: { type: params.initiator?.type, url: safeUrl(params.initiator?.url), stack: safeStack(params.initiator?.stack) } };
      requests.set(params.requestId, request);
      if (requests.size > 500) requests.delete(requests.keys().next().value);
      if (params.type === 'Document') emit('document-request', `${request.topFrame ? 'Top-level' : 'Frame'} document request`, { ...request, requestId: params.requestId, redirectStatus: params.redirectResponse?.status ?? null }, 'info', params.request.url);
    } else if (method === 'Network.responseReceived') {
      const request = requests.get(params.requestId);
      const response = params.response;
      if (response.status >= 400 || params.type === 'Document') emit(response.status >= 400 ? 'http-error' : 'document-response', `HTTP ${response.status} ${text(response.statusText, 100)}`, { ...request, status: response.status, fromDiskCache: response.fromDiskCache === true, fromServiceWorker: response.fromServiceWorker === true, protocol: response.protocol, ...(response.status >= 400 ? { hint: networkHint('', response.status) } : {}) }, response.status >= 400 ? 'error' : 'info', response.url);
    } else if (method === 'Network.loadingFailed') {
      const request = requests.get(params.requestId);
      emit('network-error', text(params.errorText), { ...request, error: params.errorText, blockedReason: params.blockedReason ?? null, corsError: params.corsErrorStatus?.corsError ?? null, canceled: params.canceled === true, requestId: params.requestId, hint: networkHint(params.errorText, 0, params.canceled) }, params.canceled ? 'info' : 'error', request?.url || session.url);
      requests.delete(params.requestId);
    } else if (method === 'Network.loadingFinished') requests.delete(params.requestId);
    else if (method === 'Network.webSocketCreated') { requests.set(params.requestId, { url: safeUrl(params.url), type: 'WebSocket' }); if (requests.size > 500) requests.delete(requests.keys().next().value); }
    else if (method === 'Network.webSocketFrameError') emit('websocket-error', text(params.errorMessage), { requestId: params.requestId, hint: 'A WebSocket failure can trigger application reconnects without a full page reload.' }, 'error', requests.get(params.requestId)?.url || session.url);
    else if (method === 'Network.webSocketClosed') { emit('websocket-closed', 'WebSocket closed; this does not establish a page reload.', {}, 'info', requests.get(params.requestId)?.url || session.url); requests.delete(params.requestId); }
    else if (method === 'Inspector.targetCrashed') emit('tab-crash', 'Browser reported a captured target crash.', {}, 'error');
  }

  // Optional API listeners are registered synchronously when the namespace exists.
  let navigationRegistered = false;
  let debuggerRegistered = false;
  function detached(source, reason) {
    if (!sessions.has(source.tabId)) return;
    const session = sessions.get(source.tabId);
    sessions.delete(source.tabId);
    void rememberSessions().catch(report);
    void record([diagnosticEvent('capture-stopped', source.tabId, session.url, `Browser detached the debugger: ${reason}. Reattach explicitly to continue.`, { reason }, 'warning', 'debugger')], true).catch(report);
  }
  function registerOptionalListeners() {
    if (api.webNavigation && !navigationRegistered) {
      api.webNavigation.onCommitted.addListener(data => { void navigation('committed', data).catch(report); });
      api.webNavigation.onErrorOccurred.addListener(data => { void navigation('error', data).catch(report); });
      navigationRegistered = true;
    }
    if (api.debugger && !debuggerRegistered) { api.debugger.onEvent.addListener(cdpEvent); api.debugger.onDetach.addListener(detached); debuggerRegistered = true; }
  }
  registerOptionalListeners();
  api.permissions.onAdded.addListener(registerOptionalListeners);
  api.tabs.onUpdated.addListener((id, changes, tab) => {
    if (tab.incognito) return;
    if (sessions.has(id) && tab.url && !/^https?:\/\//.test(tab.url)) void tabOperation(() => detachInternal(id, 'tab left an HTTP/HTTPS page')).catch(report);
    if (Object.hasOwn(changes, 'discarded') && /^https?:\/\//.test(tab.url ?? '')) void record([diagnosticEvent(changes.discarded ? 'tab-discarded' : 'tab-restored', id, tab.url, changes.discarded ? 'Browser reported this tab discarded.' : 'Tab is no longer discarded.', { discarded: changes.discarded }, 'info', 'tabs')]).catch(report);
  });
  api.tabs.onRemoved.addListener(id => { if (sessions.has(id)) void tabOperation(() => detachInternal(id, 'tab closed')).catch(report); });
  api.permissions.onRemoved.addListener(() => {
    void tabOperation(async () => {
      const navigationGranted = await api.permissions.contains({ permissions: ['tabs', 'webNavigation'] });
      const debuggerGranted = await api.permissions.contains({ permissions: ['debugger'] });
      if (!navigationGranted) await transaction(current => save({ ...current, enabled: false }));
      if (!navigationGranted || !debuggerGranted) await stopAll('permission revoked');
    }).catch(report);
  });

  return {
    snapshot: () => transaction(async current => ({ ...current, captures: [...sessions.values()].map(session => ({ tabId: session.tabId, title: text(session.title, 200), url: safeUrl(session.url) })) })),
    setEnabled: enabled => tabOperation(async () => {
      if (enabled && !await api.permissions.contains({ permissions: ['tabs', 'webNavigation'] })) throw new Error('Grant browser navigation diagnostics permissions first.');
      await transaction(current => save({ ...current, enabled, lastError: null }));
      if (!enabled) await stopAll('diagnostics disabled');
      await record([diagnosticEvent('diagnostics-status', null, '', enabled ? 'Navigation diagnostics enabled.' : 'Browser diagnostics disabled.', {}, 'info', 'monitor')], true);
    }),
    tabs: async () => (await api.tabs.query({})).filter(tab => !tab.incognito && /^https?:\/\//.test(tab.url ?? '')).map(tab => ({ tabId: tab.id, title: text(tab.title, 200), url: safeUrl(tab.url), discarded: tab.discarded === true, captured: sessions.has(tab.id) })),
    attach: id => tabOperation(() => attachInternal(id)),
    detach: id => tabOperation(() => detachInternal(id, 'user stopped capture')),
    sync: () => tabOperation(async () => { if (!await active()) await stopAll('monitoring paused or diagnostics disabled'); }),
    reload: (id, bypassCache) => tabOperation(async () => {
      const tab = await ordinaryTab(id);
      if (!await active()) throw new Error('Enable browser diagnostics and monitoring before using its reload controls.');
      const requestId = crypto.randomUUID();
      await record([diagnosticEvent('reload-requested', id, tab.url, `User requested ${bypassCache ? 'cache-bypassing' : 'normal'} reload from Observatory.`, { bypassCache, requestId }, 'info', 'monitor')]);
      try { await api.tabs.reload(id, { bypassCache }); }
      catch (error) { await record([diagnosticEvent('reload-request-error', id, tab.url, error.message, { requestId }, 'error', 'monitor')]); throw error; }
    }),
    clear: () => transaction(current => { capturedBuffer = []; droppedBuffered = 0; return save({ ...current, events: [], droppedEvents: 0 }); }),
    nativeBatch: entries => record((entries ?? []).slice(0, 100).map(entry => diagnosticEvent('browser-process', null, '', text(entry.message), { component: text(entry.component, 300), browserTime: text(entry.browserTime, 40), note: 'Browser process log; no tab or extension attribution.' }, entry.level === 'WARNING' ? 'warning' : 'error', 'native browser log'))),
    initialize: () => tabOperation(async () => {
      // session storage survives worker suspension but not a browser restart.
      const ids = (await api.storage.session.get('diagnosticTabs')).diagnosticTabs ?? [];
      for (const id of ids) {
        try {
          const tab = await ordinaryTab(id);
          const session = newSession(tab);
          sessions.set(id, session);
          await enableDomains(id, session); // succeeds only if our attachment still exists
        } catch {
          sessions.delete(id);
          try { await api.debugger.detach({ tabId: id }); } catch { /* Attachment no longer exists. */ }
          await record([diagnosticEvent('capture-stopped', id, '', 'Previous detailed capture could not be restored. Reattach explicitly.', {}, 'warning', 'monitor')], true);
        }
      }
      await rememberSessions();
      if (!await active()) await stopAll('monitoring inactive');
    })
  };
}
