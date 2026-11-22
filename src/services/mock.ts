import type { Category, ChatMessage, Stream, StreamProvider } from "../types.js";

const image = (seed: string, width: number, height: number): string => `https://images.unsplash.com/photo-${seed}?auto=format&fit=crop&w=${width}&h=${height}&q=78`;

const streams: Stream[] = [
  { id: "demo-1", userId: "nova", userName: "nova_nights", displayName: "Nova Nights", title: "late-night ranked climb — calm comms", gameName: "VALORANT", viewerCount: 18240, thumbnailUrl: image("1542751371-adc38448a05e", 640, 360), startedAt: "2026-11-04T18:15:00Z", tags: ["English", "Competitive"], isLive: true },
  { id: "demo-2", userId: "pixel", userName: "pixelpantry", displayName: "Pixel Pantry", title: "building a cozy town from scratch", gameName: "Stardew Valley", viewerCount: 9340, thumbnailUrl: image("1511512578047-dfb367046420", 640, 360), startedAt: "2026-11-04T16:20:00Z", tags: ["English", "Creative"], isLive: true },
  { id: "demo-3", userId: "orbit", userName: "orbitals", displayName: "Orbitals", title: "the space station has a problem", gameName: "The Outer Worlds", viewerCount: 7210, thumbnailUrl: image("1446776811953-b23d57bd21aa", 640, 360), startedAt: "2026-11-04T17:04:00Z", tags: ["English", "Story"], isLive: true },
  { id: "demo-4", userId: "miso", userName: "miso_music", displayName: "Miso Music", title: "synthwave sketches + chat requests", gameName: "Music", viewerCount: 4560, thumbnailUrl: image("1511379938547-c1f69419868d", 640, 360), startedAt: "2026-11-04T15:40:00Z", tags: ["Music", "Chill"], isLive: true },
  { id: "demo-5", userId: "atlas", userName: "atlas_arcade", displayName: "Atlas Arcade", title: "classic speedrun practice", gameName: "Celeste", viewerCount: 2910, thumbnailUrl: image("1511882150382-421056c89033", 640, 360), startedAt: "2026-11-04T19:01:00Z", tags: ["Speedrun"], isLive: true },
  { id: "demo-6", userId: "lumen", userName: "lumenlabs", displayName: "Lumen Labs", title: "how games make us feel", gameName: "Just Chatting", viewerCount: 1830, thumbnailUrl: image("1517245386807-bb43f82c33c4", 640, 360), startedAt: "2026-11-04T18:45:00Z", tags: ["Talk Show"], isLive: true },
];

const categories: Category[] = [
  { id: "1", name: "Just Chatting", boxArtUrl: image("1499750310107-5fef28a66643", 285, 380), viewerCount: 412000 },
  { id: "2", name: "VALORANT", boxArtUrl: image("1542751371-adc38448a05e", 285, 380), viewerCount: 190000 },
  { id: "3", name: "Music", boxArtUrl: image("1511379938547-c1f69419868d", 285, 380), viewerCount: 63000 },
  { id: "4", name: "Stardew Valley", boxArtUrl: image("1511512578047-dfb367046420", 285, 380), viewerCount: 25000 },
];

const chat: ChatMessage[] = [
  { id: "1", user: "moonbeam", color: "#d8b8ff", body: "the new layout is so clean", timestamp: "19:12" },
  { id: "2", user: "byte_sized", color: "#55d68a", body: "low latency feels instant here", timestamp: "19:13" },
  { id: "3", user: "cassette", color: "#ffb86c", body: "what quality are you running?", timestamp: "19:13" },
  { id: "4", user: "nova_nights", color: "#f37bff", body: "auto for now — welcome in", timestamp: "19:14" },
];

export class MockProvider implements StreamProvider {
  readonly mode = "demo" as const;
  async getFeaturedStreams(): Promise<Stream[]> { return streams; }
  async searchStreams(query: string): Promise<Stream[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return streams;
    return streams.filter((stream) => `${stream.displayName} ${stream.title} ${stream.gameName}`.toLowerCase().includes(needle));
  }
  async getStreamsByCategory(category: string): Promise<Stream[]> {
    const needle = category.trim().toLowerCase();
    if (!needle) return [];
    return streams.filter((stream) => stream.gameName.toLowerCase() === needle);
  }
  async getFollowedStreams(logins: string[]): Promise<Stream[]> {
    const wanted = new Set(logins.map((login) => login.trim().toLowerCase()).filter(Boolean));
    return streams.filter((stream) => wanted.has(stream.userName.toLowerCase()));
  }
  async getCategories(): Promise<Category[]> { return categories; }
  async getChat(_channel: string): Promise<ChatMessage[]> { return chat; }
}
