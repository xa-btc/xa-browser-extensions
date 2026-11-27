async function initialize() {
  const settings = await chrome.storage.local.get(defaults);
  for (const key of Object.keys(defaults)) {
    const input = document.getElementById(key);
    input.checked = settings[key];
    input.addEventListener("change", () => chrome.storage.local.set({ [key]: input.checked }));
  }
  const quality = document.getElementById("quality");
  quality.value = (await chrome.storage.local.get({ quality: "auto" })).quality;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const status = document.getElementById("playing");
  async function refresh() {
    if (!tab?.id) return;
    try {
      const size = await chrome.tabs.sendMessage(tab.id, { type: "xa-video-size" });
      if (!size) return;
      const details = [];
      if (quality.value !== "auto") details.push(size.selectedHeight ? `Stream list selected ${size.selectedHeight}p.` : "No adjustable stream list detected yet.");
      if (size.height) details.push(`Playing at ${size.width} x ${size.height}.`);
      status.textContent = details.join(" ");
    } catch {}
  }
  quality.addEventListener("change", async () => {
    const mode = quality.value;
    quality.disabled = true;
    try {
      await chrome.storage.local.set({ quality: mode });
      const applied = tab?.id && await chrome.tabs.sendMessage(tab.id, { type: "xa-apply-quality", quality: mode }).catch(() => false);
      status.textContent = applied ? "Reloading the title..." : "Saved for the next Netflix title.";
    } finally {
      quality.disabled = false;
    }
  });
  refresh();
  setInterval(refresh, 1000);
  document.querySelector("fieldset").disabled = false;
}
initialize();
