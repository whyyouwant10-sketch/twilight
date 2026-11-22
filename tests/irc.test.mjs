import test from "node:test";
import assert from "node:assert/strict";
import { chatMessageFromIrc, parseIrcLine } from "../dist/lib/irc.js";

test("IRC parser reads tags, prefix, command and trailing", () => {
  const line = parseIrcLine("@badge-info=;color=#1E90FF;display-name=Moon\\sBeam;id=abc :moonbeam!moonbeam@moonbeam.tmi.twitch.tv PRIVMSG #nova_nights :hello :world");
  assert.equal(line.command, "PRIVMSG");
  assert.equal(line.params[0], "#nova_nights");
  assert.equal(line.params[1], "hello :world");
  assert.equal(line.tags["display-name"], "Moon Beam");
  assert.equal(line.prefix, "moonbeam!moonbeam@moonbeam.tmi.twitch.tv");
});

test("IRC tag escaping is decoded", () => {
  const line = parseIrcLine("@display-name=a\\sb\\:c\\\\d PRIVMSG #x :hi");
  assert.equal(line.tags["display-name"], "a b;c\\d");
});

test("PING lines are parsed", () => {
  const line = parseIrcLine("PING :tmi.twitch.tv");
  assert.equal(line.command, "PING");
  assert.equal(line.params[0], "tmi.twitch.tv");
});

test("chat messages map safely and reject non-messages", () => {
  const line = parseIrcLine("@color=#1E90FF;display-name=Moon;id=abc :moon!moon@moon.tmi.twitch.tv PRIVMSG #nova :hi there");
  const message = chatMessageFromIrc(line, "fallback");
  assert.equal(message.user, "Moon");
  assert.equal(message.body, "hi there");
  assert.equal(message.color, "#1E90FF");
  assert.equal(message.id, "abc");

  assert.equal(chatMessageFromIrc(parseIrcLine("PING :x"), "id"), null);
  assert.equal(chatMessageFromIrc(parseIrcLine(":u!u@u PRIVMSG #c"), "id"), null);

  const unsafeColor = chatMessageFromIrc(parseIrcLine("@color=javascript :u!u@u PRIVMSG #c :yo"), "id2");
  assert.equal(unsafeColor.color, "#a970ff");
  assert.equal(chatMessageFromIrc(parseIrcLine(":u!u@u PRIVMSG #c :yo"), "id3").user, "u");
});
