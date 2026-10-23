// ONE WINDOW READ PER TICK, INSIDE A DEADLINE.
//
// Deep offsets cost the trace list route a scan that grows with the offset, and both posterior fetchers read the same
// 24h window each tick. readTraceWindow shares one costly read among callers within TRACE_WINDOW_SHARE_MS, and bounds
// the whole paged read by a wall-clock deadline.
//   [MUST-FAIL] two callers in one tick (in sequence, or concurrently) cause one paged read, and both get the window;
//               a read past the deadline declines as exceeded, logged and counted; a complete read logs its page count.
//   [CONTROL]   a one-page window is read afresh by each caller (one fetch each, as before); a caller after the share
//               span reads afresh; a different window start reads afresh.
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
// A namespace import, so the file loads at a parent without the new exports and fails on behaviour.
import * as tw from "./trace-window";
const { readTraceWindow, truncatedWindowCount } = tw;
const reset = () => (tw as { resetTraceWindowShare?: () => void }).resetTraceWindowShare?.();
/** The values the fix declares; the cases below assert the module agrees. */
const SHARE_MS = 30_000;
const DEADLINE_MS = 15_000;

const realFetch = globalThis.fetch;
const realError = console.error;
const realLog = console.log;
afterEach(() => {
  globalThis.fetch = realFetch; console.error = realError; console.log = realLog;
  setSystemTime();
  reset();
});

const EP = "http://activity-api.test";
const SIG = "state_signature:s1";
const T0 = Date.parse("2030-05-02T12:00:00Z");
const SINCE = T0 - 24 * 3600 * 1000;
type Row = Record<string, unknown>;
const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ execution_id: `e${i}`, tags: [SIG], activity_id: "t", success: true }));

/** A list route over `window` (newest first, limit ≤ 100, honours offset); `tickMs` advances the clock per fetch. */
function serveWindow(window: Row[], tickMs = 0) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    calls.push(String(url));
    if (tickMs) setSystemTime(new Date(Date.now() + tickMs));
    await Promise.resolve();
    const limit = Math.min(Number(u.searchParams.get("limit") ?? "50"), 100);
    const offset = Number(u.searchParams.get("offset") ?? "0");
    return new Response(JSON.stringify({ executions: window.slice(offset, offset + limit), total: -1, limit, offset }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}
function capture(which: "error" | "log"): string[] {
  const out: string[] = [];
  console[which] = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  return out;
}

describe("the posterior fetchers share one window read per tick", () => {
  it("[MUST-FAIL] two callers in sequence within a tick cause one paged read, and both get the window", async () => {
    setSystemTime(new Date(T0));
    const logs = capture("log");
    const calls = serveWindow(rows(250));
    const a = await readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature");
    setSystemTime(new Date(T0 + 400));
    const b = await readTraceWindow(EP, {}, SINCE + 400, "fetchDispatcherPosteriors");
    expect(a?.length).toBe(250);
    expect(b?.length).toBe(250);
    expect(calls.length).toBe(3);
    expect(logs.filter((l) => l.includes("trace window read whole — 250 rows in 3 page(s)")).length).toBe(1);
    expect((tw as Record<string, unknown>).TRACE_WINDOW_SHARE_MS).toBe(SHARE_MS);
  });

  it("[MUST-FAIL] two concurrent callers share the read in flight", async () => {
    setSystemTime(new Date(T0));
    const calls = serveWindow(rows(250));
    const [a, b] = await Promise.all([
      readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature"),
      readTraceWindow(EP, {}, SINCE + 5, "fetchDispatcherPosteriors"),
    ]);
    expect(a?.length).toBe(250);
    expect(b?.length).toBe(250);
    expect(calls.length).toBe(3);
  });

  it("[MUST-FAIL] a read past the deadline declines as exceeded, logged and counted, and is shared as declined", async () => {
    setSystemTime(new Date(T0));
    const errs = capture("error");
    const before = truncatedWindowCount();
    const calls = serveWindow(rows(1000), 6_000); // each page takes 6 s: the budget is spent after page 3
    expect(await readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature")).toBeNull();
    expect(calls.length).toBe(3);
    expect(truncatedWindowCount()).toBe(before + 1);
    expect(errs.some((l) => l.includes(`read exceeded ${DEADLINE_MS / 1000} s before page 4`) && l.includes("weighing nothing"))).toBe(true);
    expect((tw as Record<string, unknown>).TRACE_WINDOW_DEADLINE_MS).toBe(DEADLINE_MS);
    // The dispatcher fetcher in the same tick does not re-run the read: it declines with the shared reason.
    expect(await readTraceWindow(EP, {}, SINCE + 100, "fetchDispatcherPosteriors")).toBeNull();
    expect(calls.length).toBe(3);
    expect(truncatedWindowCount()).toBe(before + 2);
    expect(errs.some((l) => l.includes("fetchDispatcherPosteriors: trace window truncated") && l.includes("read exceeded"))).toBe(true);
  });

  it("[CONTROL] a one-page window is one fetch per caller, as before", async () => {
    setSystemTime(new Date(T0));
    const calls = serveWindow(rows(40));
    expect((await readTraceWindow(EP, {}, SINCE, "fetchPosteriorsForSignature"))?.length).toBe(40);
    expect((await readTraceWindow(EP, {}, SINCE + 10, "fetchDispatcherPosteriors"))?.length).toBe(40);
    expect(calls.length).toBe(2);
  });

  it("[CONTROL] a caller after the share span, or with another window start, reads afresh", async () => {
    setSystemTime(new Date(T0));
    const calls = serveWindow(rows(250));
    await readTraceWindow(EP, {}, SINCE, "a");
    setSystemTime(new Date(T0 + SHARE_MS + 1_000));
    expect((await readTraceWindow(EP, {}, SINCE + SHARE_MS + 1_000, "b"))?.length).toBe(250);
    expect((await readTraceWindow(EP, {}, SINCE - 10 * 60_000, "c"))?.length).toBe(250);
    expect(calls.length).toBe(9);
  });
});
