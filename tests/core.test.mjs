import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { safeExternalTwitchUrl, twitchChannelUrl } from "../dist/lib/url.js";
import { defaultSettings, loadSettings, saveSettings } from "../dist/lib/storage.js";
import { MockProvider } from "../dist/services/mock.js";

test("safe Twitch URLs reject lookalike hosts and unsafe schemes", () => {
  assert.equal(safeExternalTwitchUrl("https://www.twitch.tv/nova"), "https://www.twitch.tv/nova");
  assert.equal(safeExternalTwitchUrl("https://twitch.tv.evil.example/nova"), null);
  assert.equal(safeExternalTwitchUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalTwitchUrl("https://user:pass@twitch.tv/nova"), null);
});

test("channel links normalize to HTTPS Twitch URLs", () => {
  assert.equal(twitchChannelUrl("  Nova_Nights! "), "https://www.twitch.tv/nova_nights");
});

test("settings round-trip and malformed data fall back safely", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const settings = { ...defaultSettings(), favorites: ["nova_nights"], lowLatency: false };
  saveSettings(settings, storage);
  assert.deepEqual(loadSettings(storage), settings);
  values.set("twilight.settings.v1", "not json");
  assert.deepEqual(loadSettings(storage), defaultSettings());
});

test("demo provider supports search and deterministic chat", async () => {
  const provider = new MockProvider();
  const streams = await provider.getFeaturedStreams();
  assert.equal(provider.mode, "demo");
  assert.equal(streams.length, 6);
  assert.equal((await provider.searchStreams("stardew"))[0].gameName, "Stardew Valley");
  assert.ok((await provider.getChat("nova_nights")).length > 0);
});

test("demo provider filters by category and followed channels", async () => {
  const provider = new MockProvider();
  const valorant = await provider.getStreamsByCategory("VALORANT");
  assert.equal(valorant.length, 1);
  assert.equal(valorant[0].userName, "nova_nights");
  assert.equal((await provider.getStreamsByCategory("Unknown Game")).length, 0);

  const followed = await provider.getFollowedStreams(["Nova_Nights", "missing_channel"]);
  assert.deepEqual(followed.map((stream) => stream.userName), ["nova_nights"]);
  assert.equal((await provider.getFollowedStreams([])).length, 0);
});

test("page links the stylesheet and allows hls.js worker scripts", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css"/);
  assert.match(html, /worker-src 'self' blob:/);
});
