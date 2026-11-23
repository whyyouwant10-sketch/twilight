import assert from "node:assert/strict";
import test from "node:test";
import { livePosition, resumePosition, skipPosition } from "../dist/lib/player-controls.js";

const ranges = (...pairs) => ({ length: pairs.length, start: i => pairs[i][0], end: i => pairs[i][1] });

test("resume prioritizes the paused frame even after it leaves the live playlist", () => {
  const video = { get buffered() { return ranges([10, 30]); }, seekable: ranges([0, 100]) };
  assert.equal(resumePosition(16, video, 80), 16);
  assert.equal(resumePosition(32, video, 80), 80);
  assert.equal(resumePosition(85, video, 80), 85);
});

test("Go live uses HLS's safe live position with a seekable fallback", () => {
  assert.equal(livePosition(96, ranges([0, 100])), 96);
  assert.equal(livePosition(null, ranges([10, 40], [90, 100])), 99);
  assert.equal(livePosition(null, ranges()), null);
});

test("five-second skips stop at available video, gaps and the live edge", () => {
  const media = [[10, 20], [25, 40]];
  assert.equal(skipPosition(30, -5, media, 37), 25);
  assert.equal(skipPosition(30, 5, media, 37), 35);
  assert.equal(skipPosition(12, -5, media, 37), 10);
  assert.equal(skipPosition(35, 5, media, 37), 37);
  assert.equal(skipPosition(37, 5, media, 37), null);
  assert.equal(skipPosition(18, 5, media, 37), 19.99);
  assert.equal(skipPosition(26, -5, media, 37), 25);
  assert.equal(skipPosition(10, -5, media, 37), null);
  assert.equal(skipPosition(35, 5, [], null), null);
});

test("clicking live video preserves playback, and activity reveals idle controls", async t => {
  const { bindPlayerControls } = await import("../dist/lib/player-controls.js");
  const element = () => Object.assign(new EventTarget(), { dataset: {}, classList: { toggle() {} } });
  const controls = new Map();
  const classes = new Set();
  const shell = Object.assign(element(), {
    closest: () => element(),
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
    querySelector(selector) {
      if (!controls.has(selector)) controls.set(selector, element());
      return controls.get(selector);
    },
  });
  const video = Object.assign(element(), { closest: () => shell, currentTime: 20, volume: 1, readyState: 4,
    paused: false, buffered: ranges([10, 30]), seekable: ranges([10, 30]),
    pause() { this.paused = true; this.dispatchEvent(new Event("pause")); },
    async play() { this.paused = false; this.dispatchEvent(new Event("playing")); },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [name, value] of Object.entries({ document: element(), window: { setTimeout }, Hls: { Events: {} } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  const dispose = bindPlayerControls(video, { config: {}, on() {}, liveSyncPosition: null }, () => {});
  video.dispatchEvent(new Event("playing"));
  t.mock.timers.tick(2500);
  assert.ok(classes.has("player-idle"));
  shell.dispatchEvent(new Event("pointermove"));
  assert.ok(!classes.has("player-idle"));
  video.dispatchEvent(new Event("click"));
  assert.equal(video.paused, false);
  const play = shell.querySelector('[data-player="play"]');
  play.dispatchEvent(new Event("click"));
  video.dispatchEvent(new Event("click"));
  assert.equal(video.paused, true);
  play.dispatchEvent(new Event("click"));
  assert.equal(video.paused, false);
  dispose();
});
