let selectedHeight = 0;
document.addEventListener("xa-netflix-stream-list", event => {
  selectedHeight = Number(event.detail) || 0;
});
function publishQuality(quality) {
  document.dispatchEvent(new CustomEvent("xa-netflix-quality", { detail: quality }));
}
let changed = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.quality) {
    changed = true;
    selectedHeight = 0;
    publishQuality(changes.quality.newValue || "auto");
  }
});
chrome.storage.local.get({ quality: "auto" }).then(settings => {
  if (!changed) publishQuality(settings.quality);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!/\/watch\/\d+(?:\/|$)/.test(location.pathname)) return;
  if (message?.type === "xa-apply-quality") {
    publishQuality(message.quality);
    respond(true);
    setTimeout(() => location.reload(), 0);
    return;
  }
  if (message?.type !== "xa-video-size") return;
  const video = Array.from(document.querySelectorAll("video")).find(v => v.videoHeight && v.getClientRects().length);
  respond({ width: video?.videoWidth, height: video?.videoHeight, selectedHeight });
});
