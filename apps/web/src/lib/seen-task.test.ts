import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markTaskSeen, taskSeen } from "./seen-task.js";

const store = new Map<string, string>();

describe("taskSeen", () => {
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      clear: () => store.clear(),
    });
  });
  afterEach(() => {
    store.clear();
    vi.unstubAllGlobals();
  });

  it("stays unseen until this visit is marked", () => {
    expect(taskSeen("task-1")).toBe(false);
    markTaskSeen("task-1");
    expect(taskSeen("task-1")).toBe(true);
    expect(taskSeen("task-2")).toBe(false);
  });
});
