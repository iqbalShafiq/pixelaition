/**
 * The isolated Jev evaluation: the intent decision only, against Jev alone.
 *
 * No baseline LLM, no guardrail, gate, or home suites — one cheap Jev call per
 * fixture, so a prompt change can be measured for a few cents. Every fixture
 * is run `runs` times (default 3) because a marginal case answers differently
 * between calls, and a prompt is only better when it is better most of the
 * time, not once.
 *
 * The suite runs through Anvia's own eval runner (`runEvalSuite` from
 * `@anvia/core/evals`) with deterministic metrics only — no judge model, so
 * nothing here costs a second call beyond Jev itself.
 *
 * Run with `pnpm eval:jev:decisions` (root), which injects the root `.env`.
 * Flags: --runs <n> (default 3), --only <substring> (filter labels), --verbose.
 */
import { exactMatch, runEvalSuite } from "@anvia/core/evals";
import { decidePrompt, type DecisionContext } from "../decide.js";

const apiKey = process.env.DECISION_MODEL_API_KEY?.trim();
const jevModel = process.env.DECISION_MODEL?.trim();
const baseUrl = process.env.DECISION_MODEL_BASE_URL?.trim();
if (!apiKey || !jevModel || !baseUrl) {
  console.error(
    "DECISION_MODEL_API_KEY, DECISION_MODEL, and DECISION_MODEL_BASE_URL are required.",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const RUNS = Math.max(1, Number(flag("--runs") ?? 3));
const ONLY = flag("--only");

/** The cost Jev reported for the last call, summed by `target`. */
let lastCost = 0;
const env = {
  apiKey,
  model: jevModel,
  baseUrl,
  onCall: (call: { cost?: number }) => {
    lastCost = call.cost ?? 0;
  },
};

/** One eval case: the user's turn plus the context the decision reads. */
type Intent = "draw" | "edit" | "variant" | "ask";

type DecisionCaseInput = {
  label: string;
  /** The message the user typed. */
  input: string;
  context: DecisionContext;
  /** What the fixture guards, printed next to a failure. */
  why: string;
};

type Fixture = {
  label: string;
  /** The message the user typed. */
  input: string;
  expected: Intent;
  /** What the fixture guards, printed in the failure list. */
  why: string;
  context?: DecisionContext;
  /** Override the run count for a case whose answer is a coin flip. */
  runs?: number;
};

const palette = ["#00000000", "#1a1c2c", "#3b5dc9", "#41a6f6"];
const slimeAsset = {
  name: "slime",
  width: 32,
  height: 32,
  palette,
  summary: "A blue round blob with two eyes.",
};
const slime: DecisionContext = {
  asset: slimeAsset,
  frames: ["idle"],
  frameName: "idle",
};
const scoups: DecisionContext = {
  asset: {
    name: "scoups",
    width: 32,
    height: 32,
    palette: [
      "#00000000",
      "#1a1c2c",
      "#f4efe4",
      "#c65a4e",
      "#f6cba6",
      "#d79a74",
      "#3a2830",
      "#f2a3ae",
      "#232329",
    ],
    summary:
      "A smiling cartoon face with a 9-color palette on a 32×32 canvas, featuring black hair, peach skin, black eyes and a red mouth. Its only frame is sweet-face.",
  },
  frames: ["sweet-face"],
  frameName: "sweet-face",
};
/** The real komputer thread, as the decision read it turn by turn. */
const komputer: DecisionContext = {
  projectName:
    "Pixel-art asset library: komputer, kipp2, kipp, fan, obor, showing 6–8-color sprites.",
  asset: {
    name: "komputer",
    width: 32,
    height: 32,
    palette: ["#00000000", "#1a1c2c", "#f4efe4", "#e8ff6a", "#5a6a7a", "#7de8ff"],
    summary:
      "A 6-color pixel-art vintage desktop computer, shown first with a blank screen, then with a glowing light-blue screen.",
  },
  frames: ["layar-mati", "layar-nyala"],
  frameName: "layar-nyala",
};
const turn1 = {
  prompt:
    "saya ingin kamu buatkan saya komputer tabung jadul ya. saya mau yang layarnya mati dan nyala",
  answer: '{"frames":["layar-mati","layar-nyala"]}',
};
const turn2 = {
  prompt: "kok antar frame nggak konsisten ya tapi?",
  answer:
    "Iya, memang agak goyang — Frame layar-nyala digambar 1px lebih ke atas dari layar-mati, bodi bawah dan keyboardnya juga beda lebar.",
};
const turn3 = {
  prompt: "boy? antar frame kok tidak konsisten ya?",
  answer:
    "Betul, boy, agak goyang karena digambar ulang bukan dicopy: monitor naik 1px, alas keyboard beda bentuk.",
};

const fixtures: Fixture[] = [
  // --- a new asset from scratch ---
  {
    label: "draw/potion",
    input: "draw a small red potion bottle",
    expected: "draw",
    why: "plain draw",
  },
  {
    label: "draw/sword",
    input: "a 32x32 sword",
    expected: "draw",
    why: "noun-phrase draw",
  },
  {
    label: "draw/indonesian",
    input: "tolong bikin slime biru 32x32 dong",
    expected: "draw",
    why: "plain draw, Indonesian",
  },
  {
    label: "draw/reference",
    input: "buatkan pixel art seperti gambar ini",
    expected: "draw",
    why: "an attachment is the subject",
    context: { attachments: 1 },
  },
  {
    label: "draw/attachment-edit",
    input: "i have attached it please try to fix and improve it!",
    expected: "edit",
    why: "a fix of existing art is an edit",
    context: { ...slime, attachments: 1 },
  },

  // --- an existing asset changes ---
  {
    label: "edit/recolor",
    input: "make the slime green instead of blue",
    expected: "edit",
    why: "direct edit",
    context: slime,
  },
  {
    label: "edit/eyes",
    input: "give it bigger eyes",
    expected: "edit",
    why: "short direct edit",
    context: slime,
  },
  {
    label: "edit/outline",
    input: "change the outline to dark blue",
    expected: "edit",
    why: "direct edit",
    context: slime,
  },
  {
    label: "edit/shadow",
    input: "add a shadow under the potion",
    expected: "edit",
    why: "additive edit",
    context: slime,
  },
  {
    label: "edit/colour-followup",
    input: "it's not blue though",
    expected: "edit",
    why: "a correction of the last result",
    context: {
      ...slime,
      history: [{ prompt: "draw a blue slime", answer: "32×32 slime, idle, 4 colors." }],
    },
  },
  {
    label: "edit/id-resize-question",
    input:
      "boy, bisa nggak semisal canvas nya kamu resize jadi lebih besar sehingga wajahnya jadi lebih detail seperti foto yang saya kasih tadi?",
    expected: "edit",
    why: "a request phrased as a question",
    context: scoups,
  },
  {
    label: "edit/id-likeness",
    input: "kayak masih belum mirip nih boy dengan wajah aslinya",
    expected: "edit",
    why: "a complaint that names the flaw",
    context: scoups,
  },

  // --- another state of a frame ---
  {
    label: "variant/jump",
    input: "add a jump animation frame to the slime",
    expected: "variant",
    why: "names a new state to add",
    context: slime,
  },
  {
    label: "variant/attack",
    input: "another state where the knight attacks",
    expected: "variant",
    why: "names a new state to add",
    context: {
      asset: {
        name: "knight",
        width: 32,
        height: 32,
        palette: ["#00000000", "#1a1c2c", "#f4f4f4", "#ef7d57"],
      },
      frames: ["idle"],
      frameName: "idle",
    },
  },

  // --- the real komputer session: a complaint, then a short "yes fix it" ---
  {
    label: "real/1-consistency",
    input: "kok antar frame nggak konsisten ya tapi?",
    expected: "edit",
    why: "a complaint that points at a fix is an edit, not a chat",
    context: { ...komputer, frameName: "layar-mati", history: [turn1] },
  },
  {
    label: "real/2-consistency-again",
    input: "boy? antar frame kok tidak konsisten ya?",
    expected: "edit",
    why: "the repeated complaint is still a fix request",
    context: { ...komputer, history: [turn1, turn2] },
  },
  {
    label: "real/3-perbaiki",
    input: "ya perbaiki dong!",
    expected: "edit",
    why: "a short yes that answers the agent's own diagnosis",
    context: { ...komputer, history: [turn1, turn2, turn3] },
  },
  {
    label: "real/agents-plan-approved",
    input: "oke lanjut",
    expected: "draw",
    why: "agreeing to the plan the agent just proposed",
    context: {
      ...komputer,
      history: [
        turn1,
        {
          prompt: "saya ingin kamu buatkan saya komputer tabung jadul ya.",
          answer: "Rencana: dua frame layar-mati dan layar-nyala. Setuju?",
        },
      ],
    },
  },
  {
    label: "real/too-loud",
    input: "layarnya kurang nyala",
    expected: "edit",
    why: "a one-line flaw is a fix request",
    context: { ...komputer, history: [turn1, turn2] },
  },

  // --- what must stay an ask ---
  {
    label: "ask/colours",
    input: "what colors does the slime use right now?",
    expected: "ask",
    why: "wants information",
    context: slime,
  },
  {
    label: "ask/advice",
    input: "what should I draw next for this character?",
    expected: "ask",
    why: "wants a suggestion",
    context: slime,
  },
  {
    label: "ask/greeting",
    input: "halo",
    expected: "ask",
    why: "a greeting changes no pixel",
    context: { ...komputer, history: [turn1] },
  },
  {
    label: "ask/thanks",
    input: "makasih ya",
    expected: "ask",
    why: "thanks changes no pixel",
    context: { ...komputer, history: [turn1, turn2] },
  },
  {
    label: "ask/why",
    input: "kenapa warnanya jadi lebih gelap?",
    expected: "ask",
    why: "asks for a reason, not a repaint",
    context: { ...komputer, history: [turn1] },
  },
  {
    label: "ask/opinion",
    input: "menurutmu mana yang lebih bagus?",
    expected: "ask",
    why: "asks for an opinion",
    context: { ...komputer, history: [turn1, turn2] },
  },
  {
    label: "ask/reference-question",
    input: "warna apa yang cocok untuk gambar ini?",
    expected: "ask",
    why: "a question with an attachment",
    context: { attachments: 1 },
  },
];

/** A vague draw has no subject: the decision turns it into a question. */
const vague = [
  "draw something",
  "make an animation",
  "bikin gambar dong",
  "gambar apa aja",
];

/** The intent each case chose, per repetition, for the failure report. */
const got: Record<string, string[]> = {};
const confidences: Record<string, number[]> = {};
let calls = 0;
let observedCost = 0;

const target = async (turn: DecisionCaseInput): Promise<string> => {
  const decision = await decidePrompt(turn.input, env, turn.context);
  calls += 1;
  observedCost += lastCost;
  (got[turn.label] ??= []).push(decision.intent);
  (confidences[turn.label] ??= []).push(Number(decision.confidence.toFixed(2)));
  return decision.intent;
};

const wanted = fixtures.filter(
  (fixture) => ONLY === undefined || fixture.label.includes(ONLY),
);
const cases = [
  ...wanted.map((fixture) => ({
    id: fixture.label,
    expected: fixture.expected,
    runs: fixture.runs ?? RUNS,
    input: {
      label: fixture.label,
      input: fixture.input,
      context: fixture.context ?? {},
      why: fixture.why,
    },
  })),
  ...vague
    .filter((input) => ONLY === undefined || `vague/${input.slice(0, 18)}`.includes(ONLY))
    .map((input) => ({
      id: `vague/${input.slice(0, 18)}`,
      expected: "ask" as Intent,
      runs: RUNS,
      input: {
        label: `vague/${input.slice(0, 18)}`,
        input,
        context: {} as DecisionContext,
        why: "a vague draw becomes a question",
      },
    })),
];

// A prompt is only better when it is better most of the time, not once: every
// case becomes `runs` eval cases, numbered, so the runner reports each one.
const suiteCases = cases.flatMap((item) =>
  Array.from({ length: item.runs }, (_, index) => ({
    ...item,
    id: `${item.id}#${index + 1}`,
  })),
);

const original = new Map(cases.map((item) => [item.id, item]));
const started = Date.now();
const result = await runEvalSuite<DecisionCaseInput, string, string>({
  name: `jev-intent-${jevModel}`,
  cases: suiteCases,
  target,
  metrics: [exactMatch({ name: "intent" })],
  concurrency: 4,
});
const elapsed = Date.now() - started;

const base = (id: string) => id.replace(/#\d+$/, "");
const missed = [
  ...new Set(
    result.results
      .filter((row) => row.outcome !== "pass")
      .map((row) => base(row.case.id)),
  ),
];
const flip = missed.filter((id) => new Set(got[id]).size > 1);
const lines = [
  `Jev ${jevModel} — intent decision via @anvia/core/evals`,
  `   verdicts:  ${result.cases.passed}/${result.cases.total} pass   ${result.cases.failed} fail   ${result.cases.invalid} invalid   (${cases.length} fixtures × ${RUNS} runs, ${calls} Jev calls)`,
  `   cost:      ${observedCost > 0 ? `$${observedCost.toFixed(4)}` : "n/a (provider reports no cost)"}   ${Math.round(elapsed / Math.max(1, result.cases.total))}ms/case   ${elapsed}ms wall`,
];
for (const id of missed) {
  const item = original.get(id);
  lines.push(
    `   miss ${id.padEnd(28)} expected ${(item?.expected ?? "?").padEnd(7)} got ${got[id]?.join(",")}  — ${item?.input.why ?? ""}`,
  );
}
if (flip.length > 0) {
  lines.push(`   flip-flop: ${flip.join(", ")}`);
}
if (result.reporterErrors.length > 0) {
  lines.push(`   reporter errors: ${result.reporterErrors.length}`);
}
console.log(lines.join("\n"));
process.exitCode = result.cases.failed === 0 && result.cases.invalid === 0 ? 0 : 1;
