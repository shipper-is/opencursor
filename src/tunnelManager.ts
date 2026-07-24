import { spawn, ChildProcess } from "child_process";
import * as vscode from "vscode";

const TUNNEL_URL_TIMEOUT_MS = 45_000;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

export type TunnelProvider = "auto" | "ngrok" | "cloudflared";

export interface TunnelResult {
  publicUrl: string;
  provider: Exclude<TunnelProvider, "auto">;
}

export class TunnelManager {
  private process: ChildProcess | undefined;
  private publicUrl: string | undefined;
  private provider: Exclude<TunnelProvider, "auto"> | undefined;
  private log: (msg: string) => void = () => {};

  setLogger(fn: (msg: string) => void): void {
    this.log = fn;
  }

  getPublicUrl(): string | undefined {
    return this.publicUrl;
  }

  getProvider(): string | undefined {
    return this.provider;
  }

  isRunning(): boolean {
    return Boolean(this.process && !this.process.killed && this.publicUrl);
  }

  async start(port: number): Promise<TunnelResult> {
    await this.stop();

    const config = vscode.workspace.getConfiguration("openCursorModels");
    const preference = config.get<TunnelProvider>("tunnelProvider", "auto");
    const providers = resolveProviderOrder(preference);

    let lastError = "No tunnel provider available";

    for (const provider of providers) {
      try {
        const result = await this.startProvider(provider, port);
        this.publicUrl = result.publicUrl;
        this.provider = result.provider;
        this.log(
          `Tunnel ready (${result.provider}): ${result.publicUrl} → localhost:${port}`
        );
        return result;
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : String(error);
        this.log(`Tunnel ${provider} failed: ${lastError}`);
        await this.stop();
      }
    }

    throw new Error(
      `${lastError}. Install ngrok (https://ngrok.com/download) or cloudflared, ensure it is on your PATH, then try Start proxy again.`
    );
  }

  async stop(): Promise<void> {
    this.publicUrl = undefined;
    this.provider = undefined;

    if (!this.process) {
      return;
    }

    const proc = this.process;
    this.process = undefined;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 3000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      proc.kill("SIGTERM");
    });
  }

  private async startProvider(
    provider: Exclude<TunnelProvider, "auto">,
    port: number
  ): Promise<TunnelResult> {
    switch (provider) {
      case "ngrok":
        return this.startNgrok(port);
      case "cloudflared":
        return this.startCloudflared(port);
    }
  }

  private async startNgrok(port: number): Promise<TunnelResult> {
    await assertCommandExists("ngrok");

    const proc = spawn("ngrok", ["http", String(port), "--log=stdout"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.process = proc;

    proc.stdout?.on("data", (data: Buffer) => {
      this.log(`[ngrok] ${data.toString().trim()}`);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      this.log(`[ngrok] ${data.toString().trim()}`);
    });

    const url = await waitForNgrokUrl(proc);
    return { publicUrl: url, provider: "ngrok" };
  }

  private async startCloudflared(port: number): Promise<TunnelResult> {
    await assertCommandExists("cloudflared");

    const proc = spawn(
      "cloudflared",
      [
        "tunnel",
        "--url",
        `http://127.0.0.1:${port}`,
        "--protocol",
        "http2",
        "--no-autoupdate",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env }
    );
    this.process = proc;

    let buffer = "";
    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      buffer += text;
      this.log(`[cloudflared] ${text.trim()}`);
    };

    proc.stdout?.on("data", handleOutput);
    proc.stderr?.on("data", handleOutput);

    const url = await waitForRegexUrl(
      proc,
      buffer,
      /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      "cloudflared"
    );

    this.log(
      "Note: Cloudflare quick tunnels may not support streaming (SSE). Prefer ngrok if chat fails."
    );

    return { publicUrl: url, provider: "cloudflared" };
  }
}

function resolveProviderOrder(
  preference: TunnelProvider
): Array<Exclude<TunnelProvider, "auto">> {
  if (preference !== "auto") {
    return [preference];
  }
  return ["ngrok", "cloudflared"];
}

async function assertCommandExists(command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const checker = process.platform === "win32" ? "where" : "which";
    const proc = spawn(checker, [command], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.on("error", () => {
      reject(new Error(`${command} is not installed`));
    });
    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        resolve();
      } else {
        reject(new Error(`${command} is not installed`));
      }
    });
  });
}

async function waitForNgrokUrl(proc: ChildProcess): Promise<string> {
  const started = Date.now();

  while (Date.now() - started < TUNNEL_URL_TIMEOUT_MS) {
    if (proc.exitCode !== null) {
      throw new Error("ngrok exited before publishing a tunnel URL");
    }

    try {
      const response = await fetch(NGROK_API);
      if (response.ok) {
        const data = (await response.json()) as {
          tunnels?: Array<{ public_url?: string; proto?: string }>;
        };
        const httpsTunnel = data.tunnels?.find(
          (t) => t.public_url?.startsWith("https://")
        );
        if (httpsTunnel?.public_url) {
          return httpsTunnel.public_url;
        }
      }
    } catch {
      // ngrok API not ready yet
    }

    await sleep(500);
  }

  throw new Error("Timed out waiting for ngrok tunnel URL");
}

async function waitForRegexUrl(
  proc: ChildProcess,
  initialBuffer: string,
  pattern: RegExp,
  name: string
): Promise<string> {
  let buffer = initialBuffer;

  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      buffer += data.toString();
      const match = pattern.exec(buffer);
      if (match) {
        cleanup();
        resolve(match[0]);
      }
    };

    const onExit = () => {
      cleanup();
      reject(new Error(`${name} exited before publishing a tunnel URL`));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${name} tunnel URL`));
    }, TUNNEL_URL_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      proc.stdout?.off("data", onData);
      proc.stderr?.off("data", onData);
      proc.off("exit", onExit);
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", onExit);

    const immediate = pattern.exec(buffer);
    if (immediate) {
      cleanup();
      resolve(immediate[0]);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
