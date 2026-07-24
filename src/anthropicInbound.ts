/**
 * Translates inbound Anthropic Messages API traffic into OpenAI
 * chat/completions calls, and converts the replies back.
 *
 * Needed because Cursor picks a provider slot from the model-name prefix:
 * `claude-*` routes through the Anthropic slot, which lets the OpenAI BYOK
 * switch stay off so built-in Cursor models keep working.
 */

interface AnthropicToolUseBlock extends Record<string, unknown> {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface OpenAiToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export function anthropicToOpenAi(
  payload: Record<string, unknown>,
  upstreamModel: string
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  const system = payload.system;
  if (typeof system === "string" && system.trim()) {
    messages.push({ role: "system", content: system });
  } else if (Array.isArray(system)) {
    const text = system
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : ""
      )
      .join("");
    if (text.trim()) {
      messages.push({ role: "system", content: text });
    }
  }

  const inputMessages = Array.isArray(payload.messages) ? payload.messages : [];

  for (const raw of inputMessages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as Record<string, unknown>;
    const role = String(message.role ?? "user");
    const content = message.content;

    if (typeof content === "string") {
      messages.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) {
      continue;
    }

    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];

    for (const blockRaw of content) {
      if (!blockRaw || typeof blockRaw !== "object") {
        continue;
      }
      const block = blockRaw as Record<string, unknown>;
      const type = String(block.type ?? "");

      if (type === "text") {
        textParts.push(String(block.text ?? ""));
      } else if (type === "tool_use") {
        toolCalls.push({
          id: String(block.id ?? ""),
          type: "function",
          function: {
            name: String(block.name ?? ""),
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (type === "tool_result") {
        // Tool results become their own OpenAI `tool` message.
        messages.push({
          role: "tool",
          tool_call_id: String(block.tool_use_id ?? ""),
          content: stringifyToolResult(block.content),
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
    stream: payload.stream ?? false,
  };

  if (payload.max_tokens !== undefined) {
    body.max_tokens = payload.max_tokens;
  }
  if (payload.temperature !== undefined) {
    body.temperature = payload.temperature;
  }
  if (payload.top_p !== undefined) {
    body.top_p = payload.top_p;
  }

  const tools = Array.isArray(payload.tools) ? payload.tools : undefined;
  if (tools && tools.length > 0) {
    body.tools = tools.map((toolRaw) => {
      const tool = (toolRaw ?? {}) as Record<string, unknown>;
      return {
        type: "function",
        function: {
          name: String(tool.name ?? ""),
          description: String(tool.description ?? ""),
          parameters: tool.input_schema ?? { type: "object", properties: {} },
        },
      };
    });
  }

  if (body.stream === true) {
    body.stream_options = { include_usage: true };
  }

  return body;
}

export function openAiToAnthropicResponse(
  openai: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const choices = Array.isArray(openai.choices) ? openai.choices : [];
  const first = (choices[0] ?? {}) as Record<string, unknown>;
  const message = (first.message ?? {}) as Record<string, unknown>;

  const content: Array<Record<string, unknown>> = [];
  const text = typeof message.content === "string" ? message.content : "";
  if (text) {
    content.push({ type: "text", text });
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const callRaw of toolCalls) {
    const call = (callRaw ?? {}) as OpenAiToolCall;
    content.push(toolUseBlock(call));
  }

  const usage = (openai.usage ?? {}) as Record<string, unknown>;

  return {
    id: openai.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

/**
 * Incrementally rewrites an OpenAI SSE stream as Anthropic SSE events.
 * Anthropic requires explicit block start/stop framing, so state is kept
 * across chunks.
 */
export class AnthropicStreamTranslator {
  private buffer = "";
  private started = false;
  private textBlockOpen = false;
  private nextIndex = 0;
  private readonly toolBlocks = new Map<
    number,
    { index: number; id: string; name: string }
  >();
  private finished = false;
  private usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 0,
    output_tokens: 0,
  };
  private stopReason = "end_turn";

  constructor(
    private readonly messageId: string,
    private readonly model: string
  ) {}

  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }

      const data = trimmed.slice(5).trim();
      if (!data) {
        continue;
      }

      if (data === "[DONE]") {
        out += this.finish();
        continue;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      out += this.handleChunk(parsed);
    }

    return out;
  }

  finish(): string {
    if (this.finished) {
      return "";
    }
    this.finished = true;

    let out = "";
    if (!this.started) {
      out += this.start();
    }

    if (this.textBlockOpen) {
      out += event("content_block_stop", { type: "content_block_stop", index: 0 });
      this.textBlockOpen = false;
    }

    for (const block of this.toolBlocks.values()) {
      out += event("content_block_stop", {
        type: "content_block_stop",
        index: block.index,
      });
    }
    this.toolBlocks.clear();

    out += event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: this.stopReason, stop_sequence: null },
      usage: { output_tokens: this.usage.output_tokens },
    });
    out += event("message_stop", { type: "message_stop" });
    return out;
  }

  private handleChunk(chunk: Record<string, unknown>): string {
    let out = "";

    if (!this.started) {
      out += this.start();
    }

    const usage = chunk.usage as Record<string, unknown> | undefined;
    if (usage) {
      this.usage = {
        input_tokens: Number(usage.prompt_tokens ?? this.usage.input_tokens),
        output_tokens: Number(
          usage.completion_tokens ?? this.usage.output_tokens
        ),
      };
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;

    const textDelta =
      typeof delta.content === "string" ? delta.content : undefined;
    if (textDelta) {
      if (!this.textBlockOpen) {
        this.textBlockOpen = true;
        this.nextIndex = Math.max(this.nextIndex, 1);
        out += event("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
      }
      out += event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: textDelta },
      });
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const callRaw of toolCalls) {
      const call = (callRaw ?? {}) as Record<string, unknown>;
      const slot = Number(call.index ?? 0);
      let block = this.toolBlocks.get(slot);

      if (!block) {
        const index = this.nextIndex === 0 ? 1 : this.nextIndex;
        this.nextIndex = index + 1;
        block = {
          index,
          id: String(call.id ?? `toolu_${Date.now()}_${slot}`),
          name: String(
            (call.function as Record<string, unknown> | undefined)?.name ?? ""
          ),
        };
        this.toolBlocks.set(slot, block);
        out += event("content_block_start", {
          type: "content_block_start",
          index: block.index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        });
      }

      const fn = call.function as Record<string, unknown> | undefined;
      const args = typeof fn?.arguments === "string" ? fn.arguments : "";
      if (args) {
        out += event("content_block_delta", {
          type: "content_block_delta",
          index: block.index,
          delta: { type: "input_json_delta", partial_json: args },
        });
      }
      this.stopReason = "tool_use";
    }

    const finishReason = choice.finish_reason;
    if (typeof finishReason === "string" && finishReason) {
      this.stopReason =
        finishReason === "tool_calls" ? "tool_use" : mapStopReason(finishReason);
    }

    return out;
  }

  private start(): string {
    this.started = true;
    return event("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: this.usage,
      },
    });
  }
}

function toolUseBlock(call: OpenAiToolCall): AnthropicToolUseBlock {
  let input: unknown = {};
  const args = call.function?.arguments;
  if (typeof args === "string" && args.trim()) {
    try {
      input = JSON.parse(args);
    } catch {
      input = { _raw: args };
    }
  }

  return {
    type: "tool_use",
    id: call.id ?? `toolu_${Date.now()}`,
    name: call.function?.name ?? "",
    input,
  };
}

function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && "text" in block
          ? String((block as { text: unknown }).text)
          : JSON.stringify(block)
      )
      .join("");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

function mapStopReason(reason: string): string {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "stop":
      return "end_turn";
    default:
      return "end_turn";
  }
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
