import type { StreamProvider } from "../types.js";

/** The form keeps its normal submit action. Suggestions can also be reached with Tab. */
export function bindChannelSearch(input: HTMLInputElement, provider: StreamProvider, imageSource: (url: string) => string, select: (login: string) => void) {
  const form = input.form!;
  const results = document.createElement("div");
  results.className = "channel-suggestions";
  results.hidden = true;
  form.append(results);
  let timer: number | undefined;
  let generation = 0;

  function close(): void {
    ++generation;
    window.clearTimeout(timer);
    results.replaceChildren();
    results.hidden = true;
  }

  async function search(submitted = false): Promise<void> {
    close();
    const term = input.value.trim().replace(/^@/, "");
    if (!term || !provider.searchChannels) return;
    const request = generation;
    try {
      const channels = await provider.searchChannels(term);
      if (request !== generation || !input.isConnected) return;
      const exact = channels.find(channel => channel.login.toLowerCase() === term.toLowerCase());
      if (submitted && (exact || !channels.length) && /^[a-z0-9_]{1,25}$/i.test(term)) {
        select(exact?.login ?? term);
        return;
      }
      for (const channel of channels) {
        const option = document.createElement("button");
        option.type = "button";
        option.textContent = channel.displayName.toLowerCase() === channel.login.toLowerCase()
          ? channel.displayName : `${channel.displayName} (@${channel.login})`;
        if (channel.isLive) {
          option.setAttribute("aria-label", `${option.textContent}, live now`);
          option.title = "Live now";
          option.classList.add("live-match");
        }
        if (channel.avatarUrl) {
          const avatar = document.createElement("img");
          avatar.alt = "";
          avatar.width = avatar.height = 28;
          avatar.loading = "lazy";
          avatar.decoding = "async";
          avatar.onerror = () => avatar.remove();
          avatar.src = imageSource(channel.avatarUrl);
          option.prepend(avatar);
        }
        option.onclick = () => { close(); select(channel.login); };
        results.append(option);
      }
      if (submitted && !channels.length) results.textContent = "No matching channels.";
      results.hidden = !results.childNodes.length;
    } catch {
      if (submitted && request === generation && input.isConnected) select(term);
    }
  }

  input.addEventListener("input", () => {
    close();
    if (input.value.trim()) timer = window.setTimeout(() => void search(), 250);
  });
  form.addEventListener("keydown", event => {
    if (event.key === "Escape") { close(); input.focus(); }
    if (event.key === "ArrowDown" && event.target === input && !results.hidden) {
      event.preventDefault();
      results.querySelector("button")?.focus();
    }
  });
  form.addEventListener("focusout", event => {
    if (event.relatedTarget && !form.contains(event.relatedTarget as Node)) close();
  });
  return { search, close };
}
