/**
 * Web search and reference images. Tavily is the one search provider: the tool
 * layer decides what the agent may ask for, this module owns the two HTTP
 * calls (search, image fetch) and the URL guards that keep fetches on public
 * https hosts. A missing key is an error naming the cause, never a fallback.
 */
import { z } from "zod";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const SEARCH_TIMEOUT_MS = 20_000;
const IMAGE_TIMEOUT_MS = 15_000;

/** One reference image may not exceed this; previews use the same bound. */
export const MAX_REFERENCE_IMAGE_BYTES = 1024 * 1024;

const imageSchema = z.object({
  url: z.string(),
  // Tavily sends null for missing descriptions and content, not just absence.
  description: z.string().nullish(),
});

const searchResponseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        content: z.string().nullish(),
        images: z.array(imageSchema).nullish(),
      }),
    )
    .nullish(),
  images: z.array(imageSchema).nullish(),
});

export type SearchOutcome = {
  results: Array<{ title: string; url: string; content: string }>;
  images: Array<{ url: string; description?: string }>;
};

/** The one key that turns web search on; empty means the tool must not run. */
export function tavilyApiKey(): string | undefined {
  const key = process.env.TAVILY_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

/**
 * One Tavily search with images. The provider's answer text is not requested;
 * the agent reads the results and views the images it chooses.
 */
export async function searchWeb(
  query: string,
  options: { apiKey: string; maxResults: number },
): Promise<SearchOutcome> {
  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: options.maxResults,
      include_images: true,
      include_image_descriptions: true,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`Tavily returned ${response.status}: ${detail}`);
  }
  const parsed = searchResponseSchema.parse(await response.json());
  // The top-level list and per-result lists can overlap; first sighting wins.
  const seen = new Set<string>();
  const images: SearchOutcome["images"] = [];
  for (const image of [
    ...(parsed.images ?? []),
    ...(parsed.results ?? []).flatMap((result) => result.images ?? []),
  ]) {
    if (seen.has(image.url)) continue;
    seen.add(image.url);
    images.push({
      url: image.url,
      ...(image.description != null ? { description: image.description } : {}),
    });
  }
  return {
    results: (parsed.results ?? []).map((result) => ({
      title: result.title,
      url: result.url,
      // Snippets are a menu for the next step; keeping them short is a choice
      // about signal, not a cap on what the user wrote.
      content: (result.content ?? "").slice(0, 400),
    })),
    images,
  };
}

/**
 * An https URL on a public host. Plain-TCP and private-range hosts are
 * refused, because the worker must not become a probe for the local network.
 */
export function parseHttpsPublicUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.startsWith("[")
  ) {
    return undefined;
  }
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part))) {
    const [a = -1, b = -1] = parts;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31)
    ) {
      return undefined;
    }
  }
  return url;
}

/** The image media types the vision path accepts, mapped from a header. */
export function imageMediaType(contentType: string | null): string | undefined {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (type === "image/png" || type === "image/jpeg" || type === "image/webp") {
    return type;
  }
  if (type === "image/gif") return type;
  return undefined;
}

export type FetchedImage = { mediaType: string; data: string; bytes: number };

/**
 * Fetch one reference image as base64 for a vision tool result. The final URL
 * after redirects is checked again so a public link cannot bounce the worker
 * onto a private host.
 */
export async function fetchReferenceImage(url: URL): Promise<FetchedImage> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`The image host returned ${response.status}.`);
  }
  const finalUrl = new URL(response.url);
  if (parseHttpsPublicUrl(finalUrl.href) === undefined) {
    throw new Error("The image redirected to a host the worker will not fetch.");
  }
  const mediaType = imageMediaType(response.headers.get("content-type"));
  if (!mediaType) {
    throw new Error(
      `That URL is not a supported image (${response.headers.get("content-type") ?? "no content type"}).`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_REFERENCE_IMAGE_BYTES) {
    throw new Error(
      `The image is ${buffer.length} bytes, over the ${MAX_REFERENCE_IMAGE_BYTES}-byte limit.`,
    );
  }
  return { mediaType, data: buffer.toString("base64"), bytes: buffer.length };
}
