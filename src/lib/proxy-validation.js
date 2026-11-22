// Shared by the browser settings and the Node relay before DNS resolution.
export function isPublicHttpsUrl(value) {
  if (typeof value !== "string" || !/^https:\/\/[^/?#@]+(?:[/?]|$)/i.test(value) || /[\s\\#]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname;
    return !url.username && !url.password && !url.port
      && host.includes(".") && !/^[\d.]+$/.test(host)
      && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
      && !/\.(?:localhost|local|internal|lan|home|arpa|onion)$/i.test(host);
  } catch {
    return false;
  }
}

export function isStreamProxy(value) {
  return isPublicHttpsUrl(value) && !value.includes("?");
}

// Literal concatenation must keep the image request on the selected origin.
export function isImageProxy(value) {
  if (!isPublicHttpsUrl(value)) return false;
  const target = value + "https://static-cdn.jtvnw.net/image";
  return isPublicHttpsUrl(target) && new URL(target).origin === new URL(value).origin;
}
