import type { AppSettings } from "../types.js";
import { isImageProxy } from "./proxy-validation.js";

export const defaultImageProxy = "https://external-content.duckduckgo.com/iu/?u=";
export const streamPresets = [
  "https://lb-eu.cdn-perfprod.com",
  "https://lb-eu2.cdn-perfprod.com",
  "https://lb-eu3.cdn-perfprod.com",
  "https://lb-eu4.cdn-perfprod.com",
  "https://lb-eu5.cdn-perfprod.com",
  "https://lb-na.cdn-perfprod.com",
  "https://lb-as.cdn-perfprod.com",
  "https://lb-sa.cdn-perfprod.com",
  "https://eu.luminous.dev",
  "https://eu2.luminous.dev",
  "https://as.luminous.dev",
];

export function playbackUrl(channel: string, live: boolean, streamProxy: string): string {
  const params = new URLSearchParams({ channel });
  if (live && streamProxy) params.set("proxy", streamProxy);
  return `/api/playback?${params}`;
}

export function imageUrl(original: string, settings: Pick<AppSettings, "imageProxyEnabled" | "imageProxyUrl">): string {
  if (!settings.imageProxyEnabled) return original;
  if (!isImageProxy(settings.imageProxyUrl)) throw new Error("Invalid image proxy URL");
  return `/api/image?${new URLSearchParams({ url: original, proxy: settings.imageProxyUrl })}`;
}
