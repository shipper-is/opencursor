import * as vscode from "vscode";
import {
  REASONING_EFFORTS,
  REASONING_EFFORT_LABELS,
  ReasoningEffort,
  SPEED_TIERS,
  SPEED_TIER_LABELS,
  SpeedTier,
  anthropicThinkingStyle,
  describeVariation,
} from "./modelVariations";
import { ProviderSlot, SLOT_LABELS } from "./types";

export type SettingsTab = "setup" | "models" | "subagents" | "diagnostics";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "setup", label: "Setup" },
  { id: "models", label: "Models" },
  { id: "subagents", label: "Subagents" },
  { id: "diagnostics", label: "Diagnostics" },
];

export interface SetupModel {
  id: string;
  displayName: string;
  cursorName: string;
  /** Prefix-free slug, stable across provider-slot changes. */
  slug: string;
  upstreamModel: string;
  baseUrl: string;
  provider: string;
  enabled: boolean;
  reasoningEffort: ReasoningEffort;
  speedTier: SpeedTier;
}

export interface SubagentSettings {
  enabled: boolean;
  /** Raw value of the `subagentModel` setting. */
  model: string;
  /** Cursor-facing name the setting actually resolved to, if any. */
  resolvedModel?: string;
  reasoningEffort?: ReasoningEffort;
  speedTier?: SpeedTier;
}

export interface DiagnosticsSettings {
  logRequests: boolean;
  logRequestBodies: boolean;
}

export interface SetupWizardOptions {
  proxyPort: number;
  proxyApiKey: string;
  proxyRunning: boolean;
  models: SetupModel[];
  cursorBaseUrl?: string;
  tunnelProvider?: string;
  tunnelError?: string;
  /** The proxy and tunnel are owned by another open Cursor window. */
  sharedFromOtherWindow?: boolean;
  providerSlot: ProviderSlot;
  subagent: SubagentSettings;
  diagnostics: DiagnosticsSettings;
}

export class SetupWizardPanel {
  public static currentPanel: SetupWizardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private activeTab: SettingsTab = "setup";

  private constructor(
    panel: vscode.WebviewPanel,
    private options: SetupWizardOptions
  ) {
    this.panel = panel;
    this.render();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: {
        command?: string;
        text?: string;
        label?: string;
        id?: string;
        providerSlot?: ProviderSlot;
        tab?: SettingsTab;
        key?: string;
        field?: string;
        value?: string | boolean;
      }) => {
        switch (message.command) {
          case "copy":
            if (message.text) {
              await vscode.env.clipboard.writeText(message.text);
              void vscode.window.showInformationMessage(
                `Copied ${message.label ?? "value"}`
              );
            }
            break;
          case "setTab":
            // Remembered so a config-driven re-render keeps the user in place.
            if (message.tab) {
              this.activeTab = message.tab;
            }
            break;
          case "openCursorSettings":
            await openCursorModelSettings();
            break;
          case "addModel":
            await vscode.commands.executeCommand("openCursorModels.addModel");
            break;
          case "editModel":
          case "deleteModel":
          case "toggleModel":
          case "testModel":
            if (message.id) {
              await vscode.commands.executeCommand(
                `openCursorModels.${message.command}`,
                message.id
              );
            }
            break;
          case "setModelVariation":
            if (message.id && message.field && typeof message.value === "string") {
              await vscode.commands.executeCommand(
                "openCursorModels.setModelVariation",
                message.id,
                message.field,
                message.value
              );
            }
            break;
          case "updateSetting":
            if (message.key && message.value !== undefined) {
              await vscode.commands.executeCommand(
                "openCursorModels.updateSetting",
                message.key,
                message.value
              );
            }
            break;
          case "showLogs":
            await vscode.commands.executeCommand("openCursorModels.showLogs");
            break;
          case "startProxy":
            await vscode.commands.executeCommand("openCursorModels.startProxy");
            break;
          case "setProviderSlot":
            if (message.providerSlot) {
              await vscode.commands.executeCommand(
                "openCursorModels.setProviderSlot",
                message.providerSlot
              );
            }
            break;
        }
      },
      null,
      this.disposables
    );
  }

  static show(options: SetupWizardOptions, tab?: SettingsTab): void {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (SetupWizardPanel.currentPanel) {
      SetupWizardPanel.currentPanel.options = options;
      if (tab) {
        SetupWizardPanel.currentPanel.activeTab = tab;
      }
      SetupWizardPanel.currentPanel.render();
      SetupWizardPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "openCursorModelsSetup",
      "Open Cursor Settings",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    const created = new SetupWizardPanel(panel, options);
    if (tab) {
      created.activeTab = tab;
      created.render();
    }
    SetupWizardPanel.currentPanel = created;
  }

  update(options: SetupWizardOptions): void {
    this.options = options;
    this.render();
  }

  private render(): void {
    this.panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const {
      cursorBaseUrl,
      diagnostics,
      models,
      providerSlot,
      proxyApiKey,
      proxyPort,
      proxyRunning,
      sharedFromOtherWindow,
      subagent,
      tunnelError,
      tunnelProvider,
    } = this.options;
    const enabledModels = models.filter((model) => model.enabled);
    const slotLabel = SLOT_LABELS[providerSlot];
    const providerKeyLabel = `${slotLabel} API Key`;
    const ready = proxyRunning && Boolean(cursorBaseUrl);

    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${this.panel.webview.cspSource} data:`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const statusPill = ready
      ? `<span class="pill ready"><span class="status-dot ready"></span>Connected</span>`
      : `<span class="pill"><span class="status-dot"></span>${proxyRunning ? "Tunnel pending" : "Proxy stopped"}</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>${styles()}</style>
</head>
<body>
  <main>
    <header>
      <div class="title-row">
        <h1>Open Cursor Settings</h1>
        ${statusPill}
      </div>
      <p class="lede">Configure custom models, per-model thinking and speed variations, subagent routing, and diagnostics.</p>
    </header>

    <nav class="tabs" role="tablist">
      ${TABS.map(
        (tab) =>
          `<button class="tab${tab.id === this.activeTab ? " active" : ""}" data-tab="${tab.id}" role="tab">${escapeHtml(tab.label)}</button>`
      ).join("")}
    </nav>

    ${this.renderSetupTab({
      cursorBaseUrl,
      enabledModels,
      models,
      providerKeyLabel,
      providerSlot,
      proxyApiKey,
      proxyPort,
      ready,
      sharedFromOtherWindow,
      slotLabel,
      tunnelError,
      tunnelProvider,
    })}
    ${this.renderModelsTab(models)}
    ${this.renderSubagentsTab(subagent, enabledModels, diagnostics)}
    ${this.renderDiagnosticsTab(diagnostics)}
  </main>
  <script nonce="${nonce}">${script()}</script>
</body>
</html>`;
  }

  private renderSetupTab(context: {
    cursorBaseUrl?: string;
    enabledModels: SetupModel[];
    models: SetupModel[];
    providerKeyLabel: string;
    providerSlot: ProviderSlot;
    proxyApiKey: string;
    proxyPort: number;
    ready: boolean;
    sharedFromOtherWindow?: boolean;
    slotLabel: string;
    tunnelError?: string;
    tunnelProvider?: string;
  }): string {
    const {
      cursorBaseUrl,
      enabledModels,
      models,
      providerKeyLabel,
      providerSlot,
      proxyApiKey,
      proxyPort,
      ready,
      sharedFromOtherWindow,
      slotLabel,
      tunnelError,
      tunnelProvider,
    } = context;

    const proxyContent = ready
      ? `<div class="status-line">
          <span class="status-dot ready"></span>
          <div>
            <strong>${sharedFromOtherWindow ? "Shared proxy and tunnel are running" : "Proxy and tunnel are running"}</strong>
            <p>${escapeHtml(tunnelProvider ?? "HTTPS tunnel")} · local port ${proxyPort}</p>
          </div>
        </div>
        ${
          sharedFromOtherWindow
            ? `<div class="callout">Another open Cursor window is hosting the proxy and tunnel, and this window shares it. Your models and settings are the same everywhere, so the Base URL and key below already work here — there is nothing extra to start.</div>`
            : `<button data-command="startProxy">Restart proxy</button>`
        }`
      : `<div class="status-line">
          <span class="status-dot"></span>
          <div>
            <strong>Proxy is not ready</strong>
            <p>${escapeHtml(tunnelError ?? "Start it after adding your models.")}</p>
          </div>
        </div>
        <button class="primary" data-command="startProxy" ${enabledModels.length === 0 ? "disabled" : ""}>Start proxy</button>`;

    const baseUrlField = cursorBaseUrl
      ? copyField("Base URL", cursorBaseUrl)
      : `<div class="pending-field">Start the proxy to generate your HTTPS Base URL.</div>`;

    const modelNames =
      enabledModels.length === 0
        ? `<p class="empty-copy">Enable at least one model to get its Cursor model name.</p>`
        : `<div class="copy-list">
            ${enabledModels
              .map(
                (model) => `<div class="copy-row">
                  <div>
                    <code>${escapeHtml(model.cursorName)}</code>
                    <div class="model-meta">${escapeHtml(model.displayName)} → ${escapeHtml(model.upstreamModel)}</div>
                  </div>
                  <button data-copy="${escapeHtml(model.cursorName)}" data-label="model name">Copy</button>
                </div>`
              )
              .join("")}
          </div>
          ${
            enabledModels.length > 1
              ? `<button data-copy="${escapeHtml(enabledModels.map((model) => model.cursorName).join("\n"))}" data-label="model names">Copy all names</button>`
              : ""
          }`;

    return `<section class="tab-panel${this.activeTab === "setup" ? " active" : ""}" data-panel="setup">
      <div class="progress">
        <div class="progress-item ${models.length > 0 ? "done" : ""}"><strong>Models</strong>${models.length > 0 ? `${models.length} added` : "None yet"}</div>
        <div class="progress-item ${ready ? "done" : ""}"><strong>Proxy</strong>${ready ? "Running" : "Not running"}</div>
        <div class="progress-item"><strong>Cursor slot</strong>${escapeHtml(slotLabel)}</div>
        <div class="progress-item"><strong>Model names</strong>${enabledModels.length} ready</div>
      </div>

      <div class="card">
        <h2>1 · Start the proxy</h2>
        <p>OpenCursor runs a local router plus an HTTPS tunnel that Cursor can reach.</p>
        <div class="panel">${proxyContent}</div>
      </div>

      <div class="card">
        <h2>2 · Set Base URL and API key in Cursor</h2>
        <p>Google is the default slot because it leaves the OpenAI and Anthropic slots free.</p>
        <div class="panel">
          <div class="provider-row">
            <div>
              <strong>Cursor API key slot</strong>
              <p>The selected slot controls the prefix Cursor uses to route these models.</p>
            </div>
            <select data-provider-slot aria-label="Cursor API key slot">
              ${providerOption("google", providerSlot, "Google API Key — recommended")}
              ${providerOption("anthropic", providerSlot, "Anthropic API Key")}
              ${providerOption("openai", providerSlot, "OpenAI API Key")}
            </select>
          </div>
          ${baseUrlField}
          ${copyField("API Key", proxyApiKey)}
          <ol class="checklist">
            <li>Open <strong>Cursor Settings → Models</strong>.</li>
            <li>Enable <strong>Override OpenAI Base URL</strong> and paste the Base URL above.</li>
            <li>Paste the proxy key above into <strong>${escapeHtml(providerKeyLabel)}</strong> and enable it.</li>
          </ol>
          <button class="primary" data-command="openCursorSettings">Open Cursor model settings</button>
          <div class="callout">Use this generated proxy key in Cursor—not a model provider key. Provider keys stay in OpenCursor's secret storage.</div>
        </div>
      </div>

      <div class="card">
        <h2>3 · Add model names to Cursor</h2>
        <p>In Cursor Settings → Models, choose <strong>Add model</strong> and paste each exact name.</p>
        ${modelNames}
      </div>
    </section>`;
  }

  private renderModelsTab(models: SetupModel[]): string {
    const body =
      models.length === 0
        ? `<div class="empty">
            <div class="empty-icon">＋</div>
            <strong>No models added yet</strong>
            <p>Pick a known model or enter a custom provider URL, model ID, and API key. Keys stay in Cursor's secure secret storage.</p>
            <button class="primary" data-command="addModel">Add your first model</button>
          </div>`
        : models.map((model) => this.renderModelCard(model)).join("");

    return `<section class="tab-panel${this.activeTab === "models" ? " active" : ""}" data-panel="models">
      <div class="card">
        <div class="card-head">
          <div>
            <h2>Models</h2>
            <p>Each model keeps its own provider URL, model ID, protocol, API key, and variation.</p>
          </div>
          ${models.length > 0 ? `<button class="primary" data-command="addModel">Add model</button>` : ""}
        </div>
        ${body}
      </div>
    </section>`;
  }

  private renderModelCard(model: SetupModel): string {
    const summary = describeVariation({
      reasoningEffort: model.reasoningEffort,
      speedTier: model.speedTier,
    });

    return `<article class="model-card${model.enabled ? "" : " disabled"}">
      <div class="model-head">
        <div class="model-main">
          <div class="model-title">
            <strong>${escapeHtml(model.displayName)}</strong>
            <span class="badge ${model.enabled ? "success" : "muted-badge"}">${model.enabled ? "Enabled" : "Disabled"}</span>
            ${summary ? `<span class="badge info">${escapeHtml(summary)}</span>` : ""}
          </div>
          <code>${escapeHtml(model.cursorName)}</code>
          <div class="model-meta">
            ${escapeHtml(model.upstreamModel)} · ${escapeHtml(model.provider)}<br />
            ${escapeHtml(model.baseUrl)}
          </div>
        </div>
        <div class="model-actions">
          <button data-command="testModel" data-id="${escapeHtml(model.id)}">Test</button>
          <button data-command="editModel" data-id="${escapeHtml(model.id)}">Edit</button>
          <button data-command="toggleModel" data-id="${escapeHtml(model.id)}">${model.enabled ? "Disable" : "Enable"}</button>
          <button class="danger" data-command="deleteModel" data-id="${escapeHtml(model.id)}">Delete</button>
        </div>
      </div>
      <div class="variation-row">
        <label>
          <span>Thinking / reasoning</span>
          <select data-variation="reasoningEffort" data-id="${escapeHtml(model.id)}">
            ${effortOptions(model.reasoningEffort)}
          </select>
        </label>
        <label>
          <span>Speed</span>
          <select data-variation="speedTier" data-id="${escapeHtml(model.id)}">
            ${speedOptions(model.speedTier)}
          </select>
        </label>
      </div>
      <p class="variation-note">${variationNote(model)}</p>
    </article>`;
  }

  private renderSubagentsTab(
    subagent: SubagentSettings,
    enabledModels: SetupModel[],
    diagnostics: DiagnosticsSettings
  ): string {
    const modelOptions = enabledModels
      .map(
        (model) =>
          `<option value="${escapeHtml(model.slug)}">${escapeHtml(model.displayName)} (${escapeHtml(model.cursorName)})</option>`
      )
      .join("");

    // Every spelling `resolveSubagentModelName` accepts, so the field can warn
    // about an unusable value before it is committed.
    const knownTargets = enabledModels.flatMap((model) => [
      model.slug,
      model.cursorName,
      model.displayName,
    ]);

    const unresolved =
      subagent.enabled && subagent.model && !subagent.resolvedModel
        ? `<div class="callout warn">"${escapeHtml(subagent.model)}" doesn't match an enabled model, so subagent requests will keep whatever model the orchestrator picked. The override can only target a model you added here — the proxy has no way to hand a request back to Cursor's built-in models.</div>`
        : "";

    const inactive =
      subagent.enabled && !subagent.model
        ? `<div class="callout warn">Pick or type a model below — the override is on but has no target.</div>`
        : "";

    return `<section class="tab-panel${this.activeTab === "subagents" ? " active" : ""}" data-panel="subagents">
      <div class="card">
        <h2>Subagent routing</h2>
        <p>Force every subagent (Task tool) run onto one model, ignoring the model the orchestrating agent selected.</p>
        <div class="panel">
          <label class="switch">
            <input type="checkbox" data-setting="forceSubagentModel" ${subagent.enabled ? "checked" : ""} />
            <span><strong>Force a model for all subagent runs</strong><br />
            <span class="muted">Applies to every Cursor slot: OpenAI, Anthropic, and Google.</span></span>
          </label>
          ${inactive}
          ${unresolved}
          <div class="variation-row">
            <label class="combo">
              <span>Subagent model</span>
              <input
                type="text"
                list="subagent-model-options"
                placeholder="Type or pick a model"
                spellcheck="false"
                autocomplete="off"
                data-setting="subagentModel"
                data-known="${escapeHtml(JSON.stringify(knownTargets))}"
                value="${escapeHtml(subagent.model)}"
                ${subagent.enabled ? "" : "disabled"} />
              <datalist id="subagent-model-options">${modelOptions}</datalist>
              <span class="field-status" data-status-for="subagentModel"></span>
            </label>
            <label>
              <span>Thinking / reasoning</span>
              <select data-setting="subagentReasoningEffort" ${subagent.enabled ? "" : "disabled"}>
                ${inheritOptions(REASONING_EFFORTS, REASONING_EFFORT_LABELS, subagent.reasoningEffort)}
              </select>
            </label>
            <label>
              <span>Speed</span>
              <select data-setting="subagentSpeedTier" ${subagent.enabled ? "" : "disabled"}>
                ${inheritOptions(SPEED_TIERS, SPEED_TIER_LABELS, subagent.speedTier)}
              </select>
            </label>
          </div>
          <div class="callout">Leaving thinking or speed on <strong>Inherit</strong> uses whatever the target model's own variation is set to on the Models tab.</div>
        </div>
      </div>

      <div class="card">
        <h2>How subagents are detected</h2>
        <p>Cursor sends no explicit subagent marker, so detection is a heuristic over the request body.</p>
        <ul class="bullets">
          <li>A request carrying a <code>Task</code> tool is treated as the <strong>orchestrator</strong>.</li>
          <li>A request with tools but no <code>Task</code> tool is treated as a <strong>subagent</strong>.</li>
          <li>A request with no tools at all is left alone, so title generation and similar calls are never rerouted.</li>
        </ul>
        <div class="callout warn">Cursor can change its tool sets in any release. Verify with request logging before relying on this, or a prompt change could silently route your main agent to the subagent model.</div>
        <label class="switch">
          <input type="checkbox" data-setting="logRequestBodies" ${diagnostics.logRequestBodies ? "checked" : ""} />
          <span>Log detected roles and tool names for each request</span>
        </label>
        <button data-command="showLogs">Open request log</button>
      </div>
    </section>`;
  }

  private renderDiagnosticsTab(diagnostics: DiagnosticsSettings): string {
    return `<section class="tab-panel${this.activeTab === "diagnostics" ? " active" : ""}" data-panel="diagnostics">
      <div class="card">
        <h2>Diagnostics</h2>
        <p>Logging goes to the <strong>Open Cursor Models</strong> output channel.</p>
        <div class="panel">
          <label class="switch">
            <input type="checkbox" data-setting="logRequests" ${diagnostics.logRequests ? "checked" : ""} />
            <span><strong>Log request paths and routes</strong><br />
            <span class="muted">Method, path, and which upstream model each request mapped to.</span></span>
          </label>
          <label class="switch">
            <input type="checkbox" data-setting="logRequestBodies" ${diagnostics.logRequestBodies ? "checked" : ""} />
            <span><strong>Log agent role, tools, and system prompt preview</strong><br />
            <span class="muted">Needed to verify subagent detection. May include prompt text in the output channel.</span></span>
          </label>
          <button data-command="showLogs">Open output channel</button>
        </div>
      </div>

      <div class="card">
        <h2>How variations are sent upstream</h2>
        <ul class="bullets">
          <li><strong>OpenAI-compatible</strong> — <code>reasoning_effort</code>, plus <code>service_tier</code> of <code>priority</code> for fast or <code>flex</code> for economy.</li>
          <li><strong>Claude 4.6 and newer</strong> — adaptive thinking with <code>output_config.effort</code>; token budgets are rejected on these models.</li>
          <li><strong>Claude 4.5 and older</strong> — <code>thinking.budget_tokens</code>, or <code>thinking.type: "disabled"</code> at none/minimal.</li>
          <li><strong>Anthropic speed</strong> — no true fast tier exists, so fast maps to <code>service_tier: "auto"</code> (allow priority capacity) and economy to <code>standard_only</code>.</li>
        </ul>
        <div class="callout">Families that cannot disable reasoning (adaptive Claude, Grok 4.5+) clamp none and minimal up to low rather than sending a value the API would reject.</div>
      </div>
    </section>`;
  }

  private dispose(): void {
    SetupWizardPanel.currentPanel = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function variationNote(model: SetupModel): string {
  if (model.provider !== "anthropic") {
    return "Sent as reasoning_effort and service_tier on the upstream request.";
  }

  return anthropicThinkingStyle(model.upstreamModel) === "adaptive"
    ? "Adaptive thinking model: effort is sent as output_config.effort."
    : "Pre-4.6 model: effort is sent as a thinking.budget_tokens budget.";
}

function effortOptions(selected: ReasoningEffort): string {
  return REASONING_EFFORTS.map(
    (effort) =>
      `<option value="${effort}"${effort === selected ? " selected" : ""}>${escapeHtml(REASONING_EFFORT_LABELS[effort])}</option>`
  ).join("");
}

function speedOptions(selected: SpeedTier): string {
  return SPEED_TIERS.map(
    (tier) =>
      `<option value="${tier}"${tier === selected ? " selected" : ""}>${escapeHtml(SPEED_TIER_LABELS[tier])}</option>`
  ).join("");
}

function inheritOptions<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
  selected: T | undefined
): string {
  const head = `<option value="inherit"${selected ? "" : " selected"}>Inherit from model</option>`;
  const rest = values
    .map(
      (value) =>
        `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(labels[value])}</option>`
    )
    .join("");
  return head + rest;
}

function copyField(label: string, value: string): string {
  return `<div class="copy-field">
    <label>${escapeHtml(label)}</label>
    <div class="copy-box">
      <code>${escapeHtml(value)}</code>
      <button data-copy="${escapeHtml(value)}" data-label="${escapeHtml(label.toLowerCase())}">Copy</button>
    </div>
  </div>`;
}

function providerOption(
  value: ProviderSlot,
  selected: ProviderSlot,
  label: string
): string {
  return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

export async function openCursorModelSettings(): Promise<void> {
  for (const command of ["aiSettings.action.open", "workbench.action.openSettings"]) {
    try {
      await vscode.commands.executeCommand(command);
      return;
    } catch {
      // Try the next command because Cursor command IDs change between releases.
    }
  }

  void vscode.window.showInformationMessage(
    "Open Cursor Settings → Models manually to finish setup."
  );
}

function styles(): string {
  return `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      line-height: 1.5;
    }
    main { width: min(940px, calc(100% - 48px)); margin: 0 auto; padding: 40px 0 80px; }
    header { margin-bottom: 20px; }
    .title-row { display: flex; align-items: center; gap: 12px; }
    h1 { margin: 0 0 4px; font-size: 26px; letter-spacing: -0.02em; }
    h2 { margin: 0 0 2px; font-size: 17px; }
    p { margin: 6px 0 0; color: var(--vscode-descriptionForeground); }
    .lede { max-width: 700px; font-size: 14px; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 3px 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      font-size: 11px;
    }
    .pill.ready { border-color: var(--vscode-testing-iconPassed); }
    .tabs { display: flex; gap: 4px; margin: 22px 0 24px; border-bottom: 1px solid var(--vscode-panel-border); }
    .tab {
      border: none;
      border-bottom: 2px solid transparent;
      border-radius: 0;
      background: none;
      color: var(--vscode-descriptionForeground);
      padding: 8px 14px;
    }
    .tab:hover { background: var(--vscode-list-hoverBackground); }
    .tab.active { border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-foreground); font-weight: 600; }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .card { padding: 20px 0; border-top: 1px solid var(--vscode-panel-border); }
    .card:first-of-type { border-top: none; padding-top: 0; }
    .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
    .progress { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 26px; }
    .progress-item {
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .progress-item.done { border-color: var(--vscode-testing-iconPassed); color: var(--vscode-foreground); }
    .progress-item strong { display: block; font-size: 13px; }
    button, select, input[type="text"] {
      min-height: 30px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 5px 11px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      font: inherit;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled, select:disabled, input:disabled { cursor: not-allowed; opacity: 0.5; }
    button.danger { color: var(--vscode-errorForeground); }
    select { min-width: 170px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
    input[type="text"] {
      min-width: 240px;
      border-color: var(--vscode-input-border, var(--vscode-panel-border));
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      cursor: text;
    }
    input[type="text"]:focus { outline: 1px solid var(--vscode-focusBorder); }
    .combo { position: relative; }
    .variation-row label > .field-status { font-size: 11px; text-transform: none; letter-spacing: normal; font-weight: 400; }
    .variation-row label > .field-status:empty { display: none; }
    .variation-row label > .field-status.ok { color: var(--vscode-testing-iconPassed); }
    .variation-row label > .field-status.warn { color: var(--vscode-editorWarning-foreground); }
    code { color: var(--vscode-textPreformat-foreground); font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
    .model-card, .panel, .copy-row, .pending-field {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: var(--vscode-editorWidget-background);
    }
    .model-card { padding: 14px; margin-top: 10px; }
    .model-card.disabled { opacity: 0.66; }
    .model-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
    .model-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
    .model-meta { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .model-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .variation-row { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 14px; }
    .variation-row label { display: flex; flex-direction: column; gap: 4px; }
    .variation-row label > span { color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
    .variation-note { margin-top: 10px; font-size: 11px; }
    .badge { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; }
    .success { color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent); }
    .info { color: var(--vscode-editorInfo-foreground); background: color-mix(in srgb, var(--vscode-editorInfo-foreground) 12%, transparent); }
    .muted-badge { color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); }
    .empty { padding: 28px; text-align: center; border: 1px dashed var(--vscode-panel-border); border-radius: 7px; }
    .empty p { max-width: 560px; margin: 6px auto 16px; }
    .empty-icon { font-size: 25px; color: var(--vscode-descriptionForeground); }
    .panel { padding: 16px; margin-top: 12px; }
    .status-line { display: flex; gap: 11px; align-items: flex-start; margin-bottom: 14px; }
    .status-line p { font-size: 12px; }
    .status-dot { width: 10px; height: 10px; margin-top: 6px; border-radius: 50%; background: var(--vscode-testing-iconFailed); }
    .pill .status-dot { margin-top: 0; width: 8px; height: 8px; }
    .status-dot.ready { background: var(--vscode-testing-iconPassed); }
    .provider-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .provider-row p { font-size: 12px; }
    .switch { display: flex; align-items: flex-start; gap: 10px; margin: 4px 0 14px; cursor: pointer; }
    .switch input { margin-top: 4px; }
    .checklist { margin: 16px 0 0; padding-left: 22px; }
    .checklist li, .bullets li { margin: 9px 0; }
    .bullets { margin: 12px 0 0; padding-left: 22px; color: var(--vscode-descriptionForeground); font-size: 13px; }
    .copy-field { margin: 10px 0; }
    .copy-field label { display: block; margin-bottom: 5px; color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600; }
    .copy-box, .copy-row { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 11px; }
    .copy-box { border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); }
    .copy-box code, .copy-row code { flex: 1; }
    .copy-list { display: grid; gap: 8px; margin: 12px 0 10px; }
    .pending-field, .empty-copy { padding: 12px; color: var(--vscode-descriptionForeground); }
    .callout {
      margin: 14px 0;
      padding: 11px 13px;
      border-left: 3px solid var(--vscode-editorInfo-foreground);
      background: var(--vscode-textBlockQuote-background);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .callout.warn { border-left-color: var(--vscode-editorWarning-foreground); }
    @media (max-width: 720px) {
      main { width: min(100% - 28px, 940px); padding-top: 26px; }
      .progress { grid-template-columns: 1fr 1fr; }
      .model-head, .provider-row, .card-head { align-items: stretch; flex-direction: column; }
      .model-actions { justify-content: flex-start; }
      .tabs { overflow-x: auto; }
    }
  `;
}

function script(): string {
  return `
    const vscode = acquireVsCodeApi();

    document.addEventListener('click', (event) => {
      const tab = event.target.closest('.tab');
      if (tab) {
        document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el === tab));
        document.querySelectorAll('.tab-panel').forEach((el) => {
          el.classList.toggle('active', el.dataset.panel === tab.dataset.tab);
        });
        vscode.postMessage({ command: 'setTab', tab: tab.dataset.tab });
        return;
      }

      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.dataset.copy !== undefined) {
        vscode.postMessage({ command: 'copy', text: button.dataset.copy, label: button.dataset.label });
        return;
      }
      if (button.dataset.command) {
        vscode.postMessage({ command: button.dataset.command, id: button.dataset.id });
      }
    });

    // Mirrors resolveSubagentModelName loosely: enough to flag a typo before the
    // value is committed, without a round trip to the extension.
    const showFieldStatus = (el) => {
      const status = document.querySelector('[data-status-for="' + el.dataset.setting + '"]');
      if (!status) return;

      const value = el.value.trim();
      const known = JSON.parse(el.dataset.known || '[]');
      if (!value) {
        status.className = 'field-status warn';
        status.textContent = 'No target set — subagents keep the orchestrator\\'s model.';
        return;
      }

      const match = known.some((name) => name.toLowerCase() === value.toLowerCase());
      status.className = 'field-status ' + (match ? 'ok' : 'warn');
      status.textContent = match
        ? 'Matches an enabled model.'
        : 'No enabled model by that name — must be one you added here.';
    };

    document.querySelectorAll('[data-known]').forEach((el) => {
      if (!el.disabled) showFieldStatus(el);
    });

    document.addEventListener('input', (event) => {
      if (event.target.dataset && event.target.dataset.known !== undefined) {
        showFieldStatus(event.target);
      }
    });

    document.addEventListener('change', (event) => {
      const el = event.target;
      if (el.dataset.providerSlot !== undefined) {
        vscode.postMessage({ command: 'setProviderSlot', providerSlot: el.value });
        return;
      }
      if (el.dataset.variation) {
        vscode.postMessage({
          command: 'setModelVariation',
          id: el.dataset.id,
          field: el.dataset.variation,
          value: el.value,
        });
        return;
      }
      if (el.dataset.setting) {
        vscode.postMessage({
          command: 'updateSetting',
          key: el.dataset.setting,
          value: el.type === 'checkbox' ? el.checked : el.value.trim(),
        });
      }
    });
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getNonce(): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
