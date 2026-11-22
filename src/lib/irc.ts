import type { ChatMessage } from "../types.js";

export interface IrcLine {
  tags: Record<string, string>;
  prefix: string | null;
  command: string;
  params: string[];
}

const unescapeTag = (value: string): string =>
  value.replace(/\\(.)/g, (_match, character: string) => {
    switch (character) {
      case "s": return " ";
      case ":": return ";";
      case "\\": return "\\";
      case "r": return "\r";
      case "n": return "\n";
      default: return character;
    }
  });

export function parseIrcLine(input: string): IrcLine | null {
  let rest = input.replace(/[\r\n]+$/g, "");
  if (!rest) return null;

  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space === -1) return null;
    for (const pair of rest.slice(1, space).split(";")) {
      if (!pair) continue;
      const equals = pair.indexOf("=");
      const key = equals === -1 ? pair : pair.slice(0, equals);
      tags[key] = unescapeTag(equals === -1 ? "" : pair.slice(equals + 1));
    }
    rest = rest.slice(space + 1);
  }

  let prefix: string | null = null;
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space === -1) {
      prefix = rest.slice(1);
      rest = "";
    } else {
      prefix = rest.slice(1, space);
      rest = rest.slice(space + 1);
    }
  }

  let trailing: string | undefined;
  const trailingIndex = rest.indexOf(" :");
  if (trailingIndex !== -1) {
    trailing = rest.slice(trailingIndex + 2);
    rest = rest.slice(0, trailingIndex);
  }

  const tokens = rest.split(" ").filter(Boolean);
  const command = tokens.shift();
  if (!command) return null;

  const params = tokens;
  if (trailing !== undefined) params.push(trailing);

  return { tags, prefix, command, params };
}

const prefixUser = (prefix: string | null): string | null => {
  if (!prefix) return null;
  const nick = prefix.split("!")[0] ?? "";
  return nick || null;
};

const validColor = /^#[0-9a-f]{6}$/i;

export function chatMessageFromIrc(line: IrcLine, fallbackId: string): ChatMessage | null {
  if (line.command !== "PRIVMSG" || line.params.length < 2) return null;
  const body = line.params[1] ?? "";
  if (!body) return null;

  const user = line.tags["display-name"] || line.tags["login"] || prefixUser(line.prefix) || "anonymous";
  const tagColor = line.tags["color"] ?? "";
  const color = validColor.test(tagColor) ? tagColor : "#a970ff";

  return {
    id: line.tags["id"] || fallbackId,
    user,
    color,
    body,
    timestamp: new Date().toISOString(),
  };
}
