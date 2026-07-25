import * as crypto from "crypto";
import * as vscode from "vscode";
import { resolveModelAlias, slugifyModelName } from "./modelAliases";
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
      models.push({
        cursorModelName: this.cursorNameFor(profile, modelPrefix),
        upstreamModel: resolvedUpstream,
        baseUrl: profile.baseUrl,
        apiKey,
        provider: profile.provider,
        enabled: profile.enabled,
      });
    }

    return {
      port,
      proxyApiKey,
      modelPrefix,
      logRequests,
      logRequestBodies,
      subagentModelName: this.resolveSubagentModelName(profiles, modelPrefix),
      models,
    };
  }

  /**
   * Turns the user-facing `subagentModel` setting into the Cursor-facing model
   * name the proxy routes on. The setting accepts a profile id, slug, display
   * name, or the full prefixed name so it stays usable by hand.
   */
  private resolveSubagentModelName(
    profiles: StoredModelProfile[],
    modelPrefix: string
  ): string | undefined {
    const config = vscode.workspace.getConfiguration("openCursorModels");
    if (!config.get<boolean>("forceSubagentModel", false)) {
      return undefined;
    }

    const raw = config.get<string>("subagentModel", "").trim();
    if (!raw) {
      return undefined;
    }

    const withoutPrefix = raw.startsWith(modelPrefix)
      ? raw.slice(modelPrefix.length)
      : raw;
    const match = profiles.find(
      (profile) =>
        profile.id === withoutPrefix ||
        profile.cursorSlug === withoutPrefix ||
        profile.displayName === raw ||
        this.cursorNameFor(profile, modelPrefix) === raw
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
