import { ProviderType } from "./types";

export interface ModelAlias {
  /** Readable name shown in Open Cursor and suggested for Cursor. */
  displayName: string;
  /** Exact model ID sent to the upstream provider. */
  upstreamModel: string;
  provider: ProviderType;
  /** Suggested provider base URL when adding from this alias. */
  baseUrl: string;
  /** Alternate names users might type (e.g. "sonnet", "claude sonnet 5"). */
  aliases: string[];
  /** Short stable slug preferred for Cursor model names. */
  cursorSlug: string;
}

export interface ModelAliasMatch extends ModelAlias {
  /** Which input form matched (display name, alias, or upstream id). */
  matchedOn: "displayName" | "alias" | "upstreamModel" | "cursorSlug";
}

const ANTHROPIC_BASE = "https://api.anthropic.com";

/**
 * Known models with readable names → provider model IDs.
 * Keep Anthropic entries current; users can still enter any custom ID.
 */
export const KNOWN_MODEL_ALIASES: ModelAlias[] = [
  {
    displayName: "Claude Sonnet 5",
    upstreamModel: "claude-sonnet-5",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-sonnet-5",
    aliases: ["sonnet", "sonnet 5", "claude sonnet", "claude-sonnet-5"],
  },
  {
    displayName: "Claude Opus 5",
    upstreamModel: "claude-opus-5",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-opus-5",
    aliases: ["opus", "opus 5", "claude opus", "claude-opus-5"],
  },
  {
    displayName: "Claude Fable 5",
    upstreamModel: "claude-fable-5",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-fable-5",
    aliases: ["fable", "fable 5", "claude fable", "claude-fable-5"],
  },
  {
    displayName: "Claude Haiku 4.5",
    upstreamModel: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-haiku-4-5",
    aliases: [
      "haiku",
      "haiku 4.5",
      "claude haiku",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ],
  },
  {
    displayName: "Claude Sonnet 4.6",
    upstreamModel: "claude-sonnet-4-6",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-sonnet-4-6",
    aliases: ["sonnet 4.6", "claude sonnet 4.6", "claude-sonnet-4-6"],
  },
  {
    displayName: "Claude Opus 4.8",
    upstreamModel: "claude-opus-4-8",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-opus-4-8",
    aliases: ["opus 4.8", "claude opus 4.8", "claude-opus-4-8"],
  },
  {
    displayName: "Claude Opus 4.7",
    upstreamModel: "claude-opus-4-7",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-opus-4-7",
    aliases: ["opus 4.7", "claude opus 4.7", "claude-opus-4-7"],
  },
  {
    displayName: "Claude Opus 4.6",
    upstreamModel: "claude-opus-4-6",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-opus-4-6",
    aliases: ["opus 4.6", "claude opus 4.6", "claude-opus-4-6"],
  },
  {
    displayName: "Claude Sonnet 4.5",
    upstreamModel: "claude-sonnet-4-5-20250929",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-sonnet-4-5",
    aliases: [
      "sonnet 4.5",
      "claude sonnet 4.5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20250929",
    ],
  },
  {
    displayName: "Claude Opus 4.5",
    upstreamModel: "claude-opus-4-5-20251101",
    provider: "anthropic",
    baseUrl: ANTHROPIC_BASE,
    cursorSlug: "claude-opus-4-5",
    aliases: [
      "opus 4.5",
      "claude opus 4.5",
      "claude-opus-4-5",
      "claude-opus-4-5-20251101",
    ],
  },
];

/** Collapse punctuation/spacing so "Claude Sonnet 5", "claude-sonnet-5", "sonnet 5" compare. */
export function normalizeAliasKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function aliasKeys(alias: ModelAlias): Array<{
  key: string;
  matchedOn: ModelAliasMatch["matchedOn"];
}> {
  return [
    { key: normalizeAliasKey(alias.displayName), matchedOn: "displayName" },
    { key: normalizeAliasKey(alias.upstreamModel), matchedOn: "upstreamModel" },
    { key: normalizeAliasKey(alias.cursorSlug), matchedOn: "cursorSlug" },
    ...alias.aliases.map((name) => ({
      key: normalizeAliasKey(name),
      matchedOn: "alias" as const,
    })),
  ];
}

/**
 * Resolve a readable name, nickname, or known ID to a catalog entry.
 * Prefer longer / more specific keys when multiple aliases collide
 * (e.g. "sonnet 5" over "sonnet").
 */
export function resolveModelAlias(input: string): ModelAliasMatch | undefined {
  const needle = normalizeAliasKey(input);
  if (!needle) {
    return undefined;
  }

  let best: { alias: ModelAlias; matchedOn: ModelAliasMatch["matchedOn"]; key: string } | undefined;

  for (const alias of KNOWN_MODEL_ALIASES) {
    for (const entry of aliasKeys(alias)) {
      if (entry.key !== needle) {
        continue;
      }
      if (!best || entry.key.length > best.key.length) {
        best = { alias, matchedOn: entry.matchedOn, key: entry.key };
      }
    }
  }

  if (!best) {
    return undefined;
  }

  return { ...best.alias, matchedOn: best.matchedOn };
}

/**
 * Strip a Cursor slot/model prefix (gemini-oc-, claude-oc-, oc-) and resolve
 * the remaining readable slug against the alias catalog.
 */
export function resolveCursorModelAlias(
  cursorModelName: string,
  modelPrefix: string
): ModelAliasMatch | undefined {
  const trimmed = cursorModelName.trim();
  if (!trimmed) {
    return undefined;
  }

  const withoutPrefix = trimmed.startsWith(modelPrefix)
    ? trimmed.slice(modelPrefix.length)
    : trimmed.replace(/^(gemini-|claude-)?oc-/, "");

  return (
    resolveModelAlias(trimmed) ??
    resolveModelAlias(withoutPrefix) ??
    resolveModelAlias(withoutPrefix.replace(/-[a-z0-9]{4,8}$/i, ""))
  );
}

export function slugifyModelName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "model"
  );
}
