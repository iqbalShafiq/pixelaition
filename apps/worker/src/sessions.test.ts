import { describe, expect, it } from "vitest";
import { askSessionId } from "./sessions.js";

describe("askSessionId", () => {
  it("keeps a conversation inside one model and api shape", () => {
    const base = askSessionId("thread", "model-a", "chat");
    expect(base).toBe("thread:ask:model-a:chat");
    // Another model, shape, or thread must not continue this conversation:
    // the responses endpoint rejects the reasoning ids a chat turn minted
    // locally ("Invalid reasoning item id format").
    expect(askSessionId("thread", "model-b", "chat")).not.toBe(base);
    expect(askSessionId("thread", "model-a", "responses")).not.toBe(base);
    expect(askSessionId("other", "model-a", "chat")).not.toBe(base);
    // The same model and shape stay on one conversation.
    expect(askSessionId("thread", "model-a", "chat")).toBe(base);
  });
});
