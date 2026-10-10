import {
  abstention,
  answerRelevancy,
  faithfulness,
  llmScore,
  promptAlignment,
  runEvalSuite,
} from "@anvia/core/evals";
import { OpenAIClient } from "@anvia/openai";

const key = process.env.OPENAI_API_KEY?.trim();
if (!key) {
  console.error("OPENAI_API_KEY is required for judge evaluations.");
  process.exit(1);
}

const model = new OpenAIClient({
  apiKey: key,
  ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
}).completionModel({
  modelId: process.env.EVAL_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
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
