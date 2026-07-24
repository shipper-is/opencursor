import * as crypto from "crypto";
import * as vscode from "vscode";
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
    const profile: StoredModelProfile = {
      id: generateId(values.displayName || values.upstreamModel),
      displayName: values.displayName.trim() || values.upstreamModel.trim(),
      upstreamModel: values.upstreamModel.trim(),
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
    const updated: StoredModelProfile = {
      ...existing,
      displayName: values.displayName.trim() || values.upstreamModel.trim(),
      upstreamModel: values.upstreamModel.trim(),
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
    const proxyApiKey = await this.getProxyApiKey();
    const profiles = await this.listProfiles();

    const models = [];
    for (const profile of profiles) {
      const apiKey = (await this.getApiKey(profile.id)) ?? "";
      models.push({
        cursorModelName: `${modelPrefix}${profile.id}`,
        upstreamModel: profile.upstreamModel,
        baseUrl: profile.baseUrl,
        apiKey,
        provider: profile.provider,
        enabled: profile.enabled,
      });
    }

    return { port, proxyApiKey, modelPrefix, logRequests, models };
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

  cursorNameFor(profile: ModelProfile): string {
    return `${this.getModelPrefix()}${profile.id}`;
  }

  private secretKey(id: string): string {
    return `openCursorModels.apiKey.${id}`;
  }
}
