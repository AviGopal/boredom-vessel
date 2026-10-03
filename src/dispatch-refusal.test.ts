// A goal-host refusing work during a graceful restart (HTTP 503 with
// draining/quiesced/retryable in the body) is RETRYABLE. It says nothing about
// the work, so neither grader may score it as a failure. These tests drive both
// graders' decision functions through a stubbed fetch.
import { afterEach, describe, expect, test } from "bun:test";
import {
  isRetryableRefusal,
  settleGapGoalPost,
  settleOneShotDispatch,
} from "./dispatch-refusal";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    })) as unknown as typeof fetch;
}

async function post(): Promise<Response> {
  return fetch("http://goal-host.invalid/run-goal", { method: "POST", body: "{}" });
}

const QUIESCED = { error: "quiesced", quiesced: true, retryable: true };
const DRAINING = { error: "goal-host draining for restart — retry", draining: true };
const BOOM = { error: "boom" };

describe("isRetryableRefusal", () => {
  test("503 + any refusal flag is retryable", () => {
    expect(isRetryableRefusal({ status: 503 }, QUIESCED)).toBe(true);
    expect(isRetryableRefusal({ status: 503 }, DRAINING)).toBe(true);
    expect(isRetryableRefusal({ status: 503 }, { retryable: true })).toBe(true);
  });
  test("a flag without 503, or 503 without a flag, is not", () => {
    expect(isRetryableRefusal({ status: 500 }, QUIESCED)).toBe(false);
    expect(isRetryableRefusal({ status: 503 }, BOOM)).toBe(false);
    expect(isRetryableRefusal({ status: 503 }, null)).toBe(false);
    expect(isRetryableRefusal({ status: 503 }, { draining: "true" })).toBe(false);
  });
});

describe("grader #1 — gap-goal supply (dispatchByTemplateId)", () => {
  function harness() {
    const calls: Array<[string, boolean]> = [];
    const failures = new Map<string, number>();
    const logs: string[] = [];
    const recordOutcome = (id: string, ok: boolean) => {
      calls.push([id, ok]);
      if (!ok) failures.set(id, (failures.get(id) ?? 0) + 1);
    };
    return { calls, failures, logs, deps: { recordOutcome, log: (l: string) => logs.push(l) } };
  }

  test("(a) 503 {quiesced, retryable} is not graded and leaves failure counters unchanged", async () => {
    stubFetch(503, QUIESCED, { "Retry-After": "30" });
    const h = harness();
    const verdict = await settleGapGoalPost(await post(), "gap-goal:x", h.deps);
    expect(verdict).toBe("retryable");
    expect(h.calls).toEqual([]);
    expect(h.failures.size).toBe(0);
    expect(h.logs).toEqual([
      "[gap-goal-supply] goal-host refused (retryable: quiesced) — not graded, retry next tick",
    ]);
  });

  test("(b) 503 {draining} is not graded and leaves failure counters unchanged", async () => {
    stubFetch(503, DRAINING);
    const h = harness();
    const verdict = await settleGapGoalPost(await post(), "gap-goal:x", h.deps);
    expect(verdict).toBe("retryable");
    expect(h.calls).toEqual([]);
    expect(h.failures.size).toBe(0);
    expect(h.logs).toEqual([
      "[gap-goal-supply] goal-host refused (retryable: draining) — not graded, retry next tick",
    ]);
  });

  test("(c) control: 500 {error:boom} is still graded as a failure", async () => {
    stubFetch(500, BOOM);
    const h = harness();
    const verdict = await settleGapGoalPost(await post(), "gap-goal:x", h.deps);
    expect(verdict).toBe("failure");
    expect(h.calls).toEqual([["gap-goal:x", false]]);
    expect(h.failures.get("gap-goal:x")).toBe(1);
  });

  test("202 is ok and the body stays readable for the caller", async () => {
    stubFetch(202, { dispatchId: "d-1" });
    const h = harness();
    const res = await post();
    expect(await settleGapGoalPost(res, "gap-goal:x", h.deps)).toBe("ok");
    expect(h.calls).toEqual([]);
    expect(((await res.json()) as { dispatchId: string }).dispatchId).toBe("d-1");
  });
});

describe("grader #2 — one-shot main() dispatch", () => {
  function harness() {
    let failures = 0;
    const logs: string[] = [];
    return {
      get failures() { return failures; },
      logs,
      deps: {
        onFailure: async () => { failures++; },
        log: (l: string) => logs.push(l),
        logError: (l: string) => logs.push(l),
      },
    };
  }

  test("(d) 503 retryable writes no semantic_reject lesson and does not exit 1", async () => {
    for (const body of [QUIESCED, DRAINING]) {
      stubFetch(503, body);
      const h = harness();
      const out = await settleOneShotDispatch(await post(), "goal-host", h.deps);
      expect(out.verdict).toBe("retryable");
      expect(h.failures).toBe(0);
      expect(out.exitCode).toBe(0);
      expect(h.logs.some((l) => l.includes("not dispatched: goal-host restarting"))).toBe(true);
    }
  });

  test("control: 500 still writes the semantic_reject lesson and exits 1", async () => {
    stubFetch(500, BOOM);
    const h = harness();
    const out = await settleOneShotDispatch(await post(), "goal-host", h.deps);
    expect(out.verdict).toBe("failure");
    expect(h.failures).toBe(1);
    expect(out.exitCode).toBe(1);
    expect(h.logs).toEqual([`[boredom-vessel] goal-host HTTP 500: ${JSON.stringify(BOOM)}`]);
  });

  test("207 is ok and returns no exit code", async () => {
    stubFetch(207, { status: "failure" });
    const h = harness();
    const res = await post();
    const out = await settleOneShotDispatch(res, "light-dispatch", h.deps);
    expect(out).toEqual({ verdict: "ok", exitCode: null });
    expect(h.failures).toBe(0);
    expect(((await res.json()) as { status: string }).status).toBe("failure");
  });
});
