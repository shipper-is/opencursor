import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGeminiRoute } from "../src/geminiInbound.ts";
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
