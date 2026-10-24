// THE POSTERIOR WINDOW IS COUNTED BY THE AGGREGATE; THE LIST IS ONE PAGE.
//
// The list route serves at most 100 rows a page, so one page of a busy 24 h window is a full page and weighs nothing,
// and paging it by offset was reverted (it crossed the database CPU rule). A fetcher that names its signature
// (traceWindowSignature) now gets the window from traceAggregateReport: count and success_count for the signature's
// tag, grouped by activity_id and the dispatcher_used tag, success by bv's rule (status_or_flag). The fallback is the
// one-page list read: a short page is weighed, a full page weighs nothing. No list request ever carries `offset`.
//   [MUST-FAIL]   on a 6,000-row window the list page is full and weighs nothing; the aggregate returns the whole window
//                 (every non-observe signature trace) in its two calls, no list page.
//   [EQUIVALENCE] on one fixture short enough for one page, both fetchers' cells from the aggregate equal the cells the
//                 old list read gives over the non-observe traces; the one named difference is the observe traces.
//   [MUST-FAIL]   both fetchers in index.ts name their signature immediately before their readTraceWindow call.
//   [MUST-FAIL]   an aggregate measured but empty while the list has traces logs a scope mismatch and reads the list
//                 page (both empty: no fallback, no loud line).
//   [FIX]         a producer that does not echo the tag filter (it would count the whole window) is unavailable: its own
//                 line ("aa extension not live"), and the read falls back to the one list page, never to offset pages.
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// A namespace import, so the file loads at a parent without traceWindowSignature and fails on behaviour.
import * as tw from "./trace-window";
const { readTraceWindow } = tw;
const nameSignature = (sig: string) => (tw as { traceWindowSignature?: (s: string) => void }).traceWindowSignature?.(sig);

const realFetch = globalThis.fetch;
const realError = console.error;
const realLog = console.log;
afterEach(() => {
  globalThis.fetch = realFetch; console.error = realError; console.log = realLog;
  setSystemTime();
});

const EP = "http://activity-api.test";
const SIG = "s1";
const SIG_TAG = `state_signature:${SIG}`;
const T0 = Date.parse("2030-05-02T12:00:00Z");
const SINCE = T0 - 24 * 3600 * 1000;
const OBSERVE = ["learning_mode:observe", "reach_observe:true"];
/** The fixture's goal templates (index.ts maps template id → goal idx the same way). */
const TEMPLATES = ["development-vessel:alpha-tick", "development-vessel:beta-tick", "development-vessel:gamma-tick"];
type Row = Record<string, unknown>;

/** A deterministic window: signatures, dispatchers, outcomes, observe probes and template-id forms all mixed. */
function fixture(n: number): Row[] {
  const out: Row[] = [];
  for (let i = 0; i < n; i++) {
    const tags: string[] = [];
    tags.push(i % 5 === 4 ? "state_signature:other" : SIG_TAG);
    if (i % 3 === 0) tags.push("dispatcher_used:goal-host");
    else if (i % 3 === 1) tags.push("dispatcher_used:light-dispatch");
    if (i % 11 === 0) tags.push(OBSERVE[i % 2]!);
    tags.push("boredom_source");
    const tpl = TEMPLATES[i % TEMPLATES.length]!;
    const activity_id = i % 13 === 0 ? `activity:⟨${tpl}⟩` : i % 17 === 0 ? "development-vessel:not-a-goal" : tpl;
    const k = i % 7;
    const row: Row = { execution_id: `e${i}`, activity_id, tags, executed_at: new Date(T0 - i * 1000).toISOString() };
    if (k === 0) { row.status = "success"; row.success = true; }
    else if (k === 1) { row.status = "completed"; row.success = false; }
    else if (k === 2) { row.status = "failure"; row.success = true; }
    else { row.status = "failure"; row.success = false; }
    out.push(row);
  }
  return out;
}
const isObserve = (r: Row) => (r.tags as string[]).some((t) => OBSERVE.includes(t));

/** traceAggregateReport over `window`, by the contract: tag filter, observe excluded by default, (activity_id, first dispatcher_used tag). */
function aggregate(window: Row[], p: Record<string, unknown>, echo: boolean): Record<string, unknown> {
  const groups = new Map<string, { key: string; tag_value: string | null; value: number }>();
  for (const r of window) {
    const tags = r.tags as string[];
    if (typeof p.tag === "string" && !tags.includes(p.tag)) continue;
    if (p.exclude_observe !== false && tags.some((t) => OBSERVE.includes(t))) continue;
    const ok = r.success === true || r.status === "success" || r.status === "completed";
    if (p.metric === "success_count" && !ok) continue;
    const key = typeof r.activity_id === "string" ? r.activity_id : "(none)";
    const dt = tags.find((t) => t.startsWith(`${String(p.group_by_tag)}:`));
    const tag_value = dt ? dt.slice(String(p.group_by_tag).length + 1) : null;
    const g = JSON.stringify([key, tag_value]);
    const cur = groups.get(g) ?? { key, tag_value, value: 0 };
    cur.value++;
    groups.set(g, cur);
  }
  const rows = [...groups.values()];
  return {
    shape: "traceAggregateReport", metric: p.metric, group_by: "activity_id", rows, total_groups: rows.length,
    truncated: false, empty: rows.length === 0, measured: true, matched_total: rows.reduce((s, r) => s + r.value, 0),
    ...(echo ? { tag: p.tag, group_by_tag: p.group_by_tag, success_rule: p.success_rule } : {}),
  };
}

/**
 * The trace store: the list route (newest first, limit ≤ 100, honours offset, `pageMs` per page whatever the offset:
 * it rebuilds the whole window each time) and the resolve route serving traceAggregateReport (`aggMs` per call).
 * The double honours `offset` so a reader that paged would be seen paging (noOffset below).
 */
function serve(window: Row[], opts: { pageMs?: number; aggMs?: number; echo?: boolean; aggregateWindow?: Row[] } = {}) {
  const calls = { list: [] as string[], aggregate: [] as Record<string, unknown>[] };
  const advance = (ms = 0) => { if (ms) setSystemTime(new Date(Date.now() + ms)); };
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    await Promise.resolve();
    if (u.pathname === "/v2/impulses/resolve") {
      const pointer = (JSON.parse(String(init?.body)) as { impulse: { pointer: Record<string, unknown> } }).impulse.pointer;
      calls.aggregate.push(pointer);
      advance(opts.aggMs);
      const report = aggregate(opts.aggregateWindow ?? window, pointer, opts.echo ?? true);
      return new Response(JSON.stringify({ success: true, content: JSON.stringify(report) }), { status: 200 });
    }
    calls.list.push(String(url));
    advance(opts.pageMs);
    const limit = Math.min(Number(u.searchParams.get("limit") ?? "50"), 100);
    const offset = Number(u.searchParams.get("offset") ?? "0");
    return new Response(JSON.stringify({ executions: window.slice(offset, offset + limit), total: -1, limit, offset }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}
const noOffset = (calls: { list: string[] }) => calls.list.every((u) => !u.includes("offset="));
function capture(which: "error" | "log"): string[] {
  const out: string[] = [];
  console[which] = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  return out;
}

// The two fetchers' loops, as index.ts runs them over readTraceWindow's rows (index.ts cannot be imported).
type Cell = { alpha: number; beta: number; samples: number };
const tid = (t: Row) => (typeof t.activity_id === "string" ? t.activity_id : undefined)
  ?? (typeof t.template_id === "string" ? t.template_id : undefined)
  ?? (typeof t.selected_template_id === "string" ? t.selected_template_id : undefined);
const won = (t: Row) => t.status === "success" || t.status === "completed" || t.success === true;
function bump<K>(cells: Map<K, Cell>, k: K, success: boolean) {
  let c = cells.get(k);
  if (!c) { c = { alpha: 0, beta: 0, samples: 0 }; cells.set(k, c); }
  if (success) c.alpha += 1; else c.beta += 1;
  c.samples += 1;
}
function signatureCells(arr: Row[], signature: string): Map<number, Cell> {
  const cells = new Map<number, Cell>();
  const sigTag = `state_signature:${signature}`;
  const tplToGoal = new Map<string, number>();
  TEMPLATES.forEach((t, i) => tplToGoal.set(t, i));
  for (const t of arr) {
    const tags = Array.isArray(t.tags) ? (t.tags as string[]) : [];
    if (!tags.includes(sigTag)) continue;
    const id = tid(t);
    if (!id) continue;
    const normalized = id.replace(/^activity:⟨(.+)⟩$/, "$1");
    const goalIdx = tplToGoal.get(normalized) ?? tplToGoal.get(id);
    if (goalIdx === undefined) continue;
    bump(cells, goalIdx, won(t));
  }
  return cells;
}
function dispatcherCells(arr: Row[], signature: string, targetTpl: string | undefined): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  const sigTag = `state_signature:${signature}`;
  for (const t of arr) {
    const tags = Array.isArray(t.tags) ? (t.tags as string[]) : [];
    if (!tags.includes(sigTag)) continue;
    let dispatcher: string | undefined;
    for (const tag of tags) {
      if (tag === "dispatcher_used:goal-host") { dispatcher = "goal-host"; break; }
      if (tag === "dispatcher_used:light-dispatch") { dispatcher = "light-dispatch"; break; }
    }
    if (!dispatcher) continue;
    if (targetTpl) {
      const id = tid(t);
      if (id && !id.includes(targetTpl)) continue;
    }
    bump(cells, dispatcher, won(t));
  }
  return cells;
}
const sorted = <K>(m: Map<K, Cell>) => [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe("the posterior window is counted by the aggregate", () => {
  it("[MUST-FAIL] a 6,000-row window: the aggregate returns it whole, with no list page", async () => {
    setSystemTime(new Date(T0));
    const errs = capture("error");
    const window = fixture(6000);
    const calls = serve(window, { pageMs: 1_200, aggMs: 3_000 });
    nameSignature(SIG);
    const got = await readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature");
    const whole = window.filter((r) => (r.tags as string[]).includes(SIG_TAG) && !isObserve(r)).length;
    expect(got).not.toBeNull();
    expect(got!.length).toBe(whole);
    expect(calls.list.length).toBe(0);
    expect(calls.aggregate.map((p) => p.metric)).toEqual(["count", "success_count"]);
    expect(calls.aggregate[0]).toMatchObject({
      type: "traceAggregateReport", group_by: "activity_id", tag: SIG_TAG, group_by_tag: "dispatcher_used",
      success_rule: "status_or_flag", window_hours: 24, limit: 20000,
    });
    // The default observe exclusion: the parameter is not sent.
    expect("exclude_observe" in calls.aggregate[0]!).toBe(false);
    expect(errs.some((l) => l.includes("truncated") || l.includes("weighing nothing"))).toBe(false);
  });

  it("[CONTROL] the same window, read by the list (no signature named), is one full page and weighs nothing", async () => {
    setSystemTime(new Date(T0));
    const errs = capture("error");
    const calls = serve(fixture(6000), { pageMs: 1_200, aggMs: 3_000 });
    expect(await readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature")).toBeNull();
    expect(calls.aggregate.length).toBe(0);
    expect(calls.list).toEqual([`${EP}/v2/activities/execution-traces?limit=100&since=${SINCE}`]);
    expect(errs.some((l) => l.includes("trace window truncated") && l.includes("weighing nothing"))).toBe(true);
  });

  it("[EQUIVALENCE] both fetchers' cells from the aggregate equal the old list read's over non-observe traces", async () => {
    const window = fixture(99);
    const observeCounted = window.filter((r) => (r.tags as string[]).includes(SIG_TAG) && isObserve(r)).length;
    // The old read: the list, one short page, so the whole window (no signature named).
    serve(window);
    const oldAll = await readTraceWindow(EP, {}, SINCE, "old");
    expect(oldAll?.length).toBe(window.length);
    const oldNonObserve = oldAll!.filter((r) => !isObserve(r));
    // The new read: the aggregate for the signature.
    serve(window);
    nameSignature(SIG);
    const agg = await readTraceWindow(EP, {}, SINCE, "new");
    expect(agg).not.toBeNull();
    expect(sorted(signatureCells(agg!, SIG))).toEqual(sorted(signatureCells(oldNonObserve, SIG)));
    for (const target of [undefined, ...TEMPLATES]) {
      expect(sorted(dispatcherCells(agg!, SIG, target))).toEqual(sorted(dispatcherCells(oldNonObserve, SIG, target)));
    }
    // The one named difference: the observe traces the old read counted into the signature's cells.
    const samples = (m: Map<unknown, Cell>) => [...m.values()].reduce((s, c) => s + c.samples, 0);
    const oldCounted = samples(signatureCells(oldAll!, SIG)) - samples(signatureCells(oldNonObserve, SIG));
    expect(observeCounted).toBeGreaterThan(0);
    expect(oldCounted).toBeGreaterThan(0);
    expect(samples(signatureCells(oldAll!, SIG))).toBe(samples(signatureCells(agg!, SIG)) + oldCounted);
    const oldDispatcherCounted = samples(dispatcherCells(oldAll!, SIG, undefined)) - samples(dispatcherCells(oldNonObserve, SIG, undefined));
    expect(samples(dispatcherCells(oldAll!, SIG, undefined))).toBe(samples(dispatcherCells(agg!, SIG, undefined)) + oldDispatcherCounted);
    console.log(`[equivalence] fixture: ${observeCounted} observe traces at the signature; the old signature cells counted ` +
      `${oldCounted} of them, the old dispatcher cells (no template filter) ${oldDispatcherCounted}`);
  });

  it("[FIX] the window asked for is the callers' 24 h even when the clock has moved since they computed `since`", async () => {
    setSystemTime(new Date(T0 + 7));
    const calls = serve(fixture(50));
    nameSignature(SIG);
    expect(await readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature")).not.toBeNull();
    expect(calls.aggregate.map((p) => p.window_hours)).toEqual([24, 24]);
  });

  it("[FIX] a producer that does not serve the tag filter is unavailable, and the read takes the one list page", async () => {
    setSystemTime(new Date(T0));
    const errs = capture("error");
    const calls = serve(fixture(60), { echo: false });
    nameSignature(SIG);
    const got = await readTraceWindow(EP, {}, SINCE, "fetchDispatcherPosteriors");
    expect(got?.length).toBe(60);
    expect(calls.aggregate.length).toBe(1);
    expect(calls.list).toEqual([`${EP}/v2/activities/execution-traces?limit=100&since=${SINCE}`]);
    expect(errs.some((l) => l.includes("fetchDispatcherPosteriors: trace window: aggregate producer lacks tag/success_rule echo: aa extension not live, using list")
      && l.includes("does not serve tag"))).toBe(true);
    // Its own line, never read as a generic unavailable aggregate.
    expect(errs.some((l) => l.includes("exceeded") || l.includes("traceAggregateReport unavailable"))).toBe(false);
  });

  it("[FIX] the fallback is one page: a full page weighs nothing, and no list request carries offset", async () => {
    setSystemTime(new Date(T0));
    const errs = capture("error");
    const calls = serve(fixture(250), { echo: false });
    nameSignature(SIG);
    expect(await readTraceWindow(EP, {}, SINCE, "fetchDispatcherPosteriors")).toBeNull();
    expect(calls.list.length).toBe(1);
    expect(noOffset(calls)).toBe(true);
    expect(errs.some((l) => l.includes("fetchDispatcherPosteriors: trace window truncated") && l.includes("weighing nothing"))).toBe(true);
  });

  it("[MUST-FAIL] an aggregate measured but empty while the list has traces is a scope mismatch: loud, and the list is read", async () => {
    setSystemTime(new Date(T0));
    const errs = capture("error");
    const window = fixture(60);
    const calls = serve(window, { aggregateWindow: [] });
    nameSignature(SIG);
    const got = await readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature");
    expect(calls.aggregate.length).toBe(2);
    expect(calls.list).toEqual([
      `${EP}/v2/activities/execution-traces?limit=1&since=${SINCE}`,
      `${EP}/v2/activities/execution-traces?limit=100&since=${SINCE}`,
    ]);
    expect(got?.length).toBe(60);
    expect(errs.filter((l) => l.includes("fetchPosteriorsForSignature: trace window: aggregate empty while list has traces: scope mismatch")).length).toBe(1);
  });

  it("[CONTROL] an aggregate and a list both empty: the empty window is weighed as empty, no fallback, no loud line", async () => {
    setSystemTime(new Date(T0));
    const errs = capture("error");
    const calls = serve([]);
    nameSignature(SIG);
    expect(await readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature")).toEqual([]);
    expect(calls.aggregate.length).toBe(2);
    expect(calls.list.length).toBe(1); // the one-row probe only
    expect(errs.some((l) => l.includes("scope mismatch") || l.includes("weighing nothing"))).toBe(false);
  });
});

describe("both posterior fetchers name the signature they weigh", () => {
  const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  for (const name of ["fetchPosteriorsForSignature", "fetchDispatcherPosteriors"]) {
    it(`[MUST-FAIL] ${name} calls traceWindowSignature(signature) right before readTraceWindow`, () => {
      const call = `const arr = await readTraceWindow(ACTIVITY_API_ENDPOINT, authHeaders(), since, "${name}");`;
      const at = SRC.indexOf(call);
      expect(at).toBeGreaterThan(0);
      expect(SRC.slice(Math.max(0, at - 200), at)).toMatch(/traceWindowSignature\(signature\);\s*$/);
    });
  }
});
