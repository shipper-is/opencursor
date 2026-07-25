import * as http from "http";
import { IncomingMessage, ServerResponse } from "http";
import { ProxyRuntimeConfig } from "./types";
import {
  isResponsesFormat,
  joinUpstreamUrl,
  toChatCompletionsPayload,
} from "./requestTransform";
import {
  AnthropicStreamTranslator,
  anthropicToOpenAi,
  openAiToAnthropicResponse,
} from "./anthropicInbound";
import {
  GeminiRoute,
  GeminiStreamTranslator,
  geminiToOpenAi,
  openAiToGeminiResponse,
  parseGeminiRoute,
} from "./geminiInbound";
import {
  fetchUpstream,
  readBody,
  summarizeErrorBody,
} from "./httpUtils";
import { classifyAgentRequest, describeAgentRequest } from "./subagentRouting";
import {
  DEFAULT_VARIATION,
  ReasoningEffort,
  SpeedTier,
  applyModelVariation,
  describeVariation,
} from "./modelVariations";

type LogFn = (message: string) => void;

interface RouteTarget {
  upstreamModel: string;
  baseUrl: string;
  apiKey: string;
  provider: "openai-compatible" | "anthropic";
  reasoningEffort: ReasoningEffort;
  speedTier: SpeedTier;
}

export class ProxyServer {
  private server: http.Server | undefined;
  private config: ProxyRuntimeConfig | undefined;
  private log: LogFn = () => {};

  setLogger(fn: LogFn): void {
    this.log = fn;
  }

  isRunning(): boolean {
    return Boolean(this.server?.listening);
  }

  getPort(): number | undefined {
    if (!this.server?.listening) {
      return undefined;
    }
    const address = this.server.address();
    if (!address || typeof address === "string") {
      return undefined;
    }
    return address.port;
  }

  updateConfig(config: ProxyRuntimeConfig): void {
    this.config = config;
  }

  async start(config: ProxyRuntimeConfig): Promise<number> {
    await this.stop();
    this.config = config;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(config.port, "127.0.0.1", () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });

    const port = this.getPort() ?? config.port;
    this.log(`Proxy listening on http://127.0.0.1:${port}/v1`);
    return port;
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = undefined;

    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    try {
      if (!this.config) {
        this.sendJson(res, 503, { error: "Proxy not configured" });
        return;
      }

      if (!this.isAuthorized(req)) {
        this.sendJson(res, 401, {
          error: {
            message: "Invalid API key. Use the proxy API key from Open Cursor Models setup.",
            type: "invalid_request_error",
          },
        });
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (this.config?.logRequests) {
        this.log(`${req.method} ${path}`);
      }

      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        await this.handleModels(res);
        return;
      }

      if (req.method === "POST") {
        const geminiRoute = parseGeminiRoute(path, url.searchParams);
        if (geminiRoute) {
          await this.handleGeminiGenerate(req, res, geminiRoute);
          return;
        }
      }

      if (
        req.method === "POST" &&
        (path === "/v1/messages" || path === "/messages")
      ) {
        await this.handleAnthropicMessages(req, res);
        return;
      }

      if (
        req.method === "POST" &&
        (path === "/v1/chat/completions" ||
          path === "/chat/completions" ||
          path === "/v1/responses" ||
          path === "/responses")
      ) {
        await this.handleChatCompletions(req, res, path);
        return;
      }

      if (req.method === "GET" && path === "/health") {
        this.sendJson(res, 200, { status: "ok" });
        return;
      }

      this.sendJson(res, 404, { error: `Unknown route: ${req.method} ${path}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Request error: ${summarizeErrorBody(message, 200)}`);
      this.sendJson(res, 500, {
        error: {
          message: message.includes("Request body exceeds")
            ? message
            : "Proxy request failed",
          type: "proxy_error",
        },
      });
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const expected = this.config?.proxyApiKey;
    if (!expected) {
      return false;
    }

    const auth = req.headers.authorization ?? "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    if (bearer === expected) {
      return true;
    }

    // Anthropic slot sends the key as x-api-key instead of a bearer token.
    const apiKeyHeader = req.headers["x-api-key"];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    if (apiKey === expected) {
      return true;
    }

    // Google slot sends it as x-goog-api-key, or as a ?key= query parameter.
    const googHeader = req.headers["x-goog-api-key"];
    const goog = Array.isArray(googHeader) ? googHeader[0] : googHeader;
    if (goog === expected) {
      return true;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("key") === expected;
  }

  private async handleModels(res: ServerResponse): Promise<void> {
    const data = this.config!.models
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.cursorModelName,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "open-cursor-models",
      }));

    this.sendJson(res, 200, { object: "list", data });
  }

  private async handleGeminiGenerate(
    req: IncomingMessage,
    res: ServerResponse,
    route: GeminiRoute
  ): Promise<void> {
    const body = await readBody(req);
    let payload: Record<string, unknown>;

    try {
      payload = body.trim() ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      this.sendJson(res, 400, {
        error: { code: 400, message: "Invalid JSON body", status: "INVALID_ARGUMENT" },
      });
      return;
    }

    const target = this.routeFor(route.model, payload, "google-slot");
    if (!target) {
      this.log(`No route for Google-slot model "${route.model}"`);
      this.sendJson(res, 404, {
        error: {
          code: 404,
          message: `No route for model "${route.model}".`,
          status: "NOT_FOUND",
        },
      });
      return;
    }

    this.log(
      `[google-slot] ${route.model} => ${target.baseUrl} (${target.upstreamModel})` +
        `${route.streaming ? " streaming" : ""}${route.sse ? " sse" : ""}`
    );

    if (target.provider === "anthropic") {
      await this.handleGeminiAnthropicTarget(res, route, payload, target);
      return;
    }

    const upstreamUrl = joinUpstreamUrl(target.baseUrl, "/chat/completions");
    const upstream = await fetchUpstream(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.apiKey}`,
        accept: route.streaming ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(
        this.withVariation(
          geminiToOpenAi(payload, target.upstreamModel, route.streaming),
          target
        )
      ),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      this.log(
        `Upstream ${upstream.status} from ${upstreamUrl}: ${summarizeErrorBody(text)}`
      );
      this.sendJson(res, upstream.status, {
        error: {
          code: upstream.status,
          message: summarizeErrorBody(text, 200),
          status: "UNKNOWN",
        },
      });
      return;
    }

    if (!route.streaming) {
      const text = await upstream.text();
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        this.sendJson(res, 200, openAiToGeminiResponse(parsed));
      } catch {
        this.sendJson(res, 502, {
          error: { code: 502, message: "Invalid upstream response", status: "INTERNAL" },
        });
      }
      return;
    }

    const translator = new GeminiStreamTranslator();
    const chunks: Array<Record<string, unknown>> = [];

    res.statusCode = 200;
    if (route.sse) {
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
    } else {
      // Without alt=sse, streamGenerateContent returns a single JSON array.
      res.setHeader("content-type", "application/json");
    }

    if (upstream.body) {
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        for (const chunk of translator.push(
          decoder.decode(value, { stream: true })
        )) {
          if (route.sse) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          } else {
            chunks.push(chunk);
          }
        }
      }
    }

    const final = translator.finish();
    if (route.sse) {
      res.write(`data: ${JSON.stringify(final)}\n\n`);
      res.end();
    } else {
      chunks.push(final);
      res.end(JSON.stringify(chunks));
    }
  }

  private async handleGeminiAnthropicTarget(
    res: ServerResponse,
    route: GeminiRoute,
    payload: Record<string, unknown>,
    target: RouteTarget
  ): Promise<void> {
    const upstreamUrl = joinUpstreamUrl(target.baseUrl, "/v1/messages");
    const openAiPayload = geminiToOpenAi(
      payload,
      target.upstreamModel,
      false
    );
    const upstream = await fetchUpstream(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": target.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(
        this.withVariation(
          toAnthropicBody(
            { ...openAiPayload, stream: false },
            target.upstreamModel
          ),
          target
        )
      ),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      this.log(
        `Upstream ${upstream.status} from ${upstreamUrl}: ${summarizeErrorBody(text)}`
      );
      this.sendJson(res, upstream.status, {
        error: {
          code: upstream.status,
          message: summarizeErrorBody(text, 200),
          status: "UNKNOWN",
        },
      });
      return;
    }

    let anthropic: Record<string, unknown>;
    try {
      anthropic = (await upstream.json()) as Record<string, unknown>;
    } catch {
      this.sendJson(res, 502, {
        error: {
          code: 502,
          message: "Invalid Anthropic upstream response",
          status: "INTERNAL",
        },
      });
      return;
    }

    const gemini = openAiToGeminiResponse(
      fromAnthropicResponse(anthropic, target.upstreamModel)
    );

    if (!route.streaming) {
      this.sendJson(res, 200, gemini);
      return;
    }

    res.statusCode = 200;
    if (route.sse) {
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.end(`data: ${JSON.stringify(gemini)}\n\n`);
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([gemini]));
    }
  }

  private async handleAnthropicMessages(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const body = await readBody(req);
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      this.sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const requestedModel = String(payload.model ?? "");
    const target = this.routeFor(requestedModel, payload, "anthropic-slot");

    if (!target) {
      this.log(`No route for Anthropic-slot model "${requestedModel}"`);
      this.sendJson(res, 404, {
        type: "error",
        error: {
          type: "not_found_error",
          message: `No route for model "${requestedModel}".`,
        },
      });
      return;
    }

    this.log(
      `[anthropic-slot] ${requestedModel} => ${target.baseUrl} (${target.upstreamModel})`
    );

    const streaming = payload.stream === true;
    const upstreamUrl = joinUpstreamUrl(target.baseUrl, "/chat/completions");
    const upstreamBody = JSON.stringify(
      this.withVariation(anthropicToOpenAi(payload, target.upstreamModel), target)
    );

    const upstream = await fetchUpstream(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.apiKey}`,
        accept: streaming ? "text/event-stream" : "application/json",
      },
      body: upstreamBody,
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      this.log(
        `Upstream ${upstream.status} from ${upstreamUrl}: ${summarizeErrorBody(text)}`
      );
      this.sendJson(res, upstream.status, {
        type: "error",
        error: { type: "api_error", message: summarizeErrorBody(text, 200) },
      });
      return;
    }

    const messageId = `msg_${Date.now()}`;

    if (!streaming) {
      const text = await upstream.text();
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        this.sendJson(
          res,
          200,
          openAiToAnthropicResponse(parsed, requestedModel)
        );
      } catch {
        this.sendJson(res, 502, {
          type: "error",
          error: { type: "api_error", message: "Invalid upstream response" },
        });
      }
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");

    const translator = new AnthropicStreamTranslator(messageId, requestedModel);

    if (!upstream.body) {
      res.write(translator.finish());
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const translated = translator.push(decoder.decode(value, { stream: true }));
      if (translated) {
        res.write(translated);
      }
    }

    res.write(translator.finish());
    res.end();
  }

  private async handleChatCompletions(
    req: IncomingMessage,
    res: ServerResponse,
    path: string
  ): Promise<void> {
    const body = await readBody(req);
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(body) as Record<string, unknown>;
    } catch {
      this.sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const requestedModel = String(payload.model ?? "");
    const target = this.routeFor(requestedModel, payload, "openai-slot");

    if (!target) {
      this.log(`No route for model "${requestedModel}"`);
      this.sendJson(res, 404, {
        error: {
          message: `No route for model "${requestedModel}". Add it in Open Cursor Models and use the oc- prefixed name in Cursor.`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      });
      return;
    }

    if (this.config?.logRequests) {
      this.log(`→ ${requestedModel} => ${target.baseUrl} (${target.upstreamModel})`);
    }

    const responsesFormat = isResponsesFormat(payload);
    const upstreamPath =
      target.provider === "anthropic"
        ? "/v1/messages"
        : responsesFormat
          ? "/chat/completions"
          : path.startsWith("/v1")
            ? path
            : `/v1${path}`;

    const upstreamUrl = joinUpstreamUrl(target.baseUrl, upstreamPath);

    let upstreamPayload: Record<string, unknown>;
    if (target.provider === "anthropic") {
      upstreamPayload = toAnthropicBody(payload, target.upstreamModel);
    } else if (responsesFormat) {
      if (this.config?.logRequests) {
        this.log(`Converting Responses API payload to chat/completions for upstream`);
      }
      upstreamPayload = toChatCompletionsPayload(payload, target.upstreamModel);
    } else {
      upstreamPayload = { ...payload, model: target.upstreamModel };
    }

    const upstreamBody = JSON.stringify(
      this.withVariation(upstreamPayload, target)
    );

    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: req.headers.accept ?? "application/json",
    };

    if (target.provider === "anthropic") {
      headers["x-api-key"] = target.apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers.authorization = `Bearer ${target.apiKey}`;
    }

    const upstream = await fetchUpstream(upstreamUrl, {
      method: "POST",
      headers,
      body: upstreamBody,
    });

    res.statusCode = upstream.status;
    copyHeaders(upstream.headers, res);

    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");

      if (!upstream.body) {
        res.end();
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        if (target.provider === "anthropic") {
          res.write(translateAnthropicSseChunk(chunk));
        } else {
          res.write(chunk);
        }
      }
      res.end();
      return;
    }

    const text = await upstream.text();
    if (!upstream.ok) {
      this.log(
        `Upstream ${upstream.status} from ${upstreamUrl}: ${summarizeErrorBody(text)}`
      );
    }
    if (target.provider === "anthropic") {
      try {
        const parsed = JSON.parse(text);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(fromAnthropicResponse(parsed, target.upstreamModel)));
        return;
      } catch {
        // fall through
      }
    }

    res.end(text);
  }

  /**
   * Resolves the upstream route for a request, applying the subagent model
   * override when the payload looks like a Task-tool subagent run.
   */
  private routeFor(
    requestedModel: string,
    payload: Record<string, unknown>,
    label: string
  ): RouteTarget | undefined {
    const target = this.resolveTarget(requestedModel);
    if (!target) {
      return undefined;
    }

    const signals = classifyAgentRequest(payload);
    if (this.config?.logRequestBodies) {
      this.log(`[${label}] ${requestedModel} ${describeAgentRequest(signals)}`);
    }

    const override = this.config?.subagentModelName;
    if (signals.role !== "subagent" || !override || override === requestedModel) {
      return target;
    }

    const overrideTarget = this.resolveTarget(override);
    if (!overrideTarget) {
      this.log(
        `Subagent override model "${override}" is not an enabled profile; keeping ${requestedModel}`
      );
      return target;
    }

    const subagentTarget: RouteTarget = {
      ...overrideTarget,
      reasoningEffort:
        this.config?.subagentReasoningEffort ?? overrideTarget.reasoningEffort,
      speedTier: this.config?.subagentSpeedTier ?? overrideTarget.speedTier,
    };
    const variation = describeVariation(subagentTarget);

    this.log(
      `[${label}] subagent detected, forcing ${override} (${subagentTarget.upstreamModel}` +
        `${variation ? `, ${variation}` : ""}) instead of ${requestedModel}`
    );
    return subagentTarget;
  }

  private resolveTarget(modelName: string): RouteTarget | undefined {
    const config = this.config;
    if (!config) {
      return undefined;
    }

    const direct = config.models.find(
      (m) => m.enabled && m.cursorModelName === modelName
    );
    if (direct) {
      return this.toRouteTarget(direct);
    }

    // Match profile id / readable slug without the slot prefix
    const withoutPrefix = modelName.startsWith(config.modelPrefix)
      ? modelName.slice(config.modelPrefix.length)
      : modelName;
    const bySlug = config.models.find(
      (m) =>
        m.enabled &&
        (modelName === m.cursorModelName.replace(config.modelPrefix, "") ||
          withoutPrefix === m.cursorModelName.replace(config.modelPrefix, ""))
    );
    if (bySlug) {
      return this.toRouteTarget(bySlug);
    }

    return undefined;
  }

  private toRouteTarget(
    model: ProxyRuntimeConfig["models"][number]
  ): RouteTarget {
    return {
      upstreamModel: model.upstreamModel,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      provider: model.provider,
      reasoningEffort: model.reasoningEffort ?? DEFAULT_VARIATION.reasoningEffort,
      speedTier: model.speedTier ?? DEFAULT_VARIATION.speedTier,
    };
  }

  /**
   * Adds the profile's thinking-effort and speed-tier parameters to a fully
   * built upstream body, in whichever dialect the upstream provider expects.
   */
  private withVariation(
    body: Record<string, unknown>,
    target: RouteTarget
  ): Record<string, unknown> {
    if (
      target.reasoningEffort === "default" &&
      target.speedTier === "default"
    ) {
      return body;
    }

    return applyModelVariation(body, {
      provider: target.provider,
      upstreamModel: target.upstreamModel,
      reasoningEffort: target.reasoningEffort,
      speedTier: target.speedTier,
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(payload);
  }
}

function copyHeaders(source: Headers, res: ServerResponse): void {
  source.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") {
      return;
    }
    res.setHeader(key, value);
  });
}

function toAnthropicBody(
  openaiPayload: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const messages = Array.isArray(openaiPayload.messages)
    ? openaiPayload.messages
    : [];

  let system: string | undefined;
  const anthropicMessages: Array<{ role: string; content: unknown }> = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const record = msg as Record<string, unknown>;
    const role = String(record.role ?? "user");
    if (role === "system") {
      system = String(record.content ?? "");
      continue;
    }
    anthropicMessages.push({
      role: role === "assistant" ? "assistant" : "user",
      content: record.content,
    });
  }

  const body: Record<string, unknown> = {
    model,
    messages: anthropicMessages,
    max_tokens: openaiPayload.max_tokens ?? 4096,
    stream: openaiPayload.stream ?? false,
  };

  if (system) {
    body.system = system;
  }

  if (openaiPayload.temperature !== undefined) {
    body.temperature = openaiPayload.temperature;
  }

  return body;
}

function fromAnthropicResponse(
  anthropic: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const content = Array.isArray(anthropic.content) ? anthropic.content : [];
  const text = content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text: unknown }).text)
        : ""
    )
    .join("");

  return {
    id: anthropic.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: anthropic.stop_reason ?? "stop",
      },
    ],
    usage: anthropic.usage,
  };
}

function translateAnthropicSseChunk(chunk: string): string {
  // Best-effort passthrough; Anthropic SSE differs from OpenAI. Many providers
  // accept OpenAI format only, so anthropic provider is mainly for direct API use.
  return chunk;
}
