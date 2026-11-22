import type { Category, ChatMessage, Stream, StreamProvider, TwitchPage } from "../types.js";
import { MockProvider } from "./mock.js";

const API = "https://api.twitch.tv/helix";
const imageUrl = (template: string, width: number, height: number): string => template.replace("{width}", String(width)).replace("{height}", String(height));

interface HelixStream { id: string; user_id: string; user_name: string; user_login: string; title: string; game_name: string; viewer_count: number; thumbnail_url: string; started_at: string; tags: string[]; type: string; }
interface HelixGame { id: string; name: string; box_art_url: string; }
interface HelixUser { id: string; login: string; display_name: string; }

export class TwitchProvider implements StreamProvider {
  readonly mode = "twitch" as const;
  constructor(private readonly clientId: string, private readonly accessToken: string) {}

  private async get<T>(path: string): Promise<TwitchPage<T>> {
    const response = await fetch(`${API}${path}`, { headers: { "Client-Id": this.clientId, Authorization: `Bearer ${this.accessToken}` } });
    if (!response.ok) throw new Error(`Twitch request failed (${response.status})`);
    return response.json() as Promise<TwitchPage<T>>;
  }

  private mapStream(stream: HelixStream): Stream {
    return { id: stream.id, userId: stream.user_id, userName: stream.user_login, displayName: stream.user_name, title: stream.title, gameName: stream.game_name || "No category", viewerCount: stream.viewer_count, thumbnailUrl: imageUrl(stream.thumbnail_url, 640, 360), startedAt: stream.started_at, tags: stream.tags ?? [], isLive: stream.type === "live" };
  }

  async getFeaturedStreams(): Promise<Stream[]> { return (await this.get<HelixStream>("/streams?first=24")).data.map((stream) => this.mapStream(stream)); }
  async searchStreams(query: string): Promise<Stream[]> {
    const [channels, games] = await Promise.all([
      this.get<HelixUser>(`/search/channels?query=${encodeURIComponent(query)}&first=24`),
      this.get<HelixGame>(`/search/categories?query=${encodeURIComponent(query)}&first=5`),
    ]);
    const logins = channels.data.map((channel) => channel.login).filter(Boolean).slice(0, 24);
    const channelQuery = logins.map((login) => `user_login=${encodeURIComponent(login)}`).join("&");
    const categoryId = games.data[0]?.id;
    const streams = channelQuery ? (await this.get<HelixStream>(`/streams?first=24&${channelQuery}`)).data : [];
    if (streams.length || !categoryId) return streams.map((stream) => this.mapStream(stream));
    return (await this.get<HelixStream>(`/streams?first=24&game_id=${encodeURIComponent(categoryId)}`)).data.map((stream) => this.mapStream(stream));
  }
  async getStreamsByCategory(category: string): Promise<Stream[]> {
    const games = await this.get<HelixGame>(`/games?name=${encodeURIComponent(category.trim())}`);
    const gameId = games.data[0]?.id;
    if (!gameId) return [];
    return (await this.get<HelixStream>(`/streams?first=24&game_id=${encodeURIComponent(gameId)}`)).data.map((stream) => this.mapStream(stream));
  }
  async getFollowedStreams(logins: string[]): Promise<Stream[]> {
    const unique = [...new Set(logins.map((login) => login.trim().toLowerCase()).filter(Boolean))].slice(0, 100);
    if (!unique.length) return [];
    const query = unique.map((login) => `user_login=${encodeURIComponent(login)}`).join("&");
    return (await this.get<HelixStream>(`/streams?first=100&${query}`)).data.map((stream) => this.mapStream(stream));
  }
  async getCategories(): Promise<Category[]> {
    return (await this.get<HelixGame>("/games/top?first=24")).data.map((game) => ({ id: game.id, name: game.name, boxArtUrl: imageUrl(game.box_art_url, 285, 380), viewerCount: 0 }));
  }
  async getChat(_channel: string): Promise<ChatMessage[]> { return []; }
}

export function createProvider(clientId: string, accessToken: string): StreamProvider {
  return clientId.trim() && accessToken.trim() ? new TwitchProvider(clientId.trim(), accessToken.trim()) : new MockProvider();
}
