/**
 * One place that turns a task role key into something a person reads. The
 * internal keys (w1, review-1, fix-1-2, plan) stay as they are; every surface
 * that shows them to the user goes through this.
 */
export function agentLabel(key: string): string {
  const worker = /^w(\d+)$/.exec(key);
  if (worker) return `Agent ${worker[1]}`;
  if (key === "plan") return "Supervisor";
  const review = /^review-(\d+)$/.exec(key);
  if (review) return `Reviewer ${review[1]}`;
  const fix = /^fix-(\d+)-(\d+)$/.exec(key);
  if (fix) return `Agent ${fix[2]} · fix ${fix[1]}`;
  return key;
}
