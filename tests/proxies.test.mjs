import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { EventEmitter, once } from "node:events";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { defaultSettings, loadSettings, saveSettings } from "../dist/lib/storage.js";
import { defaultImageProxy, imageUrl, playbackUrl } from "../dist/lib/proxy.js";
import { buildProxiedPlaylistUrl, isAllowedProxyMediaUrl } from "../scripts/twitch-api.mjs";
import { buildImageTarget, publicAddress } from "../scripts/relay.mjs";
import { handleApi } from "../scripts/server.mjs";

const base = "https://relay.example/path";
const source = "https://images.unsplash.com/photo?width=640&fit=crop";
const invalid = ["http://relay.example", "https://user:pass@relay.example", base + "#", "https://relay.example:8443", "https://127.1", "https://[::1]", "https://localhost"];

test("v1 settings round-trip, reject invalid saves and normalize older or malformed data", () => {
  let raw;
  const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
  const defaults = defaultSettings();
  const settings = { ...defaults, favorites: ["nova"], streamProxy: base, imageProxyEnabled: true, imageProxyUrl: base + "?url=" };
  saveSettings(settings, storage);
  assert.deepEqual(loadSettings(storage), settings);
  for (const url of invalid) {
    assert.throws(() => saveSettings({ ...settings, streamProxy: url }, storage));
    assert.throws(() => saveSettings({ ...settings, imageProxyUrl: url }, storage));
    assert.deepEqual(loadSettings(storage), settings);
  }
  for (const fields of [{}, { streamProxy: 12, imageProxyEnabled: "true", imageProxyUrl: null }, { streamProxy: base + "?x", imageProxyUrl: "http://example.com" }]) {
    raw = JSON.stringify({ ...fields, favorites: [12, "nova"] });
    assert.deepEqual(loadSettings(storage), { ...defaults, favorites: ["nova"] });
  }
});

test("only live playback uses the configured relay and its encoded Twire flags", () => {
  assert.equal(playbackUrl("nova", true, ""), "/api/playback?channel=nova");
  assert.equal(playbackUrl("nova", false, base), "/api/playback?channel=nova");
  assert.equal(playbackUrl("nova", true, base), "/api/playback?channel=nova&proxy=" + encodeURIComponent(base));
  assert.equal(buildProxiedPlaylistUrl(base + "/", " NoVa "), base + "/playlist/nova.m3u8%3Fallow_source%3Dtrue%26allow_audio_only%3Dtrue%26fast_bread%3Dtrue");
  for (const url of [...invalid, base + "?"]) assert.throws(() => buildProxiedPlaylistUrl(url, "nova"));
  assert.throws(() => buildProxiedPlaylistUrl(base, "../nova"));
});

test("proxy media scope is exact origin", () => {
  assert.ok(isAllowedProxyMediaUrl("https://relay.example/key", base));
  for (const url of [...invalid, "https://relay.example.evil.example", "https://sub.relay.example", "https://other.example"]) {
    assert.equal(isAllowedProxyMediaUrl(url, base), false);
  }
  assert.equal(isAllowedProxyMediaUrl(base, ""), false);
});

test("image URL preserves original bytes through local query encoding and upstream concatenation", () => {
  const settings = defaultSettings();
  assert.equal(imageUrl(source, settings), source);
  const path = imageUrl(source, { ...settings, imageProxyEnabled: true });
  const url = new URL(path, "http://localhost");
  assert.equal(url.pathname, "/api/image");
  assert.equal(buildImageTarget(url.searchParams.get("url"), url.searchParams.get("proxy")), defaultImageProxy + source);
  for (const prefix of invalid) {
    assert.throws(() => imageUrl(source, { imageProxyEnabled: true, imageProxyUrl: prefix }));
    assert.throws(() => buildImageTarget(source, prefix));
  }
  assert.throws(() => buildImageTarget("https://images.unsplash.com.evil.example/a", defaultImageProxy));
});

test("DNS address checks reject special-use IPv4 and IPv6", () => {
  for (const ip of ["127.0.0.1", "169.254.169.254", "224.0.0.1", "192.0.2.1", "100.64.0.1", "::ffff:127.0.0.1", "fc00::1", "fe80::8", "2001:db8::4", "2002::1", "3fff::2"]) {
    assert.equal(publicAddress(ip), false, ip);
  }
  assert.ok(publicAddress("8.8.8.8"));
  assert.ok(publicAddress("2606:4700:4700::1111"));
});

// Exercise the production handlers and socket lookup callback without external services.
function mockNetwork(t, reply) {
  t.mock.method(dns, "lookup", async host => [{ address: host === "private.example" ? "10.0.0.1" : "8.8.8.8", family: 4 }]);
  const calls = [];
  t.mock.method(https, "get", (url, options, callback) => {
    const request = new EventEmitter();
    options.lookup(new URL(url).hostname, { all: true }, error => {
      if (error) return request.emit("error", error);
      calls.push({ url, headers: options.headers });
      const { status = 200, headers = {}, body = "" } = reply(url);
      callback(Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, headers }));
    });
    return request;
  });
  return calls;
}

async function api(path, method = "GET", handler = handleApi) {
  const chunks = [];
  const response = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
  response.setHeader = () => {};
  response.writeHead = (status, headers) => Object.assign(response, { status, headers });
  const closed = once(response, "close");
  await handler({ method, headers: { range: "bytes=2-4", authorization: "secret", cookie: "session=test" } },
    new URL(path, "http://localhost"), response);
  await closed;
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString() };
}

test("proxied master, variants, keys and ranged segments preserve scope and stream semantics", async t => {
  const calls = mockNetwork(t, url => {
    if (url.includes("/playlist/")) return { body: "#EXTM3U\nhttps://playlist.ttvnw.net/live.m3u8\n/variant.m3u8\nhttps://other.example/no.ts" };
    if (url.endsWith(".m3u8")) return { body: '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg.ts' };
    return { status: 206, headers: { "accept-ranges": "bytes", "content-range": "bytes 2-4/10", "content-type": "video/mp2t", "content-length": "3" }, body: "ABC" };
  });
  const master = await api(playbackUrl("nova", true, base));
  assert.equal(master.headers["cache-control"], "no-store");
  assert.deepEqual(calls, [{ url: buildProxiedPlaylistUrl(base, "nova"), headers: { "Accept-Encoding": "identity", Referer: "https://player.twitch.tv", Origin: "https://player.twitch.tv" } }]);
  const [, twitch, variant, unrelated] = master.body.split("\n");
  for (const path of [twitch, variant]) {
    const parsed = new URL(path, "http://localhost");
    assert.equal(parsed.pathname, "/api/hls");
    assert.equal(parsed.searchParams.get("proxy"), new URL(base).origin);
    assert.equal((await api(path)).status, 200);
  }
  assert.equal((await api(unrelated)).status, 400);
  assert.equal((await api(variant.split("&proxy=")[0])).status, 400);
  const nested = await api(variant);
  const [, key, segment] = nested.body.split("\n");
  assert.match(key, /URI="\/api\/hls\?url=.*key.bin&proxy=/);
  const media = await api(segment);
  assert.equal(media.status, 206);
  assert.equal(media.body, "ABC");
  assert.equal(media.headers["content-range"], "bytes 2-4/10");
  assert.equal(media.headers["accept-ranges"], "bytes");
  assert.equal(media.headers["content-type"], "video/mp2t");
  assert.deepEqual(calls.at(-1).headers, { "Accept-Encoding": "identity", Accept: "*/*", Range: "bytes=2-4" });
});

test("image relay streams originals via the prefix and bounds redirects, size and type", async t => {
  const path = imageUrl(source, { imageProxyEnabled: true, imageProxyUrl: defaultImageProxy });
  let reply = { headers: { "content-type": "image/webp" }, body: "image" };
  const calls = mockNetwork(t, () => reply);
  const image = await api(path);
  assert.equal(image.status, 200);
  assert.equal(image.body, "image");
  assert.equal(image.headers["content-type"], "image/webp");
  assert.match(image.headers["cache-control"], /max-age=/);
  assert.deepEqual(calls[0], { url: defaultImageProxy + source, headers: { "Accept-Encoding": "identity" } });
  for (const location of ["http://relay.example", "https://private.example", "https://127.0.0.1"]) {
    reply = { status: 302, headers: { location } };
    const before = calls.length;
    assert.equal((await api(path)).status, 400);
    assert.equal(calls.length, before + 1);
  }
  reply = { status: 302, headers: { location: "/again" } };
  const before = calls.length;
  assert.equal((await api(path)).status, 502);
  assert.equal(calls.length, before + 4);
  for (const headers of [{ "content-type": "text/html" }, { "content-type": "image/png", "content-length": "10485761" }]) {
    reply = { headers };
    assert.equal((await api(path)).status, 502);
  }
  reply = { status: 503 };
  const failed = await api(playbackUrl("nova", true, base));
  assert.equal(failed.status, 502);
  assert.match(failed.body, /Stream proxy request failed \(503\)/);
  assert.equal((await api(playbackUrl("nova", true, "http://relay.example"))).status, 400);
  for (const path of ["/api/image", "/api/playback", "/api/hls"]) assert.equal((await api(path, "POST")).status, 405);
});

test("disabled stream proxy keeps the existing token, usher and playlist format", async t => {
  const token = t.mock.method(globalThis, "fetch", async () => Response.json({ data: {
    streamPlaybackAccessToken: { value: "test-value", signature: "test-signature" },
  } }));
  const calls = mockNetwork(t, () => ({ body: "#EXTM3U\r\nhttps://a.ttvnw.net/v.m3u8\r\n" }));
  const master = await api(playbackUrl("nova", true, ""));
  assert.equal(token.mock.callCount(), 1);
  assert.equal(new URL(calls[0].url).hostname, "usher.ttvnw.net");
  assert.equal(new URL(calls[0].url).searchParams.get("token"), "test-value");
  assert.equal(new URL(calls[0].url).searchParams.get("sig"), "test-signature");
  assert.equal(master.body, "#EXTM3U\n/api/hls?url=https%3A%2F%2Fa.ttvnw.net%2Fv.m3u8\n");
});

test("image relay aborts a chunked image exceeding the byte limit", async t => {
  mockNetwork(t, () => ({ headers: { "content-type": "image/png" }, body: Buffer.alloc(10 * 1024 * 1024 + 1) }));
  await assert.rejects(api(imageUrl(source, { imageProxyEnabled: true, imageProxyUrl: defaultImageProxy })), /Image too large/);
});

test("enabled playback coordinates renditions before URI rewriting and preserves segment failures", async t => {
  const saved = process.env.HLS_FILTER_ENABLED;
  process.env.HLS_FILTER_ENABLED = "true";
  let enabled;
  try { enabled = (await import("../scripts/server.mjs?enabled-integration")).handleApi; }
  finally {
    if (saved === undefined) delete process.env.HLS_FILTER_ENABLED;
    else process.env.HLS_FILTER_ENABLED = saved;
  }
  const [master, video, audio] = await Promise.all(["master", "video", "audio"].map(name =>
    readFile(new URL(`./fixtures/hls/${name}.m3u8`, import.meta.url), "utf8")));
  let failRefresh = false;
  const calls = mockNetwork(t, url => {
    if (url.endsWith("video.m3u8")) return failRefresh ? { status: 503 } : { body: video };
    if (url.endsWith("audio.m3u8")) return { body: audio };
    if (url.endsWith(".m4s")) return { status: 404 };
    return { body: master };
  });
  const get = path => api(path, "GET", enabled);
  const top = await get(playbackUrl("nova", true, base));
  const variant = top.body.split("\n").find(line => line.startsWith("/api/hls"));
  assert.match(variant, /&timeline=/);
  const filtered = await get(variant);
  assert.equal(filtered.status, 200);
  assert.match(filtered.body, /\/api\/hls\?url=.*v104.m4s&proxy=/);
  assert.doesNotMatch(filtered.body, /v10[23]\.m4s|timeline=/);
  assert.equal(filtered.headers["cache-control"], "no-store");
  const audioPath = top.body.match(/URI="([^"]+)"/)[1];
  assert.doesNotMatch((await get(audioPath)).body, /a7[23]\.aac/);
  assert.equal(calls.filter(c => c.url.endsWith("audio.m3u8")).length, 2);
  const segment = filtered.body.split("\n").find(line => line.startsWith("/api/hls"));
  assert.equal((await get(segment)).status, 502);
  failRefresh = true;
  assert.deepEqual(await get(variant), filtered);
  assert.equal((await get(variant.replace(/timeline=.*/, "timeline=expired"))).status, 410);
});

test("player type persists, defaults to site and reaches only the direct live token request", async t => {
  let raw;
  const storage = { getItem: () => raw, setItem: (_key, value) => { raw = value; } };
  for (const stored of [{}, { playerType: "invalid" }]) {
    raw = JSON.stringify(stored);
    assert.equal(loadSettings(storage).playerType, "site");
  }
  saveSettings({ ...defaultSettings(), playerType: "embed" }, storage);
  assert.equal(loadSettings(storage).playerType, "embed");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ data: { streamPlaybackAccessToken: { value: "token", signature: "sig" } } });
  });
  const upstream = mockNetwork(t, () => ({ body: "#EXTM3U\nhttps://a.ttvnw.net/live.m3u8" }));
  for (const type of ["site", "embed"]) {
    const path = playbackUrl("nova", true, "", type);
    assert.equal(path, "/api/playback?channel=nova" + (type === "embed" ? "&playerType=embed" : ""));
    assert.equal((await api(path)).status, 200);
    assert.equal(requests.at(-1).variables.playerType, type);
  }
  assert.deepEqual(requests[1], { ...requests[0], variables: { ...requests[0].variables, playerType: "embed" } });
  assert.deepEqual(upstream[0], upstream[1]);
  assert.equal(playbackUrl("nova", false, "", "embed"), "/api/playback?channel=nova");
  assert.equal(playbackUrl("nova", true, base, "embed"), playbackUrl("nova", true, base));
  assert.equal((await api(playbackUrl("nova", true, base, "embed"))).status, 200);
  assert.equal((await api("/api/playback?channel=nova&playerType=invalid")).status, 400);
  assert.equal(requests.length, 2);
});
