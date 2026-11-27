// XA Translation

const DEFAULT_SETTINGS = {
  autoTranslate: false,
  targetLang: "en",
  minChars: 2,
  skipEnglishLikeText: true,
  showBadge: true,
  translateOnLoad: true,
  ocrOverlay: false
};

let blockedHosts = [];

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "CODE", "PRE", "KBD", "SAMP", "SVG", "CANVAS"]);
const translatedNodes = new Map();
let revision = 0;
const pendingRoots = new Set();

let observer = null;
let busy = false;
let settings = { ...DEFAULT_SETTINGS };
let initialScanTimers = [];
let debounceTimer = null;
let observerStarted = false;

let lastNavUrl = location.href;

init();

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  settings = await loadSettings();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "GET_HOST") {
      sendResponse({ host: location.hostname });
      return false;
    }
    if (message?.type === "TRANSLATE_PAGE") {
      translatePage({ force: true, root: document.body || document.documentElement }).then(sendResponse);
      return true;
    }
    if (message?.type === "RESTORE_PAGE") {
      restorePage();
      sendResponse({ ok: true });
      return false;
    }
  });
  hookNavigation();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.blockedHosts) blockedHosts = changes.blockedHosts.newValue || [];
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (changes[key]) settings[key] = changes[key].newValue ?? DEFAULT_SETTINGS[key];
    }
    revision++;
    if (changes.targetLang) restorePage();
    applySettings();
  });
  applySettings();
}

async function loadSettings() {
  const saved = await chrome.storage.local.get({ ...DEFAULT_SETTINGS, blockedHosts: [] });
  blockedHosts = saved.blockedHosts;
  return saved;
}

function isBlocked() {
  const host = location.hostname.toLowerCase();
  return blockedHosts.some((pattern) => {
    const p = pattern.toLowerCase().replace(/^\*\./, "");
    return host === p || host.endsWith("." + p);
  });
}

function applySettings() {
  if (settings.autoTranslate && !isBlocked()) startAutoTranslate();
  else stopAutoTranslate();

  xtVideo.configure(settings.ocrOverlay && !isBlocked(), settings.targetLang);
  if (!settings.showBadge || isBlocked()) clearBadge();
}

// ── Navigation detection (handles SPA pushState / replaceState / popstate) ────

function hookNavigation() {
  // Modern browsers: Navigation API
  if (typeof navigation !== "undefined") {
    navigation.addEventListener("currententrychange", onNavigate);
    return;
  }

  // Fallback: monkey-patch History API + popstate
  const patchHistory = (method) => {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      onNavigate();
      return result;
    };
  };
  patchHistory("pushState");
  patchHistory("replaceState");
  window.addEventListener("popstate", onNavigate);
}

function onNavigate() {
  const newUrl = location.href;
  if (newUrl === lastNavUrl) return;
  lastNavUrl = newUrl;

  // Clear translated state for the new page
  pendingRoots.clear();
  clearTimeout(debounceTimer);

  if (isBlocked()) { stopAutoTranslate(); return; }

  if (settings.autoTranslate && settings.translateOnLoad) {
    // Give the SPA time to render the new route's content
    setTimeout(() => translatePage({ force: false, root: document.body || document.documentElement }), 600);
    setTimeout(() => translatePage({ force: false, root: document.body || document.documentElement }), 2000);
  }
}

// ── Auto-translate ────────────────────────────────────────────────────────────

function startAutoTranslate() {
  stopAutoTranslate();

  if (settings.translateOnLoad) {
    const scanRoot = () => translatePage({ force: false, root: document.body || document.documentElement });
    scanRoot();
    initialScanTimers = [
      setTimeout(scanRoot, 1200),
      setTimeout(scanRoot, 3000),
      setTimeout(scanRoot, 6000)
    ];
  }

  startObserver();
}

function startObserver() {
  if (observerStarted) return;
  observerStarted = true;

  observer = new MutationObserver((mutations) => {
    if (!settings.autoTranslate) return;

    for (const mutation of mutations) {
      if (isOwnUi(mutation.target)) continue;

      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE && !isOwnUi(node)) pendingRoots.add(node);
          if (node.nodeType === Node.TEXT_NODE && node.parentElement && !isOwnUi(node.parentElement)) pendingRoots.add(node.parentElement);
        });
      }

      if (mutation.type === "characterData" && mutation.target?.parentElement && translatedNodes.get(mutation.target)?.translated !== mutation.target.nodeValue) {
        pendingRoots.add(mutation.target.parentElement);
      }
    }

    if (!pendingRoots.size) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPendingRoots, 900);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });
}

function stopAutoTranslate() {
  if (observer) observer.disconnect();
  observer = null;
  observerStarted = false;
  pendingRoots.clear();
  clearTimeout(debounceTimer);
  initialScanTimers.forEach(clearTimeout);
  initialScanTimers = [];
}

async function flushPendingRoots() {
  if (!pendingRoots.size || busy) return;
  const roots = Array.from(pendingRoots).filter((root) => root?.isConnected);
  pendingRoots.clear();

  for (const root of roots) {
    await translatePage({ force: false, root });
  }
}

// ── Core translation ──────────────────────────────────────────────────────────

async function translatePage({ force, root }) {
  if (isBlocked()) return { ok: false, error: "This site is blocked." };
  if (!force && !settings.autoTranslate) return { ok: true, translatedCount: 0 };
  const started = revision;
  if (busy) return { ok: false, error: "Translation already running" };
  busy = true;
  try {
    const scanRoot = root || document.body || document.documentElement;
    const nodes = collectTextNodes(scanRoot, force);
    if (!nodes.length) return { ok: true, translatedCount: 0 };

    setBadge(`Translating ${nodes.length} text blocks…`);

    const texts = nodes.map((node) => node.nodeValue.trim());
    const response = await chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", texts, targetLang: settings.targetLang });
    if (!response?.ok) throw new Error(response?.error || "Translation failed");

    if (started !== revision) return { ok: true, translatedCount: 0 };
    let translatedCount = 0;
    response.translations.forEach((item, index) => {
      const node = nodes[index];
      if (!node?.isConnected || node.nodeValue.trim() !== texts[index] || !item?.translated) return;
      const original = node.nodeValue;
      const translated = item.translated.trim();
      if (!translated || translated === original.trim()) return;
      if (!force && settings.skipEnglishLikeText && isEnglishLike(original) && item.detectedLanguage === "en") return;


      node.nodeValue = preserveSpacing(original, translated);
      translatedNodes.set(node, { original, translated: node.nodeValue });
      translatedCount += 1;
    });

    setBadge(translatedCount ? `Translated ${translatedCount} text blocks` : "Nothing new to translate");
    return { ok: true, translatedCount };
  } catch (error) {
    setBadge(`Error: ${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    busy = false;
    if (pendingRoots.size) debounceTimer = setTimeout(flushPendingRoots, 100);
    setTimeout(clearBadge, 3500);
  }
}

function collectTextNodes(root, force) {
  const nodes = [];
  if (!root || isOwnUi(root)) return nodes;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node?.nodeValue || translatedNodes.get(node)?.translated === node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || shouldSkipElement(parent) || isOwnUi(parent)) return NodeFilter.FILTER_REJECT;
      const text = node.nodeValue.trim();
      if (text.length < settings.minChars) return NodeFilter.FILTER_REJECT;
      if (!force && settings.skipEnglishLikeText && isEnglishLike(text) && !hasNonLatinText(text)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

// ── OCR Video Overlay ─────────────────────────────────────────────────────────

function shouldSkipElement(element) {
  if (element.closest(Array.from(SKIP_TAGS).join(","))) return true;
  if (element.closest("[contenteditable]:not([contenteditable=false]), [data-alt-skip], .notranslate")) return true;
  return false;
}

function isOwnUi(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(element?.closest?.("#xa-translation-badge, #xt-ocr-root"));
}

function isVisible(element) {
  if (!element.getClientRects().length) return false;
  const style = window.getComputedStyle(element);
  return style && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
}

function hasNonLatinText(text) {
  return /[\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/.test(text);
}

function isEnglishLike(text) {
  const letters = text.match(/[A-Za-z]/g)?.length || 0;
  const nonAscii = text.match(/[^\x00-\x7F]/g)?.length || 0;
  return letters > 0 && nonAscii / Math.max(text.length, 1) < 0.08;
}

function preserveSpacing(original, translated) {
  const leading = original.match(/^\s*/)?.[0] || "";
  const trailing = original.match(/\s*$/)?.[0] || "";
  return `${leading}${translated}${trailing}`;
}

function restorePage() {
  revision++;
  stopAutoTranslate();
  for (const [node, record] of translatedNodes) {
    if (node.isConnected && node.nodeValue === record.translated) node.nodeValue = record.original;
  }
  translatedNodes.clear();
  if (settings.autoTranslate && !isBlocked()) startObserver();
  clearBadge();
}

function setBadge(message) {
  if (!settings.showBadge) return;
  let badge = document.getElementById("xa-translation-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "xa-translation-badge";
    badge.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#111;color:#fff;padding:10px 12px;border-radius:10px;font:13px system-ui, sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.25);max-width:320px;";
    document.documentElement.appendChild(badge);
  }
  badge.textContent = message;
}

function clearBadge() {
  document.getElementById("xa-translation-badge")?.remove();
}
