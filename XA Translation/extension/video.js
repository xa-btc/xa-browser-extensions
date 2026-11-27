const xtVideo = (() => {
  let timer;
  let generation = 0;
  let target;
  let busy = false;
  const overlays = new Map();
  const captions = new Map();
  let observer;

  async function translate(text) {
    const reply = await chrome.runtime.sendMessage({ type: "TRANSLATE_BATCH", texts: [text], targetLang: target });
    if (!reply?.ok) throw new Error(reply?.error || "Translation unavailable");
    return reply.translations[0].translated;
  }

  async function scanCaptions(id) {
    for (const element of captions.keys()) if (!element.isConnected) captions.delete(element);
    for (const element of document.querySelectorAll(".ytp-caption-segment")) {
      const original = element.textContent;
      if (!original.trim() || captions.get(element)?.display === original) continue;
      const display = await translate(original);
      if (generation !== id) return;
      if (element.textContent !== original) continue;
      captions.set(element, { original, display });
      element.textContent = display;
    }
  }

  function position(video, bubble) {
    const rect = video.getBoundingClientRect();
    bubble.style.left = rect.left + rect.width / 2 + "px";
    bubble.style.top = rect.bottom - 10 + "px";
    bubble.style.maxWidth = rect.width * 0.9 + "px";
  }

  function reposition() {
    for (const [video, bubble] of overlays) position(video, bubble);
  }

  async function scanVideos(id) {
    for (const [video, bubble] of overlays) {
      if (!video.isConnected) { bubble.remove(); overlays.delete(video); }
    }
    const videos = [...document.querySelectorAll("video")].filter(v => v.readyState >= 2 && v.videoWidth && v.getClientRects().length);
    for (const video of videos.slice(0, 4)) {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 960 / video.videoWidth);
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      let frame;
      try {
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
        frame = canvas.toDataURL("image/png");
      } catch { continue; }
      const language = video.closest("[lang]")?.lang || "en";
      const reply = await chrome.runtime.sendMessage({ type: "XT_FRAME", frame, language });
      if (id !== generation) return;
      if (!reply?.ok) throw new Error(reply?.error || "OCR unavailable");
      let bubble = overlays.get(video);
      if (reply.text.length < 4) {
        if (bubble) bubble.hidden = true;
        continue;
      }
      const display = await translate(reply.text);
      if (id !== generation) return;
      if (!bubble) {
        bubble = document.createElement("div");
        bubble.dataset.altSkip = "";
        bubble.style.cssText = "position:fixed;transform:translate(-50%,-100%);z-index:2147483647;pointer-events:none;background:#111d;color:white;padding:6px 10px;border-radius:6px;font:600 16px/1.4 system-ui;text-align:center";
        (document.fullscreenElement || document.documentElement).append(bubble);
        overlays.set(video, bubble);
      }
      bubble.hidden = false;
      bubble.textContent = display;
      position(video, bubble);
    }
  }

  function configure(enabled, language) {
    if (timer && enabled && target === language) return;
    const id = ++generation;
    clearInterval(timer);
    timer = null;
    observer?.disconnect();
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    for (const bubble of overlays.values()) bubble.remove();
    overlays.clear();
    for (const [element, record] of captions) {
      if (element.textContent === record.display) element.textContent = record.original;
    }
    captions.clear();
    if (!enabled) return;
    target = language;
    const youtube = /(^|\.)youtube\.com$/.test(location.hostname);
    async function scan() {
      if (busy || id !== generation) return;
      busy = true;
      try {
        if (youtube) await scanCaptions(id);
        else await scanVideos(id);
      } catch (error) { console.warn("XA Translation video", error.message); }
      finally { busy = false; }
    }
    if (youtube) {
      observer = new MutationObserver(scan);
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    }
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    timer = setInterval(scan, 2500);
    scan();
  }
  return { configure };
})();