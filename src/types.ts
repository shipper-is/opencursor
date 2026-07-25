import type { ReasoningEffort, SpeedTier } from "./modelVariations";

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
  /** Thinking/reasoning depth requested from the upstream model. */
  reasoningEffort?: ReasoningEffort;
  /** Whether to ask for fast (priority) or economy capacity. */
  speedTier?: SpeedTier;
  /**
   * Readable slug used in Cursor model names after the slot prefix
   * (e.g. `claude-sonnet-5` → `gemini-oc-claude-sonnet-5`). Older
   * profiles may omit this and fall back to `id`.
   */
  cursorSlug?: string;
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
  /** Log tool names and system-prompt previews for each proxied request. */
  logRequestBodies: boolean;
  /**
   * When set, requests classified as subagent runs are forced onto this
   * Cursor-facing model name, ignoring the orchestrator's choice.
   */
  subagentModelName?: string;
  /** Variation overrides applied to subagent runs, when set. */
  subagentReasoningEffort?: ReasoningEffort;
  subagentSpeedTier?: SpeedTier;
  models: Array<{
    cursorModelName: string;
    upstreamModel: string;
    baseUrl: string;
    apiKey: string;
    provider: ProviderType;
    enabled: boolean;
    reasoningEffort: ReasoningEffort;
    speedTier: SpeedTier;
  }>;
}

export interface ModelFormValues {
  displayName: string;
  upstreamModel: string;
  baseUrl: string;
  apiKey: string;
  provider: ProviderType;
  reasoningEffort?: ReasoningEffort;
  speedTier?: SpeedTier;
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
