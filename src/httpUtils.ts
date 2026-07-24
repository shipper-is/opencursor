import { IncomingMessage } from "http";

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 5 * 60_000;

export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"'\\]+/gi, "Bearer [redacted]")
    .replace(/\bocm-[a-f0-9]+\b/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(x-api-key|api[_-]?key)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=[redacted]");
}

export function summarizeErrorBody(text: string, max = 120): string {
  return redactSecrets(text).replace(/\s+/g, " ").trim().slice(0, max);
}

export async function fetchUpstream(
  url: string,
  init: RequestInit,
  timeoutMs = UPSTREAM_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: init.signal ?? controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Upstream request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function readBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      req.destroy();
      reject(error);
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => fail(error));
  });
}
