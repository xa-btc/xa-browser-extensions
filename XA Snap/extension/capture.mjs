const MAX_EDGE = 32767;
const MAX_PIXELS = 120000000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function page(tabId, func, ...args) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  if (!result || result.error) throw new Error('Could not read the target page.');
  return result.result;
}

function inspect(includeMetadata) {
  const root = document.documentElement;
  const scroller = document.scrollingElement || root;
  const state = {
    x: scrollX, y: scrollY, width: root.clientWidth, height: root.clientHeight, innerWidth, innerHeight,
    fullWidth: Math.max(root.clientWidth, scroller.scrollWidth),
    fullHeight: Math.max(root.clientHeight, scroller.scrollHeight)
  };
  if (!includeMetadata) return state;
  const bounds = rect => ({x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height});
  const shown = element => {
    const style = getComputedStyle(element);
    return style.visibility === 'visible' && style.opacity !== '0';
  };
  state.links = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (!/^https?:/i.test(anchor.href) || !shown(anchor)) continue;
    for (const rect of anchor.getClientRects()) {
      if (rect.width && rect.height) state.links.push({ ...bounds(rect), url: anchor.href });
    }
    if (state.links.length >= 5000) break;
  }

  state.text = [];
  const walker = document.createTreeWalker(document.body || root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  while (walker.nextNode() && state.text.length < 12000) {
    const node = walker.currentNode;
    if (!node.parentElement || node.parentElement.closest('script,style,noscript,textarea,[hidden]') || !shown(node.parentElement)) continue;
    for (const word of node.data.matchAll(/\S+/g)) {
      range.setStart(node, word.index);
      range.setEnd(node, word.index + word[0].length);
      const rect = range.getBoundingClientRect();
      if (rect.width && rect.height) state.text.push({ ...bounds(rect), value: word[0] });
      if (state.text.length >= 12000) break;
    }
  }
  return state;
}

function scrollPage(x, y) {
  window.scrollTo({ left: x, top: y, behavior: 'instant' });
  return { x: scrollX, y: scrollY };
}

function configurePage(hide, first) {
  const key = 'xa-snap-page-capture';
  let style = document.getElementById(key);
  if (!hide && !first) {
    if (style?.xaSheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== style.xaSheet);
    style?.remove();
    for (const element of document.querySelectorAll('[data-xa-snap-fixed]')) element.removeAttribute('data-xa-snap-fixed');
    return;
  }
  if (first) {
    for (const element of document.querySelectorAll('body *')) {
      const position = getComputedStyle(element).position;
      if (position === 'fixed' || position === 'sticky') element.setAttribute('data-xa-snap-fixed', '');
    }
    style = document.createElement('style');
    style.id = key;
    style.xaSheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, style.xaSheet];
    document.documentElement.append(style);
  }
  if (style?.xaSheet) style.xaSheet.replaceSync('html,body {scroll-behavior:auto!important;scroll-snap-type:none!important;}' +
    (hide ? '[data-xa-snap-fixed]{visibility:hidden!important}' : ''));
}

function chooseRegion(elementMode) {
  return new Promise(resolve => {
    const host = document.createElement('div');
    host.id = 'xa-snap-selection-host';
    Object.assign(host.style, { all: 'initial', position: 'fixed', inset: '0', zIndex: '2147483647' });
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('#veil{position:absolute;inset:0;cursor:crosshair;background:#001b3016;touch-action:none} #guide{position:absolute;box-sizing:border-box;border:2px solid #67ffe2;background:#52efcc24;pointer-events:none;display:none} #help{position:absolute;top:16px;left:50%;transform:translateX(-50%);padding:10px 14px;border-radius:12px;background:#101e2c;color:white;font:14px system-ui;pointer-events:none;white-space:nowrap}');
    shadow.adoptedStyleSheets = [sheet];
    shadow.innerHTML = '<div id="veil"><div id="guide"></div><div id="help"></div></div>';
    const veil = shadow.getElementById('veil');
    const guide = shadow.getElementById('guide');
    shadow.getElementById('help').textContent = elementMode ? 'Click an element · Esc to cancel' : 'Drag to select a region · Esc to cancel';
    let start;
    let region;
    const cancel = () => finish(null);
    host.addEventListener('xa-snap-cancel', cancel, { once: true });
    const timer = setTimeout(cancel, 120000);
    function finish(value) {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      host.remove();
      resolve(value);
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        event.preventDefault();
        finish(null);
      }
    }
    function draw(event) {
      if (elementMode) {
        host.style.pointerEvents = 'none';
        const element = document.elementFromPoint(event.clientX, event.clientY);
        host.style.pointerEvents = '';
        if (!element) return;
        const rect = element.getBoundingClientRect();
        region = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      } else {
        if (!start) return;
        const x = Math.max(0, Math.min(innerWidth, event.clientX));
        const y = Math.max(0, Math.min(innerHeight, event.clientY));
        region = { x: Math.min(x, start.x), y: Math.min(y, start.y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
      }
      Object.assign(guide.style, {
        display: 'block', left: region.x + 'px', top: region.y + 'px', width: region.width + 'px', height: region.height + 'px'
      });
    }
    veil.onpointermove = draw;
    veil.onpointerdown = event => {
      if (event.button !== 0) return;
      veil.setPointerCapture(event.pointerId);
      start = { x: event.clientX, y: event.clientY };
      draw(event);
    };
    veil.onpointerup = event => {
      if (!start) return;
      draw(event);
      const selected = region && region.width >= 3 && region.height >= 3;
      finish(selected ? { ...region, x: region.x + scrollX, y: region.y + scrollY } : null);
    };
    veil.onpointercancel = () => finish(null);
    window.addEventListener('keydown', onKey, true);
    document.documentElement.append(host);
  });
}

export function cancelSelection(tabId) {
  return page(tabId, () => document.querySelector('#xa-snap-selection-host')?.dispatchEvent(new Event('xa-snap-cancel')));
}

async function captureRegion(tab, source, original, target, cancelled) {
  const metadata = await page(tab.id, inspect, true);
  await delay(80);
  const bitmap = await createImageBitmap(await screenshot(tab, cancelled));
  try {
    const sx = bitmap.width / original.innerWidth;
    const sy = bitmap.height / original.innerHeight;
    const x = Math.round((target.x - metadata.x) * sx);
    const y = Math.round((target.y - metadata.y) * sy);
    const width = Math.round((target.x + target.width - metadata.x) * sx) - x;
    const height = Math.round((target.y + target.height - metadata.y) * sy) - y;
    if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > bitmap.width || y + height > bitmap.height) {
      throw new Error('The selected area moved before capture.');
    }
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    return { ...source, image: await canvas.convertToBlob(), width, height,
      text: trimMetadata(metadata.text, target, sx, sy), links: trimMetadata(metadata.links, target, sx, sy) };
  } finally { bitmap.close(); }
}
let lastShot = 0;

async function screenshot(tab, cancelled) {
  await delay(Math.max(0, 550 - (Date.now() - lastShot)));
  if (cancelled()) throw new Error('Capture cancelled.');
  const [active] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
  if (active?.id !== tab.id) throw new Error('The active tab changed during capture.');
  lastShot = Date.now();
  const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const [current] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
  if (current?.id !== tab.id || (tab.url && current.url && current.url !== tab.url)) {
    throw new Error('The target changed during capture.');
  }
  const bytes = Uint8Array.from(atob(url.split(',')[1]), character => character.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

function coverageSteps(start, end, step) {
  const offsets = [];
  for (let position = start; position < end; position += step) offsets.push(position);
  return offsets;
}

function trimMetadata(items, bounds, sx, sy) {
  return (items || []).flatMap(rect => {
    const x = Math.max(rect.x, bounds.x);
    const y = Math.max(rect.y, bounds.y);
    const right = Math.min(rect.x + rect.width, bounds.x + bounds.width);
    const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height);
    if (right <= x || bottom <= y) return [];
    return [{ ...rect, x: (x - bounds.x) * sx, y: (y - bounds.y) * sy, width: (right - x) * sx, height: (bottom - y) * sy }];
  });
}

export async function capture(tab, mode, progress, cancelled, settings = {}) {
  if (settings.captureDelay) {
    progress('Waiting before capture');
    await delay(settings.captureDelay * 1000);
  }
  if (cancelled()) throw new Error('Capture cancelled.');
  const source = { title: tab.title || 'Screenshot', url: tab.url || '', mode };
  if (mode === 'visible') {
    let metrics;
    try { metrics = await page(tab.id, inspect, true); } catch {}
    const image = await screenshot(tab, cancelled);
    const bitmap = await createImageBitmap(image);
    try {
      const scaleX = bitmap.width / (metrics?.innerWidth || bitmap.width);
      const scaleY = bitmap.height / (metrics?.innerHeight || bitmap.height);
      const view = { ...metrics, width: metrics?.innerWidth, height: metrics?.innerHeight };
      return {
        ...source, image, width: bitmap.width, height: bitmap.height,
        text: trimMetadata(metrics?.text, view, scaleX, scaleY), links: trimMetadata(metrics?.links, view, scaleX, scaleY)
      };
    } finally { bitmap.close(); }
  }

  let original;
  try { original = await page(tab.id, inspect, false); }
  catch { throw new Error('This tab blocks page access. Try Visible tab capture.'); }
  let target;
  if (mode === 'full') {
    target = { x: 0, y: 0, width: original.fullWidth, height: original.fullHeight };
  } else {
    progress('Select on the page');
    target = await page(tab.id, chooseRegion, mode === 'element');
    if (!target) throw new Error('Selection cancelled.');
    const right = target.x + target.width;
    const bottom = target.y + target.height;
    target.x = Math.max(0, target.x);
    target.y = Math.max(0, target.y);
    target.width = Math.min(right - target.x, original.fullWidth - target.x);
    target.height = Math.min(bottom - target.y, original.fullHeight - target.y);
    const visible = await page(tab.id, inspect, false);
    if (target.width > 0 && target.height > 0 && target.x >= visible.x && target.y >= visible.y &&
        target.x + target.width <= visible.x + visible.innerWidth && target.y + target.height <= visible.y + visible.innerHeight) {
      return captureRegion(tab, source, visible, target, cancelled);
    }
  }
  if (!(original.width > 0 && original.height > 0 && target.width > 0 && target.height > 0)) {
    throw new Error('The selected area is empty.');
  }
  const xs = coverageSteps(target.x, target.x + target.width, original.width);
  const ys = coverageSteps(target.y, target.y + target.height, original.height);
  if (xs.length * ys.length > 240) throw new Error('This page requires more than 240 tiles. Capture a smaller region.');
  const deadline = Date.now() + (settings.captureTimeout || 150) * 1000;
  let canvas, context, scaleX, scaleY, metadata;
  try {
    await page(tab.id, configurePage, false, true);
    for (const [row, y] of ys.entries()) {
      for (const [column, x] of xs.entries()) {
        if (cancelled()) throw new Error('Capture cancelled.');
        if (Date.now() >= deadline) throw new Error('The capture exceeded its time limit.');
        progress('Tile ' + (row * xs.length + column + 1) + ' of ' + (xs.length * ys.length));
        const position = await page(tab.id, scrollPage, x, y);
        await delay(settings.tileDelay ?? 160);
        if (!metadata) metadata = await page(tab.id, inspect, true);
        const bitmap = await createImageBitmap(await screenshot(tab, cancelled));
        try {
          if (!canvas) {
            scaleX = bitmap.width / original.innerWidth;
            scaleY = bitmap.height / original.innerHeight;
            const width = Math.round(target.width * scaleX);
            const height = Math.round(target.height * scaleY);
            if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
              throw new Error('This capture exceeds the image size limit. Capture a smaller region.');
            }
            canvas = new OffscreenCanvas(width, height);
            context = canvas.getContext('2d', { alpha: false });
          }
          const xEnd = Math.min(x + original.width, target.x + target.width);
          const yEnd = Math.min(y + original.height, target.y + target.height);
          if (position.x > x + 1 || position.y > y + 1 || position.x + original.width < xEnd - 1 ||
              position.y + original.height < yEnd - 1) throw new Error('The page layout changed while scrolling.');
          const left = Math.round((x - target.x) * scaleX);
          const top = Math.round((y - target.y) * scaleY);
          const width = Math.round((xEnd - target.x) * scaleX) - left;
          const height = Math.round((yEnd - target.y) * scaleY) - top;
          context.drawImage(bitmap, (x - position.x) * scaleX, (y - position.y) * scaleY, width, height, left, top, width, height);
        } finally { bitmap.close(); }
        if (row === 0 && column === 0 && mode === 'full') await page(tab.id, configurePage, true, false);
      }
    }
    return {
      ...source, image: await canvas.convertToBlob(), width: canvas.width, height: canvas.height,
      text: trimMetadata(metadata.text, target, scaleX, scaleY), links: trimMetadata(metadata.links, target, scaleX, scaleY)
    };
  } finally {
    try { await page(tab.id, scrollPage, original.x, original.y); } catch {}
    try { await page(tab.id, configurePage, false, false); } catch {}
  }
}

