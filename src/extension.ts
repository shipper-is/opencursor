import * as vscode from "vscode";
import { ModelStore } from "./modelStore";
import { promptForModel, testModelConnection } from "./modelActions";
import { ProxyServer } from "./proxyServer";
import { SetupWizardOptions, SetupWizardPanel } from "./setupWizard";
import { publicBaseUrl, ProviderSlot } from "./types";
import { TunnelManager } from "./tunnelManager";

const ONBOARDING_SHOWN_KEY = "openCursorModels.onboardingShown";

let extensionContext: vscode.ExtensionContext;
let outputChannel: vscode.OutputChannel;
let proxyServer: ProxyServer;
let tunnelManager: TunnelManager;
let modelStore: ModelStore;
let statusBarItem: vscode.StatusBarItem;
let lastProxyError: string | undefined;
let lastTunnelError: string | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Open Cursor Models");
  proxyServer = new ProxyServer();
  proxyServer.setLogger((message) => outputChannel.appendLine(message));
  tunnelManager = new TunnelManager();
  tunnelManager.setLogger((message) => outputChannel.appendLine(message));
  modelStore = new ModelStore(context);

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "openCursorModels.openSetup";
  context.subscriptions.push(outputChannel, statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("openCursorModels.openSetup", () =>
      openSetup()
    ),
    vscode.commands.registerCommand("openCursorModels.addModel", () =>
      addModel()
    ),
    vscode.commands.registerCommand("openCursorModels.editModel", (id: string) =>
      editModel(id)
    ),
    vscode.commands.registerCommand(
      "openCursorModels.deleteModel",
      (id: string) => deleteModel(id)
    ),
    vscode.commands.registerCommand(
      "openCursorModels.toggleModel",
      (id: string) => toggleModel(id)
    ),
    vscode.commands.registerCommand("openCursorModels.testModel", (id: string) =>
      testModel(id)
    ),
    vscode.commands.registerCommand("openCursorModels.startProxy", () =>
      startProxy(true)
    ),
    vscode.commands.registerCommand(
      "openCursorModels.setProviderSlot",
      (slot: ProviderSlot) => setProviderSlot(slot)
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("openCursorModels.proxyPort") ||
        event.affectsConfiguration("openCursorModels.tunnelProvider")
      ) {
        if (proxyServer.isRunning()) {
          void startProxy();
        } else {
          void refreshSetup();
        }
        return;
      }

      if (
        event.affectsConfiguration("openCursorModels.logRequests") ||
        event.affectsConfiguration("openCursorModels.modelPrefix") ||
        event.affectsConfiguration("openCursorModels.providerSlot")
      ) {
        void refreshProxyConfig();
      }
    })
  );

  updateStatusBar();
  statusBarItem.show();

  const profiles = await modelStore.listProfiles();
  const autoStart = vscode.workspace
    .getConfiguration("openCursorModels")
    .get<boolean>("autoStartProxy", true);

  if (autoStart && profiles.some((profile) => profile.enabled)) {
    await startProxy();
  }

  if (!context.globalState.get<boolean>(ONBOARDING_SHOWN_KEY, false)) {
    await context.globalState.update(ONBOARDING_SHOWN_KEY, true);
    await openSetup();
  }
}

export async function deactivate(): Promise<void> {
  await tunnelManager?.stop();
  await proxyServer?.stop();
}

async function openSetup(): Promise<void> {
  SetupWizardPanel.show(await buildSetupOptions());
}

async function buildSetupOptions(): Promise<SetupWizardOptions> {
  const profiles = await modelStore.listProfiles();
  const publicUrl = tunnelManager.getPublicUrl();

  return {
    proxyPort: proxyServer.getPort() ?? modelStore.getProxyPort(),
    proxyApiKey: await modelStore.getProxyApiKey(),
    proxyRunning: proxyServer.isRunning(),
    cursorBaseUrl: publicUrl ? publicBaseUrl(publicUrl) : undefined,
    tunnelProvider: tunnelManager.getProvider(),
    tunnelError: lastTunnelError ?? lastProxyError,
    providerSlot: modelStore.getProviderSlot(),
    models: profiles.map((profile) => ({
      id: profile.id,
      displayName: profile.displayName,
      cursorName: modelStore.cursorNameFor(profile),
      upstreamModel: profile.upstreamModel,
      baseUrl: profile.baseUrl,
      provider: profile.provider,
      enabled: profile.enabled,
    })),
  };
}

async function refreshSetup(): Promise<void> {
  updateStatusBar();
  if (SetupWizardPanel.currentPanel) {
    SetupWizardPanel.currentPanel.update(await buildSetupOptions());
  }
}

async function startProxy(notify = false): Promise<void> {
  const profiles = await modelStore.listProfiles();
  if (!profiles.some((profile) => profile.enabled)) {
    void vscode.window.showWarningMessage(
      "Add and enable at least one model before starting the proxy."
    );
    await refreshSetup();
    return;
  }

  lastProxyError = undefined;
  lastTunnelError = undefined;
  updateStatusBar("starting");

  try {
    await tunnelManager.stop();
    const port = await proxyServer.start(await modelStore.buildProxyConfig());
    outputChannel.appendLine(
      `Proxy ready locally at http://127.0.0.1:${port}/v1`
    );

    try {
      const tunnel = await tunnelManager.start(port);
      outputChannel.appendLine(
        `Cursor Base URL: ${publicBaseUrl(tunnel.publicUrl)} (${tunnel.provider})`
      );
      if (notify) {
        void vscode.window.showInformationMessage(
          "OpenCursor proxy is ready. Continue with step 3 in the setup page."
        );
      }
    } catch (error) {
      lastTunnelError =
        error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`Tunnel failed: ${lastTunnelError}`);
      if (notify) {
        void vscode.window.showErrorMessage(
          `The local proxy started, but the HTTPS tunnel failed: ${lastTunnelError}`
        );
      }
    }
  } catch (error) {
    lastProxyError = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`Proxy failed: ${lastProxyError}`);
    if (notify) {
      void vscode.window.showErrorMessage(
        `OpenCursor could not start the proxy: ${lastProxyError}`
      );
    }
  }

  await refreshSetup();
}

async function refreshProxyConfig(): Promise<void> {
  if (proxyServer.isRunning()) {
    proxyServer.updateConfig(await modelStore.buildProxyConfig());
    outputChannel.appendLine("Updated proxy model routes");
  }
  await refreshSetup();
}

async function addModel(): Promise<void> {
  const values = await promptForModel("Add model");
  if (!values) {
    return;
  }

  const profile = await modelStore.addProfile(values);
  await refreshProxyConfig();
  void vscode.window.showInformationMessage(
    `Added ${profile.displayName}. Next: start the proxy.`
  );
}

async function editModel(id: string): Promise<void> {
  const profile = await modelStore.getProfile(id);
  if (!profile) {
    return;
  }

  const existingKey = (await modelStore.getApiKey(id)) ?? "";
  const values = await promptForModel("Edit model", {
    displayName: profile.displayName,
    upstreamModel: profile.upstreamModel,
    baseUrl: profile.baseUrl,
    provider: profile.provider,
  });
  if (!values) {
    return;
  }

  if (!values.apiKey.trim()) {
    values.apiKey = existingKey;
  }

  await modelStore.updateProfile(id, values);
  await refreshProxyConfig();
}

async function deleteModel(id: string): Promise<void> {
  const profile = await modelStore.getProfile(id);
  if (!profile) {
    return;
  }

  const choice = await vscode.window.showWarningMessage(
    `Delete "${profile.displayName}"?`,
    { modal: true },
    "Delete"
  );
  if (choice !== "Delete") {
    return;
  }

  await modelStore.deleteProfile(id);
  await refreshProxyConfig();
}

async function toggleModel(id: string): Promise<void> {
  await modelStore.toggleProfile(id);
  await refreshProxyConfig();
}

async function testModel(id: string): Promise<void> {
  const profile = await modelStore.getProfile(id);
  if (!profile) {
    return;
  }

  const result = await testModelConnection({
    displayName: profile.displayName,
    upstreamModel: profile.upstreamModel,
    baseUrl: profile.baseUrl,
    provider: profile.provider,
    apiKey: (await modelStore.getApiKey(id)) ?? "",
  });

  if (result.ok) {
    void vscode.window.showInformationMessage(
      `${profile.displayName}: ${result.message}`
    );
  } else {
    void vscode.window.showErrorMessage(
      `${profile.displayName}: ${result.message}`
    );
  }
}

async function setProviderSlot(slot: ProviderSlot): Promise<void> {
  if (!["google", "anthropic", "openai"].includes(slot)) {
    return;
  }
  if (slot === modelStore.getProviderSlot()) {
    return;
  }

  await vscode.workspace
    .getConfiguration("openCursorModels")
    .update("providerSlot", slot, vscode.ConfigurationTarget.Global);
  await refreshProxyConfig();
}

function updateStatusBar(state?: "starting"): void {
  if (state === "starting") {
    statusBarItem.text = "$(sync~spin) Custom Models";
    statusBarItem.tooltip = "Starting OpenCursor proxy and HTTPS tunnel";
    return;
  }

  if (tunnelManager?.getPublicUrl()) {
    statusBarItem.text = "$(pass-filled) Custom Models";
    statusBarItem.tooltip = "OpenCursor is ready — click to open setup";
  } else if (lastProxyError || lastTunnelError) {
    statusBarItem.text = "$(warning) Custom Models";
    statusBarItem.tooltip = "OpenCursor needs attention — click to open setup";
  } else {
    statusBarItem.text = "$(settings-gear) Custom Models";
    statusBarItem.tooltip = "Open OpenCursor Models Setup";
  }
}
