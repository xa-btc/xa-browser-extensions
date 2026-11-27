import { initialState, reconcile, recordLifecycle, makeEvent, appendEvents, applyImports, byteSize } from './core.js';
import { runtimeDefaults, appendRuntime } from './telemetry.js';

export function createController(api, now = () => new Date().toISOString()) {
  let state;
  let queue = Promise.resolve();
  async function load() {
    if (!state) {
      const stored = await api.storage.local.get('observatory');
      state = stored.observatory ?? initialState(now());
      state = { ...state, runtime: { ...runtimeDefaults(), ...state.runtime } };
      if (state.schemaVersion !== 1) throw new Error('Unsupported saved data version. Export data before resetting the extension.');
    }
    return state;
  }
  async function commit(next) {
    if (byteSize(next) > 8_000_000) throw new Error('Local data exceeds 8 MB. Export and clear older history or manifest imports.');
    await api.storage.local.set({ observatory: next });
    state = next;
    return state;
  }
  function enqueue(task) {
    const result = queue.then(async () => task(await load()));
    queue = result.catch(() => {});
    return result;
  }
  async function scan(current) {
    try {
      return await commit(reconcile(current, await api.management.getAll(), api.runtime.id, now()));
    } catch (error) {
      // Keep the last valid inventory; a failed scan is not an empty profile.
      await commit({ ...current, lastError: error.message });
      throw error;
    }
  }
  return {
    snapshot: () => enqueue(current => current),
    refresh: () => enqueue(current => current.monitoring ? scan(current) : current),
    lifecycle: (kind, info) => enqueue(async current => {
      if ((typeof info === 'string' ? info : info.id) === api.runtime.id || (typeof info !== 'string' && info.type !== 'extension')) return current;
      // Uninstall callbacks contain only an ID; do not mislabel unknown apps/themes.
      if (kind === 'uninstalled' && !current.inventory.some(item => item.id === info)) return current;
      return commit(recordLifecycle(current, kind, info, now()));
    }),
    setMonitoring: enabled => enqueue(async current => {
      if (current.monitoring === enabled) return current;
      const next = appendEvents({ ...current, monitoring: enabled }, [makeEvent(enabled ? 'resumed' : 'paused', null, { note: enabled ? 'Reconciling after a monitoring gap. Events during the gap were not captured.' : 'Monitoring is paused. Inventory is frozen until resumed.' }, now(), 'monitor')]);
      await commit(next);
      return enabled ? scan(next) : next;
    }),
    importManifests: entries => enqueue(async current => {
      const result = applyImports(current, entries, now());
      await commit(result.state);
      return { accepted: result.accepted, skipped: result.skipped };
    }),
    clearImports: () => enqueue(current => commit(appendEvents({ ...current, imports: {} }, [makeEvent('imports-cleared', null, {}, now(), 'monitor')]))),
    clearHistory: () => enqueue(current => commit({ ...current, droppedEvents: 0, events: [makeEvent('history-cleared', null, { note: 'Previous retained events were cleared by the user.' }, now(), 'monitor')] })),
    setRuntime: options => enqueue(current => commit({ ...current, runtime: { ...current.runtime, enabled: options.enabled, includeDetails: options.includeDetails, status: options.enabled ? 'connecting' : 'off', error: null } })),
    runtimeStatus: status => enqueue(current => commit({ ...current, runtime: { ...current.runtime, ...status } })),
    runtimeBatch: batch => enqueue(current => {
      if (!current.monitoring || !current.runtime.enabled) return current;
      let next = { ...current, runtime: appendRuntime(current.runtime, batch, current.inventory, now()) };
      if (batch.started || batch.reset || batch.skippedLines) next = appendEvents(next, [makeEvent('runtime-collector', null, { started: Boolean(batch.started), rotated: Boolean(batch.reset), oversizedLinesSkipped: Number(batch.skippedLines) || 0, note: batch.started ? 'Collector starts at the end of the diagnostic log. Old sessions and collection gaps are not replayed.' : 'Diagnostic log changed or oversized records were skipped.' }, now(), 'native log collector')]);
      return commit(next);
    }),
    clearRuntime: () => enqueue(current => commit({ ...current, runtime: { ...current.runtime, events: [], droppedEvents: 0 } })),
    startup: () => enqueue(async current => {
      const next = appendEvents(current, [makeEvent('browser-start', null, { note: 'Monitoring cannot capture activity while Brave or this extension is stopped. The next snapshot reconciles differences.' }, now(), 'monitor')]);
      await commit(next);
      return next.monitoring ? scan(next) : next;
    })
  };
}
