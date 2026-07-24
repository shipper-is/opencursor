export function joinUpstreamUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  let normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (normalizedBase.endsWith("/v1") && normalizedPath.startsWith("/v1/")) {
    normalizedPath = normalizedPath.slice(3);
  } else if (normalizedBase.endsWith("/v1") && normalizedPath === "/v1") {
    normalizedPath = "";
  }

  return `${normalizedBase}${normalizedPath}`;
}

export function isResponsesFormat(payload: Record<string, unknown>): boolean {
  if ("messages" in payload) {
    return false;
  }
  if ("input" in payload) {
    return true;
  }

  const markers = [
    "previous_response_id",
    "instructions",
    "parallel_tool_calls",
    "reasoning",
    "text",
    "truncation",
  ];

  return markers.some((marker) => marker in payload);
}

export function toChatCompletionsPayload(
  payload: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const messages = responsesInputToMessages(payload.input);

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: payload.stream ?? false,
  };

  if (payload.temperature !== undefined) {
    body.temperature = payload.temperature;
  }
  if (payload.max_tokens !== undefined) {
    body.max_tokens = payload.max_tokens;
  } else if (payload.max_output_tokens !== undefined) {
    body.max_tokens = payload.max_output_tokens;
  }

  if (payload.tools !== undefined) {
    body.tools = payload.tools;
  }
  if (payload.tool_choice !== undefined) {
    body.tool_choice = payload.tool_choice;
  }

  return body;
}

function responsesInputToMessages(
  input: unknown
): Array<{ role: string; content: unknown }> {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }

  if (!Array.isArray(input)) {
    return [{ role: "user", content: "" }];
  }

  const messages: Array<{ role: string; content: unknown }> = [];

  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }

    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const type = String(record.type ?? "");

    if (type === "message" || record.role) {
      const role = String(record.role ?? "user");
      const content = normalizeMessageContent(record.content);
      messages.push({ role, content });
      continue;
    }

    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        content: String(record.output ?? ""),
      });
      continue;
    }

    if (record.content !== undefined) {
      messages.push({
        role: String(record.role ?? "user"),
        content: record.content,
      });
    }
  }

  return messages.length > 0 ? messages : [{ role: "user", content: "" }];
}

function normalizeMessageContent(content: unknown): unknown {
  if (typeof content === "string" || Array.isArray(content)) {
    return content;
  }

  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (record.text !== undefined) {
      return String(record.text);
    }
  }

  return content ?? "";
}
