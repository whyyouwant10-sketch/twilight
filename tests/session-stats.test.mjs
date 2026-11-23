import test from "node:test";
import assert from "node:assert/strict";
import { measuredBytes, dataSize } from "../dist/lib/session-stats.js";

test("session download counts measured API and remote transfers, excluding local assets and cached hits", () => {
  const origin = "http://127.0.0.1:4173";
  const count = (name, transferSize) => measuredBytes({ name, transferSize }, origin);
  assert.equal(count(origin + "/api/hls?url=example", 1000000), 1000000);
  assert.equal(count(origin + "/main.js", 1234), 0);
  assert.equal(count("https://static-cdn.jtvnw.net/example", 0), 0);
  assert.equal(count("https://static-cdn.jtvnw.net/example", 7200), 7200);
  assert.equal(dataSize(1000000), "1.0 MB");
});
