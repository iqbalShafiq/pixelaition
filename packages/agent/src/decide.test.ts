import { describe, expect, it } from "vitest";
import { decideFromPrompt, decidePrompt, specificityFloor } from "./decide.js";

describe("draw decisions", () => {
  it("classifies offline without contacting a provider", () => {
    expect(decideFromPrompt("gambar sesuatu")).toMatchObject({
      intent: "clarify",
      source: "local",
    });
    expect(decideFromPrompt("the same knight facing left")).toMatchObject({
      intent: "variant",
      source: "local",
    });
    expect(decideFromPrompt("recolor the shield to crimson")).toMatchObject({
      intent: "edit",
      source: "local",
    });
    expect(decideFromPrompt("a 32x32 potion bottle with a cork")).toMatchObject({
      intent: "draw",
      source: "local",
    });
  });

  it("always carries a question when it asks for detail", () => {
    expect(decideFromPrompt("gambar sesuatu").question).toMatch(/what should/i);
  });

  it("uses the offline decision when no decision model is configured", async () => {
    const decided = await decidePrompt("a 32x32 potion bottle with a cork", {});
    expect(decided.source).toBe("local");
    expect(decided.intent).toBe("draw");
  });

  it("short-circuits a vague prompt without calling a provider", async () => {
    // An unusable key would throw if the provider were actually reached.
    const decided = await decidePrompt("gambar sesuatu", {
      typesafeApiKey: "not-a-real-key",
    });
    expect(decided.intent).toBe("clarify");
    expect(decided.source).toBe("local");
    expect(decided.question).toBeTruthy();
  });

  it("falls back to the offline decision when the provider is unreachable", async () => {
    const decided = await decidePrompt("a 32x32 potion bottle with a cork", {
      typesafeApiKey: "not-a-real-key",
    });
    expect(decided.intent).toBe("draw");
    expect(decided.source).toBe("local");
  });

  it("keeps the specificity floor where the plan put it", () => {
    expect(specificityFloor).toBe(0.7);
  });
});
