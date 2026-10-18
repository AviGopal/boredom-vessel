// externalTracesSince: the count the pool's external-traffic gate reads.
//   [MUST-FAIL] a window whose first page is 100 boredom rows and whose second page holds one external trace counts 1
//               (paged by offset; the newest-page-only read would have counted 0 and called it quiet).
//   [CONTROL]   it stops as soon as `enough` external traces are seen; boredom-only rows count 0; a non-OK status, a body
//               with no rows array, and the page cap reached are ok:false (busy, never quiet).
import { afterEach, describe, expect, it } from "bun:test";
import { BOREDOM_TAG, EXTERNAL_SCAN_PAGE_CAP, externalTracesSince } from "./idle-check";
import { INITIAL_EXTERNAL_GATE_STATE, deferForExternal, externalGateOn } from "./external-gate";
import { parseExternalGatePolicy } from "./selection-traps";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
let urls: string[] = [];
function servePages(pages: unknown[], status = 200) {
  urls = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    const off = Number(new URL(u).searchParams.get("offset") ?? "0");
    const body = pages[Math.floor(off / 100)] ?? { executions: [] };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}
const rows = (n: number, tags: string[]) => Array.from({ length: n }, (_, i) => ({ execution_id: `e${i}`, tags }));
const SINCE = Date.parse("2030-05-01T00:00:00Z");
const count = (enough = 1) => externalTracesSince("http://activity-api.test", {}, SINCE, enough);

describe("externalTracesSince", () => {
  it("[MUST-FAIL] pages by offset past a full page of boredom rows and counts the external one", async () => {
    servePages([{ executions: rows(100, [BOREDOM_TAG]) }, { executions: rows(1, ["operator:x"]) }]);
    expect(await count()).toEqual({ ok: true, external: 1 });
    expect(urls).toEqual([
      `http://activity-api.test/v2/activities/execution-traces?limit=100&since=${SINCE}&offset=0`,
      `http://activity-api.test/v2/activities/execution-traces?limit=100&since=${SINCE}&offset=100`,
    ]);
  });

  it("[CONTROL] stops once `enough` external traces are seen", async () => {
    servePages([{ executions: rows(100, []) }, { executions: rows(100, []) }]);
    expect(await count(5)).toEqual({ ok: true, external: 100 });
    expect(urls.length).toBe(1);
  });

  it("[CONTROL] boredom-only rows count 0 (a short page ends the scan)", async () => {
    servePages([{ executions: rows(40, ["x", BOREDOM_TAG]) }]);
    expect(await count()).toEqual({ ok: true, external: 0 });
  });

  it("[CONTROL] non-OK, a body with no rows array, an unreachable route, and the page cap are ok:false", async () => {
    servePages([{ executions: [] }], 503);
    expect((await count()).ok).toBe(false);
    servePages([{ rows: [] }]);
    expect((await count()).ok).toBe(false);
    globalThis.fetch = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    expect((await count()).ok).toBe(false);
    servePages(Array.from({ length: EXTERNAL_SCAN_PAGE_CAP + 2 }, () => ({ executions: rows(100, [BOREDOM_TAG]) })));
    const capped = await count();
    expect(capped.ok).toBe(false);
    expect(urls.length).toBe(EXTERNAL_SCAN_PAGE_CAP);
  });
});

// A THRESHOLD THE COUNT CAN REACH. The reader sees at most EXTERNAL_SCAN_PAGE_CAP pages; a threshold above that reach
// made every reading unknown (busy), so an enabled gate deferred to its bound on every tick.
//   [MUST-FAIL] a policy asking external_min_traces 2000, against a window of 1500 external rows, never reads as
//               count_unknown (the threshold is out of the reader's reach, so the policy is refused and the gate is off).
//   [CONTROL]   a threshold at the reach is accepted, and 1500 external rows read ok at that threshold.
describe("external_min_traces is bounded by the reader's reach", () => {
  const external1500 = Array.from({ length: 15 }, () => ({ executions: rows(100, ["operator:x"]) }));
  const NOW = SINCE + 60_000;
  async function decide(min: number) {
    const policy = parseExternalGatePolicy({ external_window_ms: 300_000, external_min_traces: min, external_defer_max_ms: 600_000 });
    servePages(external1500);
    const reading = externalGateOn(policy.policy) ? await externalTracesSince("http://activity-api.test", {}, SINCE, policy.policy.external_min_traces) : null;
    return { policy, reading, decision: deferForExternal(policy.policy, reading, INITIAL_EXTERNAL_GATE_STATE, NOW) };
  }

  it("[MUST-FAIL] min 2000 with 1500 external rows does not read as unknown", async () => {
    const { policy, decision } = await decide(2000);
    expect(decision.reason).not.toBe("count_unknown");
    expect(policy.ok).toBe(false);
    expect(decision.reason).toBe("off");
  });

  it("[CONTROL] min at the reach (1000) is accepted and 1500 external rows read ok, so the pool defers on a real count", async () => {
    const { policy, reading, decision } = await decide(EXTERNAL_SCAN_PAGE_CAP * 100);
    expect(policy.ok).toBe(true);
    expect(reading).toEqual({ ok: true, external: 1000 });
    expect(decision.reason).toBe("external_active");
  });
});
