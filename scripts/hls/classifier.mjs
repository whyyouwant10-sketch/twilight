// Confidence values are policy scores. A closed, semantically marked interval is mandatory.
export function classify(manifest) {
  const { segments, ranges } = manifest;
  const intervals = [];
  function add(start, end, confidence, reason, rangeId) {
    if (start < 0 || end <= start || end >= segments.length) return;
    const evidence = [reason];
    const group = segments.slice(start, end);
    if (segments[end].discontinuity) { confidence += 0.03; evidence.push("splice-boundary"); }
    if (group.every(segment => segment.lines.some(line => /^#EXTINF:[^,]+,stitched-ad(?:\b|$)/i.test(line)))) {
      confidence += 0.04;
      evidence.push("stitched-titles");
    }
    if (group.every(segment => /\/(ads?|stitched-ad)\//i.test(segment.uri.split(/[?#]/)[0]))) {
      confidence += 0.01;
      evidence.push("marked-path");
    }
    intervals.push({ start, end, confidence: Math.min(1, confidence), evidence, rangeId });
  }
  let open = -1, declared = null;
  for (let i = 0; i < segments.length; i++) {
    for (const line of segments[i].lines) {
      if (/^#EXT-X-CUE-OUT(?::|$)/.test(line)) {
        if (open !== -1) { open = -2; continue; }
        open = i;
        const value = line.split(":")[1];
        declared = value === undefined ? null : Number(value.replace(/^DURATION=/, "")) * 1000;
      } else if (line === "#EXT-X-CUE-IN") {
        if (open >= 0) {
          const length = segments.slice(open, i).reduce((sum, s) => sum + s.duration, 0);
          if (declared === null || Math.abs(declared - length) <= 1) add(open, i, declared === null ? 0.90 : 0.94, "closed-cue");
        }
        open = -1;
      }
    }
  }
  // A date range can be announced first and completed later under the same ID.
  const byId = new Map();
  for (const { attrs } of ranges) {
    const id = attrs.get("ID");
    const merged = byId.get(id);
    if (!byId.has(id)) byId.set(id, new Map(attrs));
    else if (merged) {
      for (const [name, value] of attrs) {
        if (merged.has(name) && merged.get(name) !== value) { byId.set(id, null); break; }
        merged.set(name, value);
      }
    }
  }
  for (const attrs of byId.values()) {
    if (!attrs) continue;
    const twitch = attrs.get("CLASS") === "twitch-stitched-ad";
    if (!twitch && !["ad", "advertisement"].includes(attrs.get("CLASS"))) continue;
    const from = Date.parse(attrs.get("START-DATE"));
    const duration = attrs.has("DURATION") ? Number(attrs.get("DURATION")) * 1000 : null;
    const to = attrs.has("END-DATE") ? Date.parse(attrs.get("END-DATE")) : from + (duration ?? 0);
    if (!attrs.get("ID") || !(to > from) || (duration !== null && (!Number.isFinite(duration) || Math.abs(to - from - duration) > 1))) continue;
    const start = segments.findIndex(s => s.clock === from);
    const end = segments.findIndex(s => s.clock === to);
    if (start < 0 || end <= start || segments.slice(start, end).some((s, i) => s.clock + s.duration !== segments[start + i + 1].clock)) continue;
    add(start, end, twitch ? 0.97 : 0.94, twitch ? "twitch-date-range" : "ad-date-range", attrs.get("ID"));
  }
  return intervals;
}
