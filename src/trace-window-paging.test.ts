// THE POSTERIOR TRACE WINDOW IS READ WHOLE, BY OFFSET PAGING.
//
// The route serves at most 100 rows a page, newest first, and honours `offset` (→ START). fetchPosteriorsForSignature
// and fetchDispatcherPosteriors feed every row readTraceWindow returns into their posterior loops
// (trace-window-callsites.test.ts pins that), so a window read whole is a window weighed.
//   [MUST-FAIL] 250 signature-tagged rows served 100 a page come back as 250 rows, with no "weighing nothing" logged and
//               nothing counted as truncated (before the fix: null, logged, counted).
//   [CONTROL]   (green before and after) a 40-row window is one page; an empty window and a window with no signature
//               rows return no matching rows; a window that never ends declines, logged and counted.
//   [FIX]       (the paging's own edges, red before it) a capped read names its cap; a row repeated across a page
//               boundary is read once; a failing page mid-window declines with its reason.
import { afterEach, describe, expect, it } from "bun:test";
// A namespace import, so the file loads at a parent without TRACE_WINDOW_PAGE_CAP and the [MUST-FAIL] fails on behaviour.
import * as tw from "./trace-window";
const { TRACE_LIST_PAGE, readTraceWindow, truncatedWindowCount } = tw;
/** The page cap the fix declares (10,000 rows); the cap control asserts the module agrees. */
const PAGE_CAP = 100;

const realFetch = globalThis.fetch;
const realError = console.error;
afterEach(() => { globalThis.fetch = realFetch; console.error = realError; });

const SIG = "state_signature:s1";
const SINCE = Date.parse("2030-05-01T00:00:00Z");
type Row = Record<string, unknown>;
const rows = (n: number, tags = [SIG], from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ execution_id: `e${from + i}`, tags, activity_id: "t", success: true }));

/** A list route over `window` (newest first): clamps limit to 100 and honours offset, like activity-api's. */
function serveWindow(window: Row[], opts: { failAtOffset?: number; insertAfterFirstPage?: Row[] } = {}) {
  const calls: string[] = [];
  let live = window;
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    calls.push(String(url));
    const limit = Math.min(Number(u.searchParams.get("limit") ?? "50"), 100);
    const offset = Number(u.searchParams.get("offset") ?? "0");
    if (opts.failAtOffset !== undefined && offset === opts.failAtOffset) {
      return new Response(JSON.stringify({ error: "timeout" }), { status: 504 });
    }
    const page = live.slice(offset, offset + limit);
    if (calls.length === 1 && opts.insertAfterFirstPage) live = [...opts.insertAfterFirstPage, ...live];
    return new Response(JSON.stringify({ executions: page, total: -1, limit, offset }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}
function captureErrors(): string[] {
  const logged: string[] = [];
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
  return logged;
}

describe("readTraceWindow reads the whole window by offset paging", () => {
  it("[MUST-FAIL] 250 signature rows over three pages are all returned, and nothing is declined", async () => {
    const logged = captureErrors();
    const before = truncatedWindowCount();
    const calls = serveWindow(rows(250));
    const got = await readTraceWindow("http://activity-api.test", {}, SINCE, "fetchPosteriorsForSignature");
    expect(got).not.toBeNull();
    expect(got!.length).toBe(250);
    expect(new Set(got!.map((r) => r.execution_id)).size).toBe(250);
    expect(got!.filter((r) => (r.tags as string[]).includes(SIG)).length).toBe(250);
    expect(calls.length).toBe(3);
    expect(calls[1]).toContain(`&offset=${TRACE_LIST_PAGE}`);
    expect(calls[2]).toContain(`&offset=${2 * TRACE_LIST_PAGE}`);
    expect(truncatedWindowCount()).toBe(before);
    expect(logged.some((l) => l.includes("weighing nothing"))).toBe(false);
  });

  it("[CONTROL] a 40-row window is one page, read whole", async () => {
    const calls = serveWindow(rows(40));
    const got = await readTraceWindow("http://activity-api.test", {}, SINCE, "fetchDispatcherPosteriors");
    expect(got?.length).toBe(40);
    expect(calls).toEqual([`http://activity-api.test/v2/activities/execution-traces?limit=${TRACE_LIST_PAGE}&since=${SINCE}`]);
  });

  it("[CONTROL] an empty window, or one with no signature rows, yields no matching rows", async () => {
    const before = truncatedWindowCount();
    serveWindow([]);
    expect(await readTraceWindow("http://activity-api.test", {}, SINCE, "x")).toEqual([]);
    serveWindow(rows(30, ["state_signature:other"]));
    const got = await readTraceWindow("http://activity-api.test", {}, SINCE, "x");
    expect(got?.length).toBe(30);
    expect(got!.filter((r) => (r.tags as string[]).includes(SIG)).length).toBe(0);
    expect(truncatedWindowCount()).toBe(before);
  });

  it("[FIX] a row repeated across a page boundary by a new trace is read once", async () => {
    serveWindow(rows(250), { insertAfterFirstPage: rows(1, [SIG], 9000) });
    const got = await readTraceWindow("http://activity-api.test", {}, SINCE, "x");
    // The trace landing after page 1 shifts the offsets by one: e99 repeats on page 2 and is dropped.
    expect(got?.length).toBe(250);
    expect(new Set(got!.map((r) => r.execution_id)).size).toBe(250);
  });

  it("[CONTROL] a window that never ends declines, logged and counted", async () => {
    const logged = captureErrors();
    const before = truncatedWindowCount();
    serveWindow(rows(PAGE_CAP * TRACE_LIST_PAGE + 1));
    expect(await readTraceWindow("http://activity-api.test", {}, SINCE, "fetchPosteriorsForSignature")).toBeNull();
    expect(truncatedWindowCount()).toBe(before + 1);
    expect(logged.some((l) => l.includes("fetchPosteriorsForSignature: trace window truncated") && l.includes("weighing nothing"))).toBe(true);
  });

  it("[FIX] a window past the page cap declines, saying it was capped", async () => {
    const logged = captureErrors();
    const before = truncatedWindowCount();
    expect((tw as Record<string, unknown>).TRACE_WINDOW_PAGE_CAP).toBe(PAGE_CAP);
    const calls = serveWindow(rows(PAGE_CAP * TRACE_LIST_PAGE + 1));
    expect(await readTraceWindow("http://activity-api.test", {}, SINCE, "fetchPosteriorsForSignature")).toBeNull();
    expect(calls.length).toBe(PAGE_CAP);
    expect(truncatedWindowCount()).toBe(before + 1);
    expect(logged.some((l) => l.includes(`read capped at ${PAGE_CAP} pages`) && l.includes("weighing nothing"))).toBe(true);
  });

  it("[FIX] a failing page mid-window declines with its reason, never weighing the pages before it", async () => {
    const logged = captureErrors();
    serveWindow(rows(250), { failAtOffset: 2 * TRACE_LIST_PAGE });
    expect(await readTraceWindow("http://activity-api.test", {}, SINCE, "fetchDispatcherPosteriors")).toBeNull();
    expect(logged.some((l) => l.includes("page 3 (offset 200, 200 rows read) answered HTTP 504") && l.includes("weighing nothing"))).toBe(true);
  });
});
