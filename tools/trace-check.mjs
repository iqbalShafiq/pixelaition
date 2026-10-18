#!/usr/bin/env node
// Read one task's Langfuse traces back and judge whether every generation got
// the context it needed. Usage: node tools/trace-check.mjs <durableTaskId>
// Env: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL (from .env).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
    .map((line) => {
      const key = line.slice(0, line.indexOf("=")).trim();
      const raw = line.slice(line.indexOf("=") + 1).trim();
      const value = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      return [key, value];
    }),
);
const base = env.LANGFUSE_BASE_URL?.replace(/\/$/, "");
const auth = Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64");
if (!base || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
  console.error("Langfuse is not configured; set LANGFUSE_* in .env.");
  process.exit(2);
}
const traceIdFor = (runId) => createHash("sha256").update(runId).digest("hex").slice(0, 32);

/**
 * Which task to check: the one named on the command line. The task's children
 * are read from the durable store, so a child whose row was written after a
 * worker restart is still found.
 */
const taskArg = process.argv.indexOf("--task");
const taskId = taskArg === -1 ? process.argv[2] : process.argv[taskArg + 1];
if (!taskId) {
  console.error("usage: node tools/trace-check.mjs [--task] <durableTaskId>");
  process.exit(2);
}

// Every child run id of the task, from the durable store.
const sqlite = "apps/worker/data/anvia-runs.sqlite";
const children = execFileSync(
  "sqlite3",
  ["-json", sqlite, `select key, json_extract(record,'$.agentRunId') as runId from anvia_durable_tasks where root_id='${taskId}' and json_extract(record,'$.agentRunId') is not null order by rowid`],
  { encoding: "utf8" },
);
const childRows = children.trim()
  ? JSON.parse(children).filter((row) => typeof row.runId === "string")
  : [];
const roleOf = (key) =>
  key.startsWith("plan") ? "draw-plan" : key.startsWith("w") ? "draw-worker" : key.startsWith("review") ? "draw-review" : "draw-fix";
const traces = [
  { id: taskId, role: "draw-task" },
  ...childRows.map((row) => ({ id: row.runId, role: roleOf(row.key) })),
];

/** What each role's first generation must carry, to judge its context. */
const MARKERS = {
  "draw-task": ["plan", "workers"],
  "draw-plan": ["JSON", "frames"],
  "draw-worker": ["Paint only these frames", "Palette (", "Style:"],
  "draw-review": ["Frames to review", "Plan:", "Palette:"],
  // A fix prompt names its frame and layers, quotes the review, carries the
  // work log, and bounds the writer to the ordered layers.
  "draw-fix": ["Frame:", "The review asks:", "Paint only"],
};
/** Tool failures the model sees as `error-*`; every one is a refused call worth naming. */
const REFUSAL = /"type":"error-(text|json)"/;
/**
 * By default the newest task of the asset is checked; `--task <durableTaskId>`
 * checks a named one (a session whose child rows were written after a
 * restart, for example).
 */

let missing = 0;
let first = true;
for (const { id, role } of traces) {
  // The public API rate-limits tightly; pace the reads.
  if (!first) await new Promise((resolve) => setTimeout(resolve, 4000));
  first = false;
  const traceId = traceIdFor(id);
  let response = await fetch(`${base}/api/public/observations?traceId=${traceId}&limit=100`, {
    headers: { authorization: `Basic ${auth}` },
  });
  if (response.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    response = await fetch(`${base}/api/public/observations?traceId=${traceId}&limit=100`, {
      headers: { authorization: `Basic ${auth}` },
    });
  }
  if (!response.ok) {
    console.log(`${id.slice(0, 8)} → trace ${traceId}: HTTP ${response.status} (not indexed yet?)`);
    missing += 1;
    continue;
  }
  const body = await response.json();
  const observations = body.data ?? [];
  // The trace's metadata carries the run prompt; observation inputs are
  // per-event, so the metadata is the stable place to judge context.
  const traceResponse = await fetch(`${base}/api/public/traces/${traceId}`, {
    headers: { authorization: `Basic ${auth}` },
  });
  const traceBody = traceResponse.ok ? await traceResponse.json() : null;
  const metadata = JSON.stringify(traceBody?.metadata ?? {});
  if (observations.length === 0) {
    console.log(`${id.slice(0, 8)} → trace ${traceId}: no observations yet`);
    missing += 1;
    continue;
  }
  const name = role;
  const texts = [
    ...observations.map((item) => JSON.stringify(item.input ?? "")),
    metadata,
  ].join(" ");
  const expected = MARKERS[name] ?? [];
  const found = expected.filter((marker) => texts.includes(marker));
  const refusals = observations.filter(
    (item) =>
      item.type === "TOOL" &&
      (item.level === "ERROR" || REFUSAL.test(JSON.stringify(item.output ?? ""))),
  );
  const verdict =
    found.length === expected.length
      ? "OK"
      : `MISSING ${expected.filter((m) => !found.includes(m)).join(", ")}`;
  if (verdict !== "OK") missing += 1;
  const refusalNote =
    refusals.length === 0
      ? ""
      : ` · ${refusals.length} refused call${refusals.length === 1 ? "" : "s"}: ${[
          ...new Set(refusals.map((item) => item.name)),
        ].join(", ")}`;
  console.log(
    `${id.slice(0, 8)} → ${name}: ${observations.length} observations · ${verdict}${refusalNote}`,
  );
}
process.exit(missing > 0 ? 1 : 0);
