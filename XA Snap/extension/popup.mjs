const status = document.querySelector('#status');
const stop = document.querySelector('#stop');
const buttons = [...document.querySelectorAll('[data-mode], #tabs')];

function show(message) {
  status.hidden = !message;
  status.textContent = message || '';
}

async function refresh() {
  const current = await chrome.runtime.sendMessage({ type: 'status' });
  stop.hidden = !current;
  for (const button of buttons) button.disabled = !!current;
  if (current) show(current);
  else show((await chrome.storage.session.get('lastError')).lastError);
}

for (const button of document.querySelectorAll('[data-mode]')) {
  button.onclick = () => {
    chrome.runtime.sendMessage({ type: 'capture', mode: button.dataset.mode }).catch(() => {});
    window.close();
  };
}

document.querySelector('#tabs').onclick = async () => {
  try {
    const allowed = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!allowed) { show('All tabs capture requires optional site access.'); return; }
    const { id } = await chrome.windows.getCurrent();
    chrome.runtime.sendMessage({ type: 'many', kind: 'tabs', windowId: id }).catch(() => {});
    window.close();
  } catch (error) { show(error.message); }
};

stop.onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  show('Cancelling…');
};

refresh().catch(error => show(error.message));
setInterval(() => refresh().catch(() => {}), 900);

