import { startSessionStats, statsMarkup } from "./lib/session-stats.js";
import { bindChannelSearch } from "./lib/channel-search.js";
import { mountArchives } from "./lib/archives.js";
import { bindBroadcastTimeline, replayUrls, type ReplayPosition } from "./lib/replay.js";
import { bindPlayerControls } from "./lib/player-controls.js";
import { createProvider } from "./services/twitch.js";
import { ServerProvider } from "./services/server.js";
import { TwitchChatClient, type ChatStatus } from "./services/chat.js";
import { imageUrl, playbackUrl, streamPresets } from "./lib/proxy.js";
import { isImageProxy, isStreamProxy } from "./lib/proxy-validation.js";
import { defaultSettings, loadSettings, saveSettings } from "./lib/storage.js";
import { safeExternalTwitchUrl, twitchChannelUrl } from "./lib/url.js";
import { createOAuthState, OAUTH_STATE_KEY, readOAuthHash, twitchAuthorizeUrl } from "./lib/oauth.js";
import type { AppSettings, Category, ChatMessage, Stream, StreamProvider, View } from "./types.js";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Twilight mount point missing");

const stats = startSessionStats();
let settings: AppSettings = loadSettings();
document.documentElement.style.setProperty("--transition", settings.reduceMotion ? "0s" : ".1s");
let provider: StreamProvider = createProvider(settings.clientId, settings.accessToken);
let view: View = "home";
let streams: Stream[] = [];
let browseStreams: Stream[] = [];
let followingStreams: Stream[] = [];
let categories: Category[] = [];
let chat: ChatMessage[] = [];
let selectedStream: Stream | undefined;
let archiveLogin = "";
let disposeTimeline: (() => void) | undefined;
let replayPosition: ReplayPosition | null = null;
let query = "";
let activeCategory: string | null = null;
let loading = false;
let loadError: string | null = null;
let chatStatus: ChatStatus = "offline";
let chatClient: TwitchChatClient | null = null;
let pendingChat: ChatMessage[] = [];
let chatFrame: number | undefined;
let hls: Hls | null = null;
let playerRetries = 0;
let unbindPlayerControls: (() => void) | undefined;
let toastTimer: number | undefined;
const redirectUri = `${window.location.origin}/auth/callback`;

async function serverApiAvailable(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 1500);
    const response = await fetch("/api/health", { signal: controller.signal });
    window.clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveProvider(): Promise<void> {
  if (settings.clientId.trim() && settings.accessToken.trim()) {
    provider = createProvider(settings.clientId, settings.accessToken);
    return;
  }
  provider = (await serverApiAvailable()) ? new ServerProvider() : createProvider("", "");
}

function consumeOAuthCallback(): void {
  const token = readOAuthHash(window.location.hash, localStorage.getItem(OAUTH_STATE_KEY));
  if (!token) return;
  settings.accessToken = token;
  saveSettings(settings);
  localStorage.removeItem(OAUTH_STATE_KEY);
  window.history.replaceState({}, document.title, window.location.pathname);
  provider = createProvider(settings.clientId, settings.accessToken);
}

const escapeHtml = (value: string): string => value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
const formatViewers = (value: number): string => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K` : String(value);
const formatRuntime = (startedAt: string): string => {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "";
  const total = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};
const isFavorite = (stream: Stream): boolean => settings.favorites.includes(stream.userName);
const providerLabel = (): string => provider.mode === "demo" ? "● Demo mode" : provider.mode === "live" ? "● Live · no login" : "● Twitch connected";
const providerPill = (): string => provider.mode === "demo" ? "Demo data" : provider.mode === "live" ? "Live" : "Live Twitch";

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  let element = document.querySelector<HTMLDivElement>(".toast");
  if (!element) { element = document.createElement("div"); element.className = "toast"; document.body.append(element); }
  element.textContent = message;
  toastTimer = window.setTimeout(() => element?.remove(), 3600);
}

function navButton(key: View, icon: string, label: string): string {
  return `<button class="nav-button ${view === key ? "active" : ""}" data-view="${key}" aria-current="${view === key ? "page" : "false"}"><span class="nav-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`;
}

function tabButton(key: View, icon: string, label: string): string {
  return `<button class="tab ${view === key ? "active" : ""}" data-view="${key}" aria-current="${view === key ? "page" : "false"}"><span class="tab-icon" aria-hidden="true">${icon}</span><span>${label}</span></button>`;
}

function pageHeader(icon: string, title: string, subtitle: string, actions = ""): string {
  return `<header class="page-head"><div class="page-head-icon" aria-hidden="true">${icon}</div><div class="page-head-copy"><h1>${title}</h1><p>${subtitle}</p></div>${actions ? `<div class="page-head-actions">${actions}</div>` : ""}</header>`;
}

const narrowWatch = window.matchMedia("(max-width: 820px)");
const panelPreferences = {
  wide: { navigation: true, chat: true },
  narrow: { navigation: false, chat: false },
};
function syncWatchPanels(): void {
  const shell = document.querySelector<HTMLElement>(".watch-shell");
  if (!shell) return;
  const state = panelPreferences[narrowWatch.matches ? "narrow" : "wide"];
  for (const panel of ["navigation", "chat"] as const) {
    const button = shell.querySelector<HTMLButtonElement>(`[data-panel="${panel}"]`)!;
    const open = state[panel];
    shell.classList.toggle(`collapsed-${panel}`, !open);
    button.textContent = (panel === "navigation") === open ? "‹" : "›";
    button.setAttribute("aria-expanded", String(open));
    button.title = `${open ? "Collapse" : "Expand"} ${panel}`;
    button.setAttribute("aria-label", button.title);
  }
}
narrowWatch.addEventListener("change", syncWatchPanels);

function layout(content: string): string {
  const watching = view === "watch" && !!selectedStream;
  const arrow = (panel: "navigation" | "chat") => watching ? `<button class="panel-arrow" data-panel="${panel}" aria-controls="watch-${panel}"></button>` : "";
  return `<div class="app-shell${watching ? " watch-shell" : ""}">
    <aside id="watch-navigation" class="sidebar" aria-label="Primary navigation">
      <div class="brand"><div class="brand-mark" aria-hidden="true">✦</div><div class="brand-copy"><div class="brand-name">Twilight</div><div class="brand-tagline">Twitch, focused.</div></div></div>
      <div class="nav-group"><div class="nav-label">Discover</div>${navButton("home", "⌂", "Featured")}${navButton("following", "♡", "Following")}${navButton("browse", "◈", "Top games")}</div>
      <div class="nav-group"><div class="nav-label">Library</div>${navButton("archives", "◷", "Past broadcasts")}${navButton("watch", "▶", "Now playing")}${navButton("settings", "⚙", "Settings")}</div>
      <div class="sidebar-footer"><strong>${providerLabel()}</strong><br />No ads injected by this client.<br />${settings.streamProxy || settings.imageProxyEnabled ? "Proxy settings apply on this device." : "Twitch content stays with Twitch."}</div>
    </aside>
    <main class="main"><header class="topbar">${arrow("navigation")}<form class="search" id="search-form" role="search"><span aria-hidden="true">⌕</span><input id="search-input" value="${escapeHtml(query)}" placeholder="Search streams, channels, categories" aria-label="Search Twitch" /><kbd>/</kbd></form><div class="topbar-spacer"></div><span class="pill ${provider.mode === "demo" ? "demo" : ""}">${providerPill()}</span>${statsMarkup}${arrow("chat")}</header><div class="content">${content}</div></main>
    <nav class="tabbar" aria-label="Primary navigation">${tabButton("home", "⌂", "Featured")}${tabButton("following", "♡", "Following")}${tabButton("browse", "◈", "Games")}${tabButton("archives", "◷", "VODs")}${tabButton("watch", "▶", "Playing")}${tabButton("settings", "⚙", "Settings")}</nav>
  </div>`;
}

function streamCard(stream: Stream): string {
  const saved = isFavorite(stream);
  return `<article class="stream-card"><div class="thumb-wrap"><button class="thumb" data-watch="${escapeHtml(stream.id)}" aria-label="Watch ${escapeHtml(stream.displayName)}: ${escapeHtml(stream.title)}"><img loading="lazy" decoding="async" src="${escapeHtml(imageUrl(stream.thumbnailUrl, settings))}" alt="" /><span class="live-badge">LIVE</span><span class="viewer-count">● ${formatViewers(stream.viewerCount)}</span><span class="streamer-overlay">${escapeHtml(stream.displayName)}</span></button><button class="favorite ${saved ? "saved" : ""}" data-favorite="${escapeHtml(stream.userName)}" aria-label="${saved ? "Remove" : "Add"} ${escapeHtml(stream.displayName)} ${saved ? "from" : "to"} favorites">${saved ? "★" : "☆"}</button></div><div class="card-body"><h3 class="card-title">${escapeHtml(stream.title)}</h3><div class="card-meta">${formatViewers(stream.viewerCount)} viewers · ${escapeHtml(stream.gameName)}</div><div class="card-runtime">${formatRuntime(stream.startedAt)}</div></div></article>`;
}

function categoryCard(category: Category): string {
  const viewers = category.viewerCount ? `<span class="card-meta">${formatViewers(category.viewerCount)} viewers</span>` : "";
  return `<button class="category-card" data-category="${escapeHtml(category.name)}" aria-label="Browse ${escapeHtml(category.name)}"><img loading="lazy" decoding="async" src="${escapeHtml(imageUrl(category.boxArtUrl, settings))}" alt="" /><span class="category-body"><strong>${escapeHtml(category.name)}</strong>${viewers}</span></button>`;
}

function messageRow(message: ChatMessage): string {
  return `<div class="message"><span class="message-name" style="color:${escapeHtml(message.color)}">${escapeHtml(message.user)}</span><span class="message-body">${escapeHtml(message.body)}</span></div>`;
}

const loadingBlock = (label: string): string => `<div class="empty"><strong>${escapeHtml(label)}</strong>Fetching the latest from Twitch…</div>`;
const errorBlock = (message: string): string => `<div class="empty error"><strong>Something went wrong</strong>${escapeHtml(message)}</div>`;

function homeView(): string {
  const title = query ? `Search: “${escapeHtml(query)}”` : "Featured streams";
  const subtitle = query ? "Live results from Twitch." : "Live on Twitch right now.";
  const count = !loadError && streams.length ? `<span class="count-pill">${streams.length} live</span>` : "";
  const body = loadError
    ? errorBlock(loadError)
    : streams.length
      ? `<div class="card-grid">${streams.map(streamCard).join("")}</div>`
      : loading
        ? loadingBlock("Loading live streams…")
        : `<div class="empty"><strong>No streams found</strong>Try another search or browse the live directory.</div>`;
  return pageHeader("⌂", title, subtitle, `${count}<button class="ghost" data-refresh>Refresh</button>`) + body;
}

function followingView(): string {
  const count = !loadError && followingStreams.length ? `<span class="count-pill">${followingStreams.length} live</span>` : "";
  const body = loadError
    ? errorBlock(loadError)
    : followingStreams.length
      ? `<div class="card-grid">${followingStreams.map(streamCard).join("")}</div>`
      : loading
        ? loadingBlock("Loading followed channels…")
        : `<div class="empty"><strong>Your following list is empty</strong>Star a channel from Featured or Top games to keep it close.</div>`;
  return pageHeader("♡", "Following", "Favorites stored locally on this device.", `${count}<button class="ghost" data-refresh>Refresh</button>`) + body;
}

function browseView(): string {
  const count = activeCategory
    ? (!loadError && browseStreams.length ? `<span class="count-pill">${browseStreams.length} live</span>` : "")
    : (!loadError && categories.length ? `<span class="count-pill">${categories.length} games</span>` : "");
  const actions = `${count}${activeCategory ? `<button class="ghost" data-clear-category>← All games</button>` : ""}`;
  const header = pageHeader("◈", activeCategory ? escapeHtml(activeCategory) : "Top games", activeCategory ? `Live channels playing ${escapeHtml(activeCategory)} right now.` : "Find a new live room by game or community.", actions);
  if (loadError) return header + errorBlock(loadError);
  if (activeCategory) {
    return header + (browseStreams.length
      ? `<div class="card-grid">${browseStreams.map(streamCard).join("")}</div>`
      : loading
        ? loadingBlock("Loading category streams…")
        : `<div class="empty"><strong>No live channels</strong>Nobody is streaming this category right now.</div>`);
  }
  return header + (categories.length
    ? `<div class="category-grid">${categories.map(categoryCard).join("")}</div>`
    : loading
      ? loadingBlock("Loading categories…")
      : `<div class="empty"><strong>No categories</strong>Try again once the directory responds.</div>`);
}

function watchView(): string {
  if (!selectedStream) return `<div class="empty"><strong>Nothing is playing</strong>Select a live stream to open the player.</div>`;
  const player = provider.mode === "demo"
    ? `<div class="demo-player"><div class="demo-copy"><span class="play">▶</span><strong>Demo player ready</strong><p>Live mode plays current Twitch streams here.</p></div></div>`
    : `<video id="player-video" class="hls-video" playsinline autoplay poster="${escapeHtml(imageUrl(selectedStream.thumbnailUrl, settings))}" title="Twitch stream for ${escapeHtml(selectedStream.displayName)}"></video>`;

  return `<div class="watch-layout"><section class="player-panel"><div class="player-shell" tabindex="0" role="group" aria-label="Stream player"><div class="player">${player}</div>${provider.mode === "demo" ? "" : `<div class="live-overlay"><div class="broadcast-timeline"><input id="broadcast-time" type="range" aria-label="Broadcast timeline" min="0" max="0" value="0" step="1" disabled><output for="broadcast-time" id="broadcast-clock"></output></div><div class="player-controls" role="group" aria-label="Playback controls">
    <div class="transport-group"><button data-player="play" title="Play or pause" disabled>Play</button><button data-player="back" aria-label="Back 5 seconds" title="Back 5 seconds (←)" disabled>−5s</button><button data-player="forward" aria-label="Forward 5 seconds" title="Forward 5 seconds (→)" disabled>+5s</button><button data-player="live" title="Jump to the live edge (L)" disabled>Go live</button><a id="open-current-replay" target="_blank" rel="noopener noreferrer" hidden>Open replay on Twitch</a><span class="playback-status">Connecting…</span></div>
    <div class="sound-group"><button data-player="mute" title="Toggle sound (M)">Mute</button><input class="player-volume" type="range" min="0" max="1" step="0.01" aria-label="Volume"></div>
    <div class="view-group"><select id="quality-select" aria-label="Playback quality"><option value="-1">Auto quality</option></select><button data-player="pip" title="Picture in picture" aria-label="Picture in picture">PiP</button><button data-player="fullscreen" title="Toggle fullscreen (F)">Fullscreen</button></div>
  </div></div>`}</div><div class="stream-info"><div class="stream-info-row"><div><div class="eyebrow">Live channel</div><h2>${escapeHtml(selectedStream.displayName)}</h2></div><button class="favorite ${isFavorite(selectedStream) ? "saved" : ""}" data-favorite="${escapeHtml(selectedStream.userName)}" aria-label="Favorite ${escapeHtml(selectedStream.displayName)}">${isFavorite(selectedStream) ? "★" : "☆"}</button></div><p>${escapeHtml(selectedStream.title)}</p><div class="tag-row">${selectedStream.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div><div class="hero-actions">${provider.mode === "demo" ? "" : `<button class="ghost" data-archives>Past broadcasts</button>`}<button class="ghost" data-open-twitch="${escapeHtml(selectedStream.userName)}">Open on Twitch</button></div></div></section>${chatPanel()}</div>`;
}

function chatPanel(): string {
  const statusLabel = provider.mode === "demo" ? "Demo" : chatStatus === "connected" ? "Live" : chatStatus === "connecting" ? "Connecting…" : chatStatus === "reconnecting" ? "Reconnecting…" : "Offline";
  const body = chat.length
    ? chat.slice(-80).map(messageRow).join("")
    : `<div class="empty"><strong>${provider.mode === "demo" ? "Demo chat" : "Connecting to chat"}</strong>${provider.mode === "demo" ? "Sample messages from the demo provider." : "Live chat connects over Twitch IRC when a channel opens."}</div>`;
  return `<aside id="watch-chat" class="chat-panel" aria-label="Stream chat"><div class="chat-header"><h3>Live chat</h3><span class="muted small chat-status">${statusLabel}</span></div><div class="chat-messages">${body}</div><div class="chat-footer">Chat messages are rendered as text. Links and HTML are not executed.</div></aside>`;
}

function proxySettings(): string {
  const current = settings.streamProxy;
  const custom = current !== "" && !streamPresets.includes(current);
  return `<section class="settings-card" aria-label="Proxies">
    <div class="setting"><div><label for="stream-proxy">Stream proxy</label><p>${escapeHtml(current || "Disabled")}</p></div>
      <select id="stream-proxy"><option value="">Disabled</option>${streamPresets.map(url => `<option value="${url}" ${url === current ? "selected" : ""}>${url}</option>`).join("")}<option value="custom" ${custom ? "selected" : ""}>Custom proxy</option></select></div>
    <form class="setting" id="custom-proxy-form" ${custom ? "" : "hidden"}><label for="custom-proxy">Custom proxy URL</label>
      <input type="text" id="custom-proxy" value="${escapeHtml(current)}" placeholder="https://example.com"><button class="ghost">Save</button></form>
    <div class="setting"><label for="image-proxy-enabled">Image proxy</label>
      <label class="switch"><input id="image-proxy-enabled" type="checkbox" ${settings.imageProxyEnabled ? "checked" : ""}><span class="slider"></span></label></div>
    <form class="setting" id="image-proxy-form"><label for="image-proxy-url">Image proxy URL</label>
      <input type="text" id="image-proxy-url" value="${escapeHtml(settings.imageProxyUrl)}"><button class="ghost">Save</button></form>
  </section>`;
}

function settingsView(): string {
  return pageHeader("⚙", "Settings", "Keep the experience light, local, and in your control.") + `<div class="settings-layout"><div class="notice">${provider.mode === "demo" ? "Demo mode is active. Add a Twitch Client ID and connect below to load live streams." : "Live Twitch mode is active. Your credentials stay in this browser profile and are never sent anywhere except Twitch API requests."}</div><section class="settings-card"><div class="setting"><div><label for="client-id">Twitch Client ID</label><p>Create an application in the Twitch developer console and paste its public client ID.</p></div><input id="client-id" type="text" value="${escapeHtml(settings.clientId)}" placeholder="Client ID" autocomplete="off" /></div><div class="setting"><div><label for="access-token">Access token</label><p>Optional if you use Connect Twitch. It is never written to logs.</p></div><input id="access-token" type="password" value="${escapeHtml(settings.accessToken)}" placeholder="Optional token" autocomplete="off" /></div><div class="setting"><div><label>Authentication</label><p>Use Twitch's browser consent screen. The callback is handled locally and the returned token is kept in this browser profile.</p></div><button class="primary" id="connect-twitch">Connect Twitch</button></div><div class="setting"><div><label for="player-type">Stream player type</label><p>Applies the next time you open a live channel with the stream proxy disabled.</p></div><select id="player-type"><option value="site" ${settings.playerType === "site" ? "selected" : ""}>site</option><option value="embed" ${settings.playerType === "embed" ? "selected" : ""}>embed</option></select></div><div class="setting"><div><label for="quality">Default quality</label><p>Auto adapts to your connection; lower quality can reduce buffering.</p></div><select id="default-quality"><option value="auto" ${settings.quality === "auto" ? "selected" : ""}>Auto</option><option value="1080p" ${settings.quality === "1080p" ? "selected" : ""}>1080p</option><option value="720p" ${settings.quality === "720p" ? "selected" : ""}>720p</option><option value="480p" ${settings.quality === "480p" ? "selected" : ""}>480p</option><option value="360p" ${settings.quality === "360p" ? "selected" : ""}>360p</option></select></div><div class="setting"><div><label for="low-latency">Prefer low latency</label><p>Stay closer to the live edge when the network can sustain it.</p></div><label class="switch"><input id="low-latency" type="checkbox" ${settings.lowLatency ? "checked" : ""} /><span class="slider"></span></label></div><div class="setting"><div><label for="reduce-motion">Reduce motion</label><p>Use a calmer interface with fewer hover and transition effects.</p></div><label class="switch"><input id="reduce-motion" type="checkbox" ${settings.reduceMotion ? "checked" : ""} /><span class="slider"></span></label></div><div class="setting"><div><label>Session</label><p>Credentials can be cleared from this browser profile at any time.</p></div><button class="danger" id="clear-settings">Clear local settings</button></div></section>${proxySettings()}</div>`;
}

function stopPlayer(): void {
  stats.stop();
  unbindPlayerControls?.();
  unbindPlayerControls = undefined;
  hls?.destroy();
  hls = null;
  playerRetries = 0;
}

function populateQualityLevels(): void {
  const select = document.querySelector<HTMLSelectElement>("#quality-select");
  if (!select || !hls) return;
  const levels = hls.levels;
  select.innerHTML = `<option value="-1">Auto quality</option>` + levels.map((level, index) => {
    const label = level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps`;
    return `<option value="${index}" data-height="${level.height}">${label}</option>`;
  }).join("");
  if (settings.quality !== "auto") {
    const height = Number(settings.quality.replace("p", ""));
    const index = levels.findIndex((level) => level.height === height);
    if (index >= 0) {
      hls.currentLevel = index;
      select.value = String(index);
    }
  }
}

async function attemptPlay(video: HTMLVideoElement): Promise<void> {
  try {
    await video.play();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    video.muted = true;
    try {
      await video.play();
      showToast("Started muted — use the speaker button to unmute.");
    } catch {
      showToast("Press play to start the stream.");
    }
  }
}

function mountPlayer(stream: Stream): void {
  const video = document.querySelector<HTMLVideoElement>("#player-video");
  const HlsCtor = window.Hls;
  stopPlayer();
  if (!video || !HlsCtor || !HlsCtor.isSupported()) {
    showToast("This browser cannot play Twitch HLS streams.");
    return;
  }
  stats.track({ id: stream.id, channel: stream.displayName, title: stream.title, kind: "Live" }, video);
  const instance = new HlsCtor({
    lowLatencyMode: !replayPosition && settings.lowLatency,
    startPosition: replayPosition?.seconds ?? -1,
    liveSyncDurationCount: settings.lowLatency ? 2 : 4,
    enableWorker: true,
    backBufferLength: 30,
    capLevelToPlayerSize: true,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    abrEwmaDefaultEstimate: 1_000_000,
    ...(!replayPosition && settings.lowLatency ? { liveMaxLatencyDurationCount: 8, maxLiveSyncPlaybackRate: 1.15 } : {}),
  });
  hls = instance;
  unbindPlayerControls = bindPlayerControls(video, instance, showToast, replayPosition ? () => {
    replayPosition = null;
    mountPlayer(stream);
  } : undefined);
  instance.attachMedia(video);
  instance.on(HlsCtor.Events.MANIFEST_PARSED, () => {
    playerRetries = 0;
    populateQualityLevels();
    void attemptPlay(video);
  });
  instance.on(HlsCtor.Events.ERROR, (_event, data) => {
    if (!data?.fatal) return;
    if (replayPosition && data.details === "manifestLoadError") {
      showToast("Twitch could not provide this archive for local playback. Open it on Twitch or choose Go live.");
      return;
    }
    if (stream.isLive && settings.streamProxy && data.details === "manifestLoadError") {
      showToast("The stream proxy could not load this channel.");
      return;
    }
    if (data.type === "networkError" && playerRetries < 3) {
      playerRetries += 1;
      showToast("Stream interrupted — reconnecting…");
      instance.startLoad();
      return;
    }
    if (data.type === "mediaError") {
      instance.recoverMediaError();
      return;
    }
    showToast("Could not play this stream. Try another channel.");
  });
  instance.loadSource(replayPosition ? `/api/dvr/master?video=${encodeURIComponent(replayPosition.id)}`
    : playbackUrl(stream.userName, stream.isLive, settings.streamProxy, settings.playerType));
  const fallback = document.querySelector<HTMLAnchorElement>("#open-current-replay");
  if (fallback) {
    fallback.hidden = !replayPosition;
    if (replayPosition) fallback.href = replayUrls(replayPosition, location.hostname).page;
  }
}

function render(): void {
  // Directory requests can finish while an archive is playing. Keep its iframe mounted.
  if (view === "archives" && document.getElementById("archives")) return;
  disposeTimeline?.();
  disposeTimeline = undefined;
  stopPlayer();
  if (view !== "watch") replayPosition = null;
  const content = view === "home" ? homeView() : view === "following" ? followingView() : view === "browse" ? browseView() : view === "watch" ? watchView() : view === "archives" ? pageHeader("◷", "Past broadcasts", "Browse a channel’s recorded streams.") + '<section id="archives"></section>' : settingsView();
  app!.innerHTML = layout(content);
  bindEvents();
  if (view === "archives") mountArchives(document.querySelector("#archives")!, provider, archiveLogin, url => imageUrl(url, settings), stats);
  if (view === "watch" && selectedStream && provider.mode !== "demo") mountPlayer(selectedStream);
}

const findStream = (id: string): Stream | undefined => streams.find((stream) => stream.id === id) ?? browseStreams.find((stream) => stream.id === id) ?? followingStreams.find((stream) => stream.id === id);

async function loadStreams(): Promise<void> {
  loading = true;
  loadError = null;
  render();
  try {
    streams = query ? await provider.searchStreams(query) : await provider.getFeaturedStreams();
  } catch (error) {
    streams = [];
    loadError = error instanceof Error ? error.message : "Twitch took too long to respond. Try again.";
  } finally {
    loading = false;
    render();
    if (loadError) showToast(loadError);
  }
}

async function loadFollowing(): Promise<void> {
  loading = true;
  loadError = null;
  render();
  try {
    followingStreams = settings.favorites.length ? await provider.getFollowedStreams(settings.favorites) : [];
  } catch (error) {
    followingStreams = [];
    loadError = error instanceof Error ? error.message : "Could not load followed channels.";
  } finally {
    loading = false;
    render();
    if (loadError) showToast(loadError);
  }
}

async function loadBrowse(): Promise<void> {
  loading = true;
  loadError = null;
  render();
  try {
    categories = await provider.getCategories();
  } catch (error) {
    categories = [];
    loadError = error instanceof Error ? error.message : "Could not load categories.";
  } finally {
    loading = false;
    render();
    if (loadError) showToast(loadError);
  }
}

async function loadCategory(name: string): Promise<void> {
  activeCategory = name;
  browseStreams = [];
  loading = true;
  loadError = null;
  render();
  try {
    browseStreams = await provider.getStreamsByCategory(name);
  } catch (error) {
    browseStreams = [];
    loadError = error instanceof Error ? error.message : "Could not load this category.";
  } finally {
    loading = false;
    render();
    if (loadError) showToast(loadError);
  }
}

function stopChat(): void {
  chatClient?.disconnect();
  chatClient = null;
  pendingChat = [];
  if (chatFrame !== undefined) {
    cancelAnimationFrame(chatFrame);
    chatFrame = undefined;
  }
}

function startLiveChat(stream: Stream): void {
  stopChat();
  chatStatus = "connecting";
  chatClient = new TwitchChatClient(
    (message) => {
      chat.push(message);
      if (chat.length > 200) chat = chat.slice(-200);
      appendChatMessage(message);
    },
    (status) => {
      chatStatus = status;
      updateChatStatus();
    },
  );
  chatClient.connect(stream.userName);
}

function appendChatMessage(message: ChatMessage): void {
  pendingChat.push(message);
  if (chatFrame !== undefined) return;
  chatFrame = requestAnimationFrame(() => {
    chatFrame = undefined;
    flushChat();
  });
}

function chatRow(message: ChatMessage): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "message";
  const name = document.createElement("span");
  name.className = "message-name";
  name.style.color = message.color;
  name.textContent = message.user;
  const body = document.createElement("span");
  body.className = "message-body";
  body.textContent = message.body;
  row.append(name, body);
  return row;
}

function flushChat(): void {
  const batch = pendingChat;
  pendingChat = [];
  if (!batch.length) return;
  const container = document.querySelector<HTMLDivElement>(".chat-messages");
  if (!container) return;
  const pinnedToBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 48;
  container.querySelector(".empty")?.remove();
  const fragment = document.createDocumentFragment();
  for (const message of batch) fragment.append(chatRow(message));
  container.append(fragment);
  while (container.childElementCount > 80) container.firstElementChild?.remove();
  if (pinnedToBottom) container.scrollTop = container.scrollHeight;
}

function updateChatStatus(): void {
  const element = document.querySelector<HTMLElement>(".chat-status");
  if (!element) return;
  element.textContent = provider.mode === "demo" ? "Demo" : chatStatus === "connected" ? "Live" : chatStatus === "connecting" ? "Connecting…" : chatStatus === "reconnecting" ? "Reconnecting…" : "Offline";
}

async function openStream(id: string): Promise<void> {
  const stream = findStream(id);
  if (!stream) return;
  stopChat();
  stopPlayer();
  replayPosition = null;
  selectedStream = stream;
  view = "watch";
  chat = [];
  chatStatus = provider.mode === "demo" ? "connected" : "connecting";
  if (provider.mode === "demo") {
    try { chat = await provider.getChat(stream.userName); } catch { chat = []; }
  }
  render();
  if (provider.mode !== "demo") startLiveChat(stream);
}

function syncFavoriteButtons(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-favorite]").forEach((button) => {
    const saved = settings.favorites.includes(button.dataset.favorite ?? "");
    button.classList.toggle("saved", saved);
    button.textContent = saved ? "★" : "☆";
    button.setAttribute("aria-label", `${saved ? "Remove" : "Add"} ${button.dataset.favorite ?? "channel"} ${saved ? "from" : "to"} favorites`);
  });
}

function toggleFavorite(userName: string): void {
  const wasFavorite = settings.favorites.includes(userName);
  settings.favorites = wasFavorite ? settings.favorites.filter((item) => item !== userName) : [...settings.favorites, userName];
  saveSettings(settings);
  if (view === "following") void loadFollowing();
  else syncFavoriteButtons();
  showToast(wasFavorite ? "Removed from favorites" : "Added to favorites");
}

function bindProxySettings(): void {
  const select = document.querySelector<HTMLSelectElement>("#stream-proxy");
  const customForm = document.querySelector<HTMLFormElement>("#custom-proxy-form");
  if (!select || !customForm) return;
  const persist = () => { saveSettings(settings); render(); };
  select.addEventListener("change", () => {
    if (select.value === "custom") {
      customForm.hidden = false;
      customForm.querySelector("input")?.focus();
      return;
    }
    settings.streamProxy = select.value;
    persist();
  });
  customForm.addEventListener("submit", event => {
    event.preventDefault();
    const value = customForm.querySelector("input")!.value.trim();
    if (!isStreamProxy(value)) return showToast("Enter a public HTTPS stream proxy URL without credentials, a custom port, query, or fragment.");
    settings.streamProxy = value;
    persist();
  });
  const toggle = document.querySelector<HTMLInputElement>("#image-proxy-enabled")!;
  toggle.addEventListener("change", () => { settings.imageProxyEnabled = toggle.checked; persist(); });
  document.querySelector("#image-proxy-form")!.addEventListener("submit", event => {
    event.preventDefault();
    const value = document.querySelector<HTMLInputElement>("#image-proxy-url")!.value.trim();
    if (!isImageProxy(value)) return showToast("Enter a public HTTPS image prefix with a path or query, such as https://example.com/?url=.");
    settings.imageProxyUrl = value;
    persist();
  });
}

function bindEvents(): void {
  stats.bind();
  syncWatchPanels();
  document.querySelectorAll<HTMLButtonElement>("[data-panel]").forEach(button => {
    button.onclick = () => {
      const panel = button.dataset.panel === "navigation" ? "navigation" : "chat";
      const state = panelPreferences[narrowWatch.matches ? "narrow" : "wide"];
      state[panel] = !state[panel];
      syncWatchPanels();
    };
  });
  bindProxySettings();
  document.querySelector("[data-archives]")?.addEventListener("click", () => {
    archiveLogin = selectedStream?.userName ?? "";
    stopChat();
    view = "archives";
    render();
  });
  if (selectedStream && view === "watch") {
    const stream = selectedStream;
    if (provider.mode !== "demo") disposeTimeline = bindBroadcastTimeline(stream, () => replayPosition && {
      id: replayPosition.id, duration: hls?.latestLevelDetails?.edge ?? 0,
    }, position => {
      const video = document.querySelector<HTMLVideoElement>("#player-video");
      if (video && replayPosition?.id === position.id && video.readyState) {
        video.currentTime = position.seconds;
        void attemptPlay(video);
      } else {
        replayPosition = position;
        mountPlayer(stream);
      }
    });
  }
  const playerType = document.querySelector<HTMLSelectElement>("#player-type");
  playerType?.addEventListener("change", () => {
    settings.playerType = playerType.value === "embed" ? "embed" : "site";
    saveSettings(settings);
  });
  document.querySelectorAll<HTMLElement>("[data-view]").forEach((element) => element.addEventListener("click", () => {
    const next = element.dataset.view as View;
    if (next === "watch" && view === "watch") return;
    if (view === "watch" && next !== "watch") { stopChat(); stopPlayer(); }
    view = next;
    if (next === "following") { void loadFollowing(); return; }
    if (next === "browse") { activeCategory = null; void loadBrowse(); return; }
    if (next === "watch" && selectedStream && provider.mode !== "demo" && !chatClient) { render(); startLiveChat(selectedStream); return; }
    render();
  }));
  document.querySelectorAll<HTMLElement>("[data-watch]").forEach((element) => element.addEventListener("click", () => void openStream(element.dataset.watch ?? "")));
  document.querySelectorAll<HTMLElement>("[data-category]").forEach((element) => element.addEventListener("click", () => void loadCategory(element.dataset.category ?? "")));
  document.querySelectorAll<HTMLElement>("[data-clear-category]").forEach((element) => element.addEventListener("click", () => { activeCategory = null; void loadBrowse(); }));
  document.querySelectorAll<HTMLElement>("[data-refresh]").forEach((element) => element.addEventListener("click", () => {
    if (view === "home") void loadStreams();
    else if (view === "following") void loadFollowing();
    else if (view === "browse") { if (activeCategory) void loadCategory(activeCategory); else void loadBrowse(); }
  }));
  document.querySelectorAll<HTMLElement>("[data-favorite]").forEach((element) => element.addEventListener("click", (event) => { event.stopPropagation(); toggleFavorite(element.dataset.favorite ?? ""); }));
  document.querySelectorAll<HTMLElement>("[data-open-twitch]").forEach((element) => element.addEventListener("click", () => { const url = safeExternalTwitchUrl(twitchChannelUrl(element.dataset.openTwitch ?? "")); if (url) window.open(url, "_blank", "noopener,noreferrer"); else showToast("That Twitch link could not be validated"); }));
  bindChannelSearch(document.querySelector<HTMLInputElement>("#search-input")!, provider, url => imageUrl(url, settings), login => {
    archiveLogin = login;
    stopChat();
    view = "archives";
    document.querySelector("#archives")?.remove();
    render();
  });
  document.querySelector<HTMLFormElement>("#search-form")?.addEventListener("submit", (event) => { event.preventDefault(); query = document.querySelector<HTMLInputElement>("#search-input")?.value.trim() ?? ""; activeCategory = null; view = "home"; void loadStreams(); });
  document.querySelector<HTMLInputElement>("#search-input")?.addEventListener("keydown", (event) => { if (event.key === "/") event.stopPropagation(); });
  document.querySelector<HTMLSelectElement>("#quality-select")?.addEventListener("change", (event) => {
    const select = event.target as HTMLSelectElement;
    if (hls) hls.currentLevel = Number(select.value);
    const height = select.selectedOptions[0]?.dataset.height;
    const allowed = new Set(["160", "360", "480", "720", "1080"]);
    settings.quality = height && allowed.has(height) ? `${height}p` as AppSettings["quality"] : "auto";
    saveSettings(settings);
    showToast(height ? `Quality set to ${height}p` : "Quality set to auto");
  });
  document.querySelector<HTMLButtonElement>("#connect-twitch")?.addEventListener("click", () => { const clientId = document.querySelector<HTMLInputElement>("#client-id")?.value.trim() ?? ""; if (!clientId) { showToast("Add your Twitch Client ID first"); return; } settings.clientId = clientId; saveSettings(settings); const state = createOAuthState(); localStorage.setItem(OAUTH_STATE_KEY, state); window.location.assign(twitchAuthorizeUrl(clientId, redirectUri, state)); });
  const saveCredential = (): void => {
    stopChat();
    stopPlayer();
    settings.clientId = document.querySelector<HTMLInputElement>("#client-id")?.value.trim() ?? "";
    settings.accessToken = document.querySelector<HTMLInputElement>("#access-token")?.value.trim() ?? "";
    settings.quality = (document.querySelector<HTMLSelectElement>("#default-quality")?.value ?? "auto") as AppSettings["quality"];
    settings.lowLatency = document.querySelector<HTMLInputElement>("#low-latency")?.checked ?? true;
    settings.reduceMotion = document.querySelector<HTMLInputElement>("#reduce-motion")?.checked ?? false;
    saveSettings(settings);
    document.documentElement.style.setProperty("--transition", settings.reduceMotion ? "0s" : ".1s");
    void resolveProvider().then(() => {
      showToast(provider.mode === "demo" ? "Saved — demo mode active" : provider.mode === "live" ? "Saved — live mode active (no login)" : "Saved — Twitch account mode enabled");
      render();
    });
  };
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("#client-id, #access-token, #default-quality, #low-latency, #reduce-motion").forEach((element) => element.addEventListener("change", saveCredential));
  document.querySelector<HTMLButtonElement>("#clear-settings")?.addEventListener("click", () => {
    stopChat();
    stopPlayer();
    settings = defaultSettings();
    saveSettings(settings);
    selectedStream = undefined;
    followingStreams = [];
    activeCategory = null;
    view = "home";
    void resolveProvider().then(() => { showToast("Local settings cleared"); void loadStreams(); });
  });
}

consumeOAuthCallback();
document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement?.tagName !== "INPUT") { event.preventDefault(); document.querySelector<HTMLInputElement>("#search-input")?.focus(); }
  if (event.key === "Escape" && view === "watch" && !document.fullscreenElement) { stopChat(); stopPlayer(); view = "home"; render(); }
});

void (async () => {
  await resolveProvider();
  await loadStreams();
})();
