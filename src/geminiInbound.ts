/**
 * Translates inbound Gemini generateContent traffic into OpenAI
 * chat/completions calls, and converts the replies back.
 *
 * Used by the Google provider slot, which Cursor selects for any model name
 * starting with `gemini-`, leaving both the OpenAI and Anthropic keys free.
 */

import {
  AccumulatedToolCall,
  ToolCallAccumulator,
  parseToolArguments,
} from "./toolCallAccumulator";

export interface GeminiRoute {
  model: string;
  streaming: boolean;
  sse: boolean;
}

const PATH_PATTERN =
  /^\/(?:v1beta|v1|v1beta1)\/models\/([^:/]+):(streamGenerateContent|generateContent)$/;

export function parseGeminiRoute(
  pathname: string,
  search: URLSearchParams
): GeminiRoute | undefined {
  const match = PATH_PATTERN.exec(pathname);
  if (!match) {
    return undefined;
  }

  const streaming = match[2] === "streamGenerateContent";
  return {
    model: decodeURIComponent(match[1]),
    streaming,
    sse: streaming && search.get("alt") === "sse",
  };
}

export function geminiToOpenAi(
  payload: Record<string, unknown>,
  upstreamModel: string,
  streaming: boolean
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  const systemText = extractText(payload.systemInstruction);
  if (systemText.trim()) {
    messages.push({ role: "system", content: systemText });
  }

  const contents = Array.isArray(payload.contents) ? payload.contents : [];

  // Calls and their responses are matched by position within each function
  // name, so both directions need their own occurrence counters.
  const callCounts = new Map<string, number>();
  const responseCounts = new Map<string, number>();

  for (const entryRaw of contents) {
    if (!entryRaw || typeof entryRaw !== "object") {
      continue;
    }
    const entry = entryRaw as Record<string, unknown>;
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    const role = entry.role === "model" ? "assistant" : "user";

    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];

    for (const partRaw of parts) {
      if (!partRaw || typeof partRaw !== "object") {
        continue;
      }
      const part = partRaw as Record<string, unknown>;

      if (typeof part.text === "string") {
        textParts.push(part.text);
        continue;
      }

      const functionCall = part.functionCall as
        | Record<string, unknown>
        | undefined;
      if (functionCall) {
        const name = String(functionCall.name ?? "");
        toolCalls.push({
          id: callId(name, functionCall.id, callCounts),
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(functionCall.args ?? {}),
          },
        });
        continue;
      }

      const functionResponse = part.functionResponse as
        | Record<string, unknown>
        | undefined;
      if (functionResponse) {
        const name = String(functionResponse.name ?? "");
        messages.push({
          role: "tool",
          tool_call_id: callId(name, functionResponse.id, responseCounts),
          content:
            typeof functionResponse.response === "string"
              ? functionResponse.response
              : JSON.stringify(functionResponse.response ?? {}),
        });
      }
    }

    if (textParts.length > 0 || toolCalls.length > 0) {
      const assembled: Record<string, unknown> = { role };
      assembled.content = textParts.join("") || null;
      if (toolCalls.length > 0) {
        assembled.tool_calls = toolCalls;
      }
      messages.push(assembled);
    }
  }

  const body: Record<string, unknown> = {
    model: upstreamModel,
    messages,
    stream: streaming,
  };

  const generationConfig = payload.generationConfig as
    | Record<string, unknown>
    | undefined;
  if (generationConfig) {
    if (generationConfig.maxOutputTokens !== undefined) {
      body.max_tokens = generationConfig.maxOutputTokens;
    }
    if (generationConfig.temperature !== undefined) {
      body.temperature = generationConfig.temperature;
    }
    if (generationConfig.topP !== undefined) {
      body.top_p = generationConfig.topP;
    }
  }

  const declarations = collectFunctionDeclarations(payload.tools);
  if (declarations.length > 0) {
    body.tools = declarations.map((declaration) => ({
      type: "function",
      function: {
        name: String(declaration.name ?? ""),
        description: String(declaration.description ?? ""),
        parameters: declaration.parameters ?? {
          type: "object",
          properties: {},
        },
      },
    }));
  }

  if (streaming) {
    body.stream_options = { include_usage: true };
  }

  return body;
}

export function openAiToGeminiResponse(
  openai: Record<string, unknown>
): Record<string, unknown> {
  const choices = Array.isArray(openai.choices) ? openai.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;

  const parts: Array<Record<string, unknown>> = [];
  if (typeof message.content === "string" && message.content) {
    parts.push({ text: message.content });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const callRaw of toolCalls) {
    const call = (callRaw ?? {}) as Record<string, unknown>;
    parts.push({ functionCall: functionCallPart(call) });
  }

  const usage = (openai.usage ?? {}) as Record<string, unknown>;

  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason: mapFinishReason(first.finish_reason),
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens ?? 0,
      candidatesTokenCount: usage.completion_tokens ?? 0,
      totalTokenCount: usage.total_tokens ?? 0,
    },
  };
}

/**
 * Rewrites an OpenAI SSE stream as Gemini streamGenerateContent chunks.
 * Gemini has no block framing, so each chunk maps straight across.
 */
export class GeminiStreamTranslator {
  private buffer = "";
  private readonly toolCalls = new ToolCallAccumulator();
  private usage: Record<string, unknown> | undefined;
  private finishReason: string | undefined;

  push(chunk: string): Array<Record<string, unknown>> {
    this.buffer += chunk;
    const out: Array<Record<string, unknown>> = [];

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      const converted = this.handleChunk(parsed);
      if (converted) {
        out.push(converted);
      }
    }

    return out;
  }

  /** Emits the trailing chunk carrying finish reason, tool calls and usage. */
  finish(): Record<string, unknown> {
    const parts: Array<Record<string, unknown>> = [];

    for (const call of this.toolCalls.list()) {
      parts.push({ functionCall: geminiFunctionCall(call) });
    }

    return {
      candidates: [
        {
          content: { role: "model", parts },
          finishReason: this.finishReason ?? "STOP",
          index: 0,
        },
      ],
      ...(this.usage ? { usageMetadata: this.usage } : {}),
    };
  }

  private handleChunk(
    chunk: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const usage = chunk.usage as Record<string, unknown> | undefined;
    if (usage) {
      this.usage = {
        promptTokenCount: usage.prompt_tokens ?? 0,
        candidatesTokenCount: usage.completion_tokens ?? 0,
        totalTokenCount: usage.total_tokens ?? 0,
      };
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    if (typeof choice.finish_reason === "string" && choice.finish_reason) {
      this.finishReason = mapFinishReason(choice.finish_reason);
    }

    // Tool call arguments arrive in fragments and are only valid JSON once
    // complete, so they are buffered and emitted by finish().
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const callRaw of toolCalls) {
      this.toolCalls.add((callRaw ?? {}) as Record<string, unknown>);
    }

    const text = typeof delta.content === "string" ? delta.content : "";
    if (!text) {
      return undefined;
    }

    return {
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          index: 0,
        },
      ],
    };
  }
}

function collectFunctionDeclarations(
  tools: unknown
): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) {
    return [];
  }

  const declarations: Array<Record<string, unknown>> = [];
  for (const toolRaw of tools) {
    if (!toolRaw || typeof toolRaw !== "object") {
      continue;
    }
    const tool = toolRaw as Record<string, unknown>;
    const list = tool.functionDeclarations ?? tool.function_declarations;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && typeof item === "object") {
          declarations.push(item as Record<string, unknown>);
        }
      }
    }
  }

  return declarations;
}

function functionCallPart(call: Record<string, unknown>): Record<string, unknown> {
  const fn = call.function as Record<string, unknown> | undefined;
  const raw = typeof fn?.arguments === "string" ? fn.arguments : "";

  return geminiFunctionCall({
    id: typeof call.id === "string" ? call.id : undefined,
    name: String(fn?.name ?? ""),
    arguments: raw,
  });
}

/**
 * Carries the upstream call id through as `functionCall.id` when there is one,
 * so a client that echoes it back lets tool results be matched exactly instead
 * of by name and position.
 */
function geminiFunctionCall(call: AccumulatedToolCall): Record<string, unknown> {
  const part: Record<string, unknown> = {
    name: call.name,
    args: parseToolArguments(call.arguments),
  };
  if (call.id) {
    part.id = call.id;
  }
  return part;
}

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const parts = (value as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) =>
      part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
        ? String((part as Record<string, unknown>).text)
        : ""
    )
    .join("");
}

/**
 * Gemini usually identifies tool results by function name rather than a call
 * id, so ids are derived deterministically to survive the round trip. The
 * occurrence counter keeps parallel calls to the same function distinct —
 * without it an upstream sees one assistant message carrying two tool_calls
 * with the same id, rejects the turn, and the agent retries it forever.
 */
function callId(
  name: string,
  explicitId: unknown,
  counts: Map<string, number>
): string {
  const occurrence = (counts.get(name) ?? 0) + 1;
  counts.set(name, occurrence);

  if (typeof explicitId === "string" && explicitId) {
    return explicitId;
  }
  return `call_${name}_${occurrence}`;
}

function mapFinishReason(reason: unknown): string {
  switch (reason) {
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    case "tool_calls":
    case "stop":
      return "STOP";
    default:
      return "STOP";
  }
}
