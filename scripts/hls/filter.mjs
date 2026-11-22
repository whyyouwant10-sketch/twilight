import { createHash, randomUUID } from "node:crypto";
import { masterTracks, parseMedia } from "./manifest.mjs";
import { classify } from "./classifier.mjs";
import { planCut, transform } from "./timeline.mjs";

const idleMs = 10 * 60_000;
const maxManifest = 128 * 1024;

function identities(media) {
  let disc = media.discBase;
  return new Map(media.segments.map(s => {
    if (s.discontinuity) disc++;
    const identity = JSON.stringify([s.uri, s.duration, disc, s.key, s.map]);
    return [s.sn, createHash("sha256").update(identity).digest("base64url")];
  }));
}

function verifyWindow(state, media, ids) {
  if (media.segments.at(-1).sn < (state.cuts.at(-1)?.resume ?? -1) || media.first < state.first || media.segments.at(-1).sn < state.published) throw new Error("stale-window");
  for (const [sn, id] of ids) {
    if (state.expected?.has(sn) && state.expected.get(sn) !== id) throw new Error("changed-segment");
  }
}

export function filterConfig(env) {
  const threshold = Number(env.HLS_FILTER_CONFIDENCE || 0.9);
  return {
    enabled: env.HLS_FILTER_ENABLED === "true",
    threshold: threshold >= 0.8 && threshold <= 1 ? threshold : 0.9,
    diagnostics: ["summary", "debug"].includes(env.HLS_FILTER_LOG) ? env.HLS_FILTER_LOG : "off",
    debugSequence: /^\d+$/.test(env.HLS_FILTER_DEBUG_SEQUENCE ?? "") ? Number(env.HLS_FILTER_DEBUG_SEQUENCE) : null,
    fallback: env.HLS_FILTER_FALLBACK === "retry" ? "retry" : "last-good",
  };
}

export class IntervalFilter {
  sessions = new Map();

  constructor(config, log = record => console.info(JSON.stringify(record))) {
    this.config = config;
    this.log = log;
  }

  report(event, fields = {}) {
    if (this.config.diagnostics !== "off") this.log({ event, ...fields });
  }

  open(text, base, proxy) {
    if (!this.config.enabled || Buffer.byteLength(text) > maxManifest) return null;
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.used + idleMs < now) this.sessions.delete(id);
    let urls;
    try { urls = masterTracks(text, base); } catch { this.report("invalid-master"); return null; }
    if (!urls.length || urls.length > 12 || this.sessions.size >= 32) return null;
    const tracks = new Map(urls.map(url => [url, { cuts: [], published: -1, first: -1, last: null }]));
    const session = {
      id: randomUUID(), tracks, proxy: proxy ? new URL(proxy).origin : null, used: now,
      independent: /^#EXT-X-INDEPENDENT-SEGMENTS\r?$/m.test(text),
      queue: Promise.resolve(), pending: 0, nextProbe: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  resolve(id, target, proxy) {
    const session = this.sessions.get(id);
    if (!session || session.used + idleMs < Date.now() || !session.tracks.has(target) || proxy !== session.proxy) return null;
    session.used = Date.now();
    return session;
  }

  previous(session, url) {
    const last = session.tracks.get(url).last;
    return this.config.fallback === "last-good" && last && Date.now() < last.expires ? last : null;
  }

  // Serialize the publication decision, including peer reads. No client can observe half a cut.
  update(session, url, text, loadPeer, signal, base = url) {
    if (session.pending >= 16) throw new Error("HLS session busy. Retry the playlist.");
    session.pending++;
    const job = session.queue.then(() => this.process(session, url, text, loadPeer, signal, base));
    session.queue = job.catch(() => {});
    return job.finally(() => { session.pending--; });
  }

  async process(session, url, text, loadPeer, signal, base) {
    const track = session.tracks.get(url);
    let media, ids;
    try {
      if (Buffer.byteLength(text) > maxManifest) throw new Error("large-window");
      media = parseMedia(text);
      if (track.cuts.length && track.last && base !== track.last.base) throw new Error("changed-base");
      ids = identities(media);
      verifyWindow(track, media, ids);
      if (track.last && track.last.target !== media.target) throw new Error("changed-target-duration");
      if (track.cuts.length && !media.tail.length) {
        const removed = media.segments.filter(s => track.cuts.some(c => c.first <= s.sn && s.sn < c.resume));
        const duration = media.segments.reduce((sum, s) => sum + s.duration, 0);
        if (removed.length && duration - removed.reduce((sum, s) => sum + s.duration, 0) < media.target * 3000) {
          throw new Error("short-window");
        }
      }
    } catch (error) {
      // Report only local reason codes, never parser input or URL-bearing exceptions.
      this.report("unsafe-window", { reason: /^[a-z-]{1,32}$/.test(error.message) ? error.message : "invalid-window" });
      const previous = this.previous(session, url);
      if (previous && previous.base === base) return previous.text;
      if (!track.cuts.length) {
        track.needsBaseline = true;
        track.last = null;
        return text;
      }
      throw new Error("HLS timeline changed. Reopen the stream.");
    }
    const candidates = this.candidates(session, track, media);
    if (candidates.length && Date.now() >= session.nextProbe) {
      await this.coordinate(session, url, candidates, ids, loadPeer, signal, media.target);
    }
    const output = transform(media, track.cuts, text);
    if (this.config.diagnostics === "debug" && this.config.debugSequence != null) {
      const sn = this.config.debugSequence;
      if (sn >= media.first && sn <= media.segments.at(-1).sn) {
        const match = classify(media).find(c => sn >= media.segments[c.start].sn && sn < media.segments[c.end].sn);
        this.report("segment-decision", { sn, evidence: match?.evidence ?? [], confidence: match?.confidence ?? 0,
          omitted: track.cuts.some(c => c.first <= sn && sn < c.resume) });
      }
    }
    track.published = media.segments.at(-1).sn;
    track.first = media.first;
    track.expected = ids;
    track.needsBaseline = false;
    track.last = { text: output, base, target: media.target, expires: Date.now() + media.target * 2000 };
    return output;
  }

  async coordinate(session, url, candidates, ids, loadPeer, signal, targetDuration) {
    session.nextProbe = Date.now() + targetDuration * 500;
    const probe = new AbortController();
    const cancel = () => probe.abort();
    const deadline = setTimeout(cancel, 1000);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const snapshots = await Promise.all([...session.tracks].map(async ([peer, state]) => {
        if (peer === url) return { state, plans: candidates, ids };
        const body = await loadPeer(peer, probe.signal);
        if (Buffer.byteLength(body) > maxManifest) throw new Error();
        const peerMedia = parseMedia(body);
        const peerIds = identities(peerMedia);
        verifyWindow(state, peerMedia, peerIds);
        return { state, plans: this.candidates(session, state, peerMedia), ids: peerIds };
      }));
      for (const candidate of candidates) {
        const consensus = snapshots.map(({ plans }) => plans.find(p => p === candidate ||
          (candidate.from !== null && p.from === candidate.from && p.to === candidate.to && p.duration === candidate.duration
            && p.discBefore === candidate.discBefore && p.to - p.from === p.duration)));
        if (consensus.every((plan, i) => plan && plan.spare >= (snapshots[i].spent ?? 0)
            && plan.first > (snapshots[i].state.cuts.at(-1)?.resume ?? -1) && snapshots[i].state.cuts.length < 256)) {
          snapshots.forEach(({ state, ids }, i) => {
            snapshots[i].spent = (snapshots[i].spent ?? 0) + consensus[i].duration;
            state.cuts.push(consensus[i]);
            state.expected = ids;
          });
          this.report("omitted-interval", { first: candidate.first, count: candidate.resume - candidate.first, durationMs: candidate.duration, confidence: candidate.confidence });
        } else { this.report("kept-interval", { first: candidate.first, reason: "rendition-or-buffer-disagreement" }); }
      }
    } catch {
      this.report("peer-unavailable");
    } finally {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", cancel);
      cancel();
    }
  }

  candidates(session, state, media) {
    if (state.needsBaseline) return [];
    const result = [];
    const total = media.segments.reduce((sum, s) => sum + s.duration, 0);
    const alreadyCut = media.segments.reduce((sum, s) => sum + (state.cuts.some(c => c.first <= s.sn && s.sn < c.resume) ? s.duration : 0), 0);
    const intervals = classify(media);
    for (const interval of intervals) {
      const plan = planCut(media, interval);
      plan.discBefore += state.cuts.reduce((sum, c) => sum + (c.resume < plan.first ? c.discDelta : 0), 0);
      plan.rangeIds = intervals.filter(i => i.rangeId && i.start >= interval.start && i.end <= interval.end).map(i => i.rangeId);
      const eligible = plan.first > state.published && interval.confidence >= this.config.threshold
        && state.cuts.length < 256 && (!state.cuts.length || plan.first > state.cuts.at(-1).resume)
        && (session.independent || media.independent || media.segments[interval.end].discontinuity)
        && total - alreadyCut - plan.duration >= media.target * 3000;
      if (this.config.diagnostics === "debug") this.report("classification", {
        first: plan.first, count: plan.resume - plan.first, confidence: interval.confidence, evidence: interval.evidence, eligible,
      });
      if (eligible) result.push({ ...plan, confidence: interval.confidence, spare: total - alreadyCut - plan.duration - media.target * 3000 });
    }
    return result.sort((a, b) => a.first - b.first || b.confidence - a.confidence);
  }
}
