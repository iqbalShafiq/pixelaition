import type { RgbaImageData } from "@pixelaition/pixel";

/**
 * Decode a browser image file to RGBA. GIF decodes its first frame; an animated
 * sheet import is the user's explicit grid, not a hidden frame sampler.
 */
export async function decodeImageFile(file: File): Promise<RgbaImageData> {
  if (!file.type.startsWith("image/")) {
    throw new Error("That file is not an image.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width < 1 || bitmap.height < 1) {
      throw new Error("That image has no pixels.");
    }
    if (bitmap.width > 4096 || bitmap.height > 4096) {
      throw new Error("That image is larger than 4096 by 4096.");
    }
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("This browser cannot read image pixels.");
    context.imageSmoothingEnabled = false;
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    return {
      width: bitmap.width,
      height: bitmap.height,
      data: new Uint8Array(data.buffer.slice(0)),
    };
  } finally {
    bitmap.close();
  }
}
