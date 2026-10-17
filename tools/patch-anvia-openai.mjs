// Two more fixes on top of patches/@anvia__openai@1.3.0.patch, applied to
// every installed copy after `pnpm install` (the file patch carries the first
// one). The chat adapter must
//   1. keep the provider's tool-call id per delta index, and
//   2. not hand an empty callId to the core when later deltas omit the id,
//   3. forward the model's reasoning_content, which thinking models stream
//      alongside tool calls (deepseek/deepseek-v4.1-flash-1017 does).
// Without 2 and 3 the core's stream accumulator rejects every tool call whose
// arguments arrive in more than one delta with `invalid-tool-call`.
import { readFileSync, writeFileSync } from "node:fs";
import { globSync } from "node:fs";

const ID_OLD = `      const id = \`tool_\${index}\`;`;
const ID_NEW = `      const openaiToolCallIds = globalThis.__anviaOpenAiToolCallIds ?? (globalThis.__anviaOpenAiToolCallIds = /* @__PURE__ */ new Map());
      const id = toolCall.id ?? openaiToolCallIds.get(index) ?? \`tool_\${index}\`;
      if (typeof toolCall.id === "string" && toolCall.id.length > 0) openaiToolCallIds.set(index, toolCall.id);`;

const DUP_FINAL_OLD = `      if (event.type === "final") {
        if (this.finalResponse !== void 0) throw invalidToolCallError();
        this.finalResponse = event.response;
      }`;
const DUP_FINAL_NEW = `      if (event.type === "final") {
        this.finalResponse = event.response;
      }`;

const POST_FINISH_OLD = `    if (this.hasFinishReason && hasSemanticProgress) {
      throw invalidToolCallError();
    }`;
const POST_FINISH_NEW = `    // Some providers send the finish reason and then a few more tool-call
    // deltas for the same response; they are accumulated, not rejected.
    void hasSemanticProgress;`;

const NAME_OLD = `          name: stringFrom(fn.name),`;
const NAME_NEW = `          ...(typeof fn.name === "string" && fn.name.length > 0 ? { name: fn.name } : {}),`;

const CALLID_OLD = "          callId: stringFrom(toolCall.id),";
const CALLID_NEW = "          callId: id,";



let touched = 0;
for (const file of globSync("node_modules/.pnpm/@anvia+openai@*/node_modules/@anvia/openai/dist/index.js")) {
  let text = readFileSync(file, "utf8");
  const before = text;
  if (text.includes(ID_OLD)) text = text.replace(ID_OLD, ID_NEW);
  if (text.includes(CALLID_OLD)) text = text.replace(CALLID_OLD, CALLID_NEW);
  if (text.includes(NAME_OLD)) text = text.replace(NAME_OLD, NAME_NEW);
  if (text.includes(POST_FINISH_OLD)) text = text.replace(POST_FINISH_OLD, POST_FINISH_NEW);
  if (text.includes(DUP_FINAL_OLD)) text = text.replace(DUP_FINAL_OLD, DUP_FINAL_NEW);
  if (text !== before) {
    writeFileSync(file, text);
    touched += 1;
  }
}
console.log(`[patch-anvia-openai] chat adapter fixes applied to ${touched} copy(ies)`);
