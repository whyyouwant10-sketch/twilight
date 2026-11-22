// Cut bounds use upstream sequence numbers local to ONE rendition, never another track's MSN.
export function planCut(media, interval) {
  const { start, end } = interval;
  const omitted = media.segments.slice(start, end);
  const duration = omitted.reduce((sum, segment) => sum + segment.duration, 0);
  const resume = media.segments[end];
  return {
    first: omitted[0].sn, resume: resume.sn, duration,
    from: omitted[0].clock, to: resume.clock,
    discBefore: media.discBase + media.segments.slice(0, start).filter(s => s.discontinuity).length,
    discDelta: 1 - media.segments.slice(start, end + 1).filter(s => s.discontinuity).length,
  };
}

export function transform(media, cuts, text) {
  if (!cuts.length) return text;
  const lines = [...media.header];
  const active = media.segments.filter(s => !cuts.some(c => c.first <= s.sn && s.sn < c.resume));
  if (!active.length) throw new Error("empty-window");
  if (media.startOffset !== null) {
    const total = media.segments.reduce((sum, s) => sum + s.duration, 0);
    const position = Math.max(0, Math.min(total, media.startOffset < 0 ? total + media.startOffset : media.startOffset));
    const kept = new Set(active);
    let elapsed = 0, mapped = 0;
    for (const segment of media.segments) {
      if (kept.has(segment)) mapped += Math.max(0, Math.min(segment.duration, position - elapsed));
      elapsed += segment.duration;
    }
    const duration = active.reduce((sum, s) => sum + s.duration, 0);
    const offset = media.startOffset < 0 ? mapped - duration : mapped;
    const index = lines.findIndex(line => line.startsWith("#EXT-X-START:"));
    lines[index] = lines[index].replace(/TIME-OFFSET=[^,]+/, `TIME-OFFSET=${offset / 1000}`);
  }
  const first = active[0];
  const prior = cuts.filter(c => c.resume <= first.sn);
  const sequence = first.sn - prior.reduce((sum, c) => sum + c.resume - c.first, 0);
  const firstBoundary = first.discontinuity || prior.some(c => c.resume === first.sn);
  const skippedMarkers = media.segments.slice(0, first.sn - media.first + 1).filter(s => s.discontinuity).length;
  const discBase = media.discBase + skippedMarkers + prior.reduce((sum, c) => sum + c.discDelta, 0) - Number(firstBoundary);
  if (discBase < 0 || sequence < 0) throw new Error("inconsistent-window");
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${sequence}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${discBase}`);
  const removedRanges = new Set(cuts.flatMap(c => c.rangeIds));
  for (const { line, attrs } of media.ranges) {
    if (!removedRanges.has(attrs.get("ID"))) lines.push(line);
  }
  let previousMap = "", previousKey = "";
  for (const [index, segment] of active.entries()) {
    const splice = cuts.some(c => c.resume === segment.sn);
    if (segment.discontinuity || splice) lines.push("#EXT-X-DISCONTINUITY");
    if (segment.map && segment.map !== previousMap) {
      if (previousKey.includes("METHOD=AES-128")) { previousKey = "#EXT-X-KEY:METHOD=NONE"; lines.push(previousKey); }
      lines.push(segment.map);
      previousMap = segment.map;
    }
    let key = segment.key;
    if (sequence + index !== segment.sn && segment.implicitIV) {
      key += `,IV=0x${segment.sn.toString(16).padStart(32, "0")}`;
    }
    if (key && key !== previousKey) { lines.push(key); previousKey = key; }
    if (segment.clock !== null && (splice || index === 0) && !segment.lines.some(l => l.startsWith("#EXT-X-PROGRAM-DATE-TIME:"))) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(segment.clock).toISOString()}`);
    }
    for (const line of segment.lines) {
      if (/^#EXT-X-(?:KEY:|MAP:|DATERANGE:|DISCONTINUITY$|TWITCH-(?:ELAPSED|TOTAL)-SECS:)/.test(line)) continue;
      if (!(splice && line === "#EXT-X-CUE-IN")) lines.push(line);
    }
    lines.push(segment.uri);
  }
  if (lines.some(l => l.startsWith("#EXT-X-KEY:") && l.includes(",IV="))) {
    const version = lines.findIndex(l => l.startsWith("#EXT-X-VERSION:"));
    if (version < 0) lines.splice(1, 0, "#EXT-X-VERSION:2");
    else if (Number(lines[version].split(":")[1]) < 2) lines[version] = "#EXT-X-VERSION:2";
  }
  return [...lines, ...media.tail, ""].join("\n");
}
