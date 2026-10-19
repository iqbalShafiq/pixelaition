import { afterEach, describe, expect, it, vi } from "vitest";
import { imageMediaType, parseHttpsPublicUrl, searchWeb } from "./search.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("searchWeb", () => {
  it("accepts the nulls Tavily sends for missing fields", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Slime",
                url: "https://example.com/slime",
                content: null,
                images: null,
              },
            ],
            images: [{ url: "https://cdn.example.com/a.png", description: null }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const outcome = await searchWeb("slime", { apiKey: "tvly-test", maxResults: 3 });
    expect(outcome.results).toEqual([
      { title: "Slime", url: "https://example.com/slime", content: "" },
    ]);
    expect(outcome.images).toEqual([{ url: "https://cdn.example.com/a.png" }]);
  });
});

describe("reference URL guard", () => {
  it("accepts https URLs on public hosts", () => {
    expect(parseHttpsPublicUrl("https://cdn.example.com/a.png")?.href).toBe(
      "https://cdn.example.com/a.png",
    );
  });

  it("refuses plain http, local hosts, and private ranges", () => {
    for (const url of [
      "http://cdn.example.com/a.png",
      "ftp://cdn.example.com/a.png",
      "https://localhost/a.png",
      "https://service.local/a.png",
      "https://service.internal/a.png",
      "https://10.0.0.5/a.png",
      "https://172.16.4.4/a.png",
      "https://192.168.1.20/a.png",
      "https://169.254.1.1/a.png",
      "https://127.0.0.1/a.png",
      "https://0.0.0.0/a.png",
      "https://[::1]/a.png",
      "not a url",
    ]) {
      expect(parseHttpsPublicUrl(url), url).toBeUndefined();
    }
  });
});

describe("imageMediaType", () => {
  it("maps the supported image types and strips parameters", () => {
    expect(imageMediaType("image/png")).toBe("image/png");
    expect(imageMediaType("image/jpeg; charset=binary")).toBe("image/jpeg");
    expect(imageMediaType("image/webp")).toBe("image/webp");
    expect(imageMediaType("image/gif")).toBe("image/gif");
    expect(imageMediaType("IMAGE/PNG")).toBe("image/png");
  });

  it("refuses everything else", () => {
    expect(imageMediaType("text/html")).toBeUndefined();
    expect(imageMediaType("image/svg+xml")).toBeUndefined();
    expect(imageMediaType(null)).toBeUndefined();
  });
});
