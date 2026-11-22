# Twilight

Twilight is a focused, open-source Twitch client for Linux and Windows, inspired by the useful parts of [Twire](https://github.com/twireapp/Twire): a clean stream browser, a low-distraction player surface, local favorites, chat, and configurable playback preferences.

## Current status

The project is a desktop-ready web client. Run it through the local server and it opens in **live mode**: current Twitch streams are discovered through a small server-side GraphQL adapter and played as HLS through a same-origin media proxy. No Twitch account is required for live discovery or playback. Add Twitch Helix credentials in Settings to use your account for discovery and followed channels. If the local API is unreachable (for example a static preview), the app falls back to **demo mode** with deterministic fixtures.

Twilight does not promise guaranteed ad removal or lag-free playback. It avoids injecting additional ads, prefers a low-latency player configuration, and leaves Twitch content delivery to Twitch.

## Run locally

Requirements: Node.js 18+.

```bash
npm install
npm run check
npm run dev
```

Open <http://127.0.0.1:4173>.

On Linux, macOS, or Windows, `npm run open` builds the app, starts the local server, and opens it in your default browser.

The only runtime dependency is `hls.js` for HLS playback; it is copied into `dist/` during the build. Twitch discovery, playback tokens, and the media proxy are served by `scripts/server.mjs`, so the app must run via `npm run dev`/`npm start` for live mode.

## Live playback (no login required)

`npm run dev` starts a local server that provides:

- `GET /api/twitch/streams` — current live streams (optionally `?game=`, `?logins=`, `?q=`).
- `GET /api/twitch/categories` — top categories.
- `GET /api/playback?channel=<login>` — Twitch playback token + rewritten HLS master playlist.
- `GET /api/hls?url=<url>` — same-origin proxy for Twitch playlist and segment hosts (allowlisted).

The browser plays the stream with `hls.js`. The proxy is required because Twitch's HLS endpoints do not send CORS headers; it also validates every media URL against a Twitch host allowlist.

Login-free discovery uses Twitch's public web GraphQL endpoint. It is unofficial and can change without notice; account mode uses the official Helix API.

## Optional live HLS interval filtering

Start the local server with `HLS_FILTER_ENABLED=true npm run dev` and reopen the channel. The setting applies to direct Twitch and configured stream-proxy playback. Environment variables are read at server startup. Export them in the shell or set them in the process launcher.

| Variable | Default | Behavior |
| --- | --- | --- |
| `HLS_FILTER_ENABLED` | `false` | `true` enables per-playback timeline state. Disabled playback uses the original URI rewrite. |
| `HLS_FILTER_CONFIDENCE` | `0.90` | Minimum policy score, from 0.80 to 1.00. Invalid values use the default. |
| `HLS_FILTER_LOG` | `off` | `summary` records cuts, failed peer checks and unsafe windows. `debug` also records candidate sequence numbers, scores, evidence and eligibility. Logs exclude URLs, raw tags, headers and credentials. |
| `HLS_FILTER_DEBUG_SEQUENCE` | unset | With debug logging, report whether this upstream media sequence was kept or omitted, including its classification evidence. |
| `HLS_FILTER_FALLBACK` | `last-good` | After a bad refresh, reuse the last published manifest for at most two target durations. `retry` skips reuse. After a committed cut, an unrecoverable timeline change returns an error and reopening the channel starts a fresh timeline. |

The relay recognizes a completed cue-out/cue-in pair or a segment-aligned, timed advertisement date range, including Twitch's `twitch-stitched-ad` class. Matching durations, stitched titles, splice boundaries and marked paths can strengthen a decision. Shared CDN hosts and ordinary-looking segments are expected. An unmarked or ambiguous interval stays playable.

Before committing a cut, the relay checks every advertised media playlist through the existing validated fetch path. Peer checks run concurrently with a one-second deadline. Audio and video can use different sequence numbers or segment lengths. Their cut boundaries and removed duration must agree in program time. A single multiplexed rendition can use a closed cue without a wall clock. The resume point must be independently decodable or have an upstream discontinuity, and the published window must retain three target durations. Retained segments keep their original media bytes and wall-clock times. The relay inserts a splice discontinuity, maintains downstream sequence numbers, restores initialization and key state, and makes implicit AES-128 IVs explicit when numbering changes. Positive and negative preferred start offsets are mapped onto the retained durations. The live window and discontinuity rules follow [RFC 8216](https://www.rfc-editor.org/rfc/rfc8216#section-6.2.2).

**Live-edge behavior.** A completed interval can be removed on join or when a refresh first reveals the whole interval and resumed content together. Once any rendition has published the interval, the relay keeps it. When upstream is still transmitting an insertion, future program content is unavailable. The relay continues serving that insertion so the player can keep filling its buffer.

**Compatibility and limits.** Filtering starts from a multivariant master with up to 12 distinct rendition URLs. Media-only entry points, trick-play masters, partial/delta or speculative playlists, byte ranges, gap tags, encrypted initialization sections, non-identity encryption, and unrecognized timeline extensions use conservative fallback. Peer failure or disagreement keeps the candidate. Segment download failures retain the existing relay error behavior. Each server holds up to 32 sessions, with a ten-minute idle expiry and at most 256 cuts per rendition. At capacity, new streams use ordinary forwarding. Reopen a stream after a server restart or session expiry.

## Twitch account mode

1. Create a Twitch application in the Twitch developer console.
2. Copy its client ID and an access token with only the scopes you need.
3. Add `http://127.0.0.1:4173/auth/callback` as an allowed OAuth redirect URL in the Twitch application settings.
4. Open **Settings** in Twilight, enter the client ID, and choose **Connect Twitch**.
5. Twilight will use the Helix API for account discovery and the same HLS player for playback.

The MVP stores these values in the browser's local storage. Do not use a shared machine for credentials. A future desktop wrapper should move token storage to the OS credential store (Windows Credential Manager / DPAPI or Linux Secret Service).

## Features

- Live discovery of current Twitch streams without an account.
- HLS playback of live streams with quality selection, low-latency mode, mute, fullscreen, and picture-in-picture.
- Search by stream title, creator, or category.
- Category browsing: top categories with live viewer counts, drill-down, and per-category live streams.
- Following view that loads live channels from your locally stored favorites.
- Favorites stored locally on the current device.
- Read-only live Twitch chat over anonymous IRC with automatic reconnect and bounded history.
- Safe text-only chat rendering with bounded history.
- Browser-based Twitch OAuth with state validation and local callback handling.
- Validated “Open on Twitch” links.
- Responsive dark UI with keyboard search shortcut (`/`) and `Escape` to leave the player.
- Twitch Helix adapter for account mode and a public GraphQL adapter for login-free mode.
- Loading and error states for discovery, categories, and following.
- Same-origin media proxy with an SSRF host allowlist and playlist rewriting.
- Deterministic demo fallback when the local API is unavailable.
- URL validation utilities and tests for unsafe external links.

## Testing

```bash
npm run typecheck
npm test
```

The tests cover settings round-trips and malformed data, safe Twitch URL handling, demo search/chat behavior, category and followed-channel filtering, IRC parsing and safe chat mapping, OAuth state validation, media-proxy URL allowlisting, HLS playlist rewriting, GraphQL stream mapping, and deterministic fixtures. The UI can be smoke-tested by running `npm run dev`, opening the local URL, selecting a live stream, and using the quality, mute, fullscreen, and picture-in-picture controls.

## Privacy and safety

- No telemetry, analytics, or crash reporting is included.
- No credentials are checked into the repository.
- Chat messages are escaped and displayed as text; HTML and links are not executed.
- External Twitch links must use HTTPS and an exact Twitch host allowlist.
- Account-mode Twitch API calls are made directly from the browser to Twitch's API.
- Login-free discovery and playback tokens are fetched by the local server from Twitch GraphQL.
- HLS playlists and segments are proxied through the local server; the proxy only accepts HTTPS URLs on Twitch media host suffixes.
- Live chat connects anonymously to Twitch IRC (`wss://irc-ws.chat.twitch.tv`) and is read-only.

## License

Twilight is released under the GNU General Public License v3.0. See `LICENSE`.

Twire is an independent Android project licensed under GPL-3.0. Twilight is a new desktop implementation and does not bundle Twire source or assets.
