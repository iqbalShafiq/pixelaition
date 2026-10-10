import { describe, expect, it } from "vitest";
import { projects, user } from "./schema.js";

describe("schema", () => {
  it("keeps projects owned by a user", () => {
    expect(projects.userId.name).toBe("user_id");
    expect(user.email.name).toBe("email");
  });
});
