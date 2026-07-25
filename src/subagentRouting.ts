/**
 * Cursor sends no explicit marker telling the proxy that a request belongs to a
 * subagent (Task tool) run rather than the main orchestrating agent, so the
 * classification below is a heuristic over the request body.
 *
 * The load-bearing signal is the tool list: the orchestrator is given a `Task`
 * tool so it can spawn subagents, while subagent runs get a narrower tool set
 * without it. Cursor can change its prompts and tool sets at any release, so
 * enable `logRequestBodies` and compare a real parent/child pair before
 * trusting this in anger.
 */

/** Tool names that only the spawning (orchestrator) side is given. */
const ORCHESTRATOR_TOOL_NAMES = ["task"];

export type AgentRole = "orchestrator" | "subagent" | "unknown";

export interface AgentRequestSignals {
  role: AgentRole;
  toolNames: string[];
  turnCount: number;
  systemPreview: string;
}

/**
 * Reads tool names out of an OpenAI, Anthropic, or Gemini shaped payload.
 */
export function extractToolNames(payload: Record<string, unknown>): string[] {
  const names: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) {
      names.push(value.trim());
    }
  };

  const tools = payload.tools;
  if (!Array.isArray(tools)) {
    return names;
  }

  for (const entry of tools) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const tool = entry as Record<string, unknown>;

    // OpenAI: { type: "function", function: { name } }
    const fn = tool.function;
    if (fn && typeof fn === "object") {
      push((fn as Record<string, unknown>).name);
    }

    // Anthropic: { name, input_schema }
    push(tool.name);

    // Gemini: { functionDeclarations: [{ name }] }
    const declarations = tool.functionDeclarations;
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        if (declaration && typeof declaration === "object") {
          push((declaration as Record<string, unknown>).name);
        }
      }
    }
  }

  return names;
}

/**
 * Collects the system prompt text from any of the three inbound formats.
 */
export function extractSystemText(payload: Record<string, unknown>): string {
  const parts: string[] = [];

  const collectContent = (content: unknown): void => {
    if (typeof content === "string") {
      parts.push(content);
      return;
    }
    if (!Array.isArray(content)) {
      return;
    }
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }
  };

  // Anthropic top-level system
  collectContent(payload.system);

  // OpenAI instructions (Responses API)
  if (typeof payload.instructions === "string") {
    parts.push(payload.instructions);
  }

  // OpenAI system/developer messages
  if (Array.isArray(payload.messages)) {
    for (const entry of payload.messages) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const message = entry as Record<string, unknown>;
      if (message.role === "system" || message.role === "developer") {
        collectContent(message.content);
      }
    }
  }

  // Gemini systemInstruction
  const systemInstruction = payload.systemInstruction ?? payload.system_instruction;
  if (systemInstruction && typeof systemInstruction === "object") {
    const instruction = systemInstruction as Record<string, unknown>;
    if (Array.isArray(instruction.parts)) {
      for (const part of instruction.parts) {
        if (part && typeof part === "object") {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === "string") {
            parts.push(text);
          }
        }
      }
    }
  }

  return parts.join("\n");
}

function countTurns(payload: Record<string, unknown>): number {
  if (Array.isArray(payload.messages)) {
    return payload.messages.length;
  }
  if (Array.isArray(payload.contents)) {
    return payload.contents.length;
  }
  if (Array.isArray(payload.input)) {
    return payload.input.length;
  }
  return 0;
}

/**
 * Classifies a request as coming from the orchestrator or a subagent.
 *
 * Requests with no tools at all (title generation, embeddings-style calls) stay
 * `unknown` so they are never rerouted.
 */
export function classifyAgentRequest(
  payload: Record<string, unknown>
): AgentRequestSignals {
  const toolNames = extractToolNames(payload);
  const systemText = extractSystemText(payload);
  const lowerNames = new Set(toolNames.map((name) => name.toLowerCase()));

  let role: AgentRole = "unknown";
  if (toolNames.length > 0) {
    role = ORCHESTRATOR_TOOL_NAMES.some((name) => lowerNames.has(name))
      ? "orchestrator"
      : "subagent";
  }

  return {
    role,
    toolNames,
    turnCount: countTurns(payload),
    systemPreview: systemText.slice(0, 240).replace(/\s+/g, " ").trim(),
  };
}

/**
 * One-line summary for the output channel when body logging is enabled.
 */
export function describeAgentRequest(signals: AgentRequestSignals): string {
  const tools =
    signals.toolNames.length > 0 ? signals.toolNames.join(", ") : "(none)";
  return [
    `role=${signals.role}`,
    `turns=${signals.turnCount}`,
    `tools=[${tools}]`,
    `system="${signals.systemPreview}"`,
  ].join(" ");
}
