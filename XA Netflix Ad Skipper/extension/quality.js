(() => {
  const modes = new Set(["auto", "480", "720", "1080", "2160", "highest"]);
  let mode = "auto";
  // Carry the selected mode across the title reload, before the async storage read.
  try {
    const saved = sessionStorage.getItem("xa-netflix-quality");
    if (modes.has(saved)) mode = saved;
  } catch {}
  document.addEventListener("xa-netflix-quality", event => {
    if (!modes.has(event.detail)) return;
    mode = event.detail;
    try { sessionStorage.setItem("xa-netflix-quality", mode); } catch {}
  });

  function selectQuality(value) {
    if (mode === "auto" || !value || typeof value !== "object") return value;
    const roots = [value, value.result, value.manifest, value.result?.manifest];
    for (const manifest of roots) {
      const tracks = manifest?.videoTracks ?? manifest?.video_tracks;
      if (!Array.isArray(tracks)) continue;
      const candidates = [];
      for (const track of tracks) {
        const key = Array.isArray(track?.downloadables) ? "downloadables" : "streams";
        const streams = track?.[key];
        if (!Array.isArray(streams) || !streams.length) continue;
        const heights = streams.map(stream => Number(stream?.height ?? stream?.res_h));
        if (!heights.every(h => Number.isInteger(h) && h > 0)) continue;
        candidates.push({track, key, streams, heights});
      }
      // Leave mixed/unknown layouts intact rather than offer a misleading selection.
      if (!candidates.length || candidates.length !== tracks.length) continue;
      const heights = candidates.flatMap(group => group.heights);
      const limit = mode === "highest" ? Infinity : Number(mode);
      const allowed = heights.filter(h => h <= limit);
      const target = allowed.length ? Math.max(...allowed) : Math.min(...heights);
      const kept = [];
      for (const {track, key, streams, heights} of candidates) {
        if (!heights.includes(target)) continue;
        track[key] = streams.filter((_, index) => heights[index] === target);
        kept.push(track);
      }
      manifest[manifest.videoTracks === tracks ? "videoTracks" : "video_tracks"] = kept;
      document.dispatchEvent(new CustomEvent("xa-netflix-stream-list", {detail: String(target)}));
    }
    return value;
  }

  const parse = JSON.parse;
  JSON.parse = function (...args) {
    const value = Reflect.apply(parse, this, args);
    if (mode === "auto" || typeof args[0] !== "string" || !/"video(?:Tracks|_tracks)"/.test(args[0])) return value;
    return selectQuality(value);
  };
  const readJson = Response.prototype.json;
  Response.prototype.json = function (...args) {
    const result = Reflect.apply(readJson, this, args);
    return mode === "auto" ? result : result.then(selectQuality);
  };
})();
