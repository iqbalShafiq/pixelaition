// Calls the gateway through the same SDK stack the worker uses, so a stream
// failure prints its full fields (kind, toolCallId, finishReason, message)
// instead of a bare "invalid tool call".
const { OpenAIClient } = await import("@anvia/openai");
const { OpenAI } = await import("openai");

const apiKey = process.env.AGENT_API_KEY;
const baseURL = process.env.AGENT_BASE_URL;
const client = new OpenAIClient({
  client: new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }),
});
const model = client.completionModel({ modelId: "deepseek/deepseek-v4.1-flash-1017", api: "chat" });

const tools = Array.from({ length: 6 }, (_, index) => ({
  name: `tool_${index}`,
  description: `Tool number ${index} that saves a note with id and a long details string.`,
  parameters: {
    type: "object",
    properties: { id: { type: "string" }, details: { type: "string" } },
    required: ["id", "details"],
  },
}));

const attempt = async (label, request) => {
  try {
    const stream = model.streamCompletion(request);
    let deltas = 0;
    let calls = 0;
    for await (const event of stream) {
      if (event.type === "tool_call_delta") deltas += 1;
      if (event.type === "tool_call") calls += 1;
    }
    console.log(`${label}: OK deltas=${deltas} calls=${calls}`);
  } catch (error) {
    console.log(
      `${label}: FAIL code=${error?.code} kind=${error?.kind} toolCallId=${error?.toolCallId} finishReason=${error?.finishReason}`,
    );
    console.log(`${label}: message=${String(error?.message).slice(0, 200)}`);
    console.log(`${label}: usage=${JSON.stringify(error?.usage ?? null).slice(0, 160)}`);
  }
};

await attempt("one long call", {
  messages: [
    {
      role: "user",
      content:
        "Call tool_0 with id a1 and a details string of about 200 characters about birds in the forest.",
    },
  ],
  tools,
});

await attempt("two parallel calls", {
  messages: [
    {
      role: "user",
      content:
        "Call tool_0 with id a1 and about 150 characters of details, and call tool_1 with id b2 and about 150 characters of details, in the same message.",
    },
  ],
  tools,
});
