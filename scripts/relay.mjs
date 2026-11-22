import dns from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { isImageProxy, isPublicHttpsUrl } from "../src/lib/proxy-validation.js";

export class InvalidRelayUrl extends Error {}

const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["2620:4f:8000::", 48]]) {
  blocked.addSubnet(ip, bits, "ipv6");
}

export function publicAddress(address) {
  if (isIP(address) === 4) return !blocked.check(address, "ipv4");
  return isIP(address) === 6 && /^[23]/.test(address) && !blocked.check(address, "ipv6");
}

async function publicAddresses(hostname) {
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || !addresses.every(item => publicAddress(item.address))) {
    throw new InvalidRelayUrl("Blocked relay address");
  }
  return addresses;
}

function checkedLookup(hostname, options, callback) {
  publicAddresses(hostname).then(addresses => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }, callback);
}

// Resolve once per connection and hand only the checked addresses to TLS.
export async function relayGet(input, allowed, headers = {}, signal = AbortSignal.timeout(15_000)) {
  let target = input;
  for (let redirects = 0; ; redirects++) {
    if (!isPublicHttpsUrl(target) || !allowed(target)) throw new InvalidRelayUrl("Blocked relay URL");
    const upstream = await new Promise((resolve, reject) => {
      https.get(target, { agent: false, headers: { "Accept-Encoding": "identity", ...headers }, lookup: checkedLookup, signal }, resolve).on("error", reject);
    });
    const status = upstream.statusCode;
    if (![301, 302, 303, 307, 308].includes(status)) return { upstream, url: target, status };
    upstream.destroy();
    if (redirects === 3 || !upstream.headers.location) throw new Error("Invalid relay redirect");
    target = new URL(upstream.headers.location, target).href;
  }
}

export function buildImageTarget(original, prefix) {
  if (!isPublicHttpsUrl(original) || !["static-cdn.jtvnw.net", "images.unsplash.com"].includes(new URL(original).hostname)) {
    throw new InvalidRelayUrl("Blocked image URL");
  }
  if (!isImageProxy(prefix)) throw new InvalidRelayUrl("Invalid image proxy URL");
  return prefix + original;
}

export async function checkImageSource(original, signal) {
  // The remote image service resolves the source independently.
  await new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    publicAddresses(new URL(original).hostname).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function playlistText(upstream, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of upstream) {
    size += chunk.length;
    if (size > limit) throw new Error("Playlist too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
