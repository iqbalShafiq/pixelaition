import { z } from "zod";
import type { RunBinding } from "./runs.js";

/**
 * The Jev request check for destructive tool calls. Jev answers two typed
 * questions about the call against the user's request; the code turns the
 * probabilities into one of three outcomes, the way OpenRouter's tool-gate
 * cookbook prescribes:
 *
 * - `approve`: every check is at or above `GATE_APPROVE_AT`, so the call runs.
 * - `block`: some check is at or below `GATE_BLOCK_AT`, so the call is refused
 *   to the model without touching the frame.
 * - `review`: anything in the middle pauses for the human through the normal
 *   approval flow.
 *
 * The thresholds are deliberately far apart so a human only sees the calls a
 * check is neither clearly true nor clearly false about.
 */
export type ToolGateOutcome = {
  outcome: "approve" | "block" | "review";
  reason: string;
  checks: { supported: number; proportionate: number };
};

const GATE_APPROVE_AT = 0.9;
const GATE_BLOCK_AT = 0.1;

/** Jev lives on OpenRouter's Decisions API, not the chat endpoints. */
const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

const gateAnswerSchema = z.object({
  answers: z.object({
    supported: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
    proportionate: z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
  }),
  usage: z.object({ cost: z.number().optional() }).optional(),
});

const gateQuestions = {
  supported: {
    type: "noul",
    instructions:
      "The user's request in `request` asks for `call`, or `call` is a direct step of what they asked for. `call.description` says what the call does.",
    criteria: {
      true: "The request asks for this change, or the change is a direct step of what the request asks for.",
      false:
        "The request does not ask for this change, and the change is not a step of what the request asks for.",
    },
  },
  proportionate: {
    type: "noul",
    instructions:
      "`call` stays within the scope of `request`: it does not clear, recolor, or replace a much larger part of the frame than the request describes. Compare `call.args` against `asset.width`, `asset.height`, and `request`.",
    criteria: {
      true: "The change touches only as much of the frame as the request describes.",
      false:
        "The change touches a much larger part of the frame than the request describes.",
    },
  },
} as const;

/** The two probabilities select the outcome; formatting keeps reasons readable. */
export function toGateOutcome(checks: {
  supported: number;
  proportionate: number;
}): ToolGateOutcome {
  const { supported, proportionate } = checks;
  const pair = `supported=${supported.toFixed(2)}, proportionate=${proportionate.toFixed(2)}`;
  if (supported >= GATE_APPROVE_AT && proportionate >= GATE_APPROVE_AT) {
    return { outcome: "approve", reason: pair, checks };
  }
  if (supported <= GATE_BLOCK_AT || proportionate <= GATE_BLOCK_AT) {
    return { outcome: "block", reason: `not supported by the request (${pair})`, checks };
  }
  return {
    outcome: "review",
    reason: `the request check is not clear (${pair})`,
    checks,
  };
}

/**
 * Ask Jev whether the call is supported by, and proportionate to, the user's
 * request. A missing key, an unreachable provider, or an answer shape this
 * client does not understand is an error naming the cause; it never becomes an
 * approval.
 */
export async function gateToolCall(
  run: RunBinding,
  toolName: string,
  description: string,
  args: unknown,
): Promise<ToolGateOutcome> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.JEV_MODEL?.trim();
  if (!apiKey || !model) {
    throw new Error("Set OPENROUTER_API_KEY and JEV_MODEL for the Jev request check.");
  }
  const frame =
    run.currentFrameId !== undefined ? run.frames.get(run.currentFrameId) : undefined;
  const state = {
    request: run.request ?? "(this run did not record the user's request)",
    asset: { name: run.assetName, width: run.width, height: run.height },
    frame: { name: frame?.name },
    palette: run.palette,
    call: { tool: toolName, description, args },
  };
  const response = await fetch(JEV_DECISIONS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, state, questions: gateQuestions }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`The Jev request check returned ${response.status}.`);
  }
  const parsed = gateAnswerSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Jev returned an answer shape this client does not understand.");
  }
  return toGateOutcome({
    supported: parsed.data.answers.supported.noul,
    proportionate: parsed.data.answers.proportionate.noul,
  });
}

/**
 * One verdict awaits its tool call at a time: `requiresApproval` records it and
 * the tool's own execution consumes it. A denied review leaves its entry
 * unused; the next call for the same run and tool overwrites it.
 */
const outcomes = new Map<string, ToolGateOutcome>();

const outcomeKey = (runId: string, toolName: string) => `${runId}:${toolName}`;

export function rememberGateOutcome(
  runId: string,
  toolName: string,
  outcome: ToolGateOutcome,
): void {
  outcomes.set(outcomeKey(runId, toolName), outcome);
}

export function takeGateOutcome(
  runId: string,
  toolName: string,
): ToolGateOutcome | undefined {
  const key = outcomeKey(runId, toolName);
  const outcome = outcomes.get(key);
  outcomes.delete(key);
  return outcome;
}

/** Drop every verdict a finished run left behind. */
export function clearGateOutcomes(runId: string): void {
  const prefix = `${runId}:`;
  for (const key of outcomes.keys()) {
    if (key.startsWith(prefix)) outcomes.delete(key);
  }
}
