import { describe, expect, it } from "vitest";
import { buildConfirmPayload, suggestName } from "./target-proposal.js";

describe("buildConfirmPayload", () => {
  it("sends the confirmed ids and drops unused names", () => {
    const payload = buildConfirmPayload("prop-1", {
      projectId: "p1",
      assetId: "a1",
      projectName: "ignored",
      assetName: "ignored",
      mode: "generate",
    });
    expect(payload).toEqual({
      proposalId: "prop-1",
      confirm: { projectId: "p1", assetId: "a1", mode: "generate" },
    });
  });

  it("carries the names a new project or asset needs", () => {
    expect(
      buildConfirmPayload("p", {
        projectId: "new",
        projectName: "knights",
        assetId: "new",
        assetName: "hero",
        mode: "generate",
      }).confirm,
    ).toMatchObject({
      projectId: "new",
      projectName: "knights",
      assetId: "new",
      assetName: "hero",
      mode: "generate",
    });
  });

  it("keeps agent mode target-free for the asset", () => {
    expect(
      buildConfirmPayload("p", { projectId: "p1", assetId: "a1", mode: "agent" }).confirm,
    ).toEqual({ projectId: "p1", mode: "agent" });
  });

  it("refuses a missing name for a new entity", () => {
    expect(() =>
      buildConfirmPayload("p", { projectId: "new", mode: "generate" }),
    ).toThrow("Give the new project a name.");
    expect(() =>
      buildConfirmPayload("p", {
        projectId: "p1",
        assetId: "new",
        mode: "generate",
      }),
    ).toThrow("Give the new asset a name.");
  });
});

describe("suggestName", () => {
  it("takes the words after 'bernama', even inside quotes", () => {
    expect(
      suggestName(
        'Buatkan di project "things" satu asset baru bernama "obor": obor kayu',
      ),
    ).toBe("obor");
  });
  it("takes the words after 'named'", () => {
    expect(suggestName("draw a red potion named healing potion please")).toBe(
      "healing-potion",
    );
  });
  it("falls back to a quoted phrase, and never to a placeholder", () => {
    expect(suggestName('make the "wooden torch" brighter')).toBe("wooden-torch");
    expect(suggestName("draw a knight")).toBe("");
  });
});
