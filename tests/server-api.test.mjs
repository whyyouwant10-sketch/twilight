import test from "node:test";
import assert from "node:assert/strict";
import { clearDiscoveryCache, fetchTopStreams, searchPublicStreams, isAllowedTwitchMediaUrl, mapGqlCategory, mapGqlStream, rewritePlaylist, sanitizeLogin } from "../scripts/twitch-api.mjs";

test("media proxy only allows Twitch media hosts over https", () => {
  assert.equal(isAllowedTwitchMediaUrl("https://video-weaver.aps32.hls.ttvnw.net/v1/segment/a.ts"), true);
  assert.equal(isAllowedTwitchMediaUrl("https://static-cdn.jtvnw.net/previews/a.jpg"), true);
  assert.equal(isAllowedTwitchMediaUrl("https://player.twitch.tv/index.html"), true);
  assert.equal(isAllowedTwitchMediaUrl("http://video-weaver.ttvnw.net/a.ts"), false);
  assert.equal(isAllowedTwitchMediaUrl("https://ttvnw.net.evil.example/a.ts"), false);
  assert.equal(isAllowedTwitchMediaUrl("https://user:pass@video-weaver.ttvnw.net/a.ts"), false);
  assert.equal(isAllowedTwitchMediaUrl("https://video-weaver.ttvnw.net:8443/a.ts"), false);
  assert.equal(isAllowedTwitchMediaUrl("not a url"), false);
});

test("playlist rewriting routes variant, segment and key URIs through the proxy", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60"',
    "#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720",
    "https://aps32.playlist.ttvnw.net/v1/playlist/abc.m3u8",
  ].join("\n");
  const rewritten = rewritePlaylist(master, "https://usher.ttvnw.net/api/channel/hls/foo.m3u8");
  assert.equal(rewritten.split("\n")[1], '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60"');
  assert.equal(rewritten.split("\n")[3], `/api/hls?url=${encodeURIComponent("https://aps32.playlist.ttvnw.net/v1/playlist/abc.m3u8")}`);

  const variant = ["#EXTM3U", "#EXTINF:2,", "segment/one.ts"].join("\n");
  const segments = rewritePlaylist(variant, "https://video-weaver.example.hls.ttvnw.net/v1/playlist/abc.m3u8").split("\n");
  assert.equal(segments[2], `/api/hls?url=${encodeURIComponent("https://video-weaver.example.hls.ttvnw.net/v1/playlist/segment/one.ts")}`);

  const key = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"';
  assert.match(rewritePlaylist(key, "https://x.hls.ttvnw.net/v1/playlist/a.m3u8"), /URI="\/api\/hls\?url=/);
});

test("channel names are validated and normalized", () => {
  assert.equal(sanitizeLogin("  IlloJuan "), "illojuan");
  assert.equal(sanitizeLogin("bad name!"), null);
  assert.equal(sanitizeLogin(""), null);
  assert.equal(sanitizeLogin("a".repeat(26)), null);
});

test("GraphQL stream nodes map to the app Stream shape", () => {
  const stream = mapGqlStream({
    id: 123,
    title: "late night",
    viewersCount: 42,
    createdAt: "2026-11-22T16:38:44Z",
    previewImageURL: "https://static-cdn.jtvnw.net/previews-ttv/live_user_x-640x360.jpg",
    broadcaster: { id: "u1", login: "Foo", displayName: "FOO" },
    game: { name: "Stardew Valley" },
  });
  assert.deepEqual(stream, {
    id: "123",
    userId: "u1",
    userName: "Foo",
    displayName: "FOO",
    title: "late night",
    gameName: "Stardew Valley",
    viewerCount: 42,
    thumbnailUrl: "https://static-cdn.jtvnw.net/previews-ttv/live_user_x-640x360.jpg",
    startedAt: "2026-11-22T16:38:44Z",
    tags: [],
    isLive: true,
  });
});

test("GraphQL game nodes map to the app Category shape with viewer counts", () => {
  const category = mapGqlCategory({
    id: 509658,
    name: "Just Chatting",
    viewersCount: 412345,
    boxArtURL: "https://static-cdn.jtvnw.net/ttv-boxart/509658-285x380.jpg",
  });
  assert.deepEqual(category, {
    id: "509658",
    name: "Just Chatting",
    boxArtUrl: "https://static-cdn.jtvnw.net/ttv-boxart/509658-285x380.jpg",
    viewerCount: 412345,
  });
  assert.deepEqual(mapGqlCategory({}), { id: "", name: "", boxArtUrl: "", viewerCount: 0 });
});

test("search ranks live channel matches, supplements title matches and respects Twitch's featured limit", async t => {
  clearDiscoveryCache();
  t.after(clearDiscoveryCache);
  const channel = { id: "1", broadcaster: { login: "shanks_ttv", displayName: "Shanks" } };
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    if (variables.term) {
      assert.equal(variables.term, "shanks");
      return Response.json({ data: { searchFor: { channels: { items: [{ stream: null }, { stream: channel }] } } } });
    }
    assert.equal(variables.first, 30);
    return Response.json({ data: { streams: { edges: [
      { node: channel }, { node: { id: "2", title: "Playing with Shanks" } }, { node: { id: "3", title: "Other" } },
    ] } } });
  });
  await fetchTopStreams(100);
  assert.deepEqual((await searchPublicStreams(" Shanks ")).map(s => s.id), ["1", "2"]);
});
