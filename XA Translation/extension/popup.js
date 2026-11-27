const DEFAULT_SETTINGS = {
  autoTranslate: false,
  targetLang: "en",
  minChars: 2,
  skipEnglishLikeText: true,
  showBadge: true,
  translateOnLoad: true,
  ocrOverlay: false
};

// Checkbox controls (keyed by settings key)
const checkboxControls = {
  autoTranslate: document.getElementById("autoTranslate"),
  skipEnglishLikeText: document.getElementById("skipEnglishLikeText"),
  showBadge: document.getElementById("showBadge"),
  translateOnLoad: document.getElementById("translateOnLoad"),
  ocrOverlay: document.getElementById("ocrOverlay")
};

const targetLangEl = document.getElementById("targetLang");
const minCharsEl = document.getElementById("minChars");
const minCharsValEl = document.getElementById("minCharsVal");
const statusEl = document.getElementById("status");
const currentHostEl = document.getElementById("currentHost");
const toggleBlockBtn = document.getElementById("toggleBlock");
const blockedListEl = document.getElementById("blockedList");

document.addEventListener("DOMContentLoaded", init);

document.getElementById("translateNow").addEventListener("click", async () => {
  const response = await sendToActiveTab({ type: "TRANSLATE_PAGE" });
  setStatus(response?.ok ? `Translated ${response.translatedCount || 0} blocks.` : response?.error || "Could not translate this page.");
});

document.getElementById("restorePage").addEventListener("click", async () => {
  const response = await sendToActiveTab({ type: "RESTORE_PAGE" });
  setStatus(response?.ok ? "Original text restored where possible." : "Could not restore this page.");
});

async function init() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);

  // Checkboxes
  Object.entries(checkboxControls).forEach(([key, control]) => {
    control.checked = Boolean(settings[key]);
    control.addEventListener("change", () => saveSettings());
  });

  // Target language select
  targetLangEl.value = settings.targetLang || "en";
  targetLangEl.addEventListener("change", () => saveSettings());

  // Min chars range
  minCharsEl.value = settings.minChars ?? 2;
  updateMinCharsLabel();
  minCharsEl.addEventListener("input", () => { updateMinCharsLabel(); saveSettings(); });

  // Blocklist
  await initBlocklist();
}

async function initBlocklist() {
  const { host } = await sendToActiveTab({ type: "GET_HOST" });

  if (host) {
    currentHostEl.textContent = host;
  } else {
    currentHostEl.textContent = "—";
    toggleBlockBtn.disabled = true;
  }

  await renderBlocklist(host);

  toggleBlockBtn.addEventListener("click", async () => {
    const { blockedHosts = [] } = await chrome.storage.local.get({ blockedHosts: [] });
    const isBlocked = blockedHosts.includes(host);
    const updated = isBlocked
      ? blockedHosts.filter((h) => h !== host)
      : [...blockedHosts, host];
    await saveBlocklist(updated);
    await renderBlocklist(host);
    setStatus(isBlocked ? `Unblocked ${host}` : `Blocked ${host}`);
  });
}

async function renderBlocklist(currentHost) {
  const { blockedHosts = [] } = await chrome.storage.local.get({ blockedHosts: [] });
  const isBlocked = currentHost && blockedHosts.includes(currentHost);

  toggleBlockBtn.textContent = isBlocked ? "Unblock this site" : "Block this site";
  toggleBlockBtn.className = isBlocked ? "block-btn unblock-btn" : "block-btn";

  blockedListEl.innerHTML = "";
  if (!blockedHosts.length) {
    const li = document.createElement("li");
    li.className = "blocked-empty";
    li.textContent = "No sites blocked.";
    blockedListEl.appendChild(li);
    return;
  }

  blockedHosts.forEach((host) => {
    const li = document.createElement("li");
    li.className = "blocked-item";

    const label = document.createElement("span");
    label.textContent = host;
    label.className = "blocked-hostname";

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.className = "remove-btn";
    removeBtn.title = `Unblock ${host}`;
    removeBtn.addEventListener("click", async () => {
      const { blockedHosts: bh = [] } = await chrome.storage.local.get({ blockedHosts: [] });
      await saveBlocklist(bh.filter((h) => h !== host));
      await renderBlocklist(currentHost);
      setStatus(`Unblocked ${host}`);
    });

    li.appendChild(label);
    li.appendChild(removeBtn);
    blockedListEl.appendChild(li);
  });
}

async function saveBlocklist(blockedHosts) {
  await chrome.storage.local.set({ blockedHosts });

}

function updateMinCharsLabel() {
  minCharsValEl.textContent = `(${minCharsEl.value})`;
}

async function saveSettings() {
  const settings = {
    ...Object.fromEntries(Object.entries(checkboxControls).map(([key, control]) => [key, control.checked])),
    targetLang: targetLangEl.value,
    minChars: Number(minCharsEl.value)
  };
  await chrome.storage.local.set(settings);

  setStatus("Saved.");
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");
  return chrome.tabs.sendMessage(tab.id, message).catch(() => ({ ok: false, error: "Open a supported webpage and reload it after installation." }));
}

function setStatus(text) {
  statusEl.textContent = text;
  setTimeout(() => { statusEl.textContent = ""; }, 3000);
}
