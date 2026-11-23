import type { AppSettings } from "../types.js";

import { defaultImageProxy } from "./proxy.js";
import { isImageProxy, isStreamProxy } from "./proxy-validation.js";

export const SETTINGS_KEY = "twilight.settings.v1";

export const defaultSettings = (): AppSettings => ({
  version: 1,
  playerType: "site",
  streamProxy: "",
  imageProxyEnabled: false,
  imageProxyUrl: defaultImageProxy,
  favorites: [],
  quality: "auto",
  lowLatency: true,
  reduceMotion: false,
  clientId: "",
  accessToken: "",
});

export function loadSettings(storage: Pick<Storage, "getItem"> = localStorage): AppSettings {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultSettings();
    const value = parsed as Partial<AppSettings>;
    return {
      ...defaultSettings(),
      ...value,
      version: 1,
      playerType: value.playerType === "embed" ? "embed" : "site",
      streamProxy: typeof value.streamProxy === "string" && isStreamProxy(value.streamProxy) ? value.streamProxy : "",
      imageProxyEnabled: value.imageProxyEnabled === true,
      imageProxyUrl: typeof value.imageProxyUrl === "string" && isImageProxy(value.imageProxyUrl) ? value.imageProxyUrl : defaultImageProxy,
      favorites: Array.isArray(value.favorites) ? value.favorites.filter((item): item is string => typeof item === "string") : [],
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: AppSettings, storage: Pick<Storage, "setItem"> = localStorage): void {
  if ((settings.streamProxy !== "" && !isStreamProxy(settings.streamProxy)) || !isImageProxy(settings.imageProxyUrl)) throw new Error("Invalid proxy URL");
  storage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, version: 1 }));
}
