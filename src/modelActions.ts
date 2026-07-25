import * as vscode from "vscode";
import { fetchUpstream, summarizeErrorBody } from "./httpUtils";
import {
  KNOWN_MODEL_ALIASES,
  ModelAlias,
  resolveModelAlias,
} from "./modelAliases";
import { joinUpstreamUrl } from "./requestTransform";
import { ModelFormValues, ProviderType } from "./types";

export async function promptForModel(
  title: string,
  initial?: Partial<ModelFormValues>
): Promise<ModelFormValues | undefined> {
  const preset = initial ? undefined : await pickKnownModel(title);
  if (preset === null) {
    return undefined;
  }

  const displayName = await vscode.window.showInputBox({
    title,
    prompt:
      "Name shown in Open Cursor Models (also used for a readable Cursor model name)",
    value: initial?.displayName ?? preset?.displayName ?? "",
    placeHolder: "Claude Sonnet 5",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() ? undefined : "A display name is required",
  });
  if (displayName === undefined) {
    return undefined;
  }

  const fromDisplayName = resolveModelAlias(displayName);
  const suggestedUpstream =
    initial?.upstreamModel ??
    fromDisplayName?.upstreamModel ??
    preset?.upstreamModel ??
    "";

  const upstreamModel = await vscode.window.showInputBox({
    title,
    prompt: fromDisplayName
      ? `Provider model ID (auto-detected from “${displayName}”)`
      : "Exact model ID — or a known alias like “sonnet” / “Claude Opus 5”",
    value: suggestedUpstream,
    placeHolder: "claude-sonnet-5",
    validateInput: (value) =>
      value.trim() ? undefined : "A model ID is required",
    ignoreFocusOut: true,
  });
  if (upstreamModel === undefined) {
    return undefined;
  }

  const fromUpstream = resolveModelAlias(upstreamModel.trim());
  const resolved = fromUpstream ?? fromDisplayName ?? preset;
  const canonicalUpstream = fromUpstream?.upstreamModel ?? upstreamModel.trim();

  if (fromUpstream && fromUpstream.upstreamModel !== upstreamModel.trim()) {
    void vscode.window.showInformationMessage(
      `Resolved “${upstreamModel.trim()}” → ${canonicalUpstream}`
    );
  }

  const defaultBaseUrl =
    initial?.baseUrl ??
    resolved?.baseUrl ??
    (resolved?.provider === "anthropic"
      ? "https://api.anthropic.com"
      : "https://api.openai.com/v1");

  const baseUrl = await vscode.window.showInputBox({
    title,
    prompt: "Provider API base URL",
    value: defaultBaseUrl,
    placeHolder: "https://api.provider.com/v1",
    validateInput: (value) => {
      if (!value.trim()) {
        return "A base URL is required";
      }
      try {
        const url = new URL(value.trim());
        if (url.protocol === "https:" || url.protocol === "http:") {
          return undefined;
        }
        return "Use an HTTP or HTTPS URL";
      } catch {
        return "Enter a valid URL";
      }
    },
    ignoreFocusOut: true,
  });
  if (baseUrl === undefined) {
    return undefined;
  }

  if (baseUrl.trim().toLowerCase().startsWith("http://")) {
    void vscode.window.showWarningMessage(
      "This provider URL uses HTTP. Prefer HTTPS so the API key is not sent in cleartext."
    );
  }

  const suggestedProvider: ProviderType =
    initial?.provider ?? resolved?.provider ?? "openai-compatible";

  const providerOptions: Array<{
    label: string;
    detail: string;
    value: ProviderType;
  }> = [
    {
      label: "OpenAI-compatible",
      detail: "OpenAI, OpenRouter, DeepSeek, Groq, and most hosted model APIs",
      value: "openai-compatible",
    },
    {
      label: "Anthropic",
      detail: "The native Anthropic Messages API",
      value: "anthropic",
    },
  ];

  // Put the suggested protocol first so Enter accepts the right default.
  providerOptions.sort((a, b) => {
    if (a.value === suggestedProvider) {
      return -1;
    }
    if (b.value === suggestedProvider) {
      return 1;
    }
    return 0;
  });

  const provider = await vscode.window.showQuickPick(providerOptions, {
    title,
    placeHolder:
      suggestedProvider === "anthropic"
        ? "API protocol (Anthropic detected from model name)"
        : "Which API protocol does this provider use?",
    ignoreFocusOut: true,
  });
  if (!provider) {
    return undefined;
  }

  const apiKey = await vscode.window.showInputBox({
    title,
    prompt: initial
      ? "Provider API key (leave blank to keep the saved key)"
      : "Provider API key (stored securely by Cursor)",
    password: true,
    value: "",
    validateInput: (value) =>
      !initial && !value.trim() ? "An API key is required" : undefined,
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) {
    return undefined;
  }

  return {
    displayName: displayName.trim(),
    upstreamModel: canonicalUpstream,
    baseUrl: baseUrl.trim(),
    apiKey,
    provider: provider.value,
  };
}

/**
 * Returns a known alias, undefined for custom, or null if the user cancelled.
 */
async function pickKnownModel(
  title: string
): Promise<ModelAlias | undefined | null> {
  type Item = vscode.QuickPickItem & { alias?: ModelAlias; custom?: boolean };

  const items: Item[] = [
    ...KNOWN_MODEL_ALIASES.map((alias) => ({
      label: alias.displayName,
      description: alias.upstreamModel,
      detail: "Readable Cursor name auto-maps to this Anthropic model ID",
      alias,
    })),
    {
      label: "Custom model…",
      description: "Enter provider details manually",
      detail: "Any OpenAI-compatible or Anthropic model ID",
      custom: true,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Pick a known model (recommended) or enter a custom one",
    ignoreFocusOut: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (!picked) {
    return null;
  }
  if (picked.custom) {
    return undefined;
  }
  return picked.alias;
}

export async function testModelConnection(
  values: ModelFormValues
): Promise<{ ok: boolean; message: string }> {
  const isAnthropic = values.provider === "anthropic";

  try {
    const response = await fetchUpstream(
      joinUpstreamUrl(
        values.baseUrl,
        isAnthropic ? "/v1/messages" : "/chat/completions"
      ),
      {
        method: "POST",
        headers: isAnthropic
          ? {
              "content-type": "application/json",
              "x-api-key": values.apiKey,
              "anthropic-version": "2023-06-01",
            }
          : {
              "content-type": "application/json",
              authorization: `Bearer ${values.apiKey}`,
            },
        body: JSON.stringify(
          isAnthropic
            ? {
                model: values.upstreamModel,
                max_tokens: 16,
                messages: [{ role: "user", content: "ping" }],
              }
            : {
                model: values.upstreamModel,
                max_tokens: 16,
                messages: [{ role: "user", content: "ping" }],
              }
        ),
      }
    );

    if (response.ok || response.status === 400) {
      return { ok: true, message: `Connected (HTTP ${response.status})` };
    }

    const text = await response.text();
    return {
      ok: false,
      message: `HTTP ${response.status}: ${summarizeErrorBody(text, 200)}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
