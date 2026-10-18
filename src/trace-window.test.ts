// A TRUNCATED TRACE WINDOW WEIGHS NOTHING.
//
// The posterior fetchers asked for limit=500 over 24h; the route serves at most 100 rows, so a full page is the newest
// slice of the window, not the window.
//   [MUST-FAIL] a full 100-row page yields no rows, logs "trace window truncated", and is counted.
//   [CONTROL]   a short page is returned whole (the fetchers compute weights from it as before); the request asks for
//               the route's real page size; a non-OK status yields no rows.
import { afterEach, describe, expect, it } from "bun:test";
import { TRACE_LIST_PAGE, readTraceWindow, truncatedWindowCount } from "./trace-window";

const realFetch = globalThis.fetch;
const realError = console.error;
afterEach(() => { globalThis.fetch = realFetch; console.error = realError; });
let seenUrl = "";
function serve(status: number, body: unknown) {
  globalThis.fetch = (async (url: string | URL) => {
    seenUrl = String(url);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ execution_id: `e${i}`, tags: ["state_signature:s1"], activity_id: "t", success: true }));
const SINCE = Date.parse("2030-05-01T00:00:00Z");

describe("readTraceWindow refuses a truncated window", () => {
  it("[MUST-FAIL] a full page yields no rows, logs the truncation, and counts it", async () => {
    const logged: string[] = [];
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    const before = truncatedWindowCount();
    serve(200, { executions: rows(100), total: -1, limit: 100, offset: 0 });
    expect(await readTraceWindow("http://activity-api.test", {}, SINCE, "fetchPosteriorsForSignature")).toBeNull();
    expect(truncatedWindowCount()).toBe(before + 1);
    expect(logged.some((l) => l.includes("fetchPosteriorsForSignature: trace window truncated") && l.includes("goal selection round-robin")
      && l.includes("signature-continuity boost off") && l.includes("dispatcher choice a uniform random draw"))).toBe(true);
  });

  it("[CONTROL] a short page is the whole window and is returned", async () => {
    serve(200, { executions: rows(37), total: -1, limit: 100, offset: 0 });
    const got = await readTraceWindow("http://activity-api.test", {}, SINCE, "fetchDispatcherPosteriors");
    expect(got?.length).toBe(37);
    expect(seenUrl).toBe(`http://activity-api.test/v2/activities/execution-traces?limit=${TRACE_LIST_PAGE}&since=${SINCE}`);
    expect(TRACE_LIST_PAGE).toBe(100);
  });

  it("[CONTROL] a non-OK status yields no rows", async () => {
    serve(503, { error: "unavailable" });
    expect(await readTraceWindow("http://activity-api.test", {}, SINCE, "x")).toBeNull();
  });
});
