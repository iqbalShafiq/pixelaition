import { describe, expect, it } from "vitest";
import { models, projects, user } from "./schema.js";

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
  });
});
