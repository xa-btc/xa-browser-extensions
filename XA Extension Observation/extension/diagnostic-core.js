export const diagnosticDefaults = () => ({ version: 1, enabled: false, events: [], droppedEvents: 0, lastError: null });
export const text = (value, max = 4000) => String(value ?? '').slice(0, max);

export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:', 'chrome-extension:'].includes(url.protocol)) return `${url.protocol}[not recorded]`;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.slice(0, 2000);
  } catch { return ''; }
}

export function safeStack(stack, depth = 0) {
  if (!stack || depth > 2) return null;
  return {
    description: text(stack.description, 500),
    callFrames: (stack.callFrames ?? []).slice(0, 12).map(frame => ({ functionName: text(frame.functionName, 200), url: safeUrl(frame.url), lineNumber: frame.lineNumber, columnNumber: frame.columnNumber })),
    parent: safeStack(stack.parent, depth + 1)
  };
}

export function diagnosticEvent(kind, tabId, url, summary, details = {}, severity = 'info', source = 'browser', time = new Date().toISOString()) {
  return { id: crypto.randomUUID(), time, kind, severity, tabId: Number.isInteger(tabId) ? tabId : null, url: safeUrl(url), summary: text(summary), source, details };
}

export function appendDiagnostics(state, incoming) {
  const events = [...state.events, ...incoming];
  let removed = Math.max(0, events.length - 1000);
  const kept = events.slice(removed);
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  let size = bytes(kept);
  while (kept.length && size > 1_000_000) { size -= bytes(kept.shift()) + 1; removed++; }
  return { ...state, events: kept, droppedEvents: state.droppedEvents + removed };
}

export function networkHint(error, status = 0, canceled = false) {
  if (canceled || /ERR_ABORTED/.test(error)) return 'Canceled or interrupted request. Navigation can cause this; it is not by itself a fault.';
  if (/ERR_BLOCKED_BY_CLIENT/.test(error)) return 'A client-side blocker may be involved. This record does not identify an extension or distinguish Brave Shields.';
  if (/NAME_NOT_RESOLVED|DNS/.test(error)) return 'Name resolution failed. Check DNS, filtering, or the hostname.';
  if (/CERT_|SSL_|TLS/.test(error)) return 'Certificate or secure-connection failure. Check the certificate, system clock, or proxy.';
  if (/CONNECTION_|TIMED_OUT|TUNNEL|NETWORK_CHANGED|INTERNET_DISCONNECTED/.test(error)) return 'Connection, network, proxy, or server interruption. This alone does not attribute an extension.';
  if (status === 429) return 'Server rate limiting. Repeated refreshes or reconnects may increase the rate.';
  if (status >= 500) return 'The server returned an error. Check other requests and server availability.';
  if (status >= 400) return 'HTTP error response. Inspect the resource and status; a page reload is not established by this error.';
  return 'Inspect the source, initiator, and surrounding events. An error alone does not establish the cause of a reload.';
}

function extensionFrames(stack) {
  if (!stack) return [];
  return [...(stack.callFrames ?? []).map(frame => frame.url.match(/^chrome-extension:\/\/([a-p]{32})\//)?.[1]).filter(Boolean), ...extensionFrames(stack.parent)];
}

// Extract only the diagnostic ARGS JSON array, without executing any log content.
export function runtimeArguments(raw) {
  const start = typeof raw === 'string' ? raw.indexOf('ARGS=[') : -1;
  if (start < 0) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start + 5; index < raw.length; index++) {
    const char = raw[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) { try { return JSON.parse(raw.slice(start + 5, index + 1)); } catch { return null; } }
    }
  }
  return null;
}

export function assessEvent(event, history, runtimeEvents = [], inventory = []) {
  const when = Date.parse(event.time);
  const names = new Map(inventory.map(info => [info.id, info.name]));
  const observations = [];
  if (event.kind === 'reload') observations.push(event.details.navigationType ? `Browser explicitly classified this committed load as ${event.details.navigationType === 'reloadBypassingCache' ? 'a cache-bypassing reload' : 'a reload'}. Its navigation-start loader matched the committed document.` : 'The browser classified a top-level navigation as a reload. Normal versus cache-bypassing reload is unknown without a detailed navigation signal or an Observatory reload request.');
  if (event.kind === 'tab-discarded') observations.push('The browser reported this tab discarded. Activating a discarded tab can require loading it again; the initiator of the discard is not identified.');
  if (event.details.hint) observations.push(event.details.hint);
  const nearby = history.filter(item => event.tabId !== null && item.tabId === event.tabId && item.id !== event.id && Date.parse(item.time) <= when && when - Date.parse(item.time) <= 10_000);
  const previousCommitTime = Math.max(-Infinity, ...nearby.filter(item => ['reload', 'document-committed'].includes(item.kind) && Date.parse(item.time) < when).map(item => Date.parse(item.time)));
  const currentNavigation = nearby.filter(item => Date.parse(item.time) > previousCommitTime);
  for (const item of [event, ...currentNavigation]) {
    if (item.kind === 'reload-requested') observations.push(`Observatory requested ${item.details.bypassCache ? 'a cache-bypassing' : 'a normal'} reload for this tab. A request is not proof of successful navigation.`);
    if (item.kind === 'navigation-requested') observations.push(`Browser navigation reason: ${item.details.reason}. This records a request; it may be canceled or superseded.`);
    if (item.kind === 'document-request' && item.details.topFrame && (!event.details.loaderId || event.details.loaderId === item.details.loaderId)) {
      const ids = [...new Set(extensionFrames(item.details.initiator?.stack))];
      for (const id of ids) observations.push(`A document request initiator stack names ${names.get(id) ?? id} (${id}). This is direct request-source evidence, not proof of malicious behavior.`);
      if (item.details.initiator?.type === 'script' && !ids.length) observations.push('A nearby document request has a script initiator; inspect its recorded stack for the source.');
    }
  }
  const correlations = runtimeEvents.filter(item => item.category === 'api_call' && ['tabs.reload', 'tabs.update', 'tabs.discard', 'tabs.remove'].includes(item.api) && Math.abs(Date.parse(item.receivedAt) - when) <= 15_000).filter(item => {
    const args = runtimeArguments(item.rawDetails);
    return !Number.isInteger(args?.[0]) || args[0] === event.tabId;
  }).slice(-8).map(item => {
    const args = runtimeArguments(item.rawDetails);
    const targetMatched = Number.isInteger(args?.[0]) && args[0] === event.tabId;
    return { eventId: item.id, extensionId: item.extensionId, name: item.name, api: item.api, targetMatched, note: targetMatched ? 'The logged call names this tab. Call success and causation are unverified; compare the browser timestamp.' : 'Receipt-time proximity only. Target tab is unknown; buffering and other profiles can make this unrelated.' };
  });
  const reloads = history.filter(item => item.tabId === event.tabId && item.kind === 'reload' && when - Date.parse(item.time) >= 0 && when - Date.parse(item.time) <= 60_000).length;
  if (reloads >= 3) observations.push(`${reloads} reloads were observed for this tab within 60 seconds. This establishes a repeated reload pattern, not its cause.`);
  if (!observations.length) observations.push('No cause established from this record. Compare its source details and nearby events.');
  return { observations: [...new Set(observations)], nearby: nearby.slice(-12).map(item => ({ id: item.id, time: item.time, kind: item.kind, summary: item.summary })), extensionCorrelations: correlations };
}
