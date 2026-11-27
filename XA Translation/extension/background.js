const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
const MAX_ITEMS_PER_BATCH = 35;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "TRANSLATE_BATCH") {
    translateBatch(message.texts || [], message.targetLang || "en")
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

async function translateBatch(texts, targetLang) {
  const results = [];
  for (let i = 0; i < texts.length; i += MAX_ITEMS_PER_BATCH) {
    const chunk = texts.slice(i, i + MAX_ITEMS_PER_BATCH);
    const translated = await Promise.all(chunk.map((text) => translateOne(text, targetLang)));
    results.push(...translated);
    await sleep(120);
  }
  return { ok: true, translations: results };
}

async function translateOne(text, targetLang) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: "auto",
    tl: targetLang,
    dt: "t",
    q: text
  });

  const response = await fetch(`${GOOGLE_TRANSLATE_URL}?${params.toString()}`);
  if (!response.ok) throw new Error(`Translate request failed: ${response.status}`);

  const data = await response.json();
  const translated = Array.isArray(data?.[0])
    ? data[0].map((part) => part?.[0] || "").join("")
    : text;

  const detectedLanguage = data?.[2] || "auto";
  return { original: text, translated, detectedLanguage };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let openingOcr;
async function recognizeFrame(message) {
  if (!await chrome.offscreen.hasDocument()) {
    openingOcr ??= chrome.offscreen.createDocument({
      url: "offscreen.html", reasons: ["WORKERS"], justification: "Read video text using a local OCR worker."
    }).finally(() => { openingOcr = null; });
    await openingOcr;
  }
  return chrome.runtime.sendMessage({ ...message, type: "XT_LOCAL_OCR" });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "XT_FRAME" || !sender.tab) return;
  recognizeFrame(message).then(respond, error => respond({ ok: false, error: String(error) }));
  return true;
});
