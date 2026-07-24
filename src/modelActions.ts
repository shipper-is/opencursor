import * as vscode from "vscode";
import { joinUpstreamUrl } from "./requestTransform";
import { ModelFormValues, ProviderType } from "./types";

export async function promptForModel(
  title: string,
  initial?: Partial<ModelFormValues>
): Promise<ModelFormValues | undefined> {
  const displayName = await vscode.window.showInputBox({
    title,
    prompt: "Name shown in Open Cursor Models",
    value: initial?.displayName ?? "",
    placeHolder: "DeepSeek V3",
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() ? undefined : "A display name is required",
  });
  if (displayName === undefined) {
    return undefined;
  }

  const upstreamModel = await vscode.window.showInputBox({
    title,
    prompt: "Exact model ID expected by the provider",
    value: initial?.upstreamModel ?? "",
    placeHolder: "deepseek-chat",
    validateInput: (value) =>
      value.trim() ? undefined : "A model ID is required",
    ignoreFocusOut: true,
  });
  if (upstreamModel === undefined) {
    return undefined;
  }

  const baseUrl = await vscode.window.showInputBox({
    title,
    prompt: "Provider API base URL",
    value: initial?.baseUrl ?? "https://api.openai.com/v1",
    placeHolder: "https://api.provider.com/v1",
    validateInput: (value) => {
      if (!value.trim()) {
        return "A base URL is required";
      }
      try {
        const url = new URL(value.trim());
        return url.protocol === "https:" || url.protocol === "http:"
          ? undefined
          : "Use an HTTP or HTTPS URL";
      } catch {
        return "Enter a valid URL";
      }
    },
    ignoreFocusOut: true,
  });
  if (baseUrl === undefined) {
    return undefined;
  }

  const provider = await vscode.window.showQuickPick<{
    label: string;
    detail: string;
    value: ProviderType;
  }>(
    [
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
    ],
    {
      title,
      placeHolder: "Which API protocol does this provider use?",
      ignoreFocusOut: true,
    }
  );
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
    upstreamModel: upstreamModel.trim(),
    baseUrl: baseUrl.trim(),
    apiKey,
    provider: provider.value,
  };
}

export async function testModelConnection(
  values: ModelFormValues
): Promise<{ ok: boolean; message: string }> {
  const isAnthropic = values.provider === "anthropic";

  try {
    const response = await fetch(
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
      message: `HTTP ${response.status}: ${text.slice(0, 200)}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
