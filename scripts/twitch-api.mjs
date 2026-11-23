import { isStreamProxy, isPublicHttpsUrl } from "../src/lib/proxy-validation.js";
import { relayGet, playlistText } from "./relay.mjs";

const GQL_URL = "https://gql.twitch.tv/gql";
const GQL_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const PLAYBACK_QUERY_HASH = "0828119ded1c13477966434e15800ff57ddacf13ba1911c129dc2200705b0712";
const USHER_BASE = "https://usher.ttvnw.net/api/channel/hls";
const MEDIA_HOST_SUFFIXES = ["ttvnw.net", "jtvnw.net", "twitch.tv", "live-video.net"];
const CACHE_TTL_MS = 15_000;

const cache = new Map();

const STREAM_FIELDS = "id title viewersCount createdAt previewImageURL(width:640,height:360) broadcaster { id login displayName } game { name }";

const clampFirst = (value, fallback = 30) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(number)));
};

export function sanitizeLogin(login) {
  const value = String(login ?? "").trim().toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(value) ? value : null;
}

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await loader();
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

async function gql(query, variables) {
  const response = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Client-ID": GQL_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Twitch GraphQL failed (${response.status})`);
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length) {
    throw new Error(payload.errors[0]?.message ?? "Twitch GraphQL error");
  }
  return payload.data ?? {};
}

export function mapGqlStream(node) {
  const broadcaster = node?.broadcaster ?? {};
  return {
    id: String(node?.id ?? ""),
    userId: String(broadcaster.id ?? ""),
    userName: String(broadcaster.login ?? ""),
    displayName: String(broadcaster.displayName ?? broadcaster.login ?? ""),
    title: String(node?.title ?? ""),
    gameName: String(node?.game?.name ?? "No category"),
    viewerCount: Number(node?.viewersCount ?? 0),
    thumbnailUrl: String(node?.previewImageURL ?? ""),
    startedAt: String(node?.createdAt ?? ""),
    tags: [],
    isLive: true,
  };
}

export async function searchChannels(term) {
  const data = await gql(`query($term:String!){ searchFor(userQuery:$term,platform:"web"){ channels { items { login displayName avatarUrl: profileImageURL(width:50) stream { id } } } } }`, { term });
  return (data.searchFor?.channels?.items ?? []).filter(user => sanitizeLogin(user?.login)).slice(0, 10)
    .map(({ login, displayName, avatarUrl, stream }) => ({ login, displayName, avatarUrl, isLive: Boolean(stream?.id) }));
}

export async function fetchArchives(login, after = null) {
  const data = await gql(`query($login:String!,$after:Cursor){
    user(login:$login){ displayName videos(first:12,after:$after,type:ARCHIVE,sort:TIME){
      edges { cursor node { id title publishedAt lengthSeconds broadcastType previewThumbnailURL(width:640,height:360)
        muteInfo { mutedSegmentConnection { nodes { offset duration } } }
      } } pageInfo { hasNextPage }
    } }
  }`, { login, after });
  if (!data.user) return null;
  const { edges, pageInfo } = data.user.videos;
  return {
    channel: data.user.displayName,
    videos: edges.map(edge => edge.node).filter(v => v?.broadcastType === "ARCHIVE" && /^\d+$/.test(v.id) && v.lengthSeconds > 0)
      .map(v => ({ id: String(v.id), title: v.title, publishedAt: v.publishedAt, duration: v.lengthSeconds, thumbnailUrl: v.previewThumbnailURL ?? "",
        muted: v.muteInfo?.mutedSegmentConnection?.nodes ?? null })),
    cursor: pageInfo?.hasNextPage ? edges.at(-1)?.cursor ?? null : null,
  };
}

export async function fetchBroadcastReplay(channel, streamId, videoId = null) {
  if (videoId) {
    // Once the viewer has opened an archive, it may keep growing after the channel goes offline.
    const { video } = await gql(`query($id:ID!){ video(id:$id){ id lengthSeconds broadcastType owner { login } } }`, { id: videoId });
    if (video?.id !== videoId || video.owner?.login !== channel || video.broadcastType !== "ARCHIVE" ||
        !Number.isSafeInteger(video.lengthSeconds) || video.lengthSeconds < 1) return null;
    return { id: videoId, duration: video.lengthSeconds };
  }
  const data = await gql(`query($login:String!){ user(login:$login){ stream { id archiveVideo { id lengthSeconds } } } }`, { login: channel });
  const stream = data.user?.stream;
  const video = stream?.archiveVideo;
  if (String(stream?.id) !== streamId || !video || !/^\d+$/.test(video.id)
      || !Number.isSafeInteger(video.lengthSeconds) || video.lengthSeconds < 1) return null;
  return { id: String(video.id), duration: video.lengthSeconds };
}

export async function fetchPlaybackToken(login, playerType = "site") {
  const channel = sanitizeLogin(login);
  if (!channel) throw new Error("Invalid channel name");
  const response = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Client-ID": GQL_CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationName: "PlaybackAccessToken",
      variables: { isLive: true, login: channel, isVod: false, vodID: "", playerType },
      extensions: { persistedQuery: { version: 1, sha256Hash: PLAYBACK_QUERY_HASH } },
    }),
  });
  if (!response.ok) throw new Error(`Twitch playback token failed (${response.status})`);
  const payload = await response.json();
  const token = payload?.data?.streamPlaybackAccessToken;
  if (!token?.value || !token?.signature) throw new Error("Channel is offline or unavailable");
  return { value: String(token.value), signature: String(token.signature), channel };
}

export function buildUsherUrl(channel, token, signature) {
  const params = new URLSearchParams({
    allow_source: "true",
    allow_audio_only: "true",
    fast_bread: "true",
    player_backend: "mediaplayer",
    playlist_include_framerate: "true",
    reassignments_supported: "true",
    sig: signature,
    token,
    cdm: "wv",
    supported_codecs: "avc1",
    transcode_mode: "cbd",
  });
  return `${USHER_BASE}/${channel}.m3u8?${params.toString()}`;
}

export function buildProxiedPlaylistUrl(proxyBase, login) {
  const channel = sanitizeLogin(login);
  if (!channel || !isStreamProxy(proxyBase)) throw new Error("Invalid stream proxy or channel");
  const path = encodeURIComponent(`${channel}.m3u8?allow_source=true&allow_audio_only=true&fast_bread=true`);
  return `${proxyBase.replace(/\/+$/, "")}/playlist/${path}`;
}

export function isAllowedProxyMediaUrl(target, proxyBase) {
  return isStreamProxy(proxyBase) && isPublicHttpsUrl(target) && new URL(target).origin === new URL(proxyBase).origin;
}

export async function fetchProxiedPlaylist(channel, proxyBase, signal) {
  const url = buildProxiedPlaylistUrl(proxyBase, channel);
  const { upstream, status, url: finalUrl } = await relayGet(url,
    target => isAllowedProxyMediaUrl(target, proxyBase) || isAllowedTwitchMediaUrl(target),
    { Referer: "https://player.twitch.tv", Origin: "https://player.twitch.tv" }, signal);
  if (status < 200 || status >= 300) {
    upstream.destroy();
    throw new Error(`Stream proxy request failed (${status})`);
  }
  return { url: finalUrl, text: await playlistText(upstream) };
}

export async function fetchMasterPlaylist(login, signal, playerType = "site") {
  const { value, signature, channel } = await fetchPlaybackToken(login, playerType);
  const url = buildUsherUrl(channel, value, signature);
  const { upstream, status } = await relayGet(url, isAllowedTwitchMediaUrl, {}, signal);
  if (status < 200 || status >= 300) {
    upstream.destroy();
    throw new Error(`Channel is offline or unavailable (${status})`);
  }
  return { url, text: await playlistText(upstream) };
}

export function isAllowedTwitchMediaUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

export function rewritePlaylist(text, baseUrl, proxyPath = "/api/hls", proxyBase = "", session = null) {
  const scope = proxyBase ? `&proxy=${encodeURIComponent(new URL(proxyBase).origin)}` : "";
  const proxy = (raw) => {
    try {
      const absolute = new URL(raw, baseUrl).toString();
      const timeline = session?.tracks.has(absolute) ? `&timeline=${session.id}` : "";
      return `${proxyPath}?url=${encodeURIComponent(absolute)}${scope}${timeline}`;
    } catch {
      if (proxyBase) throw new Error("Invalid playlist URI");
      return raw;
    }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxy(uri)}"`);
      return proxy(trimmed);
    })
    .join("\n");
}

export async function fetchMedia(url, headers = {}, proxyBase = "", signal) {
  const media = await relayGet(url, target => isAllowedTwitchMediaUrl(target) || isAllowedProxyMediaUrl(target, proxyBase), headers, signal);
  if (media.status < 200 || media.status >= 300) {
    media.upstream.destroy();
    throw new Error(`Media request failed (${media.status})`);
  }
  return media;
}

export async function fetchTopStreams(first = 30) {
  const limit = Math.min(30, clampFirst(first));
  return cached(`streams:${limit}`, async () => {
    const data = await gql(`query($first:Int!){ streams(first:$first){ edges { node { ${STREAM_FIELDS} } } } }`, { first: limit });
    return (data.streams?.edges ?? []).map((edge) => mapGqlStream(edge.node));
  });
}

export async function fetchGameStreams(name, first = 30) {
  const game = String(name ?? "").trim();
  if (!game) return [];
  const limit = clampFirst(first);
  return cached(`game:${game.toLowerCase()}:${limit}`, async () => {
    const data = await gql(`query($name:String!,$first:Int!){ game(name:$name){ streams(first:$first){ edges { node { ${STREAM_FIELDS} } } } } }`, { name: game, first: limit });
    return (data.game?.streams?.edges ?? []).map((edge) => mapGqlStream(edge.node));
  });
}

export async function fetchFollowedStreams(logins, first = 100) {
  const list = [...new Set((Array.isArray(logins) ? logins : []).map(sanitizeLogin).filter(Boolean))].slice(0, clampFirst(first, 100));
  if (!list.length) return [];
  return cached(`follows:${list.sort().join(",")}`, async () => {
    const data = await gql(`query($logins:[String!]!){ users(logins:$logins){ login displayName stream { ${STREAM_FIELDS} } } }`, { logins: list });
    return (data.users ?? [])
      .filter((user) => user?.stream)
      .map((user) => mapGqlStream({ ...user.stream, broadcaster: user.stream.broadcaster ?? { login: user.login, displayName: user.displayName } }));
  });
}

export function mapGqlCategory(node) {
  return {
    id: String(node?.id ?? ""),
    name: String(node?.name ?? ""),
    boxArtUrl: String(node?.boxArtURL ?? ""),
    viewerCount: Number(node?.viewersCount ?? 0),
  };
}

export async function fetchTopGames(first = 24) {
  const limit = clampFirst(first, 24);
  return cached(`games:${limit}`, async () => {
    const data = await gql(`query($first:Int!){ games(first:$first){ edges { node { id name viewersCount boxArtURL(width:285,height:380) } } } }`, { first: limit });
    return (data.games?.edges ?? []).map((edge) => mapGqlCategory(edge.node));
  });
}

export async function searchPublicStreams(query, first = 30) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return fetchTopStreams(first);
  const [data, featured] = await Promise.all([
    gql(`query($term:String!){ searchFor(userQuery:$term,platform:"web"){ channels { items { stream { ${STREAM_FIELDS} } } } } }`, { term: needle }),
    fetchTopStreams(30),
  ]);
  const channels = (data.searchFor?.channels?.items ?? [])
    .filter(user => user?.stream)
    .map(user => mapGqlStream(user.stream));
  const matches = featured.filter(stream =>
    `${stream.displayName} ${stream.userName} ${stream.title} ${stream.gameName}`.toLowerCase().includes(needle));
  const unique = new Map();
  for (const stream of [...channels, ...matches]) {
    if (!unique.has(stream.id)) unique.set(stream.id, stream);
  }
  return [...unique.values()].slice(0, clampFirst(first));
}

export function clearDiscoveryCache() {
  cache.clear();
}
