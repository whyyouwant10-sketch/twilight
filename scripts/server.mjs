import { IntervalFilter, filterConfig } from "./hls/filter.mjs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { pipeline, Transform } from "node:stream";
import { buildImageTarget, checkImageSource, InvalidRelayUrl, playlistText, relayGet } from "./relay.mjs";
import { isPublicHttpsUrl, isStreamProxy } from "../src/lib/proxy-validation.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  fetchFollowedStreams,
  fetchGameStreams,
  fetchMasterPlaylist,
  fetchMedia,
  fetchProxiedPlaylist,
  isAllowedProxyMediaUrl,
  fetchTopGames,
  fetchTopStreams,
  isAllowedTwitchMediaUrl,
  rewritePlaylist,
  sanitizeLogin,
  searchPublicStreams,
} from "./twitch-api.mjs";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "dist");
const port = Number(process.env.PORT ?? 4173);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".m3u8": "application/vnd.apple.mpegurl" };

const sendJson = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
};

const intervalFilter = new IntervalFilter(filterConfig(process.env));

const maxImageBytes = 10 * 1024 * 1024;
const relayHeaders = { "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff" };

function streamResponse(upstream, response, limit) {
  const streams = [upstream];
  if (limit) {
    let size = 0;
    streams.push(new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > limit) done(new Error("Image too large"));
        else done(null, chunk);
      },
    }));
  }
  pipeline(...streams, response, () => {});
}

async function handleRelay(request, url, response, signal) {
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    return sendJson(response, 405, { error: "Method not allowed" });
  }
  const proxy = url.searchParams.get("proxy");
  const target = url.searchParams.get("url");
  if (url.pathname === "/api/image") {
    const imageTarget = buildImageTarget(target, proxy);
    await checkImageSource(target, signal);
    const { upstream, status } = await relayGet(imageTarget, isPublicHttpsUrl, {}, signal);
    const type = upstream.headers["content-type"] ?? "";
    if (status < 200 || status >= 300 || !/^image\/[a-z0-9.+-]+(?:;|$)/i.test(type)
        || Number(upstream.headers["content-length"]) > maxImageBytes) {
      upstream.destroy();
      throw new Error("Image proxy returned an invalid or oversized image");
    }
    response.writeHead(status, { ...relayHeaders, "content-type": type, "cache-control": "public, max-age=300" });
    return streamResponse(upstream, response, maxImageBytes);
  }
  if (proxy !== null && !isStreamProxy(proxy)) return sendJson(response, 400, { error: "Invalid stream proxy URL" });
  if (url.pathname === "/api/playback") {
    const channel = sanitizeLogin(url.searchParams.get("channel"));
    if (!channel) return sendJson(response, 400, { error: "Invalid channel" });
    const master = proxy ? await fetchProxiedPlaylist(channel, proxy, signal) : await fetchMasterPlaylist(channel, signal);
    const session = intervalFilter.open(master.text, master.url, proxy);
    const playlist = rewritePlaylist(master.text, master.url, "/api/hls", proxy, session);
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
    return response.end(playlist);
  }
  if (!isAllowedTwitchMediaUrl(target) && !isAllowedProxyMediaUrl(target, proxy)) {
    return sendJson(response, 400, { error: "Blocked media url" });
  }
  const sessionId = url.searchParams.get("timeline");
  const session = sessionId && intervalFilter.resolve(sessionId, target, proxy);
  if (sessionId && !session) return sendJson(response, 410, { error: "HLS session expired. Reopen the stream." });
  const headers = { Accept: "*/*" };
  if (request.headers.range) headers.Range = request.headers.range;
  let media, sessionManifest;
  try {
    media = await fetchMedia(target, headers, proxy, signal);
    if (session) sessionManifest = await playlistText(media.upstream);
  } catch (error) {
    const previous = session && !(error instanceof InvalidRelayUrl) && intervalFilter.previous(session, target);
    if (!previous || response.destroyed) throw error;
    intervalFilter.report("upstream-refresh-failed");
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
    return response.end(rewritePlaylist(previous.text, previous.base, "/api/hls", proxy));
  }
  const { upstream, url: finalUrl, status } = media;
  const contentType = upstream.headers["content-type"] ?? "application/octet-stream";
  const playlistPath = proxy ? new URL(finalUrl).pathname.endsWith(".m3u8") : target.includes(".m3u8");
  if (session || contentType.toLowerCase().includes("mpegurl") || playlistPath) {
    const raw = sessionManifest ?? await playlistText(upstream);
    const text = session ? await intervalFilter.update(session, target, raw, async (peerUrl, probeSignal) => {
      const peer = await fetchMedia(peerUrl, { Accept: "*/*" }, proxy, probeSignal);
      return playlistText(peer.upstream, 128 * 1024);
    }, signal, proxy ? finalUrl : target) : raw;
    const playlist = rewritePlaylist(text, proxy ? finalUrl : target, "/api/hls", proxy);
    response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
    return response.end(playlist);
  }
  const output = { ...(proxy ? relayHeaders : {}), "content-type": contentType, "cache-control": "no-store" };
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    if (upstream.headers[name]) output[name] = upstream.headers[name];
  }
  response.writeHead(status, output);
  streamResponse(upstream, response);
}

export async function handleApi(request, url, response) {
  try {
    if (url.pathname === "/api/health") return sendJson(response, 200, { ok: true });

    if (url.pathname === "/api/twitch/streams") {
      const logins = url.searchParams.get("logins");
      const game = url.searchParams.get("game");
      const query = url.searchParams.get("q");
      const first = url.searchParams.get("first");
      let data;
      if (logins) data = await fetchFollowedStreams(logins.split(","), Number(first ?? 100));
      else if (game) data = await fetchGameStreams(game, Number(first ?? 30));
      else if (query) data = await searchPublicStreams(query, Number(first ?? 30));
      else data = await fetchTopStreams(Number(first ?? 30));
      return sendJson(response, 200, data);
    }

    if (url.pathname === "/api/twitch/categories") {
      return sendJson(response, 200, await fetchTopGames(Number(url.searchParams.get("first") ?? 24)));
    }

    if (["/api/playback", "/api/hls", "/api/image"].includes(url.pathname)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      response.once("close", () => { clearTimeout(timer); controller.abort(); });
      return await handleRelay(request, url, response, controller.signal);
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (response.destroyed) return;
    sendJson(response, error instanceof InvalidRelayUrl ? 400 : 502, { error: error instanceof Error ? error.message : "Twitch request failed" });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, url, response);
      return;
    }

    const requested = decodeURIComponent(url.pathname);
    const relative = requested === "/" ? "/index.html" : requested;
    const file = normalize(join(root, relative));
    if (file !== root && !file.startsWith(root + sep)) throw new Error("invalid path");
    let target = file;
    let info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      if (!request.headers.accept?.includes("text/html")) throw new Error("not a file");
      target = join(root, "index.html");
      info = await stat(target);
    }
    const extension = extname(target);
    const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, { etag, "cache-control": "no-cache" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": types[extension] ?? "application/octet-stream",
      "cache-control": extension === ".html" ? "no-cache" : "public, max-age=300",
      etag,
    });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, "127.0.0.1", () => console.log(`Twilight running at http://127.0.0.1:${port}`));
}
