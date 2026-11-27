const languageModels = {
  en: "eng", es: "spa", fr: "fra", de: "deu", it: "ita", pt: "por", ru: "rus", ja: "jpn", ko: "kor",
  zh: "chi_sim", ar: "ara", hi: "hin", nl: "nld", pl: "pol", tr: "tur", vi: "vie", th: "tha"
};
let worker;
let currentModel;
let queue = Promise.resolve();
let idleTimer;

async function recognize(frame, language) {
  const tag = (language || "en").toLowerCase();
  const model = /^zh-(tw|hant|hk)/.test(tag) ? "chi_tra" : languageModels[tag.split("-")[0]] || "eng";
  const url = chrome.runtime.getURL("ocr/");
  if (!worker) {
    worker = await Tesseract.createWorker(model, 1, {
      workerPath: url + "worker.min.js", corePath: url + "tesseract-core-lstm.wasm.js",
      langPath: url, workerBlobURL: false
    });
  } else if (currentModel !== model) {
    await worker.reinitialize(model);
  }
  currentModel = model;
  const result = await worker.recognize(frame);
  return result.data.text.trim();
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== "XT_LOCAL_OCR" || sender.tab) return;
  clearTimeout(idleTimer);
  queue = queue.then(() => recognize(message.frame, message.language));
  queue = queue.then(text => respond({ ok: true, text }), error => respond({ ok: false, error: String(error) }));
  const last = queue;
  queue.then(() => {
    if (queue === last) idleTimer = setTimeout(() => {
      worker?.terminate();
      worker = null;
    }, 30000);
  });
  return true;
});