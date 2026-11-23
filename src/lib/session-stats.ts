export interface Viewing {
  id: string;
  channel: string;
  title: string;
  kind: "Live" | "Replay";
}

interface HistoryRow extends Viewing { ms: number }
interface Session { bytes: number; activeMs: number; rows: HistoryRow[] }
const storageKey = "twilight.sessionStats.v1";
const empty = (): Session => ({ bytes: 0, activeMs: 0, rows: [] });

export function measuredBytes(entry: Pick<PerformanceResourceTiming, "name" | "transferSize">, origin: string): number {
  const url = new URL(entry.name);
  // App bundles are read from the local server. Count relayed responses and observable remote downloads.
  if (url.origin === origin && !url.pathname.startsWith("/api/")) return 0;
  return /^https?:$/.test(url.protocol) && entry.transferSize > 0 ? entry.transferSize : 0;
}

export function dataSize(bytes: number): string {
  if (bytes < 1000) return bytes + " B";
  const unit = bytes < 1e6 ? 1 : bytes < 1e9 ? 2 : 3;
  return (bytes / 1000 ** unit).toFixed(1) + " " + ["B", "KB", "MB", "GB"][unit];
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v, i) => i ? String(v).padStart(2, "0") : String(v)).join(":");
}

export function startSessionStats() {
  let session = empty();
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (saved && Number.isFinite(saved.bytes) && Number.isFinite(saved.activeMs) && Array.isArray(saved.rows)) session = saved;
  } catch { /* Storage may be unavailable. */ }
  let row: HistoryRow | undefined;
  let running = false;
  let visible = !document.hidden;
  let last = performance.now();
  let listeners: AbortController | undefined;

  function tick() {
    const now = performance.now();
    const delta = now - last;
    last = now;
    if (visible) session.activeMs += delta;
    if (row && running && (row.kind === "Live" || visible)) row.ms += delta;
  }

  function stop() {
    tick();
    listeners?.abort();
    row = undefined;
    running = false;
  }

  function track(item: Viewing, video?: HTMLVideoElement) {
    stop();
    row = session.rows.find(r => r.id === item.id && r.kind === item.kind);
    if (!row) { row = { ...item, ms: 0 }; session.rows.push(row); }
    running = item.kind === "Replay";
    if (!video) return;
    listeners = new AbortController();
    for (const event of ["playing", "pause", "waiting", "seeking", "ended", "error", "emptied"]) {
      video.addEventListener(event, () => { tick(); running = event === "playing"; }, { signal: listeners.signal });
    }
  }

  function persist() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(session)); } catch { /* Current session remains in memory. */ }
  }

  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) session.bytes += measuredBytes(entry as PerformanceResourceTiming, location.origin);
  });
  observer.observe({ type: "resource", buffered: true });
  document.addEventListener("visibilitychange", () => { tick(); visible = !document.hidden; persist(); });
  window.addEventListener("pagehide", () => {
    tick();
    for (const entry of observer.takeRecords()) session.bytes += measuredBytes(entry as PerformanceResourceTiming, location.origin);
    persist();
  });
  function paint() {
    tick();
    const counter = document.querySelector("#session-data");
    if (counter) counter.textContent = "↓ " + dataSize(session.bytes);
    const dialog = document.querySelector<HTMLDialogElement>("#session-stats");
    if (!dialog?.open) return;
    const values = [duration(session.activeMs), dataSize(session.bytes),
      duration(session.rows.reduce((ms, r) => ms + (r.kind === "Live" ? r.ms : 0), 0)),
      new Set(session.rows.map(r => r.channel.toLowerCase())).size.toString()];
    dialog.querySelectorAll("[data-stat]").forEach((el, i) => { el.textContent = values[i] ?? ""; });
    const body = dialog.querySelector("tbody")!;
    body.replaceChildren();
    for (const r of session.rows.slice().reverse()) {
      const tr = body.insertRow();
      for (const value of [r.channel, r.title, r.kind, duration(r.ms)]) tr.insertCell().textContent = value;
    }
    dialog.querySelector<HTMLElement>("[data-no-history]")!.hidden = session.rows.length > 0;
  }
  window.setInterval(paint, 1000);
  function bind() {
    const dialog = document.querySelector<HTMLDialogElement>("#session-stats")!;
    document.querySelector("#open-stats")!.addEventListener("click", () => { dialog.showModal(); paint(); });
    paint();
  }
  return { track, stop, bind };
}

export const statsMarkup = `<span id="session-data" title="Estimated session download">↓ 0 B</span><button class="ghost" id="open-stats" aria-haspopup="dialog">Stats</button>
<dialog id="session-stats" aria-labelledby="stats-heading"><form method="dialog"><h2 id="stats-heading">Session stats</h2><button class="ghost">Close</button></form>
<dl><dt>Time in Twilight</dt><dd data-stat></dd><dt>Estimated download</dt><dd data-stat></dd><dt>Live watch time</dt><dd data-stat></dd><dt>Channels opened</dt><dd data-stat></dd></dl>
<table><caption>Viewing history</caption><thead><tr><th>Channel</th><th>Broadcast</th><th>Type</th><th>Time</th></tr></thead><tbody></tbody></table><p data-no-history>No broadcasts opened yet.</p>
<p>Live time counts playback. Replay time counts how long the embedded player is open in the visible tab. Downloads include measurable requests from this tab. Twitch’s embedded replay traffic and chat are excluded.</p></dialog>`;
