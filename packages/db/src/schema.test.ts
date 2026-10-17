import { describe, expect, it } from "vitest";
import { generationRuns, models, projects, runTasks, user } from "./schema.js";

describe("schema", () => {
  it("keeps projects owned by a user", () => {
    expect(projects.userId.name).toBe("user_id");
    expect(user.email.name).toBe("email");
  });

  it("keeps the drawing catalog columns the worker selects", () => {
    expect(models.id.name).toBe("id");
    expect(models.api.name).toBe("api");
    expect(models.efforts.name).toBe("efforts");
    expect(models.position.name).toBe("position");
    expect(models.enabled.name).toBe("enabled");
    // The context window seeds the model's `contextLimits`, which is what makes
    // Anvia attach `contextUsage` to every response.
    expect(models.contextWindow.name).toBe("context_window");
  });

  it("keeps the task columns the worker selects", () => {
    expect(Object.keys(runTasks)).toEqual(
      expect.arrayContaining([
        "id",
        "threadId",
        "assetId",
        "status",
        "phase",
        "shape",
        "plan",
        "usage",
        "durableTaskId",
      ]),
    );
    expect(Object.keys(generationRuns)).toEqual(
      expect.arrayContaining(["taskId", "role", "workerKey", "frameIds"]),
    );
  });
});
