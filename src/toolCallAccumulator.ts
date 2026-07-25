/**
 * Reassembles streamed OpenAI tool-call deltas into whole calls.
 *
 * Providers disagree on how they identify a call across deltas: some send a
 * stable `id`, some send only an `index`, and some send `index: 0` (or nothing)
 * for every call in the turn. Keying purely on `index` makes those last cases
 * concatenate the arguments of unrelated calls into one unparsable blob, so
 * calls are tracked by whichever identifier the provider actually supplies.
 */

export interface AccumulatedToolCall {
  id?: string;
  name: string;
  arguments: string;
}

export class ToolCallAccumulator {
  private readonly slots: AccumulatedToolCall[] = [];
  private readonly byKey = new Map<string, AccumulatedToolCall>();

  /**
   * Applies one delta and reports the call it belongs to, whether that call was
   * opened by this delta, and the argument fragment appended to it.
   */
  add(delta: Record<string, unknown>): {
    call: AccumulatedToolCall;
    opened: boolean;
    added: string;
  } {
    const fn = delta.function as Record<string, unknown> | undefined;
    const id =
      typeof delta.id === "string" && delta.id ? delta.id : undefined;
    const name =
      typeof fn?.name === "string" && fn.name ? fn.name : undefined;
    const index = typeof delta.index === "number" ? delta.index : undefined;

    // An id identifies a call exactly; an index only identifies it when the
    // provider sent no id, since id-less continuations of an id-bearing call
    // still carry its index.
    const lookupKey = id
      ? `id:${id}`
      : index !== undefined
        ? `idx:${index}`
        : undefined;

    let call = lookupKey
      ? this.byKey.get(lookupKey)
      : name
        ? undefined
        : this.slots[this.slots.length - 1];

    // A name on a call whose arguments are already complete, or that names a
    // different function, means the provider is reusing the key for a new call.
    if (call && name && (name !== call.name || isCompleteJson(call.arguments))) {
      call = undefined;
    }

    let opened = false;
    if (!call) {
      call = { id, name: name ?? "", arguments: "" };
      this.slots.push(call);
      opened = true;
    }

    if (id) {
      this.byKey.set(`id:${id}`, call);
      if (!call.id) {
        call.id = id;
      }
    }
    if (index !== undefined) {
      this.byKey.set(`idx:${index}`, call);
    }
    if (name && !call.name) {
      call.name = name;
    }
    const added = typeof fn?.arguments === "string" ? fn.arguments : "";
    if (added) {
      call.arguments += added;
    }

    return { call, opened, added };
  }

  list(): readonly AccumulatedToolCall[] {
    return this.slots;
  }

  clear(): void {
    this.slots.length = 0;
    this.byKey.clear();
  }
}

/** Parses accumulated arguments, falling back to the raw text when malformed. */
export function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _raw: raw };
  }
}

function isCompleteJson(raw: string): boolean {
  if (!raw.trim()) {
    return false;
  }
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}
