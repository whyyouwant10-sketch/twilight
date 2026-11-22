// Unknown timeline extensions stay on the forwarding path. Parsing never reads media bytes.
const numeric = /^\d+(?:\.\d+)?$/;
function integer(value) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("invalid-integer");
  return Number(value);
}

export function attributes(text) {
  const attrs = new Map();
  const field = /([A-Z0-9-]+)=("[^"\r\n]*"|[^,"\s]+)(?:,|$)/y;
  let offset = 0;
  while (offset < text.length) {
    const match = field.exec(text);
    if (!match || attrs.has(match[1])) throw new Error("invalid-attributes");
    attrs.set(match[1], match[2].replace(/^"|"$/g, ""));
    offset = field.lastIndex;
  }
  return attrs;
}

export function masterTracks(text, base) {
  const tracks = new Set();
  let pending = false;
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== "#EXTM3U") return [];
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) pending = true;
    else if (line.startsWith("#EXT-X-MEDIA:")) {
      const uri = attributes(line.slice(line.indexOf(":") + 1)).get("URI");
      if (uri) tracks.add(new URL(uri, base).href);
    } else if (line && !line.startsWith("#")) {
      if (!pending) return [];
      tracks.add(new URL(line, base).href);
      pending = false;
    } else if (/^#EXT-X-(I-FRAME-STREAM-INF|CONTENT-STEERING|DEFINE|IMAGE-STREAM-INF):/.test(line)) return [];
  }
  return pending ? [] : [...tracks];
}

export function parseMedia(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.shift() !== "#EXTM3U") throw new Error("invalid-header");
  const header = ["#EXTM3U"], segments = [], ranges = [], tail = [];
  let startOffset = null, first = 0, discBase = 0, target = 0, independent = false;
  let key = "", implicitIV = false, map = "", clock = null, duration = null, pending = [], discontinuity = false;
  const seen = new Set();
  for (const line of lines) {
    if (!line) continue;
    if (!line.startsWith("#")) {
      if (duration === null || !target || tail.length || segments.length >= 2048) throw new Error("invalid-segment");
      segments.push({ sn: first + segments.length, uri: line, duration, clock, key, implicitIV, map, discontinuity, lines: pending });
      if (clock !== null) clock += duration;
      duration = null;
      pending = [];
      discontinuity = false;
      continue;
    }
    const split = line.indexOf(":");
    const tag = split < 0 ? line : line.slice(0, split);
    const value = line.slice(split + 1);
    if (tail.length) throw new Error("after-endlist");
    if (["#EXT-X-MEDIA-SEQUENCE", "#EXT-X-DISCONTINUITY-SEQUENCE", "#EXT-X-TARGETDURATION", "#EXT-X-VERSION", "#EXT-X-INDEPENDENT-SEGMENTS"].includes(tag)) {
      if (segments.length || seen.has(tag) || pending.length) throw new Error("invalid-header-order");
      seen.add(tag);
      if (tag === "#EXT-X-MEDIA-SEQUENCE") first = integer(value);
      else if (tag === "#EXT-X-DISCONTINUITY-SEQUENCE") discBase = integer(value);
      else {
        if (tag === "#EXT-X-TARGETDURATION") target = integer(value);
        if (tag === "#EXT-X-INDEPENDENT-SEGMENTS") independent = true;
        header.push(line);
      }
      continue;
    }
    if (tag === "#EXT-X-START") {
      const offset = attributes(value).get("TIME-OFFSET");
      if (startOffset !== null || segments.length || !/^-?\d+(?:\.\d+)?$/.test(offset)) throw new Error("invalid-start");
      startOffset = Number(offset) * 1000;
      if (!Number.isSafeInteger(Math.round(startOffset))) throw new Error("invalid-start");
      header.push(line);
      continue;
    }
    if (tag === "#EXTINF") {
      const seconds = value.split(",")[0];
      if (duration !== null || !numeric.test(seconds)) throw new Error("invalid-duration");
      duration = Math.round(Number(seconds) * 1000);
      if (!duration || Math.round(duration / 1000) > target) throw new Error("invalid-duration");
    } else if (tag === "#EXT-X-KEY") {
      const attrs = attributes(value);
      if (!["AES-128", "NONE"].includes(attrs.get("METHOD")) || (attrs.has("KEYFORMAT") && attrs.get("KEYFORMAT") !== "identity")
          || (attrs.get("METHOD") === "AES-128" && !attrs.has("URI"))) throw new Error("unsupported-key");
      key = line;
      implicitIV = attrs.get("METHOD") === "AES-128" && !attrs.has("IV");
    } else if (tag === "#EXT-X-MAP") {
      const attrs = attributes(value);
      if (!attrs.has("URI") || attrs.has("BYTERANGE") || (key && attributes(key.slice(11)).get("METHOD") !== "NONE")) throw new Error("unsupported-map");
      map = line;
    } else if (tag === "#EXT-X-PROGRAM-DATE-TIME") {
      clock = Date.parse(value);
      if (!Number.isFinite(clock)) throw new Error("invalid-clock");
    } else if (tag === "#EXT-X-DISCONTINUITY") {
      if (discontinuity) throw new Error("duplicate-discontinuity");
      discontinuity = true;
    } else if (tag === "#EXT-X-DATERANGE") {
      ranges.push({ line, attrs: attributes(value) });
    } else if (tag === "#EXT-X-ENDLIST") {
      tail.push(line);
      continue;
    } else if (tag.startsWith("#EXT") && !["#EXT-X-CUE-OUT", "#EXT-X-CUE-IN", "#EXT-X-CUE-OUT-CONT", "#EXT-X-TWITCH-ELAPSED-SECS", "#EXT-X-TWITCH-TOTAL-SECS"].includes(tag)) {
      throw new Error("unsupported-tag");
    }
    pending.push(line);
  }
  if (!segments.length || pending.length || !Number.isSafeInteger(first + segments.length + discBase)) throw new Error("incomplete-window");
  const anchor = segments.findIndex(s => s.clock !== null);
  for (let i = anchor - 1; i >= 0; i--) segments[i].clock = segments[i + 1].clock - segments[i].duration;
  return { header, segments, startOffset, first, discBase, target, independent, ranges, tail };
}
