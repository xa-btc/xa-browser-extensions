import { capture, cancelSelection } from './capture.mjs';
import { preferences, saveCapture } from './data.mjs';

const modes = { full: 'Full page', visible: 'Visible tab', selection: 'Region', element: 'Element' };
let operation;

async function refreshMenu() {
  await chrome.contextMenus.removeAll();
  if (!(await preferences()).contextMenu) return;
  chrome.contextMenus.create({ id: 'xa-snap', title: 'XA Snap', contexts: ['all'] });
  for (const [id, title] of Object.entries(modes)) {
    chrome.contextMenus.create({ id, title, parentId: 'xa-snap', contexts: ['all'] });
  }
}

chrome.runtime.onInstalled.addListener(() => refreshMenu().catch(console.error));
chrome.storage.onChanged.addListener(changes => {
  if (changes.contextMenu) refreshMenu().catch(console.error);
});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error('Open a page to capture.');
  return tab;
}

function update(status) {
  operation.status = status;
  chrome.action.setTitle({ title: 'XA Snap · ' + status }).catch(() => {});
}

async function withCapture(task) {
  if (operation) throw new Error('Another capture is running.');
  operation = { cancelled: false, status: 'Starting…' };
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#007f79' });
    await chrome.action.setBadgeText({ text: '…' });
    return await task(update, () => operation.cancelled);
  } finally {
    operation = undefined;
    await chrome.action.setBadgeText({ text: '' }).catch(() => {});
    await chrome.action.setTitle({ title: 'XA Snap' }).catch(() => {});
  }
}

async function review(ids, action = 'review', target, adjacent) {
  const query = new URLSearchParams({ ids: ids.join(','), action });
  const position = adjacent && target ? { windowId: target.windowId, index: target.index + 1, openerTabId: target.id } : {};
  try { await chrome.tabs.create({ ...position, url: chrome.runtime.getURL('studio.html?' + query) }); }
  catch (error) {
    if (!position.openerTabId) throw error;
    await chrome.tabs.create({ url: chrome.runtime.getURL('studio.html?' + query) });
  }
}

async function runSingle(mode, tab) {
  if (mode === 'last') mode = (await chrome.storage.local.get('lastMode')).lastMode || 'full';
  if (!Object.hasOwn(modes, mode)) throw new Error('Unknown capture mode.');
  const target = tab || await activeTab();
  const settings = await preferences();
  const id = await withCapture(async (progress, cancelled) => {
    await chrome.storage.session.remove('lastError');
    operation.target = target.id;
    const entry = await capture(target, mode, progress, cancelled, settings);
    if (cancelled()) throw new Error('Capture cancelled.');
    await chrome.storage.local.set({ lastMode: mode });
    return saveCapture(entry);
  });
  await review([id], settings.afterCapture, target, settings.adjacent);
}

async function reportError(error) {
  await chrome.storage.session.set({ lastError: error.message || String(error) });
  await chrome.action.setBadgeBackgroundColor({ color: '#bd4b33' });
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setTitle({ title: 'XA Snap · ' + (error.message || String(error)) });
}

chrome.commands.onCommand.addListener((mode, tab) => runSingle(mode, tab).catch(reportError));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (Object.hasOwn(modes, info.menuItemId)) runSingle(info.menuItemId, tab).catch(reportError);
});

async function waitForTab(id, cancelled) {
  for (let attempt = 0; attempt < 120 && !cancelled(); attempt++) {
    const tab = await chrome.tabs.get(id);
    if (tab.status === 'complete') return tab;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(cancelled() ? 'Capture cancelled.' : 'The page took too long to load.');
}

async function runMany(kind, windowId, urls = []) {
  const settings = await preferences();
  const tabs = await chrome.tabs.query({ windowId });
  const original = tabs.find(tab => tab.active);
  const targets = kind === 'tabs'
    ? tabs.filter(tab => /^(https?|file):/i.test(tab.url || ''))
    : urls;
  if (!targets.length) throw new Error('No supported pages to capture.');
  if (targets.length > 50) throw new Error('Capture up to 50 pages in one batch.');
  return withCapture(async (progress, cancelled) => {
    const ids = [];
    const errors = [];
    try {
      for (const [index, target] of targets.entries()) {
        if (cancelled()) break;
        let temporary;
        try {
          if (kind === 'urls') {
            const url = new URL(target);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
              throw new Error('Enter an HTTP or HTTPS URL without credentials.');
            }
            temporary = (await chrome.tabs.create({ url: url.href, windowId, active: true })).id;
          } else {
            await chrome.tabs.update(target.id, { active: true });
          }
          const tab = await waitForTab(temporary ?? target.id, cancelled);
          operation.target = tab.id;
          const entry = await capture(tab, settings.tabMode, message => {
            progress((index + 1) + ' / ' + targets.length + ' · ' + message);
          }, cancelled, settings);
          if (!cancelled()) ids.push(await saveCapture(entry));
        } catch (error) {
          if (!cancelled()) errors.push({ target: typeof target === 'string' ? target : target.title || 'Tab', error: error.message });
        } finally {
          if (temporary !== undefined) await chrome.tabs.remove(temporary).catch(() => {});
        }
      }
    } finally {
      if (original) await chrome.tabs.update(original.id, { active: true }).catch(() => {});
    }
    if (ids.length) await review(ids);
    return { ids, errors, cancelled: cancelled() };
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (message.type === 'status') {
    respond(operation?.status || null);
    return false;
  }
  if (message.type === 'stop') {
    if (operation) {
      operation.cancelled = true;
      if (operation.target !== undefined) cancelSelection(operation.target).catch(() => {});
    }
    respond({ ok: true });
    return false;
  }
  let task;
  if (message.type === 'capture') task = runSingle(message.mode);
  if (message.type === 'many') task = runMany(message.kind, message.windowId, message.urls);
  if (!task) return false;
  task.then(result => respond({ ok: true, result }), error => {
    reportError(error).catch(() => {});
    respond({ ok: false, error: error.message });
  });
  return true;
});

