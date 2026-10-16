export type LayerDto = { id: string; name: string; visible: boolean; pixels: string };

export type FrameDto = { id: string; name: string; index: number; layers: LayerDto[] };

export type AssetDto = {
  id: string;
  name: string;
  width: number;
  height: number;
  palette: string[];
  frames: FrameDto[];
  projectId: string;
  projectName: string;
  style: {
    defaultWidth: number;
    defaultHeight: number;
    outline: string;
    shadowDirection: string;
    notes: string;
  };
};

export type ProjectDto = {
  id: string;
  name: string;
  description: string;
  assets: Array<{ id: string; name: string }>;
};

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
