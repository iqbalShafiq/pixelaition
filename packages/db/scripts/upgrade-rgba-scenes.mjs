#!/usr/bin/env node
// One-way data migration: artboard scenes v1 (palette indices) -> v2 (packed
// RGBA). Reads the asset's palette and rewrites every stored scene, including
// frame, artboard, and version snapshots. Dry-run unless --apply is passed.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = Object.fromEntries(
  readFileSync(new URL("../../../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const key = line.slice(0, line.indexOf("=")).trim();
      const raw = line.slice(line.indexOf("=") + 1).trim();
      return [key, raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")];
    }),
);
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}
const apply = process.argv.includes("--apply");
const sql = postgres(env.DATABASE_URL, { max: 1 });

function packed(hex) {
  const value = String(hex ?? "").trim();
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!match) return 0;
  const rgb = Number.parseInt(match[1], 16);
  const alpha = match[2] ? Number.parseInt(match[2], 16) : 255;
  return ((rgb << 8) | alpha) >>> 0;
}

function color(value, palette) {
  if (!Number.isInteger(value) || value < 0) return 0;
  if (value < palette.length && value < 16) return packed(palette[value]);
  return value >>> 0;
}

function upgradeScene(scene, palette) {
  if (!scene || typeof scene !== "object" || scene.version !== 1) return undefined;
  const bg = scene.background;
  const background =
    bg?.kind === "solid"
      ? { ...bg, color: color(bg.color, palette) }
      : bg?.kind === "pattern"
        ? {
            ...bg,
            colorA: color(bg.colorA, palette),
            colorB: color(bg.colorB, palette),
          }
        : bg;
  const elements = Array.isArray(scene.elements)
    ? scene.elements.map((element) => {
        if (!element || typeof element !== "object") return element;
        if (element.kind === "pattern") {
          return {
            ...element,
            colorA: color(element.colorA, palette),
            colorB: color(element.colorB, palette),
          };
        }
        if ("color" in element) return { ...element, color: color(element.color, palette) };
        return element;
      })
    : [];
  return { ...scene, version: 2, background, elements };
}

const counts = { frames: 0, artboards: 0, versions: 0, artboardVersions: 0 };
await sql.begin(async (tx) => {
  const frames = await tx`
    select f.id, f.scene, a.palette
    from frames f join assets a on a.id = f.asset_id
    where f.scene is not null`;
  for (const row of frames) {
    const next = upgradeScene(row.scene, row.palette ?? []);
    if (!next) continue;
    counts.frames += 1;
    if (apply) await tx`update frames set scene = ${tx.json(next)} where id = ${row.id}`;
  }

  const artboards = await tx`
    select b.id, b.scene, a.palette
    from artboards b
    join artboard_sets s on s.id = b.set_id
    join assets a on a.id = s.asset_id`;
  for (const row of artboards) {
    const next = upgradeScene(row.scene, row.palette ?? []);
    if (!next) continue;
    counts.artboards += 1;
    if (apply) await tx`update artboards set scene = ${tx.json(next)} where id = ${row.id}`;
  }

  const versions = await tx`
    select v.id, v.snapshot, a.palette
    from versions v join assets a on a.id = v.asset_id
    where v.snapshot is not null`;
  for (const row of versions) {
    const scene = row.snapshot?.social?.scene;
    const next = upgradeScene(scene, row.palette ?? []);
    if (!next) continue;
    counts.versions += 1;
    if (apply) {
      const snapshot = {
        ...row.snapshot,
        social: { ...row.snapshot.social, scene: next },
      };
      await tx`update versions set snapshot = ${tx.json(snapshot)} where id = ${row.id}`;
    }
  }

  const artboardVersions = await tx`
    select v.id, v.snapshot, a.palette
    from artboard_versions v
    join artboard_sets s on s.id = v.set_id
    join assets a on a.id = s.asset_id`;
  for (const row of artboardVersions) {
    const next = upgradeScene(row.snapshot?.scene, row.palette ?? []);
    if (!next) continue;
    counts.artboardVersions += 1;
    if (apply) {
      const snapshot = { ...row.snapshot, scene: next };
      await tx`update artboard_versions set snapshot = ${tx.json(snapshot)} where id = ${row.id}`;
    }
  }
});

await sql.end();
console.log(
  `${apply ? "upgraded" : "would upgrade"} frames=${counts.frames} artboards=${counts.artboards} versions=${counts.versions} artboardVersions=${counts.artboardVersions}`,
);
