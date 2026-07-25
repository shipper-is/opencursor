import * as vscode from "vscode";
import { ProviderSlot, SLOT_LABELS } from "./types";

export interface SetupModel {
  id: string;
  displayName: string;
  cursorName: string;
  upstreamModel: string;
  baseUrl: string;
  provider: string;
  enabled: boolean;
}

export interface SetupWizardOptions {
  proxyPort: number;
  proxyApiKey: string;
  proxyRunning: boolean;
  models: SetupModel[];
  cursorBaseUrl?: string;
  tunnelProvider?: string;
  tunnelError?: string;
  providerSlot: ProviderSlot;
}

export class SetupWizardPanel {
  public static currentPanel: SetupWizardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

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

  static show(options: SetupWizardOptions): void {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (SetupWizardPanel.currentPanel) {
      SetupWizardPanel.currentPanel.options = options;
      SetupWizardPanel.currentPanel.render();
      SetupWizardPanel.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "openCursorModelsSetup",
      "Open Cursor Models Setup",
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    SetupWizardPanel.currentPanel = new SetupWizardPanel(panel, options);
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
      models,
      providerSlot,
      proxyApiKey,
      proxyPort,
      proxyRunning,
      tunnelError,
      tunnelProvider,
    } = this.options;
    const enabledModels = models.filter((model) => model.enabled);
    const slotLabel = SLOT_LABELS[providerSlot];
    const providerKeyLabel = `${slotLabel} API Key`;
    const ready = proxyRunning && Boolean(cursorBaseUrl);

    const modelCards =
      models.length === 0
        ? `<div class="empty">
            <div class="empty-icon">＋</div>
            <strong>No models added yet</strong>
            <p>Pick a known Claude model or enter a custom provider URL, model ID, and API key. Keys stay in Cursor's secure secret storage.</p>
            <button class="primary" data-command="addModel">Add your first model</button>
          </div>`
        : models
            .map(
              (model) => `<article class="model-card${model.enabled ? "" : " disabled"}">
                <div class="model-main">
                  <div class="model-title">
                    <strong>${escapeHtml(model.displayName)}</strong>
                    <span class="badge ${model.enabled ? "success" : "muted-badge"}">${model.enabled ? "Enabled" : "Disabled"}</span>
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
              </article>`
            )
            .join("");

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

    const proxyContent = ready
      ? `<div class="status-line">
          <span class="status-dot ready"></span>
          <div>
            <strong>Proxy and tunnel are running</strong>
            <p>${escapeHtml(tunnelProvider ?? "HTTPS tunnel")} · local port ${proxyPort}</p>
          </div>
        </div>
        <button data-command="startProxy">Restart proxy</button>`
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

    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${this.panel.webview.cspSource} data:`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      line-height: 1.5;
    }
    main { width: min(920px, calc(100% - 48px)); margin: 0 auto; padding: 44px 0 80px; }
    header { margin-bottom: 28px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.02em; }
    h2 { margin: 0; font-size: 18px; }
    p { margin: 6px 0 0; color: var(--vscode-descriptionForeground); }
    .lede { max-width: 680px; font-size: 15px; }
    .progress {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin: 24px 0 32px;
    }
    .progress-item {
      padding: 10px 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .progress-item.done { border-color: var(--vscode-testing-iconPassed); color: var(--vscode-foreground); }
    .progress-item strong { display: block; font-size: 13px; }
    .step {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 14px;
      padding: 24px 0;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .step-number {
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-weight: 700;
    }
    .step-body > p { margin-bottom: 16px; }
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
    button, select {
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
    button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { cursor: not-allowed; opacity: 0.5; }
    button.danger { color: var(--vscode-errorForeground); }
    select { min-width: 180px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); }
    code {
      color: var(--vscode-textPreformat-foreground);
      font-family: var(--vscode-editor-font-family);
      overflow-wrap: anywhere;
    }
    .model-card, .panel, .copy-row, .pending-field {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: var(--vscode-editorWidget-background);
    }
    .model-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding: 14px;
      margin-top: 8px;
    }
    .model-card.disabled { opacity: 0.66; }
    .model-title { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .model-meta { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .model-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
    .badge { padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; }
    .success { color: var(--vscode-testing-iconPassed); background: color-mix(in srgb, var(--vscode-testing-iconPassed) 12%, transparent); }
    .muted-badge { color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); }
    .empty {
      padding: 28px;
      text-align: center;
      border: 1px dashed var(--vscode-panel-border);
      border-radius: 7px;
    }
    .empty p { max-width: 560px; margin: 6px auto 16px; }
    .empty-icon { font-size: 25px; color: var(--vscode-descriptionForeground); }
    .panel { padding: 16px; }
    .status-line { display: flex; gap: 11px; align-items: flex-start; margin-bottom: 14px; }
    .status-line p { font-size: 12px; }
    .status-dot { width: 10px; height: 10px; margin-top: 6px; border-radius: 50%; background: var(--vscode-testing-iconFailed); }
    .status-dot.ready { background: var(--vscode-testing-iconPassed); }
    .provider-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .provider-row p { font-size: 12px; }
    .checklist { margin: 16px 0 0; padding-left: 22px; }
    .checklist li { margin: 10px 0; }
    .copy-field { margin: 10px 0; }
    .copy-field label { display: block; margin-bottom: 5px; color: var(--vscode-descriptionForeground); font-size: 12px; font-weight: 600; }
    .copy-box, .copy-row { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 11px; }
    .copy-box { border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); }
    .copy-box code, .copy-row code { flex: 1; }
    .copy-list { display: grid; gap: 8px; margin-bottom: 10px; }
    .pending-field, .empty-copy { padding: 12px; color: var(--vscode-descriptionForeground); }
    .callout {
      margin-top: 14px;
      padding: 11px 13px;
      border-left: 3px solid var(--vscode-editorInfo-foreground);
      background: var(--vscode-textBlockQuote-background);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    @media (max-width: 700px) {
      main { width: min(100% - 28px, 920px); padding-top: 28px; }
      .progress { grid-template-columns: 1fr 1fr; }
      .model-card, .provider-row { align-items: stretch; flex-direction: column; }
      .model-actions { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Open Cursor Models Setup</h1>
      <p class="lede">Route any supported provider through Cursor in four steps. This page is the only setup surface you need.</p>
    </header>

    <div class="progress">
      <div class="progress-item ${models.length > 0 ? "done" : ""}"><strong>1 · Models</strong>${models.length > 0 ? `${models.length} added` : "Not started"}</div>
      <div class="progress-item ${ready ? "done" : ""}"><strong>2 · Proxy</strong>${ready ? "Running" : "Not running"}</div>
      <div class="progress-item"><strong>3 · Cursor settings</strong>${slotLabel} slot</div>
      <div class="progress-item"><strong>4 · Model names</strong>${enabledModels.length} ready</div>
    </div>

    <section class="step">
      <div class="step-number">1</div>
      <div class="step-body">
        <h2>Add models</h2>
        <p>Each model keeps its own provider URL, model ID, protocol, and API key.</p>
        ${models.length > 0 ? `<div class="toolbar"><button class="primary" data-command="addModel">Add model</button></div>` : ""}
        ${modelCards}
      </div>
    </section>

    <section class="step">
      <div class="step-number">2</div>
      <div class="step-body">
        <h2>Start the proxy</h2>
        <p>OpenCursor starts the local router and an HTTPS tunnel that Cursor can reach.</p>
        <div class="panel">${proxyContent}</div>
      </div>
    </section>

    <section class="step">
      <div class="step-number">3</div>
      <div class="step-body">
        <h2>Set Base URL and API key in Cursor</h2>
        <p>Google is the default slot because it keeps the OpenAI and Anthropic slots available. Change it here if needed.</p>
        <div class="panel">
          <div class="provider-row">
            <div>
              <strong>Cursor API key slot</strong>
              <p>The selected slot controls the prefix Cursor uses to route these models.</p>
            </div>
            <select id="providerSlot" aria-label="Cursor API key slot">
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
            <li>Paste the proxy key above into <strong>${providerKeyLabel}</strong> and enable <strong>${providerKeyLabel}</strong>.</li>
          </ol>
          <button class="primary" data-command="openCursorSettings">Open Cursor model settings</button>
          <div class="callout">Use this generated proxy key in Cursor—not any model provider key. Provider keys remain stored per model in OpenCursor.</div>
        </div>
      </div>
    </section>

    <section class="step">
      <div class="step-number">4</div>
      <div class="step-body">
        <h2>Add model names to Cursor</h2>
        <p>In Cursor Settings → Models, choose <strong>Add model</strong> and paste each exact name. OpenCursor routes that readable name to the upstream model ID automatically.</p>
        ${modelNames}
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target || target.disabled) return;
      if (target.dataset.copy !== undefined) {
        vscode.postMessage({ command: 'copy', text: target.dataset.copy, label: target.dataset.label });
        return;
      }
      if (target.dataset.command) {
        vscode.postMessage({ command: target.dataset.command, id: target.dataset.id });
      }
    });
    document.getElementById('providerSlot').addEventListener('change', (event) => {
      vscode.postMessage({ command: 'setProviderSlot', providerSlot: event.target.value });
    });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    SetupWizardPanel.currentPanel = undefined;
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
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
