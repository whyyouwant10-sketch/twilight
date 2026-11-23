import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { InvalidRelayUrl, playlistText, relayGet } from "./relay.mjs";
import { isPublicHttpsUrl } from "../src/lib/proxy-validation.js";

const secret = randomBytes(32);
const signature = url => createHmac("sha256", secret).update(url).digest("base64url");
const twitchCdn = url => isPublicHttpsUrl(url) && /\.(cloudfront\.net|ttvnw\.net|live-video\.net|jtvnw\.net)$/.test(new URL(url).hostname);

export function rewriteDvrPlaylist(text, base, master = false) {
  if (!text.startsWith("#EXTM3U")) throw new Error("Invalid replay playlist");
  const local = uri => {
    const target = new URL(uri, base);
    if (!twitchCdn(target.href) || (!master && target.origin !== new URL(base).origin)) throw new Error("Unexpected replay media host");
    return "/api/dvr/media?" + new URLSearchParams({ url: target.href, key: signature(target.href) });
  };
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${local(uri)}"`);
    return local(line.trim());
  }).join("\n");
}

export function validDvrTarget(url, key) {
  if (!url || !key || !/^[A-Za-z0-9_-]{43}$/.test(key) || !twitchCdn(url)) return false;
  return timingSafeEqual(Buffer.from(signature(url)), Buffer.from(key));
}

export async function dvrMaster(id, signal) {
  const response = await fetch("https://gql.twitch.tv/gql", {
    method: "POST", signal, headers: { "Client-ID": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "application/json" },
    body: JSON.stringify({ query: 'query($id:ID!){videoPlaybackAccessToken(id:$id,params:{platform:"web",playerBackend:"mediaplayer",playerType:"site"}){value signature}}', variables: { id } }),
  });
  if (!response.ok) throw new Error("Replay access unavailable");
  const token = (await response.json()).data?.videoPlaybackAccessToken;
  if (!token?.value || !token.signature) throw new Error("Replay access unavailable");
  const url = `https://usher.ttvnw.net/vod/${id}.m3u8?` + new URLSearchParams({ nauth: token.value, nauthsig: token.signature, allow_source: "true" });
  const result = await relayGet(url, target => new URL(target).origin === "https://usher.ttvnw.net", {}, signal);
  if (result.status !== 200) { result.upstream.destroy(); throw new Error("Twitch did not grant replay playback"); }
  return rewriteDvrPlaylist(await playlistText(result.upstream), result.url, true);
}

export function dvrMedia(url, key, range, signal) {
  if (!validDvrTarget(url, key)) throw new InvalidRelayUrl("Invalid replay media link");
  return relayGet(url, target => new URL(target).origin === new URL(url).origin, range ? { Range: range } : {}, signal);
}
