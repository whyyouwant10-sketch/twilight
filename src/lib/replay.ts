import type { Stream } from "../types.js";

export interface ReplayPosition { id: string; seconds: number }

export function replayUrls(replay: ReplayPosition, parent: string): { player: string; page: string } {
  if (!/^\d+$/.test(replay.id) || !Number.isSafeInteger(replay.seconds) || replay.seconds < 0) throw new Error("Invalid replay position");
  const time = `${Math.floor(replay.seconds / 3600)}h${Math.floor(replay.seconds / 60) % 60}m${replay.seconds % 60}s`;
  const params = new URLSearchParams({ video: "v" + replay.id, parent, time, autoplay: "true" });
  return { player: `https://player.twitch.tv/?${params}`, page: `https://www.twitch.tv/videos/${replay.id}?t=${time}` };
}

export function timestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return [Math.floor(minutes / 60), minutes % 60, seconds % 60].map((n, i) => i ? String(n).padStart(2, "0") : String(n)).join(":");
}

interface ReplayInfo { id: string; duration: number }

export function bindBroadcastTimeline(stream: Stream, archive: () => ReplayInfo | null, seekArchive: (position: ReplayPosition) => void): () => void {
  const range = document.querySelector<HTMLInputElement>("#broadcast-time")!;
  const output = document.querySelector<HTMLOutputElement>("#broadcast-clock")!;
  const video = document.querySelector<HTMLVideoElement>("#player-video")!;
  const lifetime = new AbortController();
  const options = { signal: lifetime.signal };
  let published: ReplayInfo | null = null;
  let loading = false;
  let dragging = false;
  let nativeStart = 0;
  let nativeEnd = 0;

  function label(): void {
    output.value = `${timestamp(range.valueAsNumber)} / ${timestamp(Number(range.max))}`;
    range.setAttribute("aria-valuetext", output.value);
  }
  function update(): void {
    if (dragging) return;
    const active = archive();
    const ranges = video.seekable;
    nativeStart = ranges.length ? ranges.start(0) : 0;
    nativeEnd = ranges.length ? ranges.end(ranges.length - 1) : 0;
    const duration = active?.duration || published?.duration || (nativeEnd - nativeStart);
    const end = Math.max(0, Math.floor(duration) - 1);
    range.max = String(end);
    range.disabled = !end;
    const time = active ? video.currentTime : end - Math.max(0, nativeEnd - video.currentTime);
    range.value = String(Math.max(0, Math.min(end, Math.floor(time))));
    label();
  }
  async function refresh(): Promise<void> {
    if (loading || archive()) return;
    loading = true;
    try {
      const query = new URLSearchParams({ channel: stream.userName, stream: stream.id });
      const response = await fetch(`/api/twitch/replay?${query}`, { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) return;
      const info = await response.json();
      if (!lifetime.signal.aborted && info && /^\d+$/.test(info.id) && Number.isSafeInteger(info.duration) && info.duration > 0) {
        published = info;
        update();
      }
    } catch { /* Keep the current seekable window while discovery retries. */ }
    finally { loading = false; }
  }
  range.addEventListener("pointerdown", () => { dragging = true; }, options);
  const release = () => { dragging = false; };
  window.addEventListener("pointerup", release, options);
  window.addEventListener("pointercancel", release, options);
  range.addEventListener("blur", release, options);
  range.addEventListener("input", label, options);
  range.addEventListener("change", () => {
    dragging = false;
    const seconds = range.valueAsNumber;
    if (seconds === Number(range.max)) {
      document.querySelector<HTMLButtonElement>('[data-player="live"]')?.click();
      return;
    }
    const info = archive() ?? published;
    if (info) seekArchive({ id: info.id, seconds });
    else if (nativeEnd > nativeStart) video.currentTime = Math.min(nativeEnd, nativeStart + seconds);
  }, options);
  video.addEventListener("timeupdate", update, options);
  const tick = window.setInterval(update, 1000);
  const poll = window.setInterval(() => void refresh(), 15000);
  update();
  void refresh();
  return () => { clearInterval(tick); clearInterval(poll); lifetime.abort(); };
}
