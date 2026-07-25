/**
 * Per-profile model variations: how hard the model thinks, and whether the
 * request is served on fast or economy capacity.
 *
 * There is no cross-provider standard for either knob, so the mapping is
 * family-aware:
 *
 * - OpenAI-compatible upstreams take `reasoning_effort` plus a `service_tier`
 *   of `priority` (fast) or `flex` (economy).
 * - Anthropic models from 4.6 onward use adaptive thinking with
 *   `output_config.effort`; `thinking.type: "enabled"` with `budget_tokens`
 *   returns a 400 there. Models at 4.5 and earlier are the reverse: they only
 *   understand `budget_tokens` and reject `type: "adaptive"`.
 * - Anthropic has no true fast tier, so `service_tier` there only chooses
 *   between allowing priority capacity (`auto`) and forcing `standard_only`.
 */

import type { ProviderType } from "./types";

export const REASONING_EFFORTS = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const SPEED_TIERS = ["default", "fast", "economy"] as const;

export type SpeedTier = (typeof SPEED_TIERS)[number];

export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  default: "Provider default",
  none: "None — no reasoning",
  minimal: "Minimal",
  low: "Low — fastest thinking",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max — deepest thinking",
};

export const SPEED_TIER_LABELS: Record<SpeedTier, string> = {
  default: "Provider default",
  fast: "Fast — priority capacity",
  economy: "Economy — cheaper, slower",
};

export interface ModelVariation {
  reasoningEffort: ReasoningEffort;
  speedTier: SpeedTier;
}

export const DEFAULT_VARIATION: ModelVariation = {
  reasoningEffort: "default",
  speedTier: "default",
};

export interface VariationContext extends ModelVariation {
  provider: ProviderType;
  upstreamModel: string;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    (REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

export function isSpeedTier(value: unknown): value is SpeedTier {
  return (
    typeof value === "string" && (SPEED_TIERS as readonly string[]).includes(value)
  );
}

export type AnthropicThinkingStyle = "adaptive" | "extended";

/**
 * Anthropic switched thinking styles at 4.6. Versionless names (Mythos, Fable)
 * are all newer than the cutover, so they default to adaptive.
 */
export function anthropicThinkingStyle(
  upstreamModel: string
): AnthropicThinkingStyle {
  const match = /claude[-_]?[a-z]*[-_](\d+)(?:[-_.](\d+))?/i.exec(upstreamModel);
  if (!match) {
    return "adaptive";
  }

  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  if (!Number.isFinite(major)) {
    return "adaptive";
  }

  return major > 4 || (major === 4 && minor >= 6) ? "adaptive" : "extended";
}

/** Thinking budgets for the pre-4.6 Anthropic models that still need one. */
const EXTENDED_THINKING_BUDGETS: Record<string, number> = {
  low: 4096,
  medium: 10240,
  high: 24576,
  xhigh: 32768,
  max: 63999,
};

/** Effort levels `output_config.effort` accepts on adaptive Anthropic models. */
const ADAPTIVE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * Some families reject the lowest effort levels outright — Grok 4.5 and the
 * adaptive Claude models cannot turn reasoning off — so clamp instead of
 * sending a value that would 400.
 */
export function normalizeEffort(
  effort: ReasoningEffort,
  provider: ProviderType,
  upstreamModel: string
): ReasoningEffort {
  if (effort === "default") {
    return "default";
  }

  const model = upstreamModel.toLowerCase();
  const cannotDisable =
    provider === "anthropic"
      ? anthropicThinkingStyle(upstreamModel) === "adaptive"
      : /grok-4\.[5-9]|grok-[5-9]/.test(model);

  if (cannotDisable && (effort === "none" || effort === "minimal")) {
    return "low";
  }

  return effort;
}

/**
 * Applies the variation to an already-built upstream request body. Mutates
 * nothing: returns a new object.
 */
export function applyModelVariation(
  body: Record<string, unknown>,
  context: VariationContext
): Record<string, unknown> {
  const next = { ...body };
  const effort = normalizeEffort(
    context.reasoningEffort,
    context.provider,
    context.upstreamModel
  );

  if (context.provider === "anthropic") {
    applyAnthropicVariation(next, effort, context);
  } else {
    applyOpenAiVariation(next, effort, context.speedTier);
  }

  return next;
}

function applyAnthropicVariation(
  body: Record<string, unknown>,
  effort: ReasoningEffort,
  context: VariationContext
): void {
  const style = anthropicThinkingStyle(context.upstreamModel);

  if (effort !== "default") {
    if (style === "adaptive") {
      // Adaptive thinking is already on by default for these models, so only
      // the output-level effort control needs to be sent.
      if (ADAPTIVE_EFFORTS.has(effort)) {
        const existing =
          typeof body.output_config === "object" && body.output_config
            ? (body.output_config as Record<string, unknown>)
            : {};
        body.output_config = { ...existing, effort };
      }
    } else if (effort === "none" || effort === "minimal") {
      body.thinking = { type: "disabled" };
    } else {
      body.thinking = {
        type: "enabled",
        budget_tokens: EXTENDED_THINKING_BUDGETS[effort] ?? 10240,
      };
    }
  }

  if (context.speedTier === "fast") {
    body.service_tier = "auto";
  } else if (context.speedTier === "economy") {
    body.service_tier = "standard_only";
  }
}

function applyOpenAiVariation(
  body: Record<string, unknown>,
  effort: ReasoningEffort,
  speedTier: SpeedTier
): void {
  if (effort !== "default") {
    body.reasoning_effort = effort;
  }

  if (speedTier === "fast") {
    body.service_tier = "priority";
  } else if (speedTier === "economy") {
    body.service_tier = "flex";
  }
}

/** Short human-readable summary of a variation, for cards and logs. */
export function describeVariation(variation: ModelVariation): string {
  const parts: string[] = [];
  if (variation.reasoningEffort !== "default") {
    parts.push(`thinking: ${variation.reasoningEffort}`);
  }
  if (variation.speedTier !== "default") {
    parts.push(variation.speedTier === "fast" ? "fast" : "economy");
  }
  return parts.join(" · ");
}
