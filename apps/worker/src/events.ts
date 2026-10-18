/**
 * The event sanitizer the worker runs before anything leaves it. The runtime's
 * events are raw — a suspension's status event carries the whole interaction
 * request — so `follow` sanitizes before publishing, and the persisted history
 * is sanitized again when it is written. Both passes can meet the same shape,
 * so the sanitizer accepts its own output: `check_animation`'s counts survive
 * the second pass instead of being stripped as "not an array".
 */
import { contextFromResponse } from "./usage.js";

export function sanitizeEvent(type: string, raw: unknown): unknown {
  // Interaction payloads were already reduced to the console's fields when
  // they were published; the resolved marker is just `{ id }`. Nothing to
  // strip from either.
  if (type === "interaction" || type === "interaction-resolved") return raw;
  const data = raw as Record<string, unknown> | undefined;
  const operationId =
    typeof data?.operationId === "string" ? data.operationId : undefined;
  if (type === "model_started" || type === "model_completed") return { operationId };
  if (type === "model_delta") {
    const event = data?.event as
      { type?: unknown; text?: unknown; delta?: unknown } | undefined;
    const text =
      typeof event?.text === "string"
        ? event.text
        : typeof event?.delta === "string"
          ? event.delta
          : "";
    return {
      operationId,
      event: {
        type: typeof event?.type === "string" ? event.type : "text",
        ...(text.length > 0 ? { text: text.slice(0, 4000) } : {}),
      },
    };
  }
  if (type === "model_note") {
    const note = raw as { operationId?: unknown; channel?: unknown; text?: unknown };
    return {
      operationId: typeof note.operationId === "string" ? note.operationId : undefined,
      channel: note.channel === "thinking" ? "thinking" : "message",
      text: typeof note.text === "string" ? note.text.slice(0, 8000) : "",
    };
  }
  if (type === "tool_started") {
    const input = data?.input as
      { toolCall?: { toolName?: unknown; input?: unknown } } | undefined;
    return {
      operationId,
      input: {
        toolCall: { toolName: input?.toolCall?.toolName, input: input?.toolCall?.input },
      },
    };
  }
  if (type === "tool_completed") {
    const result = data?.result as
      { failed?: unknown; error?: unknown; output?: unknown } | undefined;
    // check_animation's report is large; the console row prints only the pair
    // and flag counts, so only those travel through the stream. A second pass
    // meets the counts themselves and must keep them. A refusal that carries
    // its own message puts it in `error`, below, which the console prints.
    const output = result?.output;
    const counts = animationCounts(output);
    const namedMessage =
      typeof (output as { message?: unknown } | undefined)?.message === "string"
        ? (output as { message: string }).message
        : undefined;
    return {
      operationId,
      result: {
        failed: result?.failed === true,
        error:
          typeof result?.error === "string" ? result.error : (namedMessage ?? undefined),
        ...(counts ? { output: counts } : {}),
      },
    };
  }
  if (type === "status") {
    const outcome = data?.outcome as { text?: unknown } | undefined;
    return {
      status: data?.status,
      error: typeof data?.error === "string" ? data.error : undefined,
      ...(typeof outcome?.text === "string" ? { outcome: { text: outcome.text } } : {}),
    };
  }
  if (type === "done") return { status: data?.status };
  // The console links a workspace run to the asset it created; the event is
  // small and worth restoring after a refresh.
  if (type === "asset-created" || type === "asset-bound") {
    return {
      assetId: typeof data?.assetId === "string" ? data.assetId : undefined,
      projectId: typeof data?.projectId === "string" ? data.projectId : undefined,
      name: typeof data?.name === "string" ? data.name : undefined,
    };
  }
  // Usage totals stream to the console as the run spends. The persisted
  // second pass meets its own `{ usage }` shape and must keep it. The context
  // state is validated: a malformed one becomes an explicit null, and the
  // console shows no context line rather than a guess.
  if (type === "usage") {
    const data = ((raw as { usage?: Record<string, unknown> } | undefined)?.usage ??
      raw) as Record<string, unknown> | undefined;
    const number = (key: string) =>
      typeof data?.[key] === "number" ? (data[key] as number) : undefined;
    return {
      usage: {
        input: number("input"),
        output: number("output"),
        total: number("total"),
        cached: number("cached"),
        cost: number("cost"),
        modelCalls: number("modelCalls"),
        modelCost: number("modelCost"),
        jevCalls: number("jevCalls"),
        jevCost: number("jevCost"),
        context: contextFromResponse(data?.context) ?? null,
      },
    };
  }
  // A steering receipt reaches the console as a follow-up row: queued when the
  // runtime accepted it, applied when it lands at a turn boundary.
  if (type === "steering_queued" || type === "steering_applied") {
    const data = raw as { id?: unknown; turn?: unknown } | undefined;
    return {
      id: typeof data?.id === "string" ? data.id : undefined,
      ...(type === "steering_applied" && typeof data?.turn === "number"
        ? { turn: data.turn }
        : {}),
    };
  }
  return {};
}

/**
 * The console's short summary of a `check_animation` result. New runs report
 * `pairs` and `flags` as lists of objects and strings; older stored runs hold
 * counts. Both are read, so a replay of an old run shows the same line a new
 * one does.
 */
export function animationCounts(
  result: unknown,
): { pairs: number; flags: number } | undefined {
  const output = result as { pairs?: unknown; flags?: unknown } | undefined;
  if (output === null || typeof output !== "object") return undefined;
  const count = (value: unknown): number | undefined => {
    if (typeof value === "number") return value;
    if (!Array.isArray(value)) return undefined;
    // An array of strings is one flag per entry; an array of objects is one per
    // pair. The caller names which it holds, below.
    return value.length;
  };
  const pairs = count(output.pairs);
  const flags = count(output.flags);
  return pairs === undefined || flags === undefined ? undefined : { pairs, flags };
}

/**
 * The closing message a run left behind: the newest stored `status` event
 * that carries an `outcome`. A stored window may still hold the run's bare
 * `running` status, and picking that one first stored no answer at all — the
 * decision then read a follow-up without the question it answers.
 */
export function outcomeTextFrom(
  events: Array<{ type: string; data?: unknown }>,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined || event.type !== "status") continue;
    const text = (event.data as { outcome?: { text?: string } } | undefined)?.outcome
      ?.text;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return undefined;
}
