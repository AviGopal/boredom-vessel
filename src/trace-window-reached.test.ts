// BOREDOM'S SELECTION POSTERIORS GRADE BY THE JUDGE'S REACHED, NOT BY EXIT STATUS.
//
// fetchPosteriorsForSignature and fetchDispatcherPosteriors counted status success/completed (or success = true) as a
// success, so a hollow completion (completed, reached:false) earned alpha for the goal template and the dispatcher arm.
// Both now grade every row with traceOutcome: reached:true is a success, reached:false a failure, no verdict neither
// (no sample). The aggregate is asked for the same rule (success_rule reached: success_count and failure_count).
//   [MUST-FAIL] a hollow completion is a failure (β), reached:true a success (α), an ungraded run neither, by traceOutcome
//               and through the aggregate read, whose request names success_rule reached.
//   [MUST-FAIL] both fetchers in index.ts grade with traceOutcome, skip an ungraded row, and no longer read exit status.
//   [CONTROL]   a window of ungraded runs only is an empty window, not a scope mismatch: no probe, no loud line.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// A namespace import, so the file loads at a parent without traceOutcome and fails on behaviour.
import * as tw from "./trace-window";
const outcome = (r: Record<string, unknown>) => (tw as { traceOutcome?: (r: Record<string, unknown>) => boolean | null }).traceOutcome!(r);
const nameSignature = (sig: string) => (tw as { traceWindowSignature?: (s: string) => void }).traceWindowSignature?.(sig);

const realFetch = globalThis.fetch;
const realError = console.error;
const realLog = console.log;
afterEach(() => { globalThis.fetch = realFetch; console.error = realError; console.log = realLog; });

const EP = "http://activity-api.test";
const SIG_TAG = "state_signature:s1";
const SINCE = Date.now() - 24 * 3600 * 1000;
type Row = Record<string, unknown>;
const HOLLOW: Row = { execution_id: "h", activity_id: "t", tags: [SIG_TAG, "dispatcher_used:goal-host"], status: "completed", success: true, reached: false };
const REACHED: Row = { execution_id: "r", activity_id: "t", tags: [SIG_TAG, "dispatcher_used:goal-host"], status: "failure", success: false, reached: true };
const UNGRADED: Row = { execution_id: "u", activity_id: "t", tags: [SIG_TAG, "dispatcher_used:goal-host"], status: "completed", success: true };

/** traceAggregateReport honouring success_rule reached (and only it), plus the list route. */
function serve(window: Row[]) {
  const calls = { list: [] as string[], aggregate: [] as Record<string, unknown>[] };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (new URL(String(url)).pathname === "/v2/impulses/resolve") {
      const p = (JSON.parse(String(init?.body)) as { impulse: { pointer: Record<string, unknown> } }).impulse.pointer;
      calls.aggregate.push(p);
      const groups = new Map<string, { key: string; tag_value: string | null; value: number }>();
      for (const r of window) {
        if (p.success_rule === "reached") {
          if (p.metric === "success_count" && r.reached !== true) continue;
          if (p.metric === "failure_count" && r.reached !== false) continue;
        } else {
          const ok = r.success === true || r.status === "success" || r.status === "completed";
          if (p.metric === "success_count" && !ok) continue;
          if (p.metric === "failure_count" && ok) continue;
        }
        const dt = (r.tags as string[]).find((t) => t.startsWith("dispatcher_used:"));
        const tag_value = dt ? dt.slice("dispatcher_used:".length) : null;
        const k = JSON.stringify([r.activity_id, tag_value]);
        const g = groups.get(k) ?? { key: String(r.activity_id), tag_value, value: 0 };
        g.value++;
        groups.set(k, g);
      }
      const report = {
        measured: true, truncated: false, rows: [...groups.values()], tag: p.tag, group_by_tag: p.group_by_tag,
        success_rule: p.success_rule, ...("exclude_observe" in p ? { exclude_observe: p.exclude_observe } : {}),
      };
      return new Response(JSON.stringify({ success: true, content: JSON.stringify(report) }), { status: 200 });
    }
    calls.list.push(String(url));
    return new Response(JSON.stringify({ executions: window }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

/** The fetchers' cell update, as index.ts runs it. */
function cell(rows: Row[]) {
  const c = { alpha: 0, beta: 0, samples: 0 };
  for (const t of rows) {
    const success = outcome(t);
    if (success === null) continue;
    if (success) c.alpha += 1; else c.beta += 1;
    c.samples += 1;
  }
  return c;
}

describe("posterior success is the judge's reached", () => {
  it("[MUST-FAIL] traceOutcome: hollow completion → failure, reached → success, ungraded → neither", () => {
    expect(outcome(HOLLOW)).toBe(false);
    expect(outcome(REACHED)).toBe(true);
    expect(outcome(UNGRADED)).toBeNull();
    expect(outcome({ ...UNGRADED, reached: null })).toBeNull();
    expect(cell([HOLLOW, REACHED, UNGRADED])).toEqual({ alpha: 1, beta: 1, samples: 2 });
  });

  it("[MUST-FAIL] the aggregate read asks for success_rule reached and weighs a hollow completion as β", async () => {
    console.log = () => {};
    const calls = serve([HOLLOW, REACHED, UNGRADED]);
    nameSignature("s1");
    const got = await tw.readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature");
    expect(calls.aggregate.length).toBeGreaterThan(0);
    expect(calls.aggregate.every((p) => p.success_rule === "reached")).toBe(true);
    expect(calls.list.length).toBe(0);
    expect(got).not.toBeNull();
    expect(cell(got!)).toEqual({ alpha: 1, beta: 1, samples: 2 });
  });

  it("[CONTROL] a window of ungraded runs only is empty, not a scope mismatch", async () => {
    const errs: string[] = [];
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    console.log = () => {};
    const calls = serve([UNGRADED, { ...UNGRADED, execution_id: "u2" }]);
    nameSignature("s1");
    expect(await tw.readTraceWindow(EP, {}, SINCE, "fetchDispatcherPosteriors")).toEqual([]);
    expect(calls.list.length).toBe(0);
    expect(errs.some((l) => l.includes("scope mismatch") || l.includes("weighing nothing"))).toBe(false);
  });
});

describe("both posterior fetchers grade by reached", () => {
  const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  for (const name of ["fetchPosteriorsForSignature", "fetchDispatcherPosteriors"]) {
    it(`[MUST-FAIL] ${name} grades with traceOutcome and skips an ungraded row`, () => {
      const start = SRC.indexOf(`async function ${name}(`);
      expect(start).toBeGreaterThan(0);
      const body = SRC.slice(start, SRC.indexOf("\n}\n", start));
      expect(body).toMatch(/const success = traceOutcome\(t\);\s*if \(success === null\) continue;/);
      expect(body).not.toContain('status === "completed"');
      expect(body).not.toContain("t.success === true");
    });
  }
});
