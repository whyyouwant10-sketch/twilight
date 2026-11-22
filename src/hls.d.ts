interface HlsLevel {
  height: number;
  width: number;
  bitrate: number;
  frameRate?: number;
  name?: string;
}

interface HlsErrorData {
  fatal?: boolean;
  type?: string;
  details?: string;
}

interface HlsConfig {
  lowLatencyMode?: boolean;
  liveSyncDurationCount?: number;
  liveMaxLatencyDurationCount?: number;
  maxLiveSyncPlaybackRate?: number;
  enableWorker?: boolean;
  backBufferLength?: number;
  capLevelToPlayerSize?: boolean;
  maxBufferLength?: number;
  maxMaxBufferLength?: number;
  abrEwmaDefaultEstimate?: number;
}

declare class Hls {
  static readonly Events: { MANIFEST_PARSED: string; ERROR: string };
  static isSupported(): boolean;
  constructor(config?: HlsConfig);
  attachMedia(media: HTMLMediaElement): void;
  loadSource(source: string): void;
  destroy(): void;
  startLoad(): void;
  recoverMediaError(): void;
  readonly levels: HlsLevel[];
  currentLevel: number;
  on(event: string, callback: (event: unknown, data: HlsErrorData) => void): void;
}

interface Window {
  Hls?: typeof Hls;
}
