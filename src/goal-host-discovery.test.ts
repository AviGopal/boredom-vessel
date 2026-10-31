import { describe, it, expect, afterEach } from "bun:test";
import { generateGapGoalCandidates } from "./goal-generation";
import * as envelope from "./spend-envelope";

// GOAL-HOST IS RESOLVED VIA DISCOVERY, NEVER PINNED. boredom read goal-host from `GOAL_HOST_ENDPOINT` /
// `GOAL_HOST_VESSEL_ENDPOINT ?? "http://127.0.0.1:8210"`, so on a node whose goal-host is not on that loopback port
// every dispatch, poll and in-flight read went to the pinned address. goal-host is now this node's own
// goalDispatchAsync producer as discovery names it (spend-envelope discoverOwnResolveUrls), and nothing falls back.
//
//   [MUST-FAIL] (existing export generateGapGoalCandidates; the goal-host resolver is built here on the EXISTING
//               discoverOwnResolveUrls) goal-host discovered on another port: the in-flight read goes there.
//   [CONTROL]   goal-host discovered on its usual loopback port: the same request as before (route, method, body).
//   [MUST-FAIL] discoverGoalHostBase names the discovered origin; discovery unreachable: a named error.
//   [MUST-FAIL] discovery unreachable: no request to any goal-host address (the old default included), and the
//               supply says why it read no in-flight goals.
// Synthetic fixtures; fetch is stubbed by URL and body, nothing leaves the process.

const DISCOVERY = "http://discovery.test";
const deps = { discoveryEndpoint: DISCOVERY, apiKey: "test-key" };
type Call = { url: string; method: string; body: unknown };
const realFetch = globalThis.fetch;
const realWarn = console.warn;
afterEach(() => { globalThis.fetch = realFetch; console.warn = realWarn; });

/** discovery answers goalDispatchAsync with goal-host at `origin` (null: discovery unreachable); records the rest. */
function serve(origin: string | null): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (u.startsWith(DISCOVERY)) {
      if (origin === null) throw new TypeError("fetch failed: discovery unreachable (synthetic)");
      const vessels = body?.pointer?.shape === "goalDispatchAsync" ? [{ endpoint: origin, resolve_endpoint: "/resolve", origin: "local" }] : [];
      return { ok: true, status: 200, json: async () => ({ content: { vessels } }) };
    }
    calls.push({ url: u, method: String(init?.method ?? "GET"), body });
    if (u.endsWith("/v2/impulses/resolve")) return { ok: true, status: 200, json: async () => ({ body: { gaps: [] } }) };
    return { ok: true, status: 200, json: async () => ({ body: { dispatches: [] } }) };
  }) as unknown as typeof fetch;
  return calls;
}
/** The goal-host base on the EXISTING discovery client (present at the parent), so the first MF needs no new export. */
const viaExistingClient = async (): Promise<string> => {
  const p = await envelope.discoverOwnResolveUrls("goalDispatchAsync", deps);
  if (!p.ok || !p.urls[0]) throw new Error("goal-host undiscovered (test resolver)");
  return new URL(p.urls[0]).origin;
};
/** The goal-host reads: a /resolve that is not dev-vessel's /v2/impulses/resolve (concept-db's /concepts/search is not one). */
const goalHostCalls = (calls: Call[]): Call[] => calls.filter((c) => c.url.endsWith("/resolve") && !c.url.endsWith("/v2/impulses/resolve"));

describe("boredom resolves goal-host through discovery", () => {
  it("[MUST-FAIL] goal-host discovered on another port: the in-flight read goes to the discovered origin", async () => {
    const calls = serve("http://127.0.0.1:18299");
    await (generateGapGoalCandidates as (...a: unknown[]) => Promise<unknown>)("http://activity-api.test", "test-key", viaExistingClient);
    expect(goalHostCalls(calls).map((c) => c.url)).toEqual(["http://127.0.0.1:18299/resolve"]);
  });

  it("[CONTROL] goal-host discovered on its usual loopback port: the same request as before", async () => {
    const calls = serve("http://127.0.0.1:8210");
    await (generateGapGoalCandidates as (...a: unknown[]) => Promise<unknown>)("http://activity-api.test", "test-key", viaExistingClient);
    const gh = goalHostCalls(calls);
    // the request itself (route, method, body) is the one boredom always sent; only where it goes is discovery's
    expect(gh.map((c) => new URL(c.url).pathname)).toEqual(["/resolve"]);
    expect(gh[0]!.method).toBe("POST");
    expect(gh[0]!.body).toEqual({ impulse: { pointer: { type: "activeDispatches" } } });
  });

  it("[MUST-FAIL] discoverGoalHostBase names the discovered origin, and a named error when discovery is unreachable", async () => {
    const discover = (envelope as { discoverGoalHostBase?: (d: typeof deps) => Promise<string> }).discoverGoalHostBase;
    expect(typeof discover).toBe("function");
    serve("http://127.0.0.1:18299");
    expect(await discover!(deps)).toBe("http://127.0.0.1:18299");
    serve(null);
    const err = await discover!(deps).then(() => null, (e: Error) => e);
    expect(err?.name).toBe("GoalHostUndiscovered");
    expect(err?.message).toMatch(/^goal-host undiscovered: /);
  });

  it("[MUST-FAIL] discovery unreachable: no request to any goal-host address, and the supply says why", async () => {
    const discover = (envelope as { discoverGoalHostBase?: (d: typeof deps) => Promise<string> }).discoverGoalHostBase;
    const warned: string[] = [];
    console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
    const calls = serve(null);
    await (generateGapGoalCandidates as (...a: unknown[]) => Promise<unknown>)("http://activity-api.test", "test-key", discover ? () => discover(deps) : undefined);
    expect(goalHostCalls(calls)).toEqual([]);
    expect(warned.some((w) => w.includes("in-flight goals unread: goal-host undiscovered: "))).toBe(true);
  });
});
