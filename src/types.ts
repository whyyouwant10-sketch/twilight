export type View = "home" | "following" | "browse" | "watch" | "settings";

export interface Stream {
  id: string;
  userId: string;
  userName: string;
  displayName: string;
  title: string;
  gameName: string;
  viewerCount: number;
  thumbnailUrl: string;
  startedAt: string;
  tags: string[];
  isLive: boolean;
}

export interface Category {
  id: string;
  name: string;
  boxArtUrl: string;
  viewerCount: number;
}

export interface ChatMessage {
  id: string;
  user: string;
  color: string;
  body: string;
  timestamp: string;
}

export interface AppSettings {
  version: 1;
  streamProxy: string;
  imageProxyEnabled: boolean;
  imageProxyUrl: string;
  favorites: string[];
  quality: "auto" | "160p" | "360p" | "480p" | "720p" | "1080p";
  lowLatency: boolean;
  reduceMotion: boolean;
  clientId: string;
  accessToken: string;
}

export interface TwitchPage<T> {
  data: T[];
  cursor?: string;
}

export interface StreamProvider {
  readonly mode: "demo" | "live" | "twitch";
  getFeaturedStreams(): Promise<Stream[]>;
  searchStreams(query: string): Promise<Stream[]>;
  getStreamsByCategory(category: string): Promise<Stream[]>;
  getFollowedStreams(logins: string[]): Promise<Stream[]>;
  getCategories(): Promise<Category[]>;
  getChat(channel: string): Promise<ChatMessage[]>;
}
