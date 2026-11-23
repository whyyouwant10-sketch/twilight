export type View = "home" | "following" | "browse" | "watch" | "archives" | "settings";

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
  playerType: "site" | "embed";
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

export interface ChannelMatch { isLive: boolean; login: string; displayName: string; avatarUrl?: string | null }

export interface ArchiveVideo {
  thumbnailUrl: string;
  id: string;
  title: string;
  publishedAt: string;
  duration: number;
  muted: { offset: number; duration: number }[] | null;
}

export interface ArchivePage {
  channel: string;
  videos: ArchiveVideo[];
  cursor: string | null;
}

export interface StreamProvider {
  readonly mode: "demo" | "live" | "twitch";
  searchChannels?(query: string): Promise<ChannelMatch[]>;
  getArchives?(login: string, cursor?: string): Promise<ArchivePage | null>;
  getFeaturedStreams(): Promise<Stream[]>;
  searchStreams(query: string): Promise<Stream[]>;
  getStreamsByCategory(category: string): Promise<Stream[]>;
  getFollowedStreams(logins: string[]): Promise<Stream[]>;
  getCategories(): Promise<Category[]>;
  getChat(channel: string): Promise<ChatMessage[]>;
}
