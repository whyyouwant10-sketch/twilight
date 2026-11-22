import { chatMessageFromIrc, parseIrcLine } from "../lib/irc.js";
import type { ChatMessage } from "../types.js";

const ENDPOINT = "wss://irc-ws.chat.twitch.tv:443";
const MAX_RETRIES = 5;

export type ChatStatus = "connecting" | "connected" | "reconnecting" | "offline";

export class TwitchChatClient {
  private socket: WebSocket | null = null;
  private channel = "";
  private closedByUser = false;
  private retries = 0;
  private retryTimer: number | undefined;

  constructor(
    private readonly onMessage: (message: ChatMessage) => void,
    private readonly onStatus: (status: ChatStatus) => void,
  ) {}

  connect(channel: string): void {
    this.disconnect();
    this.closedByUser = false;
    this.channel = channel.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (!this.channel) {
      this.onStatus("offline");
      return;
    }
    this.open();
  }

  private open(): void {
    this.onStatus(this.retries ? "reconnecting" : "connecting");
    const socket = new WebSocket(ENDPOINT);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retries = 0;
      this.onStatus("connected");
      const nick = `justinfan${Math.floor(Math.random() * 90_000) + 10_000}`;
      socket.send("PASS SCHMOOPIIE\r\n");
      socket.send(`NICK ${nick}\r\n`);
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      socket.send(`JOIN #${this.channel}\r\n`);
    });

    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      for (const raw of data.split(/\r?\n/)) {
        if (!raw) continue;
        const line = parseIrcLine(raw);
        if (!line) continue;
        if (line.command === "PING") {
          socket.send(`PONG :${line.params[0] ?? "tmi.twitch.tv"}\r\n`);
          continue;
        }
        const message = chatMessageFromIrc(line, `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        if (message) this.onMessage(message);
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closedByUser) {
        this.onStatus("offline");
        return;
      }
      this.scheduleRetry();
    });

    socket.addEventListener("error", () => {
      this.onStatus("reconnecting");
    });
  }

  private scheduleRetry(): void {
    if (this.closedByUser || this.retries >= MAX_RETRIES) {
      this.onStatus("offline");
      return;
    }
    const delay = Math.min(1000 * 2 ** this.retries, 15_000);
    this.retries += 1;
    this.onStatus("reconnecting");
    this.retryTimer = window.setTimeout(() => this.open(), delay);
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.retryTimer !== undefined) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.socket) {
      try {
        this.socket.send(`PART #${this.channel}\r\n`);
      } catch {
        /* socket already closing */
      }
      this.socket.close();
      this.socket = null;
    }
  }
}
