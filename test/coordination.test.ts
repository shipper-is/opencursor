import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { ProxyServer } from "../src/proxyServer.ts";
import {
  isPortInUseError,
  probeInstance,
  pushConfig,
} from "../src/instanceCoordinator.ts";
import { ProxyRuntimeConfig } from "../src/types.ts";

const PORT = 18999;
const KEY = "ocm-test-key";

function model(name: string): ProxyRuntimeConfig["models"][number] {
  return {
    cursorModelName: name,
    upstreamModel: "upstream",
    baseUrl: "https://example.invalid",
    apiKey: "k",
    provider: "openai-compatible",
    enabled: true,
    reasoningEffort: "inherit",
    speedTier: "inherit",
  };
}

function config(names: string[]): ProxyRuntimeConfig {
  return {
    port: PORT,
    proxyApiKey: KEY,
    modelPrefix: "gemini-oc-",
    logRequests: false,
    logRequestBodies: false,
    models: names.map(model),
  };
}

describe("multi-window coordination", () => {
  const leader = new ProxyServer();

  after(async () => {
    await leader.stop();
  });

  it("reports the shared tunnel to other windows", async () => {
    await leader.start(config(["gemini-oc-a"]));
    leader.setTunnelInfo("https://leader.ngrok.app", "ngrok");

    const status = await probeInstance(PORT, KEY);
    assert.equal(status?.publicUrl, "https://leader.ngrok.app");
    assert.equal(status?.tunnelProvider, "ngrok");
    assert.equal(status?.ownerPid, process.pid);
  });

  it("ignores a proxy guarded by a different key", async () => {
    assert.equal(await probeInstance(PORT, "ocm-wrong"), undefined);
  });

  it("applies model routes pushed from another window", async () => {
    let notified = false;
    leader.setConfigPushHandler(() => {
      notified = true;
    });

    const pushed = await pushConfig(
      PORT,
      KEY,
      config(["gemini-oc-b", "gemini-oc-c"])
    );
    assert.equal(pushed, true);
    assert.equal(notified, true);

    const body = (await fetch(`http://127.0.0.1:${PORT}/v1/models`, {
      headers: { authorization: `Bearer ${KEY}` },
    }).then((res) => res.json())) as { data: Array<{ id: string }> };
    assert.deepEqual(
      body.data.map((entry) => entry.id),
      ["gemini-oc-b", "gemini-oc-c"]
    );
  });

  it("keeps the bound port when a pushed config disagrees", async () => {
    await pushConfig(PORT, KEY, { ...config(["gemini-oc-b"]), port: 1 });
    assert.equal(leader.getPort(), PORT);
  });

  it("recognizes a second window losing the port race", async () => {
    const second = new ProxyServer();
    await assert.rejects(
      () => second.start(config(["gemini-oc-a"])),
      (error: unknown) => isPortInUseError(error)
    );
  });

  it("stops advertising once the owning window shuts down", async () => {
    await leader.stop();
    assert.equal(await probeInstance(PORT, KEY), undefined);
  });
});
