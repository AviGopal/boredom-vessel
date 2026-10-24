// OBSERVE TRACES ARE COUNTED IN THE POSTERIOR WINDOW, LIKE ANY RUN.
//
// An observe execution (learning_mode:observe, reach_observe:true) still resolves impulses, and those make real
// changes, so it is evidence about the arm. traceAggregateReport leaves observe executions out by default; the
// posterior read must ask for them (exclude_observe: false) and only trust a report that echoes it.
//   [MUST-FAIL] against a producer that excludes observe unless told otherwise, the window read for a signature holds
//               its observe traces, and the request says exclude_observe: false.
//   [CONTROL]   a producer that ignores the switch (no echo) is not trusted: the read falls back to the list page, which
//               holds the observe traces too.
import { afterEach, describe, expect, it } from "bun:test";
import * as tw from "./trace-window";
const nameSignature = (sig: string) => (tw as { traceWindowSignature?: (s: string) => void }).traceWindowSignature?.(sig);

const realFetch = globalThis.fetch;
const realError = console.error;
const realLog = console.log;
afterEach(() => { globalThis.fetch = realFetch; console.error = realError; console.log = realLog; });

const EP = "http://activity-api.test";
const SIG_TAG = "state_signature:s1";
const SINCE = Date.now() - 24 * 3600 * 1000;
type Row = Record<string, unknown>;
const window: Row[] = [
  { execution_id: "a", activity_id: "t", tags: [SIG_TAG, "dispatcher_used:goal-host"], status: "success", success: true, reached: true },
  { execution_id: "b", activity_id: "t", tags: [SIG_TAG, "dispatcher_used:goal-host", "learning_mode:observe"], status: "success", success: true, reached: true },
  { execution_id: "c", activity_id: "t", tags: [SIG_TAG, "reach_observe:true"], status: "failure", success: false, reached: false },
];
const observe = (r: Row) => (r.tags as string[]).some((t) => t === "learning_mode:observe" || t === "reach_observe:true");

/** traceAggregateReport with the producer's default: observe excluded unless exclude_observe is false. */
function serve(echoObserve: boolean) {
  const pointers: Record<string, unknown>[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (new URL(String(url)).pathname === "/v2/impulses/resolve") {
      const p = (JSON.parse(String(init?.body)) as { impulse: { pointer: Record<string, unknown> } }).impulse.pointer;
      pointers.push(p);
      const groups = new Map<string, { key: string; tag_value: string | null; value: number }>();
      for (const r of window) {
        if (p.exclude_observe !== false && observe(r)) continue;
        // The window's rows agree under either success rule, so the double serves both.
        const won = p.success_rule === "reached" ? r.reached === true : r.success === true || r.status === "success" || r.status === "completed";
        if (p.metric === "success_count" && !won) continue;
        if (p.metric === "failure_count" && won) continue;
        const dt = (r.tags as string[]).find((t) => t.startsWith("dispatcher_used:"));
        const tag_value = dt ? dt.slice("dispatcher_used:".length) : null;
        const k = JSON.stringify([r.activity_id, tag_value]);
        const g = groups.get(k) ?? { key: String(r.activity_id), tag_value, value: 0 };
        g.value++;
        groups.set(k, g);
      }
      const rows = [...groups.values()];
      const report = {
        measured: true, truncated: false, rows, tag: p.tag, group_by_tag: p.group_by_tag, success_rule: p.success_rule,
        ...(echoObserve && "exclude_observe" in p ? { exclude_observe: p.exclude_observe } : {}),
      };
      return new Response(JSON.stringify({ success: true, content: JSON.stringify(report) }), { status: 200 });
    }
    return new Response(JSON.stringify({ executions: window }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return pointers;
}

describe("the posterior window counts observe traces", () => {
  it("[MUST-FAIL] the aggregate read asks for observe traces and holds them", async () => {
    console.log = () => {};
    const pointers = serve(true);
    nameSignature("s1");
    const got = await tw.readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature");
    expect(pointers.length).toBeGreaterThan(0);
    expect(pointers.every((p) => p.exclude_observe === false)).toBe(true);
    expect(got?.length).toBe(3);
    // Both observe traces are weighed: one success (b), one failure (c), beside the plain success (a).
    expect(got!.filter((r) => r.success === true).length).toBe(2);
  });

  it("[CONTROL] a producer that does not echo the observe switch is not trusted; the list page holds them too", async () => {
    const errs: string[] = [];
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(" ")); };
    serve(false);
    nameSignature("s1");
    const got = await tw.readTraceWindow(EP, {}, SINCE, "fetchDispatcherPosteriors");
    expect(got?.length).toBe(3);
    expect(got!.filter(observe).length).toBe(2);
    expect(errs.some((l) => l.includes("does not serve exclude_observe"))).toBe(true);
  });
});
