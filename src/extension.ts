import * as vscode from "vscode";
import { ModelStore, variationFor } from "./modelStore";
import { promptForModel, testModelConnection } from "./modelActions";
import { ProxyServer } from "./proxyServer";
import { SetupWizardOptions, SetupWizardPanel } from "./setupWizard";
import { isReasoningEffort, isSpeedTier } from "./modelVariations";
import { publicBaseUrl, ProviderSlot, ProxyRuntimeConfig } from "./types";
import { TunnelManager } from "./tunnelManager";
import {
  InstanceStatus,
  isPortInUseError,
  probeInstance,
  pushConfig,
} from "./instanceCoordinator";

/** Settings the settings page is allowed to write. */
const WRITABLE_SETTINGS = new Set([
  "logRequests",
  "logRequestBodies",
  "forceSubagentModel",
  "subagentModel",
  "subagentReasoningEffort",
  "subagentSpeedTier",
]);

const ONBOARDING_SHOWN_KEY = "openCursorModels.onboardingShown";

/** How often a follower window re-checks that the leader is still alive. */
const FOLLOWER_POLL_MS = 10_000;

let extensionContext: vscode.ExtensionContext;
let outputChannel: vscode.OutputChannel;
let proxyServer: ProxyServer;
let tunnelManager: TunnelManager;
let modelStore: ModelStore;
let statusBarItem: vscode.StatusBarItem;
let lastProxyError: string | undefined;
let lastTunnelError: string | undefined;
/** Set when another Cursor window owns the proxy and tunnel for this machine. */
let sharedInstance: InstanceStatus | undefined;
let followerTimer: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Open Cursor Models");
  proxyServer = new ProxyServer();
  proxyServer.setLogger((message) => outputChannel.appendLine(message));
  proxyServer.setConfigPushHandler(() => void refreshSetup());
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
    ),
    vscode.commands.registerCommand(
      "openCursorModels.setModelVariation",
      (id: string, field: string, value: string) =>
        setModelVariation(id, field, value)
    ),
    vscode.commands.registerCommand(
      "openCursorModels.updateSetting",
      (key: string, value: string | boolean) => updateSetting(key, value)
    ),
    vscode.commands.registerCommand("openCursorModels.showLogs", () =>
      outputChannel.show(true)
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
        event.affectsConfiguration("openCursorModels.logRequestBodies") ||
        event.affectsConfiguration("openCursorModels.forceSubagentModel") ||
        event.affectsConfiguration("openCursorModels.subagentModel") ||
        event.affectsConfiguration("openCursorModels.subagentReasoningEffort") ||
        event.affectsConfiguration("openCursorModels.subagentSpeedTier") ||
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
  } else {
    // Even when this window should not launch anything, another window may
    // already be serving — attach so the setup page shows the live Base URL.
    await attachToRunningInstance();
  }

  if (!context.globalState.get<boolean>(ONBOARDING_SHOWN_KEY, false)) {
    await context.globalState.update(ONBOARDING_SHOWN_KEY, true);
    await openSetup();
  }
}

export async function deactivate(): Promise<void> {
  stopFollowing();
  // A follower owns neither of these, so both stops are no-ops there and the
  // leader's proxy keeps serving the remaining windows.
  await tunnelManager?.stop();
  await proxyServer?.stop();
}

async function openSetup(): Promise<void> {
  SetupWizardPanel.show(await buildSetupOptions());
}

async function buildSetupOptions(): Promise<SetupWizardOptions> {
  const profiles = await modelStore.listProfiles();
  const publicUrl = activePublicUrl();

  return {
    proxyPort: proxyServer.getPort() ?? modelStore.getProxyPort(),
    proxyApiKey: await modelStore.getProxyApiKey(),
    proxyRunning: proxyServer.isRunning() || Boolean(sharedInstance),
    cursorBaseUrl: publicUrl ? publicBaseUrl(publicUrl) : undefined,
    tunnelProvider: tunnelManager.getProvider() ?? sharedInstance?.tunnelProvider,
    tunnelError: lastTunnelError ?? lastProxyError,
    sharedFromOtherWindow: Boolean(sharedInstance),
    providerSlot: modelStore.getProviderSlot(),
    subagent: {
      enabled: modelStore.isForceSubagentModelEnabled(),
      model: modelStore.getSubagentModelSetting(),
      resolvedModel: await modelStore.getResolvedSubagentModel(),
      reasoningEffort: modelStore.getSubagentEffort(),
      speedTier: modelStore.getSubagentSpeedTier(),
    },
    diagnostics: {
      logRequests: modelStore.getLogRequests(),
      logRequestBodies: modelStore.getLogRequestBodies(),
    },
    models: profiles.map((profile) => {
      const variation = variationFor(profile);
      return {
        id: profile.id,
        displayName: profile.displayName,
        cursorName: modelStore.cursorNameFor(profile),
        slug: profile.cursorSlug ?? profile.id,
        upstreamModel: profile.upstreamModel,
        baseUrl: profile.baseUrl,
        provider: profile.provider,
        enabled: profile.enabled,
        reasoningEffort: variation.reasoningEffort,
        speedTier: variation.speedTier,
      };
    }),
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

  const runtimeConfig = await modelStore.buildProxyConfig();

  try {
    await tunnelManager.stop();
    const port = await proxyServer.start(runtimeConfig);
    stopFollowing();
    outputChannel.appendLine(
      `Proxy ready locally at http://127.0.0.1:${port}/v1`
    );

    try {
      const tunnel = await tunnelManager.start(port);
      proxyServer.setTunnelInfo(tunnel.publicUrl, tunnel.provider);
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
    // Another Cursor window most likely already owns the port. Share its
    // proxy and tunnel instead of fighting over them.
    if (isPortInUseError(error) && (await startFollowing(runtimeConfig, notify))) {
      await refreshSetup();
      return;
    }

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

/** Joins an already-running proxy without trying to start one of our own. */
async function attachToRunningInstance(): Promise<void> {
  const config = await modelStore.buildProxyConfig();
  await startFollowing(config, false);
  await refreshSetup();
}

/**
 * Attaches this window to the proxy owned by another Cursor window. Returns
 * false when the port is held by something that is not an OpenCursor proxy,
 * so the caller can report the original bind failure.
 */
async function startFollowing(
  runtimeConfig: ProxyRuntimeConfig,
  notify: boolean
): Promise<boolean> {
  const status = await probeInstance(runtimeConfig.port, runtimeConfig.proxyApiKey);
  if (!status) {
    return false;
  }

  sharedInstance = status;
  lastProxyError = undefined;
  lastTunnelError = undefined;
  outputChannel.appendLine(
    `Reusing the proxy and tunnel already running in another Cursor window (pid ${status.ownerPid}).`
  );

  // Only publish routes we can actually serve, so a window that has not yet
  // loaded the shared model list cannot blank out the leader's routing table.
  if (runtimeConfig.models.some((model) => model.enabled)) {
    await pushConfig(runtimeConfig.port, runtimeConfig.proxyApiKey, runtimeConfig);
  }

  if (notify) {
    void vscode.window.showInformationMessage(
      "OpenCursor is already running in another Cursor window — this window now shares the same tunnel and models."
    );
  }

  watchLeader();
  return true;
}

/**
 * Keeps the shared Base URL current and takes over as leader if the window
 * that owned the proxy goes away.
 */
function watchLeader(): void {
  followerTimer ??= setInterval(() => {
    void (async () => {
      if (!sharedInstance) {
        return;
      }

      const port = modelStore.getProxyPort();
      const status = await probeInstance(port, await modelStore.getProxyApiKey());

      if (!status) {
        stopFollowing();
        const profiles = await modelStore.listProfiles();
        if (!profiles.some((profile) => profile.enabled)) {
          outputChannel.appendLine(
            "The Cursor window that owned the proxy is gone; no enabled models here to take it over."
          );
          await refreshSetup();
          return;
        }

        outputChannel.appendLine(
          "The Cursor window that owned the proxy is gone — taking over."
        );
        await startProxy();
        return;
      }

      const changed =
        status.publicUrl !== sharedInstance.publicUrl ||
        status.ownerPid !== sharedInstance.ownerPid;
      sharedInstance = status;
      if (changed) {
        await refreshSetup();
      }
    })();
  }, FOLLOWER_POLL_MS);
}

function stopFollowing(): void {
  sharedInstance = undefined;
  if (followerTimer) {
    clearInterval(followerTimer);
    followerTimer = undefined;
  }
}

async function refreshProxyConfig(): Promise<void> {
  if (proxyServer.isRunning()) {
    proxyServer.updateConfig(await modelStore.buildProxyConfig());
    outputChannel.appendLine("Updated proxy model routes");
  } else if (sharedInstance) {
    const config = await modelStore.buildProxyConfig();
    const pushed = await pushConfig(config.port, config.proxyApiKey, config);
    outputChannel.appendLine(
      pushed
        ? "Sent updated model routes to the Cursor window running the proxy"
        : "Could not reach the Cursor window running the proxy"
    );
  }
  await refreshSetup();
}

/** Public URL of whichever proxy serves this window — ours or another window's. */
function activePublicUrl(): string | undefined {
  return tunnelManager?.getPublicUrl() ?? sharedInstance?.publicUrl;
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

async function setModelVariation(
  id: string,
  field: string,
  value: string
): Promise<void> {
  if (field === "reasoningEffort" && isReasoningEffort(value)) {
    await modelStore.setVariation(id, { reasoningEffort: value });
  } else if (field === "speedTier" && isSpeedTier(value)) {
    await modelStore.setVariation(id, { speedTier: value });
  } else {
    return;
  }

  await refreshProxyConfig();
}

async function updateSetting(
  key: string,
  value: string | boolean
): Promise<void> {
  if (!WRITABLE_SETTINGS.has(key)) {
    return;
  }

  await vscode.workspace
    .getConfiguration("openCursorModels")
    .update(key, value, vscode.ConfigurationTarget.Global);
  // The configuration listener handles refreshing the proxy and the page.
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

  if (activePublicUrl()) {
    statusBarItem.text = "$(pass-filled) Custom Models";
    statusBarItem.tooltip = sharedInstance
      ? "OpenCursor is ready — sharing the tunnel from another Cursor window"
      : "OpenCursor is ready — click to open setup";
  } else if (lastProxyError || lastTunnelError) {
    statusBarItem.text = "$(warning) Custom Models";
    statusBarItem.tooltip = "OpenCursor needs attention — click to open setup";
  } else {
    statusBarItem.text = "$(settings-gear) Custom Models";
    statusBarItem.tooltip = "Open OpenCursor Models Setup";
  }
}
