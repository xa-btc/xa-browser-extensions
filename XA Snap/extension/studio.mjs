import { defaults, preferences, getCapture, saveCapture, deleteCapture, history, filename } from './data.mjs';
import { makePDF } from './pdf.mjs';
import { Editor } from './editor.mjs';

const $ = selector => document.querySelector(selector);
const status = $('#status');
const query = new URLSearchParams(location.search);
let ids = (query.get('ids') || '').split(',').filter(Boolean);
let current;
let tool;
let savedDownload;
let firstReview = true;
let reviewSequence = 0;
const checked = new Set();

function notify(message, error = false) {
  status.hidden = !message;
  status.dataset.error = String(error);
  status.textContent = message || '';
}

function action(selector, handler) {
  $(selector).addEventListener('click', event => {
    Promise.resolve().then(() => handler(event)).catch(error => notify(error.message, true));
  });
}

const editor = new Editor($('#canvas'), () => ({
  tool, color: $('#ink').value, size: Math.max(1, Math.min(120, Number($('#stroke').value) || 1)), text: $('#label-text').value
}), () => {
  $('#undo').disabled = !editor.actions.length;
  $('#redo').disabled = !editor.future.length;
  $('#revert').disabled = !editor.actions.length && !editor.future.length;
  $('#edit-save').disabled = !editor.actions.length;
  $('#capture-size').textContent = editor.canvas.width + ' × ' + editor.canvas.height;
});

function setView(name) {
  for (const section of document.querySelectorAll('[data-view]')) section.hidden = section.id !== name;
  for (const link of document.querySelectorAll('nav a')) {
    if (link.hash === '#' + name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function openCapture(id) {
  const sequence = ++reviewSequence;
  const entry = await getCapture(id);
  if (!entry) throw new Error('This capture is no longer in history.');
  const bitmap = await createImageBitmap(entry.image);
  if (sequence !== reviewSequence) { bitmap.close(); return; }
  current = id;
  savedDownload = undefined;
  editor.setImage(bitmap, entry);
  $('#capture-title').textContent = entry.title || 'Screenshot';
  const queue = $('#queue');
  queue.hidden = ids.length < 2;
  queue.replaceChildren();
  for (const [index, item] of ids.entries()) {
    const button = document.createElement('button');
    button.textContent = 'Capture ' + (index + 1);
    button.setAttribute('aria-pressed', String(item === current));
    button.onclick = () => openCapture(item).catch(error => notify(error.message, true));
    queue.append(button);
  }
  if (ids.length > 1) {
    const button = document.createElement('button');
    button.textContent = 'Save all images';
    button.onclick = () => saveImages(ids).catch(error => notify(error.message, true));
    queue.append(button);
  }
  setView('review');
  document.title = entry.title + ' · XA Snap';
}

async function renderHistory() {
  const entries = await history();
  const filter = $('#filter').value.trim().toLowerCase();
  const rows = entries.filter(entry => (entry.title + ' ' + entry.url).toLowerCase().includes(filter));
  const container = $('#entries');
  container.replaceChildren();
  for (const entry of rows) {
    const row = document.createElement('div');
    row.className = 'entry';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked.has(entry.id);
    input.value = entry.id;
    input.setAttribute('aria-label', 'Select ' + entry.title);
    input.onchange = () => { if (input.checked) checked.add(entry.id); else checked.delete(entry.id); };
    const button = document.createElement('button');
    button.textContent = entry.title || 'Screenshot';
    button.title = entry.url || '';
    button.onclick = () => {
      ids = [entry.id];
      location.hash = 'review';
      openCapture(entry.id).catch(error => notify(error.message, true));
    };
    const time = document.createElement('time');
    time.dateTime = new Date(entry.created).toISOString();
    time.textContent = new Date(entry.created).toLocaleString();
    const dimensions = document.createElement('small');
    dimensions.textContent = entry.width + ' × ' + entry.height;
    row.append(input, button, dimensions, time);
    container.append(row);
  }
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.textContent = filter ? 'No matching captures.' : 'No captures saved yet.';
    container.append(empty);
  }
}

function populateSettings(values) {
  for (const field of $('#settings-form').elements) {
    if (!field.name) continue;
    if (field.type === 'checkbox') field.checked = values[field.name];
    else field.value = values[field.name];
  }
}

async function route() {
  const name = location.hash.slice(1) || (ids.length ? 'review' : 'history');
  if (name === 'review' && ids.length) {
    const auto = firstReview ? query.get('action') : '';
    firstReview = false;
    if (!current) await openCapture(ids[0]);
    else setView('review');
    if (auto === 'image') await saveImage();
    if (auto === 'pdf') await exportPDF(ids);
    if (auto === 'copy') await copyImage();
    if (auto === 'print') window.print();
    return;
  }
  if ($('#' + CSS.escape(name))?.matches('[data-view]') && name !== 'review') setView(name);
  else setView('history');
  if (name === 'settings') populateSettings(await preferences());
  if (name === 'history' || name === 'review') await renderHistory();
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const listener = delta => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish();
      if (delta.state.current === 'interrupted') finish(new Error('The download did not finish.'));
    };
    const timer = setTimeout(() => finish(new Error('The download is still pending. Check the browser’s Downloads page.')), 120000);
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads.search({ id }).then(([entry]) => {
      if (entry?.state) listener({ id, state: { current: entry.state } });
    }, finish);
  });
}

async function download(blob, name, settings) {
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({ url, filename: name, saveAs: settings.saveAs, conflictAction: 'uniquify' });
    await waitForDownload(id);
    if (settings.reveal) chrome.downloads.show(id);
    return id;
  } finally { URL.revokeObjectURL(url); }
}

async function imageRecord(entry, settings) {
  if (entry.id === current) return editor.export(settings.format, settings.quality / 100);
  if (settings.format === 'png' && entry.image.type === 'image/png') return entry;
  const bitmap = await createImageBitmap(entry.image);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (settings.format === 'jpg') {
      context.fillStyle = 'white';
      context.fillRect(0, 0, bitmap.width, bitmap.height);
    }
    context.drawImage(bitmap, 0, 0);
    return { ...entry, image: await canvas.convertToBlob({
      type: settings.format === 'jpg' ? 'image/jpeg' : 'image/' + settings.format, quality: settings.quality / 100
    }) };
  } finally { bitmap.close(); }
}

async function saveImages(selected) {
  const settings = await preferences();
  for (const id of selected) {
    const source = await getCapture(id);
    if (!source) continue;
    const entry = await imageRecord(source, settings);
    const result = await download(entry.image, filename(entry, settings, settings.format), settings);
    if (id === current) savedDownload = result;
  }
  notify(selected.length > 1 ? 'Images saved.' : 'Image saved.');
  if (settings.closeAfter) window.close();
}

function saveImage() {
  return saveImages([current]);
}

async function exportPDF(selected) {
  if (!selected.length) throw new Error('Select one or more captures.');
  const settings = await preferences();
  const captures = [];
  for (const id of selected) {
    const entry = id === current ? await editor.export() : await getCapture(id);
    if (entry) captures.push(entry);
  }
  if (!captures.length) throw new Error('The selected captures no longer exist.');
  notify('Building PDF…');
  const blob = await makePDF(captures, settings);
  await download(blob, filename(captures[0], settings, 'pdf'), settings);
  notify('PDF saved.');
  if (settings.closeAfter) window.close();
}

async function copyImage() {
  const clipboard = new ClipboardItem({ 'image/png': editor.export().then(entry => entry.image) });
  await navigator.clipboard.write([clipboard]);
  notify('Image copied to clipboard.');
}

async function importImage(file, mode = 'import', title) {
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width > 32767 || bitmap.height > 32767 || bitmap.width * bitmap.height > 120000000) {
      throw new Error('The image exceeds the editor size limit.');
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const id = await saveCapture({
      title: title || file.name || 'Clipboard image', width: bitmap.width, height: bitmap.height, image: await canvas.convertToBlob(),
      url: '', mode, text: [], links: []
    });
    ids = [id];
    location.hash = 'review';
    await openCapture(id);
    notify('');
  } finally { bitmap.close(); }
}

async function captureWindow() {
  const granted = await chrome.permissions.request({ permissions: ['desktopCapture'] });
  if (!granted) throw new Error('Window capture requires the optional capture permission.');
  const streamId = await new Promise(resolve => chrome.desktopCapture.chooseDesktopMedia(['window', 'screen'], resolve));
  if (!streamId) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId } }
  });
  const video = document.createElement('video');
  try {
    video.srcObject = stream;
    await video.play();
    await new Promise(resolve => video.requestVideoFrameCallback(() => resolve()));
    const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
    canvas.getContext('2d').drawImage(video, 0, 0);
    await importImage(await canvas.convertToBlob(), 'window', 'Window capture');
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}

for (const button of document.querySelectorAll('[data-tool]')) {
  button.onclick = () => {
    tool = tool === button.dataset.tool ? undefined : button.dataset.tool;
    for (const item of document.querySelectorAll('[data-tool]')) item.setAttribute('aria-pressed', String(item.dataset.tool === tool));
    $('#text-option').hidden = tool !== 'text';
    if (tool === 'text') $('#label-text').focus();
    if (tool === 'highlight') $('#ink').value = '#ffe34c';
  };
}

action('#image-export', saveImage);
action('#pdf-export', () => exportPDF(ids.length > 1 ? ids : [current]));
$('#copy').onclick = () => copyImage().catch(error => notify(error.message, true));
action('#print', () => window.print());
$('#external').onclick = () => {
  if (!savedDownload) {
    saveImage().then(() => notify('Image saved. Select Open saved image to open it.')).catch(error => notify(error.message, true));
    return;
  }
  chrome.downloads.open(savedDownload).catch(error => notify(error.message, true));
};
$('#email').onclick = () => {
  const link = document.createElement('a');
  link.href = 'mailto:?subject=' + encodeURIComponent(editor.entry.title);
  link.click();
  notify('Attach an image or PDF saved from XA Snap.');
};
$('#share').hidden = typeof navigator.share !== 'function';
$('#share').onclick = async () => {
  try {
    const entry = await editor.export();
    const file = new File([entry.image], filename(entry, { template: '{title}', folder: '' }, 'png'), { type: 'image/png' });
    if (!navigator.canShare({ files: [file] })) throw new Error('File sharing is unavailable in this browser.');
    await navigator.share({ files: [file], title: entry.title });
  } catch (error) { notify(error.message, true); }
};
action('#undo', () => editor.undo());
action('#redo', () => editor.redo());
action('#revert', () => editor.reset());
action('#fit', () => editor.canvas.classList.remove('actual'));
action('#actual', () => editor.canvas.classList.add('actual'));
action('#edit-save', async () => {
  const entry = await editor.export();
  const { id, created, ...fields } = entry;
  const saved = await saveCapture({ ...fields, title: fields.title + ' (edited)' });
  ids = [saved];
  await openCapture(saved);
  notify('Edited copy saved in history.');
});
$('#filter').oninput = () => renderHistory().catch(error => notify(error.message, true));
action('#select-all', () => {
  const boxes = [...document.querySelectorAll('#entries input')];
  const select = boxes.some(input => !input.checked);
  for (const input of boxes) {
    input.checked = select;
    input.onchange();
  }
});
action('#history-pdf', () => exportPDF([...checked]));
action('#history-delete', async () => {
  if (!checked.size || !confirm('Delete ' + checked.size + ' saved capture(s)?')) return;
  for (const id of checked) await deleteCapture(id);
  checked.clear();
  await renderHistory();
});
action('#revoke-sites', async () => {
  await chrome.permissions.remove({ origins: ['<all_urls>'] });
  notify('Optional site access cleared.');
});
action('#reset-settings', () => populateSettings(defaults));
$('#settings-form').onsubmit = async event => {
  event.preventDefault();
  const values = {};
  for (const field of event.currentTarget.elements) {
    if (!field.name) continue;
    values[field.name] = field.type === 'checkbox' ? field.checked : typeof defaults[field.name] === 'number' ? Number(field.value) : field.value;
  }
  try {
    await chrome.storage.local.set(values);
    await history();
    notify('Settings saved.');
  } catch (error) { notify(error.message, true); }
};
$('#batch-form').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type=submit], button:not([type])');
  const urls = $('#urls').value.trim().split(/\r?\n/).map(url => url.trim()).filter(Boolean);
  if (!urls.length || urls.length > 50) { notify('Enter between 1 and 50 URLs.', true); return; }
  submit.disabled = true;
  try {
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) throw new Error('URL capture requires optional site access.');
    const { id } = await chrome.windows.getCurrent();
    notify('Capturing URLs…');
    const result = await chrome.runtime.sendMessage({ type: 'many', kind: 'urls', windowId: id, urls });
    if (!result.ok) throw new Error(result.error);
    $('#batch-results').replaceChildren(...result.result.errors.map(({ target, error }) => {
      const row = document.createElement('li');
      row.textContent = target + ' · ' + error;
      return row;
    }));
    notify(result.result.ids.length + ' captures saved.' + (result.result.cancelled ? ' Batch cancelled.' : ''));
  } catch (error) { notify(error.message, true); }
  finally { submit.disabled = false; }
};
action('#batch-stop', () => chrome.runtime.sendMessage({ type: 'stop' }));
$('#choose-window').onclick = () => captureWindow().catch(error => notify(error.message, true));
$('#file').onchange = () => {
  if ($('#file').files.length) importImage($('#file').files[0]).catch(error => notify(error.message, true));
};
$('#paste').onclick = async () => {
  try {
    const items = await navigator.clipboard.read();
    const item = items.find(entry => entry.types.some(type => type.startsWith('image/')));
    if (!item) throw new Error('No image on the clipboard.');
    await importImage(await item.getType(item.types.find(type => type.startsWith('image/'))));
  } catch (error) { notify(error.message, true); }
};
document.addEventListener('paste', event => {
  if ($('#import').hidden) return;
  const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/'));
  if (file) importImage(file).catch(error => notify(error.message, true));
});

window.addEventListener('hashchange', () => { notify(''); route().catch(error => notify(error.message, true)); });
route().catch(error => notify(error.message, true));

