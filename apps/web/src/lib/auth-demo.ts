/**
 * The signed-out cast. Each asset has more than one pose and more than one
 * layer, painted in layer order so a frame is visibly built, then replaced
 * by the next pose. Colours stay on the chrome tokens.
 */

export const demoPalette = {
  o: "#6d6a64",
  s: "#e07a63",
  a: "#d8a64e",
  d: "#a5772c",
  w: "#f1efe9",
  b: "#75726c",
} as const;

export type DemoColor = keyof typeof demoPalette;

export type DemoCell = {
  x: number;
  y: number;
  color: DemoColor;
};

export type DemoLayer = {
  name: string;
  cells: DemoCell[];
};

export type DemoPose = {
  name: string;
  layers: DemoLayer[];
};

export type DemoAsset = {
  name: string;
  poses: DemoPose[];
};

const size = 16;

function cells(rows: string[]): DemoCell[] {
  const painted: DemoCell[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((mark, x) => {
      if (mark === ".") return;
      if (mark in demoPalette) painted.push({ x, y, color: mark as DemoColor });
    });
  });
  return painted;
}

function layer(name: string, rows: string[]): DemoLayer {
  return { name, cells: cells(rows) };
}

function pose(name: string, layers: DemoLayer[]): DemoPose {
  return { name, layers };
}

export const demoSize = size;

const blank = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
];

export const demoAssets: DemoAsset[] = [
  {
    name: "Cloud",
    poses: [
      pose("drift", [
        layer("shade", [
          "................",
          "................",
          "................",
          "....bbbbbb......",
          "...bbbbbbbb.....",
          "....bbbbbb......",
          ...blank.slice(6),
        ]),
        layer("puff", [
          "................",
          "..oooooooo......",
          ".owwwwwwwwo.....",
          ".owwwwwwwwo.....",
          "..oooooooo......",
          ...blank.slice(5),
        ]),
      ]),
      pose("shift", [
        layer("shade", [
          "................",
          "................",
          "................",
          "......bbbbbb....",
          ".....bbbbbbbb...",
          "......bbbbbb....",
          ...blank.slice(6),
        ]),
        layer("puff", [
          "................",
          "....oooooooo....",
          "...owwwwwwwwo...",
          "...owwwwwwwwo...",
          "....oooooooo....",
          ...blank.slice(5),
        ]),
      ]),
    ],
  },
  {
    name: "Bird",
    poses: [
      pose("glide", [
        layer("body", [
          "................",
          "................",
          "...oooo.........",
          "..oaaaao........",
          "..oaaaaaoooo....",
          "...oaaaaaao.....",
          "....aaaaaaa.....",
          "......aaa.......",
          ...blank.slice(8),
        ]),
        layer("beak", [
          "................",
          "................",
          "................",
          "..oswwo.........",
          "..........ss....",
          ...blank.slice(5),
        ]),
      ]),
      pose("flap", [
        layer("body", [
          "................",
          "..ooo...........",
          ".oaaao..........",
          "..oaaaaao.......",
          "...oaaaaaao.....",
          "....aaaaaaa.....",
          "......aaa.......",
          ".....aa.aa......",
          ...blank.slice(8),
        ]),
        layer("beak", [
          "................",
          "................",
          ".oswwo..........",
          "..........ss....",
          ...blank.slice(4),
        ]),
      ]),
    ],
  },
  {
    name: "Knight",
    poses: [
      pose("idle", [
        layer("shadow", [...blank.slice(0, 12), ".....bb..bb.....", ...blank.slice(13)]),
        layer("armour", [
          "......oooo......",
          ".....oaaaao.....",
          ".....o...o......",
          ".....o...o......",
          "......oooo......",
          ".....aaaaaa.....",
          "....aaaaaaaa....",
          "....aaaaaaaa....",
          ".....aaaaaa.....",
          ".....aa..aa.....",
          ".....aa..aa.....",
          ...blank.slice(11),
        ]),
        layer("face", [
          "................",
          "................",
          ".....oswwo......",
          ".....ossso......",
          ...blank.slice(4),
        ]),
      ]),
      pose("step", [
        layer("shadow", [...blank.slice(0, 12), "....bb....bb....", ...blank.slice(13)]),
        layer("armour", [
          "......oooo......",
          ".....oaaaao.....",
          ".....o...o......",
          ".....o...o......",
          "......oooo......",
          ".....aaaaaa.....",
          "....aaaaaaaa....",
          "....aaaaaaaa....",
          ".....aaaaaa.....",
          "....aa....aa....",
          "...aa......aa...",
          ...blank.slice(11),
        ]),
        layer("face", [
          "................",
          "................",
          ".....oswwo......",
          ".....ossso......",
          ...blank.slice(4),
        ]),
      ]),
    ],
  },
  {
    name: "Potion",
    poses: [
      pose("rest", [
        layer("glass", [
          "......oooo......",
          ".....o....o.....",
          ".....o....o.....",
          "......oooo......",
          ".....oooooo.....",
          "....oooooooo....",
          "....oooooooo....",
          "....oooooooo....",
          ".....oooooo.....",
          "......oooo......",
          ...blank.slice(10),
        ]),
        layer("liquid", [
          ...blank.slice(0, 5),
          "....aassssaa....",
          "....aasddsaa....",
          "....aassssaa....",
          ...blank.slice(8),
        ]),
        layer("cork", ["......wwww......", ...blank.slice(1)]),
      ]),
      pose("glint", [
        layer("glass", [
          "......oooo......",
          ".....o....o.....",
          ".....o....o.....",
          "......oooo......",
          ".....oooooo.....",
          "....oooooooo....",
          "....oooooooo....",
          "....oooooooo....",
          ".....oooooo.....",
          "......oooo......",
          ...blank.slice(10),
        ]),
        layer("liquid", [
          ...blank.slice(0, 5),
          "....aassssaa....",
          "....aassddaa....",
          "....aassssaa....",
          ...blank.slice(8),
        ]),
        layer("cork", ["......wwww......", ".......ww.......", ...blank.slice(2)]),
      ]),
    ],
  },
  {
    name: "Slime",
    poses: [
      pose("settle", [
        layer("shadow", [...blank.slice(0, 9), "....bbbbbbbb....", ...blank.slice(10)]),
        layer("body", [
          ...blank.slice(0, 3),
          "......oooo......",
          ".....oaaaao.....",
          "....oaaaaaao....",
          "....oaaaaaao....",
          ".....oaaaao.....",
          "....oooooooo....",
          ...blank.slice(9),
        ]),
        layer("face", [...blank.slice(0, 6), "....oasaaaso....", ...blank.slice(7)]),
      ]),
      pose("squash", [
        layer("shadow", [...blank.slice(0, 9), "...bbbbbbbbbb...", ...blank.slice(10)]),
        layer("body", [
          ...blank.slice(0, 4),
          ".....oooooo.....",
          "....oaaaaaao....",
          "...oaaaaaaaao...",
          "....oaaaaaao....",
          "...oooooooooo...",
          ...blank.slice(9),
        ]),
        layer("face", [...blank.slice(0, 6), "...oasaaaaaso...", ...blank.slice(7)]),
      ]),
    ],
  },
];

export function spriteBounds(cellsToMeasure: DemoCell[]): {
  minX: number;
  minY: number;
  width: number;
  height: number;
} {
  let minX = size;
  let minY = size;
  let maxX = 0;
  let maxY = 0;
  for (const cell of cellsToMeasure) {
    minX = Math.min(minX, cell.x);
    minY = Math.min(minY, cell.y);
    maxX = Math.max(maxX, cell.x);
    maxY = Math.max(maxY, cell.y);
  }
  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function assetCells(asset: DemoAsset): DemoCell[] {
  return asset.poses.flatMap((item) => item.layers.flatMap((part) => part.cells));
}
