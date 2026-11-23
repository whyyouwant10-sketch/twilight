import assert from "node:assert/strict";
import test from "node:test";
import { fetchBroadcastReplay } from "../scripts/twitch-api.mjs";
import { replayUrls } from "../dist/lib/replay.js";

test("replay belongs to the selected live broadcast and has playable duration", async t => {
  let stream = { id: "11", archiveVideo: { id: "987", lengthSeconds: 9000 } };
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { user: { stream } } }));
  assert.deepEqual(await fetchBroadcastReplay("nova", "11"), { id: "987", duration: 9000 });
  assert.equal(await fetchBroadcastReplay("nova", "12"), null);
  stream.archiveVideo = null;
  assert.equal(await fetchBroadcastReplay("nova", "11"), null);
  stream = null;
  assert.equal(await fetchBroadcastReplay("nova", "11"), null);
});

test("replay embed and sign-in fallback open the same timestamp on Twitch", () => {
  const urls = replayUrls({ id: "987", seconds: 3723 }, "127.0.0.1");
  const embed = new URL(urls.player);
  assert.equal(embed.origin, "https://player.twitch.tv");
  assert.equal(embed.searchParams.get("parent"), "127.0.0.1");
  assert.equal(embed.searchParams.get("video"), "v987");
  assert.equal(embed.searchParams.get("time"), "1h2m3s");
  assert.equal(urls.page, "https://www.twitch.tv/videos/987?t=1h2m3s");
  assert.throws(() => replayUrls({ id: "invalid", seconds: 1 }, "localhost"));
});

test("DVR playlist updates retain old segments, append new ones and only authorize issued URLs", async () => {
  const { rewriteDvrPlaylist, validDvrTarget } = await import("../scripts/dvr.mjs");
  const base = "https://example.cloudfront.net/archive/chunked/index.m3u8";
  const first = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n1.ts\n";
  const earlier = rewriteDvrPlaylist(first, base);
  const later = rewriteDvrPlaylist(first + "#EXTINF:10,\n2.ts\n", base);
  assert.ok(later.startsWith(earlier));
  assert.ok(!later.includes("#EXT-X-ENDLIST"));
  const link = new URL(earlier.trim().split("\n").at(-1), "http://localhost");
  assert.equal(validDvrTarget(link.searchParams.get("url"), link.searchParams.get("key")), true);
  assert.equal(validDvrTarget("https://example.cloudfront.net/other", link.searchParams.get("key")), false);
  assert.throws(() => rewriteDvrPlaylist(first + "https://other.cloudfront.net/2.ts", base));
});

test("a replay already opened can finish growing after the original stream ends", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: { video: {
    id: "987", owner: { login: "nova" }, lengthSeconds: 9200, broadcastType: "ARCHIVE",
  } } }));
  assert.deepEqual(await fetchBroadcastReplay("nova", "11", "987"), { id: "987", duration: 9200 });
  assert.equal(await fetchBroadcastReplay("other", "11", "987"), null);
});
