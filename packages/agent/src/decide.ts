import { randomUUID } from "node:crypto";
import { generateCompletion } from "@anvia/core/completion";
import { choice, check, decide } from "@anvia/core/decision";
import type { DecisionModel } from "@anvia/core/decision";
import { JEV_LATEST, JevClient } from "@anvia/jev";
import { OpenAIClient } from "@anvia/openai";
import { z } from "zod";
import { openCodeGoHeaders } from "./models.js";

export type DrawIntent = "draw" | "edit" | "variant" | "clarify";
export type DrawDecision = {
  intent: DrawIntent;
  confidence: number;
  question?: string;
  source: "jev" | "model";
};

/** Generation refuses to start until a real decision model is configured. */
export class DecisionNotConfiguredError extends Error {
  constructor() {
    super("Set DECISION_MODEL (or TYPESAFE_API_KEY) before generating.");
    this.name = "DecisionNotConfiguredError";
  }
}

const intentOptions = {
  draw: "Draw a new sprite, item, or tile from scratch.",
  edit: "Change pixels or colors that already exist on the frame.",
  variant: "Produce another state, direction, or action of an existing frame.",
  clarify: "The request is too vague, so ask one question instead of drawing.",
} as const;

const intentQuestion = choice({
  instructions:
    "Classify what the user is asking for. Prefer variant when the request names a direction, an action, or another state of a frame that already exists.",
  options: intentOptions,
});

const specificQuestion = check({
  instructions:
    "Answer yes when the request names a concrete subject and enough detail to draw it. Answer no when it is a placeholder such as 'draw something'.",
});

const decisionOutput = z.object({
  intent: z.enum(["draw", "edit", "variant", "clarify"]),
  confidence: z.number().min(0).max(1),
  // Strict structured outputs require every property in `required`, so the
  // optional question is expressed as nullable instead of omitted.
  question: z.string().min(1).max(300).nullable(),
});
type DecisionOutput = z.infer<typeof decisionOutput>;

const decisionInstructions = [
  "Decide how to handle one pixel-art request.",
  "Answer draw, edit, or variant when the request is concrete.",
  "Answer clarify when it is too vague to draw from, and then ask exactly one short question.",
].join(" ");

export function toDecision(
  raw: DecisionOutput,
  source: DrawDecision["source"],
): DrawDecision {
  return {
    intent: raw.intent,
    confidence: raw.confidence,
    ...(raw.intent === "clarify" && raw.question ? { question: raw.question } : {}),
    source,
  };
}

function jevModel(apiKey: string): DecisionModel<unknown> {
  return new JevClient({ apiKey }).decisionModel({
    modelId: JEV_LATEST,
  }) as DecisionModel<unknown>;
}

async function askJev(
  model: DecisionModel<unknown>,
  prompt: string,
): Promise<DrawDecision> {
  const result = await decide({
    model,
    state: { prompt },
    questions: { intent: intentQuestion, specific: specificQuestion },
  });
  const { intent, specific } = result.answers;
  const chosen = intent.choice;
  if (chosen === "clarify" || specific.probability < 0.7) {
    return {
      intent: "clarify",
      confidence: Math.min(intent.confidence ?? 1, specific.probability),
      question:
        "What should the pixel asset show, and about how many pixels wide should it be?",
      source: "jev",
    };
  }
  return {
    intent: chosen in intentOptions ? chosen : "draw",
    confidence: intent.confidence ?? specific.probability,
    source: "jev",
  };
}

export async function decidePrompt(
  prompt: string,
  env: {
    typesafeApiKey?: string | undefined;
    openaiApiKey?: string | undefined;
    openaiBaseUrl?: string | undefined;
    decisionModel?: string | undefined;
    decisionApi?: "chat" | "responses" | undefined;
  },
): Promise<DrawDecision> {
  if (env.typesafeApiKey?.trim()) {
    return askJev(jevModel(env.typesafeApiKey.trim()), prompt);
  }
  const apiKey = env.openaiApiKey?.trim();
  const modelId = env.decisionModel?.trim();
  if (!apiKey || !modelId || !env.decisionApi) throw new DecisionNotConfiguredError();
  const baseUrl = env.openaiBaseUrl?.trim();
  const headers = openCodeGoHeaders(baseUrl, randomUUID());
  const client = new OpenAIClient({
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(headers ? { headers } : {}),
  });
  const model = client.completionModel({ modelId, api: env.decisionApi });
  const result = await generateCompletion({
    model,
    prompt,
    instructions: decisionInstructions,
    outputSchema: decisionOutput,
  });
  return toDecision(result.output, "model");
}
