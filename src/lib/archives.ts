import type { startSessionStats } from "./session-stats.js";
import { bindChannelSearch } from "./channel-search.js";
import type { ArchiveVideo, StreamProvider } from "../types.js";
import { replayUrls, timestamp } from "./replay.js";

export function mutedRanges(video: ArchiveVideo): { start: number; end: number }[] {
  return (video.muted ?? []).flatMap(segment => {
    if (!segment || !Number.isSafeInteger(segment.offset) || !Number.isSafeInteger(segment.duration) || segment.duration <= 0) return [];
    const start = Math.max(0, segment.offset);
    const end = Math.min(video.duration, segment.offset + segment.duration);
    return end > start ? [{ start, end }] : [];
  }).sort((a, b) => a.start - b.start);
}

function archivePlayer(root: HTMLElement, video: ArchiveVideo, back: () => void): void {
  root.innerHTML = `<button class="ghost" data-back>← Past broadcasts</button><h2></h2>
    <div class="player replay-player"><iframe title="Past broadcast replay" allow="autoplay; fullscreen" allowfullscreen></iframe></div>
    <form class="archive-seek"><label for="archive-time">Seek to</label> <output for="archive-time"></output>
    <div class="archive-track"><div class="mute-track" aria-hidden="true"></div><input id="archive-time" type="range" min="0" step="1" value="0"></div>
    <button class="primary">Play from here</button> <a target="_blank" rel="noopener noreferrer">Open replay on Twitch</a></form>
    <details><summary>Muted sections</summary><ul></ul></details>`;
  root.querySelector("h2")!.textContent = video.title;
  const slider = root.querySelector("input")!;
  slider.max = String(video.duration - 1);
  const urls = () => replayUrls({ id: video.id, seconds: slider.valueAsNumber }, location.hostname);
  const seek = () => { root.querySelector("iframe")!.src = urls().player; };
  function label(): void {
    root.querySelector("output")!.value = `${timestamp(slider.valueAsNumber)} / ${timestamp(video.duration)}`;
    slider.setAttribute("aria-valuetext", timestamp(slider.valueAsNumber));
    root.querySelector("a")!.href = urls().page;
  }
  const ranges = mutedRanges(video);
  for (const { start, end } of ranges) {
    const mark = document.createElement("span");
    mark.style.left = `${100 * start / video.duration}%`;
    mark.style.width = `${100 * (end - start) / video.duration}%`;
    root.querySelector(".mute-track")!.append(mark);
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "ghost";
    button.textContent = `${timestamp(start)} – ${timestamp(end)}`;
    button.onclick = () => { slider.value = String(start); label(); seek(); };
    item.append(button);
    root.querySelector("ul")!.append(item);
  }
  root.querySelector("details")!.hidden = !ranges.length;
  root.querySelector("summary")!.textContent = `Muted sections (${ranges.length})`;
  root.querySelector<HTMLButtonElement>("[data-back]")!.onclick = back;
  root.querySelector("form")!.onsubmit = event => { event.preventDefault(); seek(); };
  slider.oninput = label;
  label();
  seek();
}

export function mountArchives(root: HTMLElement, provider: StreamProvider, initialLogin: string, imageSource: (url: string) => string, stats: Pick<ReturnType<typeof startSessionStats>, "track" | "stop">): void {
  root.innerHTML = `<form class="archive-search"><label for="archive-channel">Search channels</label>
    <input id="archive-channel" placeholder="Channel name or part of it" required maxlength="100" autocomplete="off">
    <button class="primary">Find broadcasts</button></form><p role="status"></p><div class="archive-list"></div>
    <button class="ghost" data-more hidden>Load more</button><section class="archive-player" hidden></section>`;
  const form = root.querySelector("form")!;
  const input = form.querySelector("input")!;
  const status = root.querySelector("p")!, list = root.querySelector<HTMLDivElement>(".archive-list")!;
  const more = root.querySelector<HTMLButtonElement>("[data-more]")!, player = root.querySelector("section")!;
  let login = "", cursor: string | null = null, serial = 0;
  const displayed = new Set<string>();
  function togglePlayer(show: boolean): void {
    form.hidden = status.hidden = list.hidden = show;
    more.hidden = show || !cursor;
    player.hidden = !show;
    if (!show) player.replaceChildren();
  }
  async function load(append: boolean): Promise<void> {
    const request = ++serial;
    if (!append) {
      login = input.value.trim().replace(/^@/, "").toLowerCase();
      cursor = null;
      displayed.clear();
      list.replaceChildren();
      togglePlayer(false);
    }
    if (!/^[a-z0-9_]{1,25}$/.test(login)) { status.textContent = "Enter a Twitch channel username."; return; }
    if (!provider.getArchives) { status.textContent = "Start the local server or connect a Twitch account to browse past broadcasts."; return; }
    status.textContent = "Loading past broadcasts…";
    more.disabled = true;
    try {
      const page = await provider.getArchives(login, append && cursor ? cursor : undefined);
      if (request !== serial || !root.isConnected) return;
      if (!page) { status.textContent = "Channel not found."; return; }
      for (const video of page.videos) {
        if (displayed.has(video.id)) continue;
        displayed.add(video.id);
        const button = document.createElement("button");
        button.className = "archive-card";
        if (video.thumbnailUrl) {
          const thumbnail = document.createElement("img");
          thumbnail.alt = "";
          thumbnail.loading = "lazy";
          thumbnail.decoding = "async";
          thumbnail.onerror = () => thumbnail.remove();
          thumbnail.src = imageSource(video.thumbnailUrl);
          button.append(thumbnail);
        }
        const title = document.createElement("strong");
        title.textContent = video.title || "Past broadcast";
        const meta = document.createElement("span");
        meta.textContent = `${new Date(video.publishedAt).toLocaleDateString()} · ${timestamp(video.duration)}`;
        button.append(title, meta);
        button.onclick = () => {
          togglePlayer(true);
          stats.track({ id: video.id, channel: page.channel, title: video.title, kind: "Replay" });
          archivePlayer(player, video, () => { stats.stop(); togglePlayer(false); button.focus(); });
          player.querySelector("button")?.focus();
        };
        list.append(button);
      }
      cursor = page.cursor !== cursor ? page.cursor : null;
      more.hidden = !cursor || !player.hidden;
      status.textContent = displayed.size ? `${page.channel} · ${displayed.size} past broadcasts` : `No published past broadcasts for ${page.channel}.`;
    } catch {
      if (request === serial) status.textContent = append && provider.mode === "live"
        ? "Twitch could not load more archives anonymously. Connect your Twitch account in Settings to browse older broadcasts."
        : "Could not load past broadcasts. Try again.";
    } finally { if (request === serial) more.disabled = false; }
  }
  const suggestions = bindChannelSearch(input, provider, imageSource, channel => {
    input.value = channel;
    void load(false);
  });
  form.onsubmit = event => {
    event.preventDefault();
    if (provider.searchChannels) void suggestions.search(true);
    else void load(false);
  };
  more.onclick = () => void load(true);
  if (initialLogin) { input.value = initialLogin; void load(false); }
}
