/**
 * Real-model social planning check. It exercises the format registry against a
 * live provider, with a bounded retry and the documented fallback: MiniMax M3.1
 * Flash first, Muse Spark second. No stub, no deterministic substitute.
 *
 * Run from the repo root: pnpm eval:social
 */
import { formatPresets, getPreset } from "@pixelaition/artboard";

const baseUrl = process.env.AGENT_BASE_URL?.replace(/\/$/, "");
const apiKey = process.env.AGENT_API_KEY;
if (!baseUrl || !apiKey) {
  console.error("AGENT_BASE_URL and AGENT_API_KEY are required.");
  process.exit(2);
}

const primary = process.env.SOCIAL_EVAL_PRIMARY ?? "minimax/minimax-m3.1-flash:free";
const fallback = "meta/muse-spark-1.3-contributor";

const wanted = [
  "linkedin-cover",
  "instagram-post",
  "instagram-reel",
  "youtube-thumbnail",
  "tiktok-profile",
];

const prompt = `You are art-directing a social kit for a pixel-art astronaut called Orbit.
Choose exactly these formats: ${wanted.join(", ")}.
Return only JSON with this shape:
{
  "concept": "one sentence",
  "headline": "max 6 words",
  "subhead": "max 12 words",
  "artboards": [
    {"format": "a preset id from the list", "template": "split-copy|stack-copy|thumbnail|profile-mark|centered-copy", "reason": "max 16 words"}
  ]
}
Use native formats, not one square resized. Here are the valid preset ids and sizes:
${formatPresets.map((preset) => `${preset.id} (${preset.width}x${preset.height}, ${preset.group})`).join("\n")}`;

type Plan = {
  concept: string;
  headline: string;
  subhead: string;
  artboards: Array<{ format: string; template: string; reason: string }>;
};

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start)
    throw new Error("The model did not return a JSON object.");
  return JSON.parse(candidate.slice(start, end + 1));
}

function validate(value: unknown): Plan {
  if (!value || typeof value !== "object") throw new Error("Plan is not an object.");
  const plan = value as Partial<Plan>;
  if (typeof plan.concept !== "string" || typeof plan.headline !== "string") {
    throw new Error("Plan is missing concept/headline.");
  }
  if (!Array.isArray(plan.artboards) || plan.artboards.length !== wanted.length) {
    throw new Error(`Expected ${wanted.length} artboards.`);
  }
  const seen = new Set<string>();
  for (const item of plan.artboards) {
    if (!item || typeof item.format !== "string" || typeof item.template !== "string") {
      throw new Error("An artboard is missing format/template.");
    }
    getPreset(item.format);
    seen.add(item.format);
    if (item.template.trim().length === 0)
      throw new Error("An artboard has no template.");
  }
  for (const id of wanted) {
    if (!seen.has(id)) throw new Error(`Plan omitted ${id}.`);
  }
  return plan as Plan;
}

async function chat(model: string): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": "https://pixelaition.local",
      "x-title": "Pixelaition social eval",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 1400,
      messages: [
        { role: "system", content: "Return one JSON object and nothing else." },
        { role: "user", content: prompt },
      ],
      ...(model.startsWith("minimax/") ? { reasoning: { effort: "low" } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("The model returned no content.");
  }
  return content;
}

async function responses(model: string): Promise<string> {
  const response = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": "https://pixelaition.local",
      "x-title": "Pixelaition social eval",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      reasoning: { effort: "low" },
      max_output_tokens: 1400,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await response.json().catch(() => null)) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  const text =
    body?.output_text ??
    body?.output
      ?.flatMap((item) => item.content ?? [])
      .map((item) => item.text ?? "")
      .join("");
  if (!text || text.trim().length === 0)
    throw new Error("The model returned no content.");
  return text;
}

async function tryModel(
  model: string,
  call: (model: string) => Promise<string>,
  attempts: number,
): Promise<Plan> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const text = await call(model);
      return validate(extractJson(text));
    } catch (reason) {
      last = reason;
      console.error(
        `[social-eval] ${model} attempt ${attempt}/${attempts} failed: ${
          reason instanceof Error ? reason.message : String(reason)
        }`,
      );
      if (attempt < attempts)
        await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
    }
  }
  throw last;
}

async function main() {
  console.log(`[social-eval] primary ${primary}`);
  let plan: Plan;
  let used = primary;
  try {
    plan = await tryModel(primary, chat, 2);
  } catch {
    console.warn(`[social-eval] primary failed; falling back to ${fallback}`);
    used = fallback;
    plan = await tryModel(fallback, responses, 2);
  }
  console.log(`[social-eval] ${used} passed`);
  console.log(JSON.stringify(plan, null, 2));
}

await main();
