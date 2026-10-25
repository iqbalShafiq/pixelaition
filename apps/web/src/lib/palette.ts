export type PaletteAction =
  | { action: "edit"; index: number; color: string }
  | { action: "add"; color: string }
  | { action: "remove"; index: number; remapTo?: number }
  | { action: "reorder"; order: number[] }
  | { action: "replace"; palette: string[] }
  | { action: "import"; palette: string[]; mode: "merge" | "replace" }
  | { action: "lock"; locked: boolean };
