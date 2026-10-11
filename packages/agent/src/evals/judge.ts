import {
  abstention,
  answerRelevancy,
  faithfulness,
  llmScore,
  promptAlignment,
  runEvalSuite,
} from "@anvia/core/evals";
import { OpenAIClient } from "@anvia/openai";
import OpenAI from "openai";

const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) {
  console.error("OPENROUTER_API_KEY is required for judge evaluations.");
  process.exit(1);
}

const evalModelId = process.env.EVAL_MODEL?.trim();
if (!evalModelId) {
  console.error(
    "EVAL_MODEL is required for judge evaluations. Set it to a model that supports structured outputs.",
  );
  process.exit(1);
}

const evalBaseUrl = process.env.OPENROUTER_BASE_URL?.trim();
const model = new OpenAIClient({
  // Same retry posture as the worker: the judge must not fail on one 429.
  client: new OpenAI({
    apiKey: key,
    ...(evalBaseUrl ? { baseURL: evalBaseUrl } : {}),
    maxRetries: 2,
  }),
}).completionModel({
  modelId: evalModelId,
  api: "chat",
});

type Sample = {
  prompt: string;
  answer: string;
  context: string[];
  shouldAbstain: boolean;
};

const cases: Array<{ id: string; input: Sample }> = [
  {
    id: "knight",
    input: {
      prompt: "Draw a 32 pixel knight",
      answer: "Drew a 32 by 32 knight using 4 palette colors.",
      context: ["size 32x32", "colors 4", "frame idle"],
      shouldAbstain: false,
    },
  },
  {
    id: "vague",
    input: {
      prompt: "gambar sesuatu",
      answer: "What should the pixel asset show?",
      context: ["no pixels committed"],
      shouldAbstain: true,
    },
  },
];

const result = await runEvalSuite({
  name: "pixelaition-judge",
  cases,
  target: (input: Sample) => input.answer,
  metrics: [
    faithfulness({
      model,
      retrievalContext: ({ case: testCase }) => testCase.input.context,
      threshold: 0.7,
    }),
    answerRelevancy({ model, threshold: 0.7 }),
    promptAlignment({
      model,
      threshold: 0.7,
      promptInstructions: [
        "Mention only committed size and colors.",
        "Ask a question when the prompt is vague.",
      ],
    }),
    abstention({
      model,
      shouldAbstain: ({ case: testCase }) => testCase.input.shouldAbstain,
    }),
    llmScore({
      model,
      threshold: 0.7,
      criteria:
        "Score 1 when the answer is specific, palette-limited, and free of invented colors.",
    }),
  ],
});

console.log(JSON.stringify({ cases: result.results.length }, null, 2));
if (result.results.some((item) => item.outcome === "fail")) process.exit(1);
