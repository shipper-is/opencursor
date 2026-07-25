import * as crypto from "crypto";
import * as vscode from "vscode";
import { resolveModelAlias, slugifyModelName } from "./modelAliases";
import {
  DEFAULT_VARIATION,
  ModelVariation,
  ReasoningEffort,
  SpeedTier,
  isReasoningEffort,
  isSpeedTier,
} from "./modelVariations";
import {
  ModelFormValues,
  ModelProfile,
  ProviderSlot,
  ProxyRuntimeConfig,
  StoredModelProfile,
  generateId,
  normalizeBaseUrl,
  slotPrefix,
} from "./types";

const MODELS_KEY = "openCursorModels.profiles";
const PROXY_KEY_SECRET = "openCursorModels.proxyApiKey";

export class ModelStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getProxyApiKey(): Promise<string> {
    let key = await this.context.secrets.get(PROXY_KEY_SECRET);
    if (!key) {
      key = `ocm-${crypto.randomBytes(24).toString("hex")}`;
      await this.context.secrets.store(PROXY_KEY_SECRET, key);
    }
    return key;
  }

  async listProfiles(): Promise<StoredModelProfile[]> {
    return this.context.globalState.get<StoredModelProfile[]>(MODELS_KEY, []);
  }

  async getProfile(id: string): Promise<StoredModelProfile | undefined> {
    const profiles = await this.listProfiles();
    return profiles.find((p) => p.id === id);
  }

  async getApiKey(id: string): Promise<string | undefined> {
    return this.context.secrets.get(this.secretKey(id));
  }

  async addProfile(values: ModelFormValues): Promise<StoredModelProfile> {
    const now = Date.now();
    const displayName =
      values.displayName.trim() || values.upstreamModel.trim();
    const resolved =
      resolveModelAlias(values.upstreamModel) ?? resolveModelAlias(displayName);
    const upstreamModel =
      resolveModelAlias(values.upstreamModel.trim())?.upstreamModel ||
      values.upstreamModel.trim() ||
      resolved?.upstreamModel ||
      displayName;
    const cursorSlug = await this.allocateCursorSlug(
      resolveModelAlias(displayName)?.cursorSlug ?? displayName
    );
    const profile: StoredModelProfile = {
      id: generateId(displayName),
      displayName,
      cursorSlug,
      upstreamModel,
      baseUrl: normalizeBaseUrl(values.baseUrl.trim()),
      provider: values.provider,
      reasoningEffort: values.reasoningEffort ?? DEFAULT_VARIATION.reasoningEffort,
      speedTier: values.speedTier ?? DEFAULT_VARIATION.speedTier,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    await this.context.secrets.store(this.secretKey(profile.id), values.apiKey.trim());

    const profiles = await this.listProfiles();
    profiles.push(profile);
    await this.context.globalState.update(MODELS_KEY, profiles);
    return profile;
  }

  async updateProfile(
    id: string,
    values: ModelFormValues
  ): Promise<StoredModelProfile | undefined> {
    const profiles = await this.listProfiles();
    const index = profiles.findIndex((p) => p.id === id);
    if (index === -1) {
      return undefined;
    }

    const existing = profiles[index];
    const displayName =
      values.displayName.trim() || values.upstreamModel.trim();
    const resolved =
      resolveModelAlias(values.upstreamModel) ?? resolveModelAlias(displayName);
    const upstreamModel =
      resolveModelAlias(values.upstreamModel.trim())?.upstreamModel ||
      values.upstreamModel.trim() ||
      resolved?.upstreamModel ||
      displayName;
    // Keep the Cursor-facing slug stable so existing Cursor model entries keep working.
    const cursorSlug =
      existing.cursorSlug ??
      (await this.allocateCursorSlug(
        resolveModelAlias(displayName)?.cursorSlug ?? displayName,
        id
      ));
    const updated: StoredModelProfile = {
      ...existing,
      displayName,
      cursorSlug,
      upstreamModel,
      baseUrl: normalizeBaseUrl(values.baseUrl.trim()),
      provider: values.provider,
      reasoningEffort: values.reasoningEffort ?? existing.reasoningEffort,
      speedTier: values.speedTier ?? existing.speedTier,
      updatedAt: Date.now(),
    };

    profiles[index] = updated;
    await this.context.globalState.update(MODELS_KEY, profiles);

    if (values.apiKey.trim()) {
      await this.context.secrets.store(this.secretKey(id), values.apiKey.trim());
    }

    return updated;
  }

  async deleteProfile(id: string): Promise<void> {
    const profiles = await this.listProfiles();
    await this.context.globalState.update(
      MODELS_KEY,
      profiles.filter((p) => p.id !== id)
    );
    await this.context.secrets.delete(this.secretKey(id));
  }

  async toggleProfile(id: string): Promise<StoredModelProfile | undefined> {
    const profiles = await this.listProfiles();
    const index = profiles.findIndex((p) => p.id === id);
    if (index === -1) {
      return undefined;
    }

    profiles[index] = {
      ...profiles[index],
      enabled: !profiles[index].enabled,
      updatedAt: Date.now(),
    };
    await this.context.globalState.update(MODELS_KEY, profiles);
    return profiles[index];
  }

  /**
   * Updates just the thinking/speed variation for one profile, so the settings
   * page can change it without walking the whole edit flow.
   */
  async setVariation(
    id: string,
    variation: Partial<ModelVariation>
  ): Promise<StoredModelProfile | undefined> {
    const profiles = await this.listProfiles();
    const index = profiles.findIndex((p) => p.id === id);
    if (index === -1) {
      return undefined;
    }

    const current = variationFor(profiles[index]);
    profiles[index] = {
      ...profiles[index],
      reasoningEffort: variation.reasoningEffort ?? current.reasoningEffort,
      speedTier: variation.speedTier ?? current.speedTier,
      updatedAt: Date.now(),
    };
    await this.context.globalState.update(MODELS_KEY, profiles);
    return profiles[index];
  }

  async buildProxyConfig(): Promise<ProxyRuntimeConfig> {
    const config = vscode.workspace.getConfiguration("openCursorModels");
    const port = config.get<number>("proxyPort", 18420);
    const modelPrefix = this.getModelPrefix();
    const logRequests = config.get<boolean>("logRequests", false);
    const logRequestBodies = config.get<boolean>("logRequestBodies", false);
    const proxyApiKey = await this.getProxyApiKey();
    const profiles = await this.listProfiles();

    const models = [];
    for (const profile of profiles) {
      const apiKey = (await this.getApiKey(profile.id)) ?? "";
      const resolvedUpstream =
        resolveModelAlias(profile.upstreamModel)?.upstreamModel ??
        profile.upstreamModel;
      const variation = variationFor(profile);
      models.push({
        cursorModelName: this.cursorNameFor(profile, modelPrefix),
        upstreamModel: resolvedUpstream,
        baseUrl: profile.baseUrl,
        apiKey,
        provider: profile.provider,
        enabled: profile.enabled,
        reasoningEffort: variation.reasoningEffort,
        speedTier: variation.speedTier,
      });
    }

    return {
      port,
      proxyApiKey,
      modelPrefix,
      logRequests,
      logRequestBodies,
      subagentModelName: this.isForceSubagentModelEnabled()
        ? this.resolveSubagentModelName(profiles, modelPrefix)
        : undefined,
      subagentReasoningEffort: this.getSubagentEffort(),
      subagentSpeedTier: this.getSubagentSpeedTier(),
      models,
    };
  }

  getSubagentEffort(): ReasoningEffort | undefined {
    const value = vscode.workspace
      .getConfiguration("openCursorModels")
      .get<string>("subagentReasoningEffort", "inherit");
    return isReasoningEffort(value) ? value : undefined;
  }

  getSubagentSpeedTier(): SpeedTier | undefined {
    const value = vscode.workspace
      .getConfiguration("openCursorModels")
      .get<string>("subagentSpeedTier", "inherit");
    return isSpeedTier(value) ? value : undefined;
  }

  isForceSubagentModelEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("openCursorModels")
      .get<boolean>("forceSubagentModel", false);
  }

  getSubagentModelSetting(): string {
    return vscode.workspace
      .getConfiguration("openCursorModels")
      .get<string>("subagentModel", "");
  }

  getLogRequests(): boolean {
    return vscode.workspace
      .getConfiguration("openCursorModels")
      .get<boolean>("logRequests", false);
  }

  getLogRequestBodies(): boolean {
    return vscode.workspace
      .getConfiguration("openCursorModels")
      .get<boolean>("logRequestBodies", false);
  }

  /** Resolves the `subagentModel` setting against the current profiles. */
  async getResolvedSubagentModel(): Promise<string | undefined> {
    return this.resolveSubagentModelName(
      await this.listProfiles(),
      this.getModelPrefix()
    );
  }

  /**
   * Turns the user-facing `subagentModel` setting into the Cursor-facing model
   * name the proxy routes on. The setting accepts a profile id, slug, display
   * name, or the full prefixed name so it stays usable by hand.
   */
  resolveSubagentModelName(
    profiles: StoredModelProfile[],
    modelPrefix: string
  ): string | undefined {
    const raw = this.getSubagentModelSetting().trim();
    if (!raw) {
      return undefined;
    }

    // Matching is case-insensitive because the setting is hand-typeable.
    const full = raw.toLowerCase();
    const bare = full.startsWith(modelPrefix.toLowerCase())
      ? full.slice(modelPrefix.length)
      : full;
    const match = profiles.find(
      (profile) =>
        profile.id.toLowerCase() === bare ||
        profile.cursorSlug?.toLowerCase() === bare ||
        profile.displayName.toLowerCase() === full ||
        this.cursorNameFor(profile, modelPrefix).toLowerCase() === full
    );

    return match ? this.cursorNameFor(match, modelPrefix) : undefined;
  }

  /**
   * Prefer a readable slug (e.g. claude-sonnet-5) for Cursor; fall back to
   * the opaque profile id for older profiles.
   */
  async allocateCursorSlug(
    preferredName: string,
    excludeId?: string
  ): Promise<string> {
    const alias = resolveModelAlias(preferredName);
    const base = slugifyModelName(alias?.cursorSlug ?? preferredName);
    const profiles = await this.listProfiles();
    const used = new Set(
      profiles
        .filter((profile) => profile.id !== excludeId)
        .flatMap((profile) => [profile.cursorSlug, profile.id].filter(Boolean) as string[])
    );

    if (!used.has(base)) {
      return base;
    }

    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      if (!used.has(candidate)) {
        return candidate;
      }
    }

    return generateId(preferredName);
  }

  /**
   * Cursor selects a provider slot from the model-name prefix, so the
   * Anthropic and Google slots require `claude-` and `gemini-` names.
   */
  getModelPrefix(): string {
    const prefix = vscode.workspace
      .getConfiguration("openCursorModels")
      .get<string>("modelPrefix", "oc-");

    const required = slotPrefix(this.getProviderSlot());
    if (!required) {
      return prefix;
    }

    return prefix.startsWith(required) ? prefix : `${required}${prefix}`;
  }

  getProviderSlot(): ProviderSlot {
    return vscode.workspace
      .getConfiguration("openCursorModels")
      .get<ProviderSlot>("providerSlot", "google");
  }

  getProxyPort(): number {
    return vscode.workspace
      .getConfiguration("openCursorModels")
      .get<number>("proxyPort", 18420);
  }

  cursorNameFor(profile: ModelProfile, modelPrefix = this.getModelPrefix()): string {
    return `${modelPrefix}${profile.cursorSlug ?? profile.id}`;
  }

  private secretKey(id: string): string {
    return `openCursorModels.apiKey.${id}`;
  }
}

/** Profiles created before variations existed fall back to provider defaults. */
export function variationFor(profile: {
  reasoningEffort?: unknown;
  speedTier?: unknown;
}): ModelVariation {
  return {
    reasoningEffort: isReasoningEffort(profile.reasoningEffort)
      ? profile.reasoningEffort
      : DEFAULT_VARIATION.reasoningEffort,
    speedTier: isSpeedTier(profile.speedTier)
      ? profile.speedTier
      : DEFAULT_VARIATION.speedTier,
  };
}
