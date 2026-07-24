export type ProviderType = "openai-compatible" | "anthropic";

/** Which of Cursor's BYOK key slots custom models are routed through. */
export type ProviderSlot = "openai" | "anthropic" | "google";

/** Model-name prefix Cursor requires in order to pick a given slot. */
export function slotPrefix(slot: ProviderSlot): string {
  switch (slot) {
    case "anthropic":
      return "claude-";
    case "google":
      return "gemini-";
    default:
      return "";
  }
}

export const SLOT_LABELS: Record<ProviderSlot, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

export interface ModelProfile {
  id: string;
  displayName: string;
  /** Model name sent to the upstream provider */
  upstreamModel: string;
  baseUrl: string;
  provider: ProviderType;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Stored in globalState — API keys live in SecretStorage */
export interface StoredModelProfile extends Omit<ModelProfile, never> {}

export interface ProxyRuntimeConfig {
  port: number;
  proxyApiKey: string;
  modelPrefix: string;
  logRequests: boolean;
  models: Array<{
    cursorModelName: string;
    upstreamModel: string;
    baseUrl: string;
    apiKey: string;
    provider: ProviderType;
    enabled: boolean;
  }>;
}

export interface ModelFormValues {
  displayName: string;
  upstreamModel: string;
  baseUrl: string;
  apiKey: string;
  provider: ProviderType;
}

export function cursorModelName(prefix: string, id: string): string {
  return `${prefix}${id}`;
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function publicBaseUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/v1`;
}

export function generateId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return slug ? `${slug}-${suffix}` : suffix;
}
