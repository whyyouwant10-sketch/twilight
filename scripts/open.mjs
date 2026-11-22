import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = process.env.PORT ?? "4173";
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["scripts/server.mjs"], { stdio: "inherit", env: { ...process.env, PORT: port } });
await delay(700);

if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" });
else spawn("xdg-open", [url], { detached: true, stdio: "ignore" });

process.on("SIGINT", () => server.kill("SIGINT"));
server.on("exit", (code) => process.exit(code ?? 0));
