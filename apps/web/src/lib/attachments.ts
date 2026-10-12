/**
 * Reference images the user attaches to a message. The browser downscales
 * every image to a small edge and re-encodes it, so the run payload stays tiny
 * and the vision model receives a crisp, readable reference.
 */

export type AttachmentMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type PreparedAttachment = {
  id: string;
  name: string;
  mediaType: AttachmentMediaType;
  /** Raw base64, without the data-URL prefix the API and durable prompt use. */
  data: string;
  /** The data URL the composer thumbnail renders. */
  preview: string;
  width: number;
  height: number;
};

export const MAX_ATTACHMENTS = 4;
/** The longest side of a prepared reference; more detail is wasted on pixels. */
export const MAX_ATTACHMENT_EDGE = 512;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_PREPARED_CHARS = 1_400_000;

const MEDIA_TYPES: AttachmentMediaType[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** Why a file cannot be attached, or undefined when it can. */
export function attachmentProblem(file: File): string | undefined {
  if (!MEDIA_TYPES.includes(file.type as AttachmentMediaType)) {
    return "Only PNG, JPEG, WebP, or GIF images can be attached.";
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return "That image is larger than 12 MB; pick a smaller file.";
  }
  return undefined;
}

/** The scaled size that keeps both sides within `edge`, never enlarging. */
export function fitWithin(
  width: number,
  height: number,
  edge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { width, height };
  const scale = edge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** PNG and JPEG keep their type; WebP and GIF re-encode to PNG. */
function encodeType(type: string): AttachmentMediaType {
  if (type === "image/png" || type === "image/jpeg") return type;
  return "image/png";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The browser could not read that image."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.readAsDataURL(blob);
  });
}

/** Decode, downscale, and re-encode one file for the run payload. */
export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
  const problem = attachmentProblem(file);
  if (problem) throw new Error(problem);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file could not be read as an image.");
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height, MAX_ATTACHMENT_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not prepare that image.");
    // References are often pixel art themselves; keep the edges hard.
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const mediaType = encodeType(file.type);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mediaType, mediaType === "image/jpeg" ? 0.9 : undefined),
    );
    if (!blob) throw new Error("The browser could not encode that image.");
    const data = await blobToBase64(blob);
    if (data.length > MAX_PREPARED_CHARS) {
      throw new Error(
        "That image is still too large after resizing; pick a smaller one.",
      );
    }
    return {
      id: crypto.randomUUID(),
      name: file.name,
      mediaType,
      data,
      preview: `data:${mediaType};base64,${data}`,
      width: size.width,
      height: size.height,
    };
  } finally {
    bitmap.close();
  }
}
