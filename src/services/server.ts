import type { Category, ChatMessage, Stream, StreamProvider } from "../types.js";

async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Local Twitch service failed (${response.status})`);
  return response.json() as Promise<T>;
}

export class ServerProvider implements StreamProvider {
  readonly mode = "live" as const;

  async getFeaturedStreams(): Promise<Stream[]> {
    return api<Stream[]>("/api/twitch/streams?first=30");
  }

  async searchStreams(query: string): Promise<Stream[]> {
    const needle = query.trim();
    if (!needle) return this.getFeaturedStreams();
    return api<Stream[]>(`/api/twitch/streams?q=${encodeURIComponent(needle)}`);
  }

  async getStreamsByCategory(category: string): Promise<Stream[]> {
    return api<Stream[]>(`/api/twitch/streams?game=${encodeURIComponent(category)}`);
  }

  async getFollowedStreams(logins: string[]): Promise<Stream[]> {
    const clean = logins.map((login) => login.trim()).filter(Boolean);
    if (!clean.length) return [];
    return api<Stream[]>(`/api/twitch/streams?logins=${encodeURIComponent(clean.join(","))}`);
  }

  async getCategories(): Promise<Category[]> {
    return api<Category[]>("/api/twitch/categories?first=24");
  }

  async getChat(): Promise<ChatMessage[]> {
    return [];
  }
}
