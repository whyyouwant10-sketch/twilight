import test from "node:test";
import assert from "node:assert/strict";
import { fetchArchives, searchChannels } from "../scripts/twitch-api.mjs";
import { TwitchProvider } from "../dist/services/twitch.js";
import { mutedRanges } from "../dist/lib/archives.js";

test("public archive lookup includes offline users, excludes other video types, and preserves mute offsets", async t => {
  const mute = { offset: 60, duration: 180 };
  const video = { id: "12", broadcastType: "ARCHIVE", previewThumbnailURL: "https://static-cdn.jtvnw.net/archive.jpg", title: "Past stream", publishedAt: "2026-11-01", lengthSeconds: 400,
    muteInfo: { mutedSegmentConnection: { nodes: [mute] } } };
  const user = { displayName: "Nova", stream: null, videos: { edges: [
    { node: video, cursor: "one" }, { node: { ...video, broadcastType: "HIGHLIGHT" }, cursor: "two" },
  ], pageInfo: { hasNextPage: true } } };
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    assert.match(query, /type:ARCHIVE/);
    assert.equal(variables.after, "before");
    return Response.json({ data: { user: variables.login === "nova" ? user : null } });
  });
  const page = await fetchArchives("nova", "before");
  assert.equal(page.videos[0].thumbnailUrl, video.previewThumbnailURL);
  assert.equal(page.channel, "Nova");
  assert.equal(page.cursor, "two");
  assert.deepEqual(page.videos.map(v => v.id), ["12"]);
  assert.deepEqual(mutedRanges(page.videos[0]), [{ start: 60, end: 240 }]);
  assert.equal(await fetchArchives("missing", "before"), null);
});

test("connected account uses Helix archive filter, pagination and optional muted segments", async t => {
  const provider = new TwitchProvider("test", "test");
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.twitch.tv");
    assert.equal(options.headers.Authorization, "Bearer test");
    if (url.pathname.endsWith("/users")) return Response.json({ data: [{ id: "123", display_name: "Nova" }] });
    assert.equal(url.searchParams.get("type"), "archive");
    assert.equal(url.searchParams.get("after"), "before");
    const video = { id: "99", type: "archive", title: "Replay", published_at: "2026-11-01", duration: "1h2m3s", thumbnail_url: "https://static-cdn.jtvnw.net/v-%{width}x%{height}.jpg", muted_segments: null };
    return Response.json({ data: [video, { ...video, type: "upload" }], pagination: { cursor: "after" } });
  });
  const page = await provider.getArchives("nova", "before");
  assert.equal(page.videos.length, 1);
  assert.equal(page.videos[0].thumbnailUrl, "https://static-cdn.jtvnw.net/v-640x360.jpg");
  assert.equal(page.videos[0].duration, 3723);
  assert.deepEqual(mutedRanges(page.videos[0]), []);
  assert.equal(page.cursor, "after");
});

test("mute markers stay inside the playable timeline", () => {
  assert.deepEqual(mutedRanges({ duration: 200, muted: [null, { offset: 199, duration: 30 }, { offset: 205, duration: 10 }, { offset: 0, duration: -1 }] }),
    [{ start: 199, end: 200 }]);
});

test("partial channel names preserve Twitch ranking and include offline channels in both modes", async t => {
  const expected = [{ login: "s0mcs", displayName: "s0mcs", isLive: true, avatarUrl: "https://static-cdn.jtvnw.net/avatar.png" }, { login: "s0mpp", displayName: "S0MPP", isLive: false, avatarUrl: null }];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init.method === "POST") {
      assert.match(JSON.parse(init.body).query, /avatarUrl: profileImageURL\(width:50\)/);
      assert.equal(JSON.parse(init.body).variables.term, "s0m");
      return Response.json({ data: { searchFor: { channels: { items: expected.map(({ isLive, ...channel }) => ({ ...channel, stream: isLive ? { id: "123" } : null })) } } } });
    }
    assert.equal(new URL(url).searchParams.get("query"), "s0m");
    return Response.json({ data: expected.map(c => ({ broadcaster_login: c.login, display_name: c.displayName, thumbnail_url: c.avatarUrl, is_live: c.isLive })) });
  });
  assert.deepEqual(await searchChannels("s0m"), expected);
  assert.deepEqual(await new TwitchProvider("id", "token").searchChannels("s0m"), expected);
});
