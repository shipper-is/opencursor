import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnthropicStreamTranslator } from "../src/anthropicInbound.ts";
import {
  GeminiStreamTranslator,
  geminiToOpenAi,
  parseGeminiRoute,
} from "../src/geminiInbound.ts";
import { ToolCallAccumulator } from "../src/toolCallAccumulator.ts";
import { redactSecrets, summarizeErrorBody } from "../src/httpUtils.ts";
import {
  isResponsesFormat,
  joinUpstreamUrl,
  toChatCompletionsPayload,
} from "../src/requestTransform.ts";
import {
  generateId,
  normalizeBaseUrl,
  publicBaseUrl,
  slotPrefix,
} from "../src/types.ts";
import {
  normalizeAliasKey,
  resolveCursorModelAlias,
  resolveModelAlias,
  slugifyModelName,
} from "../src/modelAliases.ts";
import {
  classifyAgentRequest,
  extractSystemText,
  extractToolNames,
} from "../src/subagentRouting.ts";
import {
  anthropicThinkingStyle,
  applyModelVariation,
  normalizeEffort,
} from "../src/modelVariations.ts";

describe("joinUpstreamUrl", () => {
  it("avoids doubling /v1", () => {
    assert.equal(
      joinUpstreamUrl("https://api.example.com/v1", "/v1/chat/completions"),
      "https://api.example.com/v1/chat/completions"
    );
  });

  it("joins when the base has no /v1", () => {
    assert.equal(
      joinUpstreamUrl("https://api.example.com", "/chat/completions"),
      "https://api.example.com/chat/completions"
    );
  });
});

describe("isResponsesFormat", () => {
  it("detects Responses API payloads", () => {
    assert.equal(isResponsesFormat({ input: "hi" }), true);
    assert.equal(isResponsesFormat({ messages: [] }), false);
  });
});

describe("toChatCompletionsPayload", () => {
  it("converts string input", () => {
    const body = toChatCompletionsPayload({ input: "hello", stream: true }, "m1");
    assert.equal(body.model, "m1");
    assert.equal(body.stream, true);
    assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  });
});

describe("parseGeminiRoute", () => {
  it("parses streaming and non-streaming routes", () => {
    const streaming = parseGeminiRoute(
      "/v1beta/models/gemini-oc-demo:streamGenerateContent",
      new URLSearchParams("alt=sse")
    );
    assert.deepEqual(streaming, {
      model: "gemini-oc-demo",
      streaming: true,
      sse: true,
    });

    const plain = parseGeminiRoute(
      "/v1/models/gemini-oc-demo:generateContent",
      new URLSearchParams()
    );
    assert.deepEqual(plain, {
      model: "gemini-oc-demo",
      streaming: false,
      sse: false,
    });
  });
});

describe("geminiToOpenAi tool call ids", () => {
  it("keeps parallel calls to the same function distinct", () => {
    const body = geminiToOpenAi(
      {
        contents: [
          { role: "user", parts: [{ text: "explore" }] },
          {
            role: "model",
            parts: [
              { functionCall: { name: "Grep", args: { pattern: "a" } } },
              { functionCall: { name: "Grep", args: { pattern: "b" } } },
            ],
          },
          {
            role: "user",
            parts: [
              { functionResponse: { name: "Grep", response: { hits: 1 } } },
              { functionResponse: { name: "Grep", response: { hits: 2 } } },
            ],
          },
        ],
      },
      "kimi-k3",
      false
    );

    const messages = body.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m.role === "assistant");
    const calls = assistant?.tool_calls as Array<Record<string, unknown>>;
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id);

    const toolIds = messages
      .filter((m) => m.role === "tool")
      .map((m) => m.tool_call_id);
    assert.deepEqual(toolIds, [calls[0].id, calls[1].id]);
  });

  it("prefers explicit call ids when the client supplies them", () => {
    const body = geminiToOpenAi(
      {
        contents: [
          {
            role: "model",
            parts: [{ functionCall: { id: "call_abc", name: "Read", args: {} } }],
          },
          {
            role: "user",
            parts: [
              { functionResponse: { id: "call_abc", name: "Read", response: "ok" } },
            ],
          },
        ],
      },
      "kimi-k3",
      false
    );

    const messages = body.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((m) => m.role === "assistant");
    const calls = assistant?.tool_calls as Array<Record<string, unknown>>;
    assert.equal(calls[0].id, "call_abc");
    assert.equal(
      messages.find((m) => m.role === "tool")?.tool_call_id,
      "call_abc"
    );
  });
});

describe("ToolCallAccumulator", () => {
  it("splits calls that a provider reports under the same index", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, function: { name: "update_step", arguments: '{"a":1}' } });
    acc.add({ index: 0, function: { name: "Grep", arguments: '{"b":2}' } });

    assert.deepEqual(
      acc.list().map((call) => [call.name, call.arguments]),
      [
        ["update_step", '{"a":1}'],
        ["Grep", '{"b":2}'],
      ]
    );
  });

  it("splits repeated calls to the same function once arguments complete", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, function: { name: "Grep", arguments: '{"p":"a"}' } });
    acc.add({ index: 0, function: { name: "Grep", arguments: '{"p":"b"}' } });

    assert.equal(acc.list().length, 2);
    assert.equal(acc.list()[1].arguments, '{"p":"b"}');
  });

  it("appends fragments when the provider omits id and index", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ function: { name: "Grep", arguments: '{"p":' } });
    acc.add({ function: { arguments: '"a"}' } });

    assert.equal(acc.list().length, 1);
    assert.equal(acc.list()[0].arguments, '{"p":"a"}');
  });

  it("keeps repeated names on one call while its arguments are partial", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, function: { name: "Grep", arguments: '{"p":' } });
    acc.add({ index: 0, function: { name: "Grep", arguments: '"a"}' } });

    assert.equal(acc.list().length, 1);
    assert.equal(acc.list()[0].arguments, '{"p":"a"}');
  });

  it("tracks calls by id ahead of index", () => {
    const acc = new ToolCallAccumulator();
    acc.add({ index: 0, id: "c1", function: { name: "Grep", arguments: '{"p":' } });
    acc.add({ index: 0, id: "c2", function: { name: "Read", arguments: "{}" } });
    acc.add({ index: 0, id: "c1", function: { arguments: '"a"}' } });

    assert.deepEqual(
      acc.list().map((call) => [call.id, call.arguments]),
      [
        ["c1", '{"p":"a"}'],
        ["c2", "{}"],
      ]
    );
  });

  it("reports the fragment appended by each delta", () => {
    const acc = new ToolCallAccumulator();
    const first = acc.add({ index: 0, function: { name: "Grep", arguments: "{" } });
    const second = acc.add({ index: 0, function: { arguments: "}" } });

    assert.equal(first.opened, true);
    assert.equal(first.added, "{");
    assert.equal(second.opened, false);
    assert.equal(second.added, "}");
  });
});

describe("GeminiStreamTranslator", () => {
  it("does not merge arguments of index-less parallel tool calls", () => {
    const translator = new GeminiStreamTranslator();
    translator.push(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  function: {
                    name: "update_step",
                    arguments: '{"currentStep":"Exploring"}',
                  },
                },
                {
                  function: {
                    name: "Grep",
                    arguments: '{"pattern":"createAgent"}',
                  },
                },
              ],
            },
          },
        ],
      })
    );

    const parts = functionCalls(translator.finish());
    assert.deepEqual(parts, [
      { name: "update_step", args: { currentStep: "Exploring" } },
      { name: "Grep", args: { pattern: "createAgent" } },
    ]);
  });

  it("reassembles fragmented arguments and carries call ids through", () => {
    const translator = new GeminiStreamTranslator();
    translator.push(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "Read", arguments: '{"pa' } },
              ],
            },
          },
        ],
      })
    );
    translator.push(
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } },
        ],
      })
    );

    const parts = functionCalls(translator.finish());
    assert.deepEqual(parts, [{ id: "c1", name: "Read", args: { path: "x" } }]);
  });
});

describe("AnthropicStreamTranslator", () => {
  it("opens a separate block per call when indexes collide", () => {
    const translator = new AnthropicStreamTranslator("msg_1", "kimi-k3");
    const out = translator.push(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: "Read", arguments: '{"path":"a"}' } },
                { index: 0, function: { name: "Grep", arguments: '{"pattern":"b"}' } },
              ],
            },
          },
        ],
      })
    );

    const starts = sseEvents(out).filter(
      (e) => e.type === "content_block_start"
    );
    assert.deepEqual(
      starts.map((e) => [
        e.index,
        (e.content_block as Record<string, unknown>).name,
      ]),
      [
        [1, "Read"],
        [2, "Grep"],
      ]
    );

    const deltas = sseEvents(out).filter(
      (e) => e.type === "content_block_delta"
    );
    assert.deepEqual(
      deltas.map((e) => [
        e.index,
        (e.delta as Record<string, unknown>).partial_json,
      ]),
      [
        [1, '{"path":"a"}'],
        [2, '{"pattern":"b"}'],
      ]
    );
  });

  it("routes later fragments to the block that owns them", () => {
    const translator = new AnthropicStreamTranslator("msg_1", "kimi-k3");
    translator.push(
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "Read", arguments: '{"pa' } },
                { index: 1, id: "c2", function: { name: "Grep", arguments: "{}" } },
              ],
            },
          },
        ],
      })
    );
    const out = translator.push(
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "c1", function: { arguments: 'th":"x"}' } }] } },
        ],
      })
    );

    const deltas = sseEvents(out).filter(
      (e) => e.type === "content_block_delta"
    );
    assert.deepEqual(
      deltas.map((e) => [
        e.index,
        (e.delta as Record<string, unknown>).partial_json,
      ]),
      [[1, 'th":"x"}']]
    );
  });
});

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function functionCalls(chunk: Record<string, unknown>): unknown[] {
  const candidates = chunk.candidates as Array<Record<string, unknown>>;
  const content = candidates[0].content as Record<string, unknown>;
  const parts = content.parts as Array<Record<string, unknown>>;
  return parts.map((part) => part.functionCall);
}

function sseEvents(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

describe("secret redaction", () => {
  it("redacts bearer tokens and proxy keys", () => {
    const text =
      "Bearer ocm-abcdef0123456789abcdef0123456789 and sk-abcdefghijklmnop";
    assert.match(redactSecrets(text), /Bearer \[redacted\]/);
    assert.doesNotMatch(redactSecrets(text), /ocm-abcdef/);
    assert.doesNotMatch(redactSecrets(text), /sk-abcdefghijklmnop/);
  });

  it("truncates summarized errors", () => {
    assert.equal(summarizeErrorBody("a".repeat(500), 20).length, 20);
  });
});

describe("types helpers", () => {
  it("normalizes trailing slashes", () => {
    assert.equal(
      normalizeBaseUrl("https://api.example.com/v1/"),
      "https://api.example.com/v1"
    );
  });

  it("builds slot prefixes", () => {
    assert.equal(slotPrefix("google"), "gemini-");
    assert.equal(slotPrefix("anthropic"), "claude-");
    assert.equal(slotPrefix("openai"), "");
  });

  it("generates stable-looking ids", () => {
    const id = generateId("DeepSeek V3");
    assert.match(id, /^deepseek-v3-[a-z0-9]+$/);
  });
});

describe("publicBaseUrl", () => {
  it("appends /v1 once", () => {
    assert.equal(
      publicBaseUrl("https://abc.ngrok-free.app/"),
      "https://abc.ngrok-free.app/v1"
    );
  });
});

describe("modelAliases", () => {
  it("resolves readable Anthropic names to API model IDs", () => {
    assert.equal(resolveModelAlias("Claude Sonnet 5")?.upstreamModel, "claude-sonnet-5");
    assert.equal(resolveModelAlias("sonnet")?.upstreamModel, "claude-sonnet-5");
    assert.equal(resolveModelAlias("opus 4.8")?.upstreamModel, "claude-opus-4-8");
    assert.equal(resolveModelAlias("haiku")?.upstreamModel, "claude-haiku-4-5-20251001");
  });

  it("resolves names regardless of punctuation", () => {
    assert.equal(
      resolveModelAlias("claude_sonnet_5")?.upstreamModel,
      "claude-sonnet-5"
    );
    assert.equal(
      normalizeAliasKey("Claude Sonnet 5"),
      normalizeAliasKey("claude-sonnet-5")
    );
  });

  it("resolves Cursor-prefixed readable names", () => {
    assert.equal(
      resolveCursorModelAlias("gemini-oc-claude-sonnet-5", "gemini-oc-")
        ?.upstreamModel,
      "claude-sonnet-5"
    );
    assert.equal(
      resolveCursorModelAlias("gemini-oc-sonnet", "gemini-oc-")?.displayName,
      "Claude Sonnet 5"
    );
  });

  it("slugifies display names for Cursor", () => {
    assert.equal(slugifyModelName("Claude Sonnet 5"), "claude-sonnet-5");
    assert.equal(slugifyModelName("  My Model!! "), "my-model");
  });
});

describe("subagentRouting", () => {
  it("reads tool names from all three inbound formats", () => {
    assert.deepEqual(
      extractToolNames({
        tools: [
          { type: "function", function: { name: "Read" } },
          { type: "function", function: { name: "Task" } },
        ],
      }),
      ["Read", "Task"]
    );
    assert.deepEqual(
      extractToolNames({ tools: [{ name: "Grep", input_schema: {} }] }),
      ["Grep"]
    );
    assert.deepEqual(
      extractToolNames({
        tools: [{ functionDeclarations: [{ name: "Glob" }, { name: "Task" }] }],
      }),
      ["Glob", "Task"]
    );
  });

  it("reads system text from all three inbound formats", () => {
    assert.match(extractSystemText({ system: "anthropic system" }), /anthropic/);
    assert.match(
      extractSystemText({
        system: [{ type: "text", text: "block system" }],
      }),
      /block system/
    );
    assert.match(
      extractSystemText({
        messages: [
          { role: "system", content: "openai system" },
          { role: "user", content: "hi" },
        ],
      }),
      /openai system/
    );
    assert.match(
      extractSystemText({
        systemInstruction: { parts: [{ text: "gemini system" }] },
      }),
      /gemini system/
    );
  });

  it("treats requests with a Task tool as the orchestrator", () => {
    const signals = classifyAgentRequest({
      messages: [{ role: "user", content: "go" }],
      tools: [
        { type: "function", function: { name: "Read" } },
        { type: "function", function: { name: "Task" } },
      ],
    });
    assert.equal(signals.role, "orchestrator");
    assert.equal(signals.turnCount, 1);
  });

  it("treats a tool-bearing request without Task as a subagent", () => {
    const signals = classifyAgentRequest({
      messages: [{ role: "system", content: "You are a subagent." }],
      tools: [
        { type: "function", function: { name: "Read" } },
        { type: "function", function: { name: "Grep" } },
      ],
    });
    assert.equal(signals.role, "subagent");
    assert.match(signals.systemPreview, /subagent/);
  });

  it("classifies Gemini and Anthropic shaped payloads too", () => {
    assert.equal(
      classifyAgentRequest({
        contents: [{ role: "user", parts: [{ text: "go" }] }],
        tools: [{ functionDeclarations: [{ name: "Read" }, { name: "Task" }] }],
      }).role,
      "orchestrator"
    );
    assert.equal(
      classifyAgentRequest({
        system: "subagent",
        messages: [],
        tools: [{ name: "Read", input_schema: {} }],
      }).role,
      "subagent"
    );
  });

  it("leaves tool-less requests unclassified so they are never rerouted", () => {
    assert.equal(
      classifyAgentRequest({ messages: [{ role: "user", content: "title this" }] })
        .role,
      "unknown"
    );
  });
});

describe("modelVariations", () => {
  it("splits Anthropic families at the 4.6 thinking cutover", () => {
    assert.equal(anthropicThinkingStyle("claude-opus-5"), "adaptive");
    assert.equal(anthropicThinkingStyle("claude-sonnet-5"), "adaptive");
    assert.equal(anthropicThinkingStyle("claude-opus-4-8"), "adaptive");
    assert.equal(anthropicThinkingStyle("claude-sonnet-4-6"), "adaptive");
    assert.equal(anthropicThinkingStyle("claude-opus-4-5"), "extended");
    assert.equal(
      anthropicThinkingStyle("claude-haiku-4-5-20251001"),
      "extended"
    );
  });

  it("sends reasoning_effort and service_tier to OpenAI-compatible upstreams", () => {
    const body = applyModelVariation(
      { model: "gpt-5.6", messages: [] },
      {
        provider: "openai-compatible",
        upstreamModel: "gpt-5.6",
        reasoningEffort: "high",
        speedTier: "fast",
      }
    );
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.service_tier, "priority");

    const economy = applyModelVariation(
      {},
      {
        provider: "openai-compatible",
        upstreamModel: "gpt-5.6",
        reasoningEffort: "default",
        speedTier: "economy",
      }
    );
    assert.equal(economy.service_tier, "flex");
    assert.ok(!("reasoning_effort" in economy));
  });

  it("uses output_config.effort on adaptive Anthropic models", () => {
    const body = applyModelVariation(
      { model: "claude-opus-5" },
      {
        provider: "anthropic",
        upstreamModel: "claude-opus-5",
        reasoningEffort: "max",
        speedTier: "default",
      }
    );
    assert.deepEqual(body.output_config, { effort: "max" });
    // budget_tokens would be rejected with a 400 on this family.
    assert.ok(!("thinking" in body));
  });

  it("uses a thinking budget on pre-4.6 Anthropic models", () => {
    const body = applyModelVariation(
      { model: "claude-opus-4-5" },
      {
        provider: "anthropic",
        upstreamModel: "claude-opus-4-5",
        reasoningEffort: "high",
        speedTier: "default",
      }
    );
    assert.deepEqual(body.thinking, {
      type: "enabled",
      budget_tokens: 24576,
    });
    assert.ok(!("output_config" in body));
  });

  it("disables thinking on older Anthropic models at minimal effort", () => {
    const body = applyModelVariation(
      {},
      {
        provider: "anthropic",
        upstreamModel: "claude-sonnet-4-5",
        reasoningEffort: "none",
        speedTier: "economy",
      }
    );
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.service_tier, "standard_only");
  });

  it("clamps effort for families that cannot disable reasoning", () => {
    assert.equal(normalizeEffort("none", "anthropic", "claude-opus-5"), "low");
    assert.equal(
      normalizeEffort("minimal", "openai-compatible", "grok-4.5"),
      "low"
    );
    assert.equal(
      normalizeEffort("none", "openai-compatible", "gpt-5.6"),
      "none"
    );
    assert.equal(
      normalizeEffort("none", "anthropic", "claude-opus-4-5"),
      "none"
    );
  });

  it("leaves the body untouched when nothing is configured", () => {
    const original = { model: "gpt-5.6", messages: [] };
    const body = applyModelVariation(original, {
      provider: "openai-compatible",
      upstreamModel: "gpt-5.6",
      reasoningEffort: "default",
      speedTier: "default",
    });
    assert.deepEqual(body, original);
  });
});
