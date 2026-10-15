/**
 * One place that turns a task role key into something a person reads. The
 * internal keys (w1, review-1, fix-1-2, plan) stay as they are; every surface
 * that shows them to the user goes through this.
 */
export function agentLabel(key: string): string {
  // A retry answers a failure of the same role: it is still that agent, and
  // the UI says "retrying" through the frame state, not through its name.
  const base = key.replace(/-retry-\d+$/, "");
  const worker = /^w(\d+)$/.exec(base);
  if (worker) return `Agent ${worker[1]}`;
  if (base === "plan" || base.startsWith("plan-")) return "Supervisor";
  const review = /^review-(\d+)/.exec(base);
  if (review) return `Reviewer ${review[1]}`;
  // A fix is its own child, spawned by the review for one frame: it is Fix N
  // (not the agent number again, which read as three agents called Agent 2).
  const fix = /^fix-(\d+)-(\d+)$/.exec(base);
  if (fix) return fix[2] === "1" ? `Fix ${fix[1]}` : `Fix ${fix[1]}.${fix[2]}`;
  if (base === "fix-unpainted") return "Fix";
  return base;
}
