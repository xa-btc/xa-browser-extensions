export const NATIVE_HOST = 'com.xa.extension_observatory';
export const runtimeDefaults = () => ({ enabled: false, includeDetails: false, status: 'off', error: null, events: [], droppedEvents: 0, lastReceived: null, logPath: null, backlogBytes: 0, fileBytes: 0 });

export function appendRuntime(current, batch, inventory, now) {
  const names = new Map(inventory.map(info => [info.id, info.name]));
  const incoming = (Array.isArray(batch.events) ? batch.events : []).slice(0, 100).filter(event => names.has(event.extensionId)).map(event => ({
    id: crypto.randomUUID(), extensionId: event.extensionId, name: names.get(event.extensionId), receivedAt: now,
    browserTime: String(event.browserTime ?? '').slice(0, 40), category: String(event.category ?? 'unknown').slice(0, 80),
    api: String(event.api ?? '').slice(0, 500),
    ...(current.includeDetails && typeof event.rawDetails === 'string' ? { rawDetails: event.rawDetails.slice(0, 8192), detailsTruncated: event.detailsTruncated === true } : {})
  }));
  const events = [...current.events, ...incoming];
  let removed = Math.max(0, events.length - 1000);
  const kept = events.slice(removed);
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  let size = bytes(kept);
  while (kept.length && size > 2_000_000) { size -= bytes(kept.shift()) + 1; removed++; }
  return {
    ...current, events: kept, droppedEvents: current.droppedEvents + removed,
    lastReceived: incoming.length ? now : current.lastReceived, status: 'connected', error: null,
    logPath: String(batch.status?.logPath ?? current.logPath ?? ''),
    fileBytes: Number(batch.fileBytes) || 0, backlogBytes: Number(batch.backlogBytes) || 0
  };
}

export function createRuntimeBridge(api, controller, diagnostics = null) {
  let port = null;
  let signature = '';
  let generation = 0;
  let queue = Promise.resolve();
  const report = error => console.error('Runtime collector:', error);
  function sync() {
    const job = queue.then(async () => {
      const state = await controller.snapshot();
      const includeBrowserErrors = diagnostics ? (await diagnostics.snapshot()).enabled : false;
      const desired = state.monitoring && state.runtime.enabled;
      const nextSignature = desired ? JSON.stringify([state.runtime.includeDetails, state.inventory.map(info => info.id).sort(), includeBrowserErrors]) : '';
      if (port && signature === nextSignature) return;
      generation++;
      const token = generation;
      if (port) { port.disconnect(); port = null; }
      signature = nextSignature;
      if (!desired) {
        await controller.runtimeStatus({ status: state.runtime.enabled ? 'paused' : 'off', error: null });
        return;
      }
      if (!await api.permissions.contains({ permissions: ['nativeMessaging'] })) {
        await controller.runtimeStatus({ status: 'error', error: 'Grant the optional local-companion permission using Connect runtime log.' });
        return;
      }
      await controller.runtimeStatus({ status: 'connecting', error: null });
      port = api.runtime.connectNative(NATIVE_HOST);
      port.onMessage.addListener(message => {
        if (token !== generation) return;
        if (message.type === 'batch') {
          void controller.runtimeBatch(message).catch(report);
          if (message.browserErrors?.length && diagnostics) void diagnostics.nativeBatch(message.browserErrors).catch(report);
        }
        else if (message.type === 'status') void controller.runtimeStatus({ status: message.state === 'error' ? 'error' : 'connected', error: message.error ?? null }).catch(report);
      });
      port.onDisconnect.addListener(() => {
        const error = api.runtime.lastError?.message;
        if (token !== generation) return;
        port = null;
        void controller.runtimeStatus({ status: 'error', error: error ?? 'Local companion disconnected. Use Reconnect after checking setup.' }).catch(report);
      });
      port.postMessage({ type: 'start', extensionIds: state.inventory.map(info => info.id), includeDetails: state.runtime.includeDetails, includeBrowserErrors });
    });
    queue = job.catch(report);
    return job;
  }
  return { sync, reconnect: async () => { signature = ''; await sync(); } };
}
