import { createController } from './controller.js';
import { openTerminal } from './window.js';
import { createRuntimeBridge } from './telemetry.js';
import { createDiagnostics } from './diagnostics.js';

const controller = createController(chrome);
const diagnostics = createDiagnostics(chrome, controller);
const runtimeBridge = createRuntimeBridge(chrome, controller, diagnostics);
const alarmName = 'observatory-reconcile';
const report = error => console.error('Extension Observatory:', error);

// Register listeners synchronously so service-worker wakeups cannot lose events.
for (const [name, kind] of [['onInstalled', 'installed'], ['onEnabled', 'enabled'], ['onDisabled', 'disabled'], ['onUninstalled', 'uninstalled']]) {
  chrome.management[name].addListener(info => { void controller.lifecycle(kind, info).then(() => runtimeBridge.sync()).catch(report); });
}
chrome.action.onClicked.addListener(() => { void openTerminal().catch(report); });
chrome.commands.onCommand.addListener(command => { if (command === 'open-terminal') void openTerminal().catch(report); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === alarmName) void controller.refresh().then(() => runtimeBridge.sync()).catch(report); });
chrome.runtime.onStartup.addListener(() => { void controller.startup().catch(report); });
chrome.runtime.onInstalled.addListener(() => { void controller.refresh().catch(report); });

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('dashboard.html')) return false;
  const tasks = {
    snapshot: () => controller.snapshot(),
    refresh: () => controller.refresh(),
    monitoring: () => {
      if (typeof message.enabled !== 'boolean') throw new Error('Monitoring must be true or false.');
      return controller.setMonitoring(message.enabled).then(async () => { await diagnostics.sync(); await runtimeBridge.sync(); return controller.snapshot(); });
    },
    import: () => controller.importManifests(message.entries),
    clearHistory: () => controller.clearHistory(),
    clearImports: () => controller.clearImports(),
    runtime: async () => {
      if (typeof message.enabled !== 'boolean' || typeof message.includeDetails !== 'boolean') throw new Error('Invalid runtime collection options.');
      await controller.setRuntime({ enabled: message.enabled, includeDetails: message.includeDetails });
      await runtimeBridge.reconnect();
      return controller.snapshot();
    },
    clearRuntime: () => controller.clearRuntime(),
    diagnosticSnapshot: () => diagnostics.snapshot(),
    diagnosticTabs: () => diagnostics.tabs(),
    diagnosticEnabled: async () => {
      if (typeof message.enabled !== 'boolean') throw new Error('Invalid diagnostic setting.');
      await diagnostics.setEnabled(message.enabled);
      await runtimeBridge.sync();
      return diagnostics.snapshot();
    },
    diagnosticAttach: async () => { await diagnostics.attach(message.tabId); return diagnostics.snapshot(); },
    diagnosticDetach: async () => { await diagnostics.detach(message.tabId); return diagnostics.snapshot(); },
    diagnosticReload: async () => {
      if (typeof message.bypassCache !== 'boolean') throw new Error('Invalid reload setting.');
      await diagnostics.reload(message.tabId, message.bypassCache); return diagnostics.snapshot();
    },
    clearDiagnostics: () => diagnostics.clear()
  };
  const task = Object.hasOwn(tasks, message?.type) ? tasks[message.type] : null;
  if (!task) { reply({ ok: false, error: 'Unknown request.' }); return false; }
  Promise.resolve().then(task).then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error.message }));
  return true;
});

// Alarms can be cleared by a browser restart; recreate on every worker activation.
void chrome.alarms.create(alarmName, { periodInMinutes: 1 }).catch(report);
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(report);
void diagnostics.initialize().catch(report);
void controller.refresh().then(() => runtimeBridge.sync()).catch(report);
