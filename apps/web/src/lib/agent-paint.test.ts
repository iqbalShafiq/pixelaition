import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "./types.js";
import {
  AgentPaintSession,
  decodeStroke,
  foldFrameUpdate,
  orderChangedCells,
  REPLAY_STROKES,
  SLOW_STEP_MS,
  type DecodedLayer,
  type FrameView,
  type IncomingStroke,
} from "./agent-paint.js";

function layer(pixels: number[], id = "base"): DecodedLayer {
  return { id, name: "pixels", visible: true, pixels: Uint8Array.from(pixels) };
}

function frame(pixels: number[], width = 4): FrameView {
  return { width, height: pixels.length / width, layers: [layer(pixels)] };
}

function stroke(
  frameId: string,
  pixels: number[],
  points: Array<{ x: number; y: number }> = [],
  width = 4,
): IncomingStroke {
  return { frameId, layers: frame(pixels, width).layers, points };
}

function painted(update: { layers?: DecodedLayer[] } | undefined): number[] {
  return [...(update?.layers?.[0]?.pixels ?? [])];
}

describe("orderChangedCells", () => {
  it("walks hinted pixels first, then the rest of the box in scan order", () => {
    const before = Uint8Array.from([0, 0, 0, 0]);
    const after = Uint8Array.from([1, 1, 1, 1]);
    expect(
      orderChangedCells(2, 2, before, after, [
        { x: 1, y: 0 },
        { x: 1, y: 0 },
        { x: 9, y: 0 },
      ]),
    ).toEqual([
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it("skips a hinted pixel the stroke did not change", () => {
    const before = Uint8Array.from([0, 2]);
    const after = Uint8Array.from([1, 2]);
    expect(orderChangedCells(2, 1, before, after, [{ x: 1, y: 0 }])).toEqual([
      { x: 0, y: 0 },
    ]);
  });
});

describe("decodeStroke", () => {
  it("keeps the paint order and ignores a point that is not a cell", () => {
    const decoded = decodeStroke(
      {
        frameId: "f1",
        layers: [
          {
            id: "base",
            name: "pixels",
            visible: true,
            pixels: bytesToBase64(Uint8Array.from([0, 1])),
          },
        ],
        points: [{ x: 1, y: 0 }, { x: "no" }, null],
        palette: ["#00000000", "#a7f070"],
      },
      "",
    );
    expect(decoded).toMatchObject({
      frameId: "f1",
      points: [{ x: 1, y: 0 }],
      palette: ["#00000000", "#a7f070"],
    });
    expect([...(decoded?.layers[0]?.pixels ?? [])]).toEqual([0, 1]);
  });
});

describe("AgentPaintSession", () => {
  it("hovers a cell before inking it, then moves the border to the next cell", () => {
    const session = new AgentPaintSession();
    const present = frame([0, 0, 0, 0]);
    session.push(
      stroke(
        "f",
        [1, 1, 0, 0],
        [
          { x: 1, y: 0 },
          { x: 0, y: 0 },
        ],
      ),
    );
    const opened = session.flush(0, () => present, false);
    expect(opened[0]?.cursor).toEqual({ x: 1, y: 0 });
    expect(painted(opened[0])).toEqual([0, 0, 0, 0]);

    const inked = session.tick(SLOW_STEP_MS);
    expect(inked[0]?.cursor).toEqual({ x: 1, y: 0 });
    expect(painted(inked[0])).toEqual([0, 1, 0, 0]);

    const moved = session.tick(SLOW_STEP_MS * 2);
    expect(moved[0]?.cursor).toEqual({ x: 0, y: 0 });
    expect(moved[0]?.layers).toBeUndefined();

    const second = session.tick(SLOW_STEP_MS * 3);
    expect(painted(second[0])).toEqual([1, 1, 0, 0]);
    expect(second[0]?.cursor).toEqual({ x: 0, y: 0 });

    const done = session.tick(SLOW_STEP_MS * 4);
    expect(done[0]?.cursor).toBeNull();
    expect(session.nextAt()).toBeNull();
  });

  it("walks two frames on the same tick", () => {
    const session = new AgentPaintSession();
    const blank = frame([0, 0, 0, 0]);
    session.push(stroke("a", [2, 0, 0, 0], [{ x: 0, y: 0 }]));
    session.push(stroke("b", [0, 3, 0, 0], [{ x: 1, y: 0 }]));
    const opened = session.flush(0, () => blank, false);
    expect(opened.map((update) => update.frameId)).toEqual(["a", "b"]);
    expect(opened.every((update) => update.cursor !== null)).toBe(true);

    const inked = session.tick(SLOW_STEP_MS);
    expect(inked).toHaveLength(2);
    expect(painted(inked.find((update) => update.frameId === "a"))).toEqual([2, 0, 0, 0]);
    expect(painted(inked.find((update) => update.frameId === "b"))).toEqual([0, 3, 0, 0]);
  });

  it("snaps a replay the screen already caught, and walks only the stroke it is one behind", () => {
    const first = stroke("f", [1, 0, 0, 0]);
    const second = stroke("f", [1, 1, 0, 0]);
    const third = stroke("f", [1, 1, 1, 0], [{ x: 2, y: 0 }]);

    const caught = new AgentPaintSession();
    caught.push(first);
    caught.push(second);
    caught.push(third);
    expect(caught.flush(0, () => frame([1, 1, 1, 0]), false)).toEqual([]);

    const behind = new AgentPaintSession();
    behind.push(first);
    behind.push(second);
    behind.push(third);
    const walking = behind.flush(0, () => frame([1, 1, 0, 0]), false);
    expect(walking[0]?.cursor).toEqual({ x: 2, y: 0 });
    expect(painted(walking[0])).toEqual([1, 1, 0, 0]);

    const far = new AgentPaintSession();
    for (let index = 0; index <= REPLAY_STROKES; index += 1) {
      const pixels = [0, 0, 0, 0];
      pixels[index % 4] = 1;
      far.push(stroke("f", pixels));
    }
    const snapped = far.flush(0, () => frame([0, 0, 0, 0]), false);
    expect(snapped[0]?.cursor).toBeNull();
    expect(snapped[0]?.layers).toBeDefined();
    expect(far.nextAt()).toBeNull();
  });

  it("walks a fill and the next paint instead of popping the whole burst", () => {
    const session = new AgentPaintSession();
    session.push(stroke("f", [1, 1, 0, 0]));
    session.push(stroke("f", [1, 1, 1, 0], [{ x: 2, y: 0 }]));
    const opened = session.flush(0, () => frame([0, 0, 0, 0]), false);
    expect(opened[0]?.cursor).toEqual({ x: 0, y: 0 });
    expect(painted(opened[0])).toEqual([0, 0, 0, 0]);

    session.tick(SLOW_STEP_MS);
    session.tick(SLOW_STEP_MS * 2);
    session.tick(SLOW_STEP_MS * 3);
    const second = session.tick(SLOW_STEP_MS * 4);
    expect(second[0]?.cursor).toEqual({ x: 2, y: 0 });
    expect(painted(second[0])).toEqual([1, 1, 0, 0]);
  });

  it("holds a whole fill back so the cursor can walk every cell", () => {
    const width = 4;
    const count = width * width;
    const blank = Array.from({ length: count }, () => 0);
    const filled = Array.from({ length: count }, () => 1);
    const session = new AgentPaintSession();
    session.push(stroke("f", filled, [], width));
    const opened = session.flush(0, () => frame(blank, width), false);
    expect(painted(opened[0])).toEqual(blank);
    expect(opened[0]?.cursor).toEqual({ x: 0, y: 0 });
    const inked = session.tick(session.nextAt() ?? 0);
    expect(painted(inked[0])[0]).toBe(1);
    expect(painted(inked[0]).filter((value) => value === 1)).toHaveLength(1);
  });

  it("queues a later burst behind the stroke already walking", () => {
    const session = new AgentPaintSession();
    session.push(stroke("f", [1, 0, 0, 0], [{ x: 0, y: 0 }]));
    session.flush(0, () => frame([0, 0, 0, 0]), false);
    for (let index = 0; index <= REPLAY_STROKES; index += 1) {
      session.push(stroke("f", [1, 1, 1, index % 2]));
    }
    const queued = session.flush(SLOW_STEP_MS, () => frame([0, 0, 0, 0]), false);
    expect(queued).toEqual([]);
    expect(session.nextAt()).not.toBeNull();
  });

  it("drops the border and commits the whole stroke when motion is reduced", () => {
    const session = new AgentPaintSession();
    session.push(stroke("f", [1, 1, 0, 0], [{ x: 0, y: 0 }]));
    const opened = session.flush(0, () => frame([0, 0, 0, 0]), true);
    expect(opened[0]?.cursor).toBeNull();
    expect(painted(opened[0])).toEqual([1, 1, 0, 0]);
    expect(session.nextAt()).toBeNull();
  });

  it("finish commits a stroke that is still hovering", () => {
    const session = new AgentPaintSession();
    session.push(stroke("f", [1, 0, 0, 0], [{ x: 0, y: 0 }]));
    session.flush(0, () => frame([0, 0, 0, 0]), false);
    const done = session.finish();
    expect(painted(done[0])).toEqual([1, 0, 0, 0]);
    expect(done[0]?.cursor).toBeNull();
    expect(session.tick(SLOW_STEP_MS)).toEqual([]);
  });
});

describe("canvas size changes", () => {
  it("decodeStroke reads the canvas size the event carries", () => {
    const decoded = decodeStroke(
      {
        frameId: "f",
        width: 8,
        height: 8,
        layers: [{ id: "l", pixels: bytesToBase64(new Uint8Array(64)) }],
      },
      "",
    );
    expect(decoded).toMatchObject({ width: 8, height: 8 });
    const sizeless = decodeStroke(
      { frameId: "f", layers: [{ id: "l", pixels: bytesToBase64(new Uint8Array(16)) }] },
      "",
    );
    expect(sizeless?.width).toBeUndefined();
  });

  it("snaps a resized frame and reports its new size", () => {
    const session = new AgentPaintSession();
    const before = frame(new Array(16).fill(0), 4);
    const resized: IncomingStroke = {
      ...stroke("frame-1", new Array(64).fill(1), [], 8),
      width: 8,
      height: 8,
    };
    session.push(resized);
    const updates = session.flush(0, () => before, false);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      frameId: "frame-1",
      cursor: null,
      width: 8,
      height: 8,
    });
    expect(painted(updates[0])).toHaveLength(64);
  });

  it("walks later strokes against the frame's new size", () => {
    const session = new AgentPaintSession();
    const resized: IncomingStroke = {
      ...stroke("frame-1", new Array(64).fill(0), [], 8),
      width: 8,
      height: 8,
    };
    session.push(resized);
    const first = session.flush(0, () => frame(new Array(16).fill(0), 4), false);
    const view: FrameView = {
      width: 8,
      height: 8,
      layers: first[0]?.layers ?? [],
    };
    const dot = new Array(64).fill(0);
    dot[33] = 2;
    session.push(stroke("frame-1", dot, [{ x: 1, y: 4 }], 8));
    const updates = session.flush(SLOW_STEP_MS + 1, () => view, false);
    const cursor = updates.find((update) => update.cursor)?.cursor;
    expect(cursor).toEqual({ x: 1, y: 4 });
  });

  it("folds a size change into the on-screen view, keeping the size otherwise", () => {
    const layers = frame(new Array(64).fill(1), 8).layers;
    expect(foldFrameUpdate({ frameId: "frame-1", width: 8, height: 8, layers })).toEqual({
      width: 8,
      height: 8,
      layers,
    });
    expect(foldFrameUpdate({ frameId: "frame-1" })).toEqual({});
  });
});
