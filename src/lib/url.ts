const allowedHosts = new Set(["twitch.tv", "www.twitch.tv", "clips.twitch.tv"]);

export function twitchChannelUrl(channel: string): string {
  const normalized = channel.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  return `https://www.twitch.tv/${normalized}`;
}

export function safeExternalTwitchUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
    return url.toString();
  } catch {
    return null;
  }
}
