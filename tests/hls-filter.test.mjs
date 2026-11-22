import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classify } from "../scripts/hls/classifier.mjs";
import { parseMedia } from "../scripts/hls/manifest.mjs";
import { filterConfig, IntervalFilter } from "../scripts/hls/filter.mjs";

const [master, video, audio] = await Promise.all(["master", "video", "audio"].map(name =>
  readFile(new URL(`./fixtures/hls/${name}.m3u8`, import.meta.url), "utf8")));
const base = "https://playlist.ttvnw.net/master.m3u8";
const videoUrl = new URL("video.m3u8", base).href;
const audioUrl = new URL("audio.m3u8", base).href;
function open(options = {}) {
  const events = [];
  const filter = new IntervalFilter({ ...filterConfig({ HLS_FILTER_ENABLED: "true", HLS_FILTER_LOG: "debug" }), ...options }, event => events.push(event));
  const session = filter.open(master, base, null);
  const update = (text = video, peer = audio) => filter.update(session, videoUrl, text, async () => peer);
  return { filter, session, events, update };
}

test("completed Twitch range and duration-confirmed cues classify on shared infrastructure", () => {
  for (const text of [video, audio]) {
    const [interval] = classify(parseMedia(text));
    assert.deepEqual([interval.start, interval.end], [2, 4]);
    assert.ok(interval.confidence >= 0.94);
  }
  const ordinary = video.replace(/^#EXT-X-DATERANGE:.*\n/m, "").replaceAll("v10", "/ads/v10");
  assert.deepEqual(classify(parseMedia(ordinary)), []);
  assert.deepEqual(classify(parseMedia(video.replace("DURATION=4", "PLANNED-DURATION=4"))), []);
  assert.deepEqual(classify(parseMedia(audio.replace("#EXT-X-CUE-IN\n", ""))), []);
  assert.deepEqual(classify(parseMedia(audio.replace("CUE-OUT:4", "CUE-OUT:8"))), []);
});

test("coordinated cuts preserve durations, discontinuities, initialization and AES IVs", async () => {
  const { update, session, filter } = open();
  const output = await update();
  const v = parseMedia(output);
  assert.equal(v.first, 100);
  assert.equal(v.discBase, 4);
  assert.deepEqual(v.segments.map(s => s.uri), ["v100.m4s", "v101.m4s", "v104.m4s", "v105.m4s"]);
  assert.deepEqual(v.segments.map(s => s.discontinuity), [false, false, true, false]);
  assert.equal(v.segments.reduce((n, s) => n + s.duration, 0), 8000);
  assert.match(v.segments[2].key, /IV=0x0{30}68$/);
  assert.match(v.segments[3].key, /IV=0x0{30}69$/);
  assert.equal(v.segments[2].map, '#EXT-X-MAP:URI="new-init.mp4"');
  assert.equal(v.ranges.length, 0);
  const a = parseMedia(await filter.update(session, audioUrl, audio, () => assert.fail()));
  assert.equal(a.first, 70);
  assert.deepEqual(a.segments.map(s => s.clock), v.segments.map(s => s.clock));
  assert.equal(await update(), output);
});

test("sliding windows preserve published media and discontinuity numbers after cues disappear", async () => {
  const { update } = open();
  const previous = parseMedia(await update());
  const next = video.slice(0, video.indexOf("#EXT-X-PROGRAM")).replace("SEQUENCE:100", "SEQUENCE:104").replace("SEQUENCE:4", "SEQUENCE:5")
    + '#EXT-X-MAP:URI="new-init.mp4"\n' + video.slice(video.lastIndexOf("#EXT-X-DISCONTINUITY\n"))
    + "#EXTINF:2,\nv106.m4s\n#EXTINF:2,\nv107.m4s\n";
  const window = parseMedia(await update(next));
  assert.equal(window.first, previous.segments[2].sn);
  assert.equal(window.discBase, 4);
  assert.equal(window.segments[0].key, previous.segments[2].key);
  assert.equal(window.segments[0].uri, previous.segments[2].uri);
  const later = next.replace("SEQUENCE:104", "SEQUENCE:105").replace("SEQUENCE:5", "SEQUENCE:6")
    .replace("#EXT-X-DISCONTINUITY\n", "").replace("#EXTINF:2,\nv104.m4s\n", "");
  assert.equal(parseMedia(await update(later)).discBase, 5);
});

test("late markers, unaligned renditions, upstream failures and short buffers retain the original window", async () => {
  const { update } = open();
  const unmarked = video.replace(/^#EXT-X-DATERANGE:.*\n/m, "");
  assert.equal(await update(unmarked), unmarked);
  assert.equal(await update(video), video);
  assert.equal(await open().update(video, audio.replace("00:00:00Z", "00:00:01Z")), video);
  assert.equal(await open().update(video, "malformed"), video);
  const { filter, session } = open();
  assert.equal(await filter.update(session, videoUrl, video, async () => { throw new Error("peer offline"); }), video);
  const short = video.replace("#EXTINF:2,\nv100.m4s\n", "").replace("#EXTINF:2,\nv105.m4s\n", "").replace("00:00:04Z", "00:00:02Z");
  assert.equal(await open().update(short), short);
  assert.equal(await open({ threshold: 1 }).update(), video);
});

test("malformed, gap and low-latency windows fall back conservatively and diagnostics omit credentials", async () => {
  for (const bad of [video + "#EXTINF:2,", video.replace("v100.m4s", "#EXT-X-GAP\nv100.m4s"), video + '#EXT-X-PART:DURATION=1,URI="x"']) {
    assert.equal(await open().update(bad), bad);
  }
  const { update, events } = open();
  const output = await update(video.replace("v100.m4s", "v100.m4s?token=secret"));
  assert.equal(await update("truncated"), output);
  assert.equal(await update(video.replace("v100.m4s", "replaced.m4s")), output);
  assert.doesNotMatch(JSON.stringify(events), /secret|token|m4s|https:/);
  assert.ok(events.some(e => e.event === "unsafe-window"));
  const strict = open({ fallback: "retry" });
  await strict.update();
  await assert.rejects(strict.update("#EXTM3U"), /Reopen/);
});

test("disabled filter and unsupported master types use the existing relay path", () => {
  assert.equal(new IntervalFilter(filterConfig({})).open(master, base, null), null);
  const { filter, session } = open();
  assert.equal(filter.open(video, base, null), null);
  assert.equal(filter.resolve(session.id, videoUrl, null), session);
  assert.equal(filter.resolve(session.id, "https://other.example/master", null), null);
  assert.equal(filter.resolve(session.id, videoUrl, "https://other.example"), null);
});

test("ordinary and transformed HLS both decode with continuous audio and expected video frame counts", async t => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const codecs = spawnSync("ffmpeg", ["-encoders"], { encoding: "utf8" }).stdout ?? "";
  if (!codecs.includes("libx264") || !codecs.includes(" aac ")) return t.skip("optional FFmpeg encoders unavailable");
  const dir = await mkdtemp(join(process.cwd(), ".hls-smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  function ffmpeg(args) {
    const result = spawnSync("ffmpeg", ["-nostdin", "-v", "error", ...args], { cwd: dir, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=128x72:rate=10", "-f", "lavfi", "-i", "sine=sample_rate=48000",
    "-t", "8", "-c:v", "libx264", "-threads", "1", "-g", "10", "-sc_threshold", "0", "-c:a", "aac",
    "-hls_time", "1", "-hls_list_size", "0", "-hls_flags", "independent_segments", "-f", "hls", "plain.m3u8"]);
  const raw = await readFile(join(dir, "plain.m3u8"), "utf8");
  let index = 0;
  const marked = raw.replace(/^#EXTINF:/gm, tag => {
    const i = index++;
    return (i === 2 ? "#EXT-X-CUE-OUT:2\n" : i === 4 ? "#EXT-X-CUE-IN\n" : "") + tag;
  });
  const filter = new IntervalFilter(filterConfig({ HLS_FILTER_ENABLED: "true" }));
  const session = filter.open("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvideo.m3u8", base, null);
  const filtered = await filter.update(session, videoUrl, marked, () => assert.fail());
  await writeFile(join(dir, "filtered.m3u8"), filtered);
  for (const [name, frames] of [["plain", 80], ["filtered", 60]]) {
    const hashes = ffmpeg(["-i", name + ".m3u8", "-map", "0:v", "-map", "0:a", "-vsync", "0", "-f", "framehash", "-"]);
    assert.equal(hashes.match(/^0,/gm)?.length, frames);
    assert.ok((hashes.match(/^1,/gm)?.length ?? 0) > frames * 4);
  }
});

test("Twitch live start offsets map onto the kept EXTINF timeline from either end", async () => {
  for (const [offset, expected] of [[9, 5], [5, 4], [-7, -4], [-2, -2]]) {
    const text = video.replace("#EXT-X-PROGRAM-DATE-TIME:", `#EXT-X-TWITCH-ELAPSED-SECS:280\n#EXT-X-TWITCH-TOTAL-SECS:292\n#EXT-X-START:TIME-OFFSET=${offset},PRECISE=YES\n#EXT-X-PROGRAM-DATE-TIME:`);
    const output = await open().update(text);
    assert.ok(output.includes(`#EXT-X-START:TIME-OFFSET=${expected},PRECISE=YES`));
    assert.doesNotMatch(output, /v102.m4s/);
  }
});

test("a new completed interval can be cut on a later refresh without changing earlier publications", async () => {
  const { update, events } = open({ debugSequence: 102 });
  const before = video.slice(0, video.indexOf("#EXT-X-DISCONTINUITY\n"));
  assert.equal(await update(before), before);
  const output = await update();
  assert.equal(parseMedia(output).first, 100);
  assert.doesNotMatch(output, /v102\.m4s/);
  assert.ok(events.some(e => e.event === "segment-decision" && e.sn === 102 && e.omitted));

  const changes = video.replace("DURATION=4", "PLANNED-DURATION=4")
    .replace("#EXTINF:2,stitched-ad", '#EXT-X-DATERANGE:ID="break",DURATION=4\n#EXTINF:2,stitched-ad');
  assert.doesNotMatch(await open().update(changes), /#EXT-X-DATERANGE|v102.m4s/);
});

test("renditions can splice the same interval with different segment lengths but require matching clocks and discontinuity history", async () => {
  const split = audio.replace("#EXTINF:2,\na72.aac", "#EXTINF:1,\na72a.aac\n#EXTINF:1,\na72b.aac");
  const { update, filter, session } = open();
  assert.doesNotMatch(await update(video, split), /v102.m4s/);
  const output = await filter.update(session, audioUrl, split, () => assert.fail());
  assert.doesNotMatch(output, /a72[ab].aac|a73.aac/);
  assert.match(output, /a74.aac/);
  assert.equal(await open().update(video, audio.replace("SEQUENCE:4", "SEQUENCE:8")), video);
});
