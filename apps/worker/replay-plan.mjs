// Rebuilds the exact request a failed plan turn sent (from the durable journal
// plus the content-addressed history) and replays it through the SDK, so the
// failure prints the rule it broke instead of a bare "invalid tool call".
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const sqlite = (sql) =>
  execFileSync("sqlite3", [
    "file:/Users/shafiq/VsCodeProjects/pixelaition/apps/worker/data/anvia-runs.sqlite?immutable=1",
    sql,
  ]).toString();

// A specific run can be named; otherwise take the newest failed worker turn,
// falling back to the newest chat call of any role.
const wanted = process.argv[2];
const pick = (where) =>
  sqlite(
    `select run_id || '|' || json_extract(data,'$.input.request.chatHistory.head') || '|' || length(data) from anvia_durable_events where type='model_started' ${where} order by sequence desc limit 1;`,
  ).trim();
let picked = wanted
  ? pick(`and run_id='${wanted}'`)
  : pick(
      "and run_id in (select distinct run_id from anvia_durable_events where type='model_attempt_failed' order by sequence desc limit 40)",
    ) || pick("and data like '%deepseek%'");
const rows = picked.split("|");
const [runId, head] = rows;
console.log("run:", runId?.slice(0, 8), "head:", head?.slice(0, 12), "bytes:", rows[2]);

const eventData = sqlite(
  `select json_extract(data,'$.input.request') from anvia_durable_events where run_id='${runId}' and type='model_started' order by sequence limit 1;`,
).trim();
const request = JSON.parse(eventData);
console.log("request keys:", Object.keys(request).join(","), "tools:", request.tools?.length ?? 0);

// Walk the history list: head -> previous -> ... -> start.
const messages = [];
let cursor = head;
let guard = 0;
while (cursor !== null && cursor !== "" && cursor !== "null" && guard < 400) {
  const row = sqlite(`select message || '\\n' || coalesce(previous,'') from anvia_durable_histories where hash='${cursor}';`).trim();
  const split = row.lastIndexOf("\n");
  const message = row.slice(0, split);
  const previous = row.slice(split + 1).trim();
  try {
    messages.unshift(JSON.parse(message));
  } catch {
    messages.unshift({ role: "user", content: String(message) });
  }
  cursor = previous;
  guard += 1;
}
console.log("messages rebuilt:", messages.length);
writeFileSync("/tmp/plan-request.json", JSON.stringify({ ...request, messages }, null, 2));

const { OpenAIClient } = await import("@anvia/openai");
const { OpenAI } = await import("openai");
const client = new OpenAIClient({
  client: new OpenAI({
    apiKey: process.env.AGENT_API_KEY,
    ...(process.env.AGENT_BASE_URL ? { baseURL: process.env.AGENT_BASE_URL } : {}),
  }),
});
const model = client.completionModel({ modelId: "deepseek/deepseek-v4.1-flash-1017", api: "chat" });
try {
  // Tool-call assistant messages carry a null content; the SDK's own file-input
  // check expects a string or an array, so normalize before replaying.
  const safeMessages = messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? message.content
        : [],
  }));
  const stream = model.streamCompletion({
    chatHistory: safeMessages,
    tools: request.tools,
    ...(request.instructions !== undefined ? { instructions: request.instructions } : {}),
    ...(request.documents !== undefined ? { documents: request.documents } : {}),
  });
  let text = 0;
  let deltas = 0;
  let calls = 0;
  for await (const event of stream) {
    if (event.type === "text_delta") text += 1;
    if (event.type === "tool_call_delta") deltas += 1;
    if (event.type === "tool_call") calls += 1;
  }
  console.log(`OK text=${text} tool_deltas=${deltas} calls=${calls}`);
} catch (error) {
  console.log(
    "FAIL name:", error?.name,
    "code:", error?.code,
    "kind:", error?.kind,
    "toolCallId:", error?.toolCallId,
    "finishReason:", error?.finishReason,
  );
  console.log("message:", String(error?.message).slice(0, 200));
  console.log("usage:", JSON.stringify(error?.usage ?? null).slice(0, 200));
  console.log("stack:", String(error?.stack ?? "").split("\n").slice(1, 4).map((line) => line.trim().replace(/.*@anvia\+openai[^)]*\//, "")).join(" | "));
}
