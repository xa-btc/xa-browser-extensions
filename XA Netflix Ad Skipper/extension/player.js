const prompts = {
  intro: '[data-uia*="player-skip-intro"], [aria-label="Skip Intro"]',
  recap: '[data-uia*="player-skip-recap"], [data-uia*="player-skip-preplay"]',
  next: '[data-uia^="next-episode-seamless-button"]',
  resume: '[data-uia="interrupt-autoplay-continue"], [aria-label="Continue Playing"]'
};
const numericTimerSelector = 'span[class*="mmvz9h"]';
const timerSelector = [
  numericTimerSelector,
  '[data-uia*="ad-countdown"]', '[data-uia*="ads-countdown"]',
  '[data-uia*="ad-timer"]', '[data-uia*="ads-timer"]', '[data-uia="player-ad-badge"]'
].join(',');
const markerSelector = '.forward-anim, ' + timerSelector;
const options = {};
let clicked = new Map();
let route;
let ad;
let pending = false;
let deadlineTimer;
let finished = false;
let lastRemaining = null;
let awaitingTick = false;
// Leave a full second for playback and two seconds for rounded or delayed UI updates.
const tailSeconds = 3;

function visible(element) {
  return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
    element.getBoundingClientRect().width > 0 && !element.closest('[aria-hidden="true"]');
}

function restore() {
  clearTimeout(deadlineTimer);
  if (!ad) return;
  const { video, rate, muted, visibility } = ad;
  if (video.playbackRate === 8) video.playbackRate = rate;
  video.muted = muted;
  video.style.visibility = visibility;
  ad = undefined;
}

function countdown(marker, scope) {
  const timers = new Set([marker, ...scope.querySelectorAll(timerSelector)]);
  // Netflix may render the clock inside the badge, or in the same compact overlay.
  const overlay = marker.closest('[data-uia*="player-ad-"], [data-uia*="player-ads-"]');
  if (overlay) timers.add(overlay);
  for (const node of [marker, marker.parentElement]) {
    if (!node || node === scope) break;
    for (const sibling of [node.previousElementSibling, node.nextElementSibling]) {
      if (sibling && /^\s*(?:\d{1,2}:[0-5]\d|\d+\s*(?:seconds?|secs?|s))\s*$/i.test(sibling.textContent)) {
        timers.add(sibling);
      }
    }
  }
  const readings = [];
  for (const timer of timers) {
    if (!visible(timer)) continue;
    for (const value of [timer.textContent, timer.getAttribute('aria-label') || '', timer.title || '', timer.getAttribute('aria-valuetext') || '']) {
      const clock = value.match(/(?:^|[^\d:])(\d{1,2}):([0-5]\d)(?![:\d])/);
      const seconds = value.match(/\b(\d+)\s*(?:seconds?|secs?|s)\b/i);
      if (timer.matches(timerSelector) && /^\s*\d{1,3}\s*$/.test(value)) readings.push(Number(value));
      if (clock) readings.push(Number(clock[1]) * 60 + Number(clock[2]));
      if (seconds) readings.push(Number(seconds[1]));
    }
  }
  return readings.length ? Math.min(...readings) : null;
}

function finishAd() {
  awaitingTick = false;
  finished = true;
  restore();
}

function updateAd() {
  const marker = options.ads && [...document.querySelectorAll(markerSelector)].find(visible);
  const scope = marker && (marker.closest('.watch-video, [data-uia="player"]') || document);
  const video = scope && [...scope.querySelectorAll('video')].find(v => v === ad?.video || visible(v));
  if (!marker) {
    finished = false;
    lastRemaining = null;
    awaitingTick = false;
    restore();
    return;
  }
  if (ad && ad.video !== video) finishAd();
  if (!video) return;
  if (document.hidden) {
    if (ad) finishAd();
    return;
  }
  const remaining = countdown(marker, scope);
  // A player can reuse the same timer node for several breaks. Re-arm on a
  // fresh countdown only after it actually ticks down above the protected tail.
  if (finished && remaining > tailSeconds && (lastRemaining === null || remaining > lastRemaining)) awaitingTick = true;
  if (finished && awaitingTick && lastRemaining > tailSeconds && remaining > tailSeconds && remaining < lastRemaining) {
    finished = false;
  }
  lastRemaining = remaining;
  if (finished) return;
  if (remaining === null) {
    if (ad) finishAd();
    return;
  }
  if (remaining <= tailSeconds) {
    finishAd();
    return;
  }
  if (!ad) {
    ad = { video, rate: video.playbackRate, muted: video.muted, visibility: video.style.visibility };
    if (video.paused) video.play().catch(() => {});
  }
  // Limit acceleration by both media progress and elapsed time. A stale countdown
  // must never extend either cutoff when the badge outlives the ad.
  const budget = remaining - tailSeconds;
  ad.stopAt = Math.min(ad.stopAt ?? Infinity, video.currentTime + budget);
  if (video.currentTime >= ad.stopAt) {
    finishAd();
    return;
  }
  const deadline = performance.now() + budget * 1000 / 8;
  if (deadline < (ad.deadline ?? Infinity)) {
    ad.deadline = deadline;
    clearTimeout(deadlineTimer);
    deadlineTimer = setTimeout(finishAd, Math.max(0, deadline - performance.now()));
  }
  if (video.playbackRate !== 8) video.playbackRate = 8;
  if (!video.muted) video.muted = true;
  if (video.style.visibility !== 'hidden') video.style.visibility = 'hidden';
}

function scan() {
  pending = false;
  if (route !== location.pathname) {
    restore();
    finished = false;
    clicked.clear();
    route = location.pathname;
  }
  if (!/\/watch\/\d+(?:\/|$)/.test(route)) return;
  updateAd();
  const current = new Map();
  for (const [key, selector] of Object.entries(prompts)) {
    if (!options[key]) continue;
    for (const element of document.querySelectorAll(selector)) {
      if (!visible(element) || element.matches(':disabled, [aria-disabled="true"]')) continue;
      current.set(element, key);
      if (clicked.get(element) !== key) element.click();
    }
  }
  clicked = current;
}

function schedule() {
  if (!pending) {
    pending = true;
    queueMicrotask(scan);
  }
}

async function start() {
  Object.assign(options, await chrome.storage.local.get(defaults));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(defaults)) {
      if (key in changes) options[key] = changes[key].newValue ?? defaults[key];
    }
    schedule();
  });
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, characterData: true, subtree: true, attributes: true,
    attributeFilter: ['hidden', 'disabled', 'aria-hidden', 'aria-disabled', 'class', 'style', 'aria-label', 'title', 'data-uia']
  });
  document.addEventListener('timeupdate', event => {
    if (ad && event.target === ad.video && ad.video.currentTime >= ad.stopAt) finishAd();
  }, true);
  for (const event of ['seeking', 'emptied', 'ended', 'loadstart']) {
    document.addEventListener(event, e => {
      if (ad && e.target === ad.video) finishAd();
    }, true);
  }
  document.addEventListener('visibilitychange', schedule);
  setInterval(schedule, 750);
  window.addEventListener('pagehide', restore);
  scan();
}
start();
