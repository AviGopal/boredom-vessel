// THE IDLE CHECK READS THE TRACE LIST'S `executions` KEY.
//
// activity-api's GET /v2/activities/execution-traces answers `{ executions: [...] }`; isIdle read `body.traces ?? []`,
// so every page parsed as empty and boredom always thought the system was idle.
//   [MUST-FAIL] {executions:[one non-boredom trace]} → not idle.
//   [CONTROL]   an empty executions list → idle; boredom-tagged rows only → idle; legacy `traces` still read;
//               non-OK HTTP and an unreachable route keep the documented fail-open (idle);
//               a body with no rows array, or one that is not JSON, is NOT idle (loud, conservative).
//   [CALL SITE] index.ts's isIdle delegates to this module (index.ts top-level-awaits main(), so it is pinned by source).
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOREDOM_TAG, isIdle } from "./idle-check";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
let seenUrl = "";
function serve(status: number, body: unknown, raw?: string) {
  globalThis.fetch = (async (url: string | URL) => {
    seenUrl = String(url);
    return new Response(raw ?? JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}
const idle = () => isIdle("http://activity-api.test", {}, 300);

describe("isIdle reads the trace list's executions", () => {
  it("[MUST-FAIL] one non-boredom trace in the window → not idle", async () => {
    serve(200, { executions: [{ execution_id: "e1", tags: ["operator:x"] }], total: 1, limit: 20, offset: 0 });
    expect(await idle()).toBe(false);
    expect(seenUrl).toContain("/v2/activities/execution-traces?limit=20&since=");
  });

  it("[CONTROL] an empty executions list → idle", async () => {
    serve(200, { executions: [], total: 0, limit: 20, offset: 0 });
    expect(await idle()).toBe(true);
  });

  it("[CONTROL] only boredom-initiated traces → idle", async () => {
    serve(200, { executions: [{ execution_id: "e1", tags: [BOREDOM_TAG] }, { execution_id: "e2", tags: ["x", BOREDOM_TAG] }] });
    expect(await idle()).toBe(true);
  });

  it("[CONTROL] legacy forms are still read: `traces` key and a bare array", async () => {
    serve(200, { traces: [{ tags: [] }] });
    expect(await idle()).toBe(false);
    serve(200, [{ tags: [] }]);
    expect(await idle()).toBe(false);
  });

  it("[CONTROL] non-OK HTTP and an unreachable route fall back to idle, as documented", async () => {
    serve(503, { error: "unavailable" });
    expect(await idle()).toBe(true);
    globalThis.fetch = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    expect(await idle()).toBe(true);
  });

  it("[CONTROL] an unexpected body shape is NOT idle", async () => {
    serve(200, { rows: [] });
    expect(await idle()).toBe(false);
    serve(200, undefined, "<html>not json</html>");
    expect(await idle()).toBe(false);
  });

  it("[CALL SITE] index.ts's isIdle delegates to idle-check", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const start = src.indexOf("async function isIdle(): Promise<boolean> {");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toContain("return checkIdle(ACTIVITY_API_ENDPOINT, authHeaders(), IDLE_WINDOW_SECONDS);");
    expect(src).toContain('import { BOREDOM_TAG, isIdle as checkIdle } from "./idle-check";');
  });
});
