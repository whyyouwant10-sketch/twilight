type PlaybackWindow = Pick<HTMLVideoElement, "buffered" | "seekable">;

function availableRanges(video: PlaybackWindow, playlistStart: number): [number, number][] {
  const available: [number, number][] = [];
  const buffered = video.buffered;
  for (const ranges of [buffered, video.seekable]) {
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges === buffered ? ranges.start(i) : Math.max(playlistStart, ranges.start(i));
      const end = ranges.end(i);
      if (start < end) available.push([start, end]);
    }
  }
  return available;
}

export function resumePosition(position: number, video: PlaybackWindow, playlistStart: number): number | null {
  let next = Infinity;
  for (const [start, end] of availableRanges(video, playlistStart)) {
    if (position >= start && position < end) return position;
    if (start > position) next = Math.min(next, start);
  }
  return Number.isFinite(next) ? next : null;
}

export function skipPosition(current: number, delta: -5 | 5, ranges: [number, number][], live: number | null): number | null {
  const target = delta > 0 && live !== null ? Math.min(current + delta, live) : current + delta;
  let best = current;
  for (const [start, end] of ranges) {
    // The range end is exclusive. Seek just inside it if the requested time is in a gap.
    const point = Math.max(start, Math.min(target, end - 0.01));
    if (delta > 0 && point <= target && point > best) best = point;
    if (delta < 0 && point >= target && point < best) best = point;
  }
  return best === current ? null : best;
}

export function livePosition(sync: number | null, ranges: TimeRanges): number | null {
  if (sync !== null && Number.isFinite(sync)) return sync;
  if (!ranges.length) return null;
  const last = ranges.length - 1;
  return Math.max(ranges.start(last), ranges.end(last) - 1);
}

export function bindPlayerControls(video: HTMLVideoElement, hls: Hls, notify: (message: string) => void, returnLive?: () => void): () => void {
  const shell = video.closest<HTMLElement>(".player-shell")!;
  const button = (action: string) => shell.querySelector<HTMLButtonElement>(`[data-player="${action}"]`)!;
  const play = button("play"), mute = button("mute"), live = button("live"), pip = button("pip");
  const back = button("back"), forward = button("forward");
  const fullscreen = button("fullscreen");
  const status = shell.querySelector<HTMLElement>(".playback-status")!;
  const volume = shell.querySelector<HTMLInputElement>(".player-volume")!;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const liveConfig = {
    liveMaxLatencyDurationCount: hls.config.liveMaxLatencyDurationCount,
    maxLiveSyncPlaybackRate: hls.config.maxLiveSyncPlaybackRate,
    maxBufferLength: hls.config.maxBufferLength,
    maxMaxBufferLength: hls.config.maxMaxBufferLength,
  };
  let pausedAt: number | null = null;
  let followingLive = true;
  const edge = () => livePosition(hls.liveSyncPosition, video.seekable);

  function syncControls(): void {
    const target = edge();
    const lag = Math.max(0, (target ?? video.currentTime) - (pausedAt ?? video.currentTime));
    const atLive = target !== null && lag <= 2 && !video.paused;
    play.disabled = video.readyState === 0;
    play.textContent = video.paused ? "Play" : "Pause";
    play.dataset.paused = String(video.paused);
    live.disabled = !returnLive && target === null;
    const ranges = availableRanges(video, hls.latestLevelDetails?.fragmentStart ?? 0);
    const current = pausedAt ?? video.currentTime;
    back.disabled = !video.readyState || skipPosition(current, -5, ranges, target) === null;
    forward.disabled = !video.readyState || skipPosition(current, 5, ranges, target) === null;
    status.textContent = !video.readyState ? "Connecting…" : video.paused ? "Paused" : atLive ? "Live" : lag > 2 ? `${Math.round(lag)}s behind live` : "Playing";
    status.classList.toggle("at-live", atLive);
    mute.textContent = video.muted || video.volume === 0 ? "Unmute" : "Mute";
    volume.value = String(video.muted ? 0 : video.volume);
    fullscreen.textContent = document.fullscreenElement === shell ? "Exit fullscreen" : "Fullscreen";
  }

  function allowDelayedPlayback(): void {
    followingLive = false;
    // Let a paused viewer use the local forward buffer beyond Twitch's sliding window.
    Object.assign(hls.config, { liveMaxLatencyDurationCount: Infinity, maxLiveSyncPlaybackRate: 1, maxBufferLength: 120, maxMaxBufferLength: 120 });
    video.playbackRate = 1;
  }

  function rememberPause(): void {
    if (pausedAt === null) pausedAt = video.currentTime;
    allowDelayedPlayback();
    syncControls();
  }

  async function startPlayback(): Promise<void> {
    try { await video.play(); }
    catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) notify("Playback could not start. Press Play to retry."); }
  }

  function restorePause(): void {
    if (pausedAt === null || followingLive) return;
    const position = resumePosition(pausedAt, video, hls.latestLevelDetails?.fragmentStart ?? 0);
    if (position !== null) {
      if (position !== pausedAt) notify("Your paused position expired. Resuming at the earliest available point.");
      if (Math.abs(position - video.currentTime) > 0.05) video.currentTime = position;
    }
    pausedAt = null;
  }

  function togglePlay(): void {
    if (!video.readyState) return;
    if (!video.paused) { rememberPause(); video.pause(); }
    else { restorePause(); void startPlayback(); }
  }

  function goLive(): void {
    const target = edge();
    if (target === null) return;
    pausedAt = null;
    followingLive = true;
    Object.assign(hls.config, liveConfig);
    if (video.currentTime < target) video.currentTime = target;
    void startPlayback();
    syncControls();
  }

  function skip(delta: -5 | 5): void {
    const ranges = availableRanges(video, hls.latestLevelDetails?.fragmentStart ?? 0);
    const target = skipPosition(pausedAt ?? video.currentTime, delta, ranges, edge());
    if (target === null) return;
    allowDelayedPlayback();
    if (video.paused) pausedAt = target;
    video.currentTime = target;
    syncControls();
  }

  back.addEventListener("click", () => skip(-5), options);
  forward.addEventListener("click", () => skip(5), options);
  play.addEventListener("click", togglePlay, options);
  let idleTimer: number;
  function revealControls(): void {
    clearTimeout(idleTimer);
    shell.classList.remove("player-idle");
    if (!video.paused) idleTimer = window.setTimeout(() => shell.classList.add("player-idle"), 2500);
  }
  for (const event of ["pointermove", "pointerdown", "focusin", "keydown"]) {
    shell.addEventListener(event, revealControls, options);
  }
  video.addEventListener("playing", revealControls, options);
  video.addEventListener("pause", revealControls, options);
  document.addEventListener("fullscreenchange", revealControls, options);
  live.addEventListener("click", returnLive ?? goLive, options);
  mute.addEventListener("click", () => {
    if (!video.volume) { video.volume = 0.5; video.muted = false; }
    else video.muted = !video.muted;
  }, options);
  volume.addEventListener("input", () => { video.volume = Number(volume.value); video.muted = video.volume === 0; }, options);
  pip.hidden = !document.pictureInPictureEnabled;
  pip.addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch { notify("Picture-in-picture is unavailable."); }
  }, options);
  fullscreen.hidden = !document.fullscreenEnabled;
  fullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === shell) await document.exitFullscreen();
      else await shell.requestFullscreen();
    } catch { notify("Fullscreen is unavailable."); }
  }, options);
  shell.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || (event.target as HTMLElement).closest("input,select")) return;
    const key = event.key.toLowerCase();
    if (key === " " && (event.target as HTMLElement).closest("button")) return;
    const action = ({ arrowleft: back, arrowright: forward, m: mute, l: live, f: fullscreen } as Record<string, HTMLButtonElement>)[key];
    if (action && !action.hidden) { event.preventDefault(); action.click(); }
  }, options);
  video.addEventListener("pause", () => { if (!video.ended && video.paused && video.readyState) rememberPause(); }, options);
  video.addEventListener("seeking", () => { if (video.paused && returnLive) pausedAt = video.currentTime; }, options);
  video.addEventListener("play", restorePause, options);
  for (const name of ["play", "pause", "playing", "loadedmetadata", "progress", "timeupdate", "seeked", "volumechange"]) video.addEventListener(name, syncControls, options);
  document.addEventListener("fullscreenchange", syncControls, options);
  hls.on(Hls.Events.LEVEL_UPDATED, syncControls);
  syncControls();
  return () => { clearTimeout(idleTimer); listeners.abort(); };
}
