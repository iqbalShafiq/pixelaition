/**
 * The event sanitizer the worker runs before anything leaves it. The runtime's
 * events are raw — a suspension's status event carries the whole interaction
 * request — so `follow` sanitizes before publishing, and the persisted history
 * is sanitized again when it is written. Both passes can meet the same shape,
 * so the sanitizer accepts its own output: `check_animation`'s counts survive
 * the second pass instead of being stripped as "not an array".
 */
export function sanitizeEvent(type: string, raw: unknown): unknown {
  // Interaction payloads were already reduced to the console's fields when
  // they were published; the resolved marker is just `{ id }`. Nothing to
  // strip from either.
  if (type === "interaction" || type === "interaction-resolved") return raw;
  const data = raw as Record<string, unknown> | undefined;
  const operationId =
    typeof data?.operationId === "string" ? data.operationId : undefined;
  if (type === "model_started" || type === "model_completed") return { operationId };
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
    const output = result?.output as { pairs?: unknown; flags?: unknown } | undefined;
    // check_animation's report is large; the console row prints only the pair
    // and flag counts, so only those travel through the stream. A second pass
    // meets the counts themselves and must keep them.
    const counts =
      typeof output?.pairs === "number" && typeof output?.flags === "number"
        ? { pairs: output.pairs, flags: output.flags }
        : Array.isArray(output?.pairs) && Array.isArray(output?.flags)
          ? { pairs: output.pairs.length, flags: output.flags.length }
          : undefined;
    return {
      operationId,
      result: {
        failed: result?.failed === true,
        error: typeof result?.error === "string" ? result.error : undefined,
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
  if (type === "asset-created") {
    return {
      assetId: typeof data?.assetId === "string" ? data.assetId : undefined,
      projectId: typeof data?.projectId === "string" ? data.projectId : undefined,
      name: typeof data?.name === "string" ? data.name : undefined,
    };
  }
  // Usage totals stream to the console as the run spends. The persisted
  // second pass meets its own `{ usage }` shape and must keep it.
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
