import { describe, expect, it } from "vitest";
import { attachmentProblem, fitWithin, MAX_ATTACHMENT_EDGE } from "./attachments.js";

describe("attachmentProblem", () => {
  it("accepts the four image types", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      expect(
        attachmentProblem(new File([new Uint8Array(8)], "ref", { type })),
        type,
      ).toBeUndefined();
    }
  });

  it("names why a file is refused", () => {
    expect(
      attachmentProblem(new File([new Uint8Array(8)], "notes", { type: "text/plain" })),
    ).toContain("Only PNG, JPEG, WebP, or GIF");
    const huge = new File([new Uint8Array(13 * 1024 * 1024)], "big.png", {
      type: "image/png",
    });
    expect(attachmentProblem(huge)).toContain("larger than 12 MB");
  });
});

describe("fitWithin", () => {
  it("never enlarges a small image", () => {
    expect(fitWithin(64, 32, MAX_ATTACHMENT_EDGE)).toEqual({ width: 64, height: 32 });
  });

  it("scales the longest side to the edge and keeps the ratio", () => {
    expect(fitWithin(1024, 512, MAX_ATTACHMENT_EDGE)).toEqual({
      width: 512,
      height: 256,
    });
    expect(fitWithin(300, 2048, MAX_ATTACHMENT_EDGE)).toEqual({
      width: 75,
      height: 512,
    });
  });

  it("keeps both sides at least one pixel", () => {
    expect(fitWithin(10000, 1, 512)).toEqual({ width: 512, height: 1 });
  });
});
