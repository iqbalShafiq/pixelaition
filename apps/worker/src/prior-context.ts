/**
 * Earlier drawing turns that a new plan child must see: every user request,
 * the follow-ups steered into those tasks, their reference images, and a
 * compact record of what each agent did. Pixel arguments stay out.
 */

const IMAGE_CAP = 8;
const TEXT_CAP = 16_000;
const MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type PriorAttachment = {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
};

export type PriorTurn = {
  request: string;
  followUps: string[];
  steps: string[];
  attachments: PriorAttachment[];
};

export type PriorContext = {
  text: string;
  attachments: PriorAttachment[];
};

export type DurableDrawRecord = {
  request?: string;
  attachments: PriorAttachment[];
  followUps: string[];
};

type StoredEvent = {
  sequence?: number;
  type?: string;
  data?: unknown;
};

export type PriorRun = {
  role: string | null;
  workerKey: string | null;
  events: unknown;
};

/** Labels match the console (`agentLabel` in the web app). */
function stepLabel(key: string): string {
  const base = key.replace(/-retry-\d+$/, "");
  const worker = /^w(\d+)$/.exec(base);
  if (worker) return `Agent ${worker[1]}`;
  if (base === "plan" || base.startsWith("plan-")) return "Supervisor";
  const review = /^review-(\d+)/.exec(base);
  if (review) return `Reviewer ${review[1]}`;
  if (base === "review") return "Reviewer";
  const fix = /^fix-(\d+)-(\d+)$/.exec(base);
  if (fix) return fix[2] === "1" ? `Fix ${fix[1]}` : `Fix ${fix[1]}.${fix[2]}`;
  if (base === "fix" || base === "fix-unpainted") return "Fix";
  return base;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function attachmentsFromUnknown(raw: unknown): PriorAttachment[] {
  if (!Array.isArray(raw)) return [];
  const images: PriorAttachment[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const mediaType = record?.mediaType;
    const data = record?.data;
    if (typeof mediaType !== "string" || !MEDIA.has(mediaType)) continue;
    if (typeof data !== "string" || data.length < 16) continue;
    images.push({
      mediaType: mediaType as PriorAttachment["mediaType"],
      data,
    });
    if (images.length === 4) break;
  }
  return images;
}

function signalPayload(entry: unknown): Record<string, unknown> | undefined {
  const record = asRecord(entry);
  if (!record) return undefined;
  return asRecord(record.value) ?? record;
}

/** steer-1, steer-2, … in the order they were delivered. */
export function followUpsFromSignals(signals: unknown): string[] {
  const record = asRecord(signals);
  if (!record) return [];
  const lines: Array<{ index: number; message: string }> = [];
  for (const [key, entry] of Object.entries(record)) {
    if (!key.startsWith("steer-")) continue;
    const index = Number(key.slice("steer-".length));
    if (!Number.isInteger(index) || index <= 0) continue;
    const message = signalPayload(entry)?.message;
    if (typeof message !== "string" || message.trim().length === 0) continue;
    lines.push({ index, message: message.trim().slice(0, 4000) });
  }
  return lines
    .sort((left, right) => left.index - right.index)
    .map((line) => line.message);
}

export function parseDurableRecord(record: string): DurableDrawRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record);
  } catch {
    return undefined;
  }
  const root = asRecord(parsed);
  const input = asRecord(root?.input);
  const request = typeof input?.request === "string" ? input.request : undefined;
  return {
    ...(request !== undefined && request.trim().length > 0
      ? { request: request.trim() }
      : {}),
    attachments: attachmentsFromUnknown(input?.attachments),
    followUps: followUpsFromSignals(root?.signals),
  };
}

function toolName(data: unknown): string | undefined {
  const input = asRecord(asRecord(data)?.input);
  const call = asRecord(input?.toolCall);
  return typeof call?.toolName === "string" ? call.toolName : undefined;
}

/**
 * One line per finished tool and per supervisor or worker message.
 * Thinking and token deltas are not steps the next run needs.
 */
export function stepsFromRuns(runs: PriorRun[]): string[] {
  const lines: string[] = [];
  for (const run of runs) {
    if ((run.workerKey ?? "").startsWith("slot-")) continue;
    const key =
      run.workerKey !== null && run.workerKey.length > 0
        ? run.workerKey
        : (run.role ?? "plan");
    const label = stepLabel(key);
    const events = (Array.isArray(run.events) ? run.events : [])
      .flatMap((event) => {
        const record = asRecord(event);
        if (!record || typeof record.type !== "string") return [];
        const stored: StoredEvent = {
          type: record.type,
          ...(typeof record.sequence === "number" ? { sequence: record.sequence } : {}),
          data: record.data,
        };
        return [stored];
      })
      .sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0));
    const names = new Map<string, string>();
    for (const event of events) {
      const data = asRecord(event.data);
      const operationId =
        typeof data?.operationId === "string" ? data.operationId : undefined;
      if (event.type === "tool_started" && operationId !== undefined) {
        const name = toolName(event.data);
        if (name !== undefined) names.set(operationId, name);
      }
      if (event.type === "tool_completed") {
        const name =
          (operationId !== undefined ? names.get(operationId) : undefined) ?? "tool";
        const result = asRecord(data?.result);
        const failed = result?.failed === true;
        const error =
          typeof result?.error === "string" ? result.error.trim().slice(0, 160) : "";
        lines.push(
          failed
            ? `${label} · ${name} — ${error.length > 0 ? error : "failed"}`
            : `${label} · ${name} — ok`,
        );
      }
      if (event.type === "model_note" && data?.channel !== "thinking") {
        const text = typeof data?.text === "string" ? data.text.trim().slice(0, 400) : "";
        if (text.length > 0) lines.push(`${label}: ${text}`);
      }
    }
  }
  return lines;
}

/**
 * Every user line stays. Images are capped at eight, dropping the oldest
 * turns' images first. Step lines drop from the oldest turn once the
 * transcript passes the character cap. A model that cannot view images
 * receives no attachment bytes; the per-turn notes say so instead.
 */
export function formatPriorContext(
  turns: PriorTurn[],
  options?: { images?: boolean },
): PriorContext {
  const kept = turns.filter((turn) => turn.request.trim().length > 0);
  if (kept.length === 0) return { text: "", attachments: [] };
  const withImages = options?.images !== false;

  const take = new Array<number>(kept.length).fill(0);
  let budget = IMAGE_CAP;
  if (withImages) {
    for (let index = kept.length - 1; index >= 0 && budget > 0; index -= 1) {
      const count = Math.min(kept[index]?.attachments.length ?? 0, budget);
      take[index] = count;
      budget -= count;
    }
  }
  const attachments: PriorAttachment[] = [];
  let droppedImages = 0;
  if (withImages) {
    for (let index = 0; index < kept.length; index += 1) {
      const all = kept[index]?.attachments ?? [];
      const count = take[index] ?? 0;
      droppedImages += all.length - count;
      attachments.push(...all.slice(all.length - count));
    }
  }

  const counts = kept.map((turn) => turn.steps.length);
  const render = (): string => {
    const preface = [
      withImages
        ? "Earlier drawing turns on this asset, oldest first. Honour them. Reference images from those turns are attached before this message's own images, in the same order."
        : "Earlier drawing turns on this asset, oldest first. Honour them.",
      droppedImages > 0
        ? `${droppedImages} older reference images were left out to stay within the image limit.`
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    const body = kept
      .map((turn, index) => {
        const count = counts[index] ?? 0;
        const omitted = turn.steps.length - count;
        const imageNote =
          turn.attachments.length === 0
            ? ""
            : !withImages
              ? `Reference images: ${turn.attachments.length} (not attached: this model cannot view images).`
              : (take[index] ?? 0) === turn.attachments.length
                ? `Reference images: ${turn.attachments.length}, attached in order before this message's images.`
                : `Reference images: ${take[index] ?? 0} of ${turn.attachments.length} attached; the oldest were left out.`;
        return [
          `Turn ${index + 1}. User: ${turn.request.trim()}`,
          ...turn.followUps.map((line) => `User follow-up: ${line}`),
          imageNote,
          omitted > 0 ? `(${omitted} earlier steps omitted)` : "",
          ...turn.steps.slice(turn.steps.length - count),
        ]
          .filter((line) => line.length > 0)
          .join("\n");
      })
      .join("\n\n");
    return `${preface}\n\n${body}\n\nThis message continues that work.`;
  };

  let text = render();
  while (text.length > TEXT_CAP && counts.some((count) => count > 0)) {
    const index = counts.findIndex((count) => count > 0);
    if (index === -1) break;
    counts[index] = (counts[index] ?? 0) - 1;
    text = render();
  }
  return { text, attachments };
}
