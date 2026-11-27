export const defaults = {
  format: 'png', quality: 92, folder: 'XA Snap', template: '{title}-{year}{month}{day}-{hour}{minute}{second}',
  captureDelay: 0, captureTimeout: 150, tileDelay: 160, adjacent: true, filenameLimit: 140,
  saveAs: true, reveal: false, closeAfter: false, retention: 0, contextMenu: true, tabMode: 'full',
  pdfSize: 'a4', pdfWidth: 595, pdfHeight: 842, pdfOrientation: 'portrait', pdfMargin: 24, pdfHeader: '', pdfFooter: '{page} / {pages}',
  pdfWatermark: '', pdfLinks: true, pdfText: true, pdfSmart: true, afterCapture: 'review'
};

export async function preferences() {
  return { ...defaults, ...await chrome.storage.local.get(Object.keys(defaults)) };
}

let dbPromise;
function database() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('xa-snap', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('captures', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = undefined; reject(request.error); };
  });
  return dbPromise;
}

async function recordRequest(mode, operation) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('captures', mode);
    const request = operation(tx.objectStore('captures'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error || request.error);
  });
}

export async function saveCapture(entry) {
  const record = { id: crypto.randomUUID(), created: Date.now(), ...entry };
  await recordRequest('readwrite', store => store.put(record));
  return record.id;
}

export function getCapture(id) {
  return recordRequest('readonly', store => store.get(id));
}

export function deleteCapture(id) {
  return recordRequest('readwrite', store => store.delete(id));
}

export async function history() {
  const { retention } = await preferences();
  const cutoff = retention > 0 ? Date.now() - retention * 86400000 : 0;
  const db = await database();
  return new Promise((resolve, reject) => {
    const items = [];
    const tx = db.transaction('captures', 'readwrite');
    const cursor = tx.objectStore('captures').openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      const { image, text, links, ...entry } = row.value;
      if (entry.created < cutoff) row.delete();
      else items.push(entry);
      row.continue();
    };
    tx.oncomplete = () => resolve(items.sort((a, b) => b.created - a.created));
    tx.onabort = () => reject(tx.error);
  });
}

export function fillTemplate(template, entry, extra = {}) {
  const date = new Date(entry.created);
  const pad = number => String(number).padStart(2, '0');
  let domain = '';
  try { domain = new URL(entry.url).hostname; } catch {}
  const values = {
    title: entry.title, url: entry.url, domain, year: date.getFullYear(), month: pad(date.getMonth() + 1),
    day: pad(date.getDate()), hour: pad(date.getHours()), minute: pad(date.getMinutes()),
    second: pad(date.getSeconds()), width: entry.width, height: entry.height, ...extra
  };
  return template.replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match));
}

function safeComponent(value) {
  const clean = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 140)
    .replace(/[ .]+$/g, '');
  return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i.test(clean) ? '_' + clean : clean;
}

export function filename(entry, settings, extension) {
  const length = Math.max(8, Math.min(140, settings.filenameLimit ?? 140));
  const name = safeComponent(fillTemplate(settings.template, entry).slice(0, length)) || 'XA Snap';
  const directories = settings.folder.split(/[\\/]/).map(safeComponent).filter(Boolean);
  return [...directories, name + '.' + extension].join('/');
}

