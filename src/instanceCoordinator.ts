import { ProxyRuntimeConfig } from "./types";

/**
 * Cursor runs one extension host per window, so every open project activates
 * this extension separately. Only one of them can bind the proxy port or hold
 * an ngrok agent session, so the first window to bind becomes the leader and
 * the rest talk to it over loopback through these endpoints.
 */
export const INSTANCE_PATH = "/__opencursor/instance";
export const CONFIG_PATH = "/__opencursor/config";

const PROBE_TIMEOUT_MS = 2000;

export interface InstanceStatus {
  /** Process id of the extension host that owns the proxy and tunnel. */
  ownerPid: number;
  publicUrl?: string;
  tunnelProvider?: string;
  startedAt: number;
}

/**
 * Asks whoever holds `port` whether they are an OpenCursor leader. Returns
 * undefined when the port is unreachable, owned by an unrelated process, or
 * guarded by a different proxy key.
 */
export async function probeInstance(
  port: number,
  proxyApiKey: string
): Promise<InstanceStatus | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${INSTANCE_PATH}`, {
      headers: { authorization: `Bearer ${proxyApiKey}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as Partial<InstanceStatus>;
    if (typeof data.ownerPid !== "number") {
      return undefined;
    }

    return {
      ownerPid: data.ownerPid,
      publicUrl: data.publicUrl,
      tunnelProvider: data.tunnelProvider,
      startedAt: typeof data.startedAt === "number" ? data.startedAt : 0,
    };
  } catch {
    return undefined;
  }
}

/**
 * Hands the leader a freshly built config. Followers do this on startup and
 * after any edit so model changes made in one window apply immediately,
 * without waiting for the leader's extension host to notice shared storage.
 */
export async function pushConfig(
  port: number,
  proxyApiKey: string,
  config: ProxyRuntimeConfig
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${CONFIG_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${proxyApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** True when a proxy start failed only because another window already owns the port. */
export function isPortInUseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "EADDRINUSE"
  );
}
