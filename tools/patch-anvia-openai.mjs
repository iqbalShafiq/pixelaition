// Two more fixes on top of patches/@anvia__openai@1.3.0.patch, applied to
// every installed copy after `pnpm install` (the file patch carries the first
// one). The chat adapter must
//   1. keep the provider's tool-call id per delta index, and
//   2. not hand an empty callId to the core when later deltas omit the id,
//   3. forward the model's reasoning_content, which thinking models stream
//      alongside tool calls (deepseek-v4.1-flash does).
// Without 2 and 3 the core's stream accumulator rejects every tool call whose
// arguments arrive in more than one delta with `invalid-tool-call`.
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const ID_OLD = `      const id = \`tool_\${index}\`;`;
const ID_NEW = `      const openaiToolCallIds = globalThis.__anviaOpenAiToolCallIds ?? (globalThis.__anviaOpenAiToolCallIds = /* @__PURE__ */ new Map());
      const id = toolCall.id ?? openaiToolCallIds.get(index) ?? \`tool_\${index}\`;
      if (typeof toolCall.id === "string" && toolCall.id.length > 0) openaiToolCallIds.set(index, toolCall.id);`;

const CALLID_OLD = "          callId: stringFrom(toolCall.id),";
const CALLID_NEW = "          callId: id,";

const REASONING_ANCHOR = `    if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
      events.push({ type: "text_delta", delta: delta.refusal });
    }
`;
const REASONING_ADD = `    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      events.push({ type: "reasoning_delta", delta: delta.reasoning_content });
    }
`;

let touched = 0;
for (const file of globSync("node_modules/.pnpm/@anvia+openai@*/node_modules/@anvia/openai/dist/index.js")) {
  let text = readFileSync(file, "utf8");
  const before = text;
  if (text.includes(ID_OLD)) text = text.replace(ID_OLD, ID_NEW);
  if (text.includes(CALLID_OLD)) text = text.replace(CALLID_OLD, CALLID_NEW);
  if (!text.includes("reasoning_delta") && text.includes(REASONING_ANCHOR)) {
    text = text.replace(REASONING_ANCHOR, REASONING_ANCHOR + REASONING_ADD);
  }
  if (text !== before) {
    writeFileSync(file, text);
    touched += 1;
  }
}
console.log(`[patch-anvia-openai] chat adapter fixes applied to ${touched} copy(ies)`);
