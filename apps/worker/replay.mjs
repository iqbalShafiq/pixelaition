import { readFileSync } from "node:fs";
const { OpenAIClient } = await import("@anvia/openai");
const { OpenAI } = await import("openai");
const request = JSON.parse(readFileSync("/tmp/plan-request.json", "utf8"));
console.log("request keys:", Object.keys(request).join(","), "tools:", Array.isArray(request.tools) ? request.tools.length : "none");
const client = new OpenAIClient({ client: new OpenAI({ apiKey: process.env.AGENT_API_KEY, baseURL: process.env.AGENT_BASE_URL }) });
const model = client.completionModel({ modelId: "deepseek-v4.1-flash", api: "chat" });
try {
  const stream = model.streamCompletion(request);
  let text = 0, calls = 0, deltas = 0;
  for await (const event of stream) {
    if (event.type === "text_delta") text += 1;
    if (event.type === "tool_call_delta") deltas += 1;
    if (event.type === "tool_call") calls += 1;
  }
  console.log(`OK text=${text} tool_deltas=${deltas} calls=${calls}`);
} catch (error) {
  console.log("FAIL name:", error?.name, "code:", error?.code, "kind:", error?.kind, "toolCallId:", error?.toolCallId, "finishReason:", error?.finishReason);
  console.log("message:", String(error?.message).slice(0, 220));
  console.log("usage:", JSON.stringify(error?.usage ?? null).slice(0, 200));
}
