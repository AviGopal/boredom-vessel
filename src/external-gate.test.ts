// THE POOL DEFERS WHILE EXTERNAL WORK IS ACTIVE — BOUNDED, SHAPED, OFF BY DEFAULT.
//
// The pool daemon dispatched on throughput alone; the one-shot isIdle check is never called in daemon mode.
//   [MUST-FAIL] gate on, one external trace in the window → the tick defers, and the defer is counted.
//   [CONTROL]   gate on, only boredom traffic (external 0) → dispatch; a defer older than external_defer_max_ms →
//               dispatch once (bound released, counted) and the clock resets; an unknown count → defer, still bounded;
//               policy absent or external_defer_max_ms 0 → off: no defer whatever the reading.
//   [POLICY]    the gate fields parse from boredomSelectionPolicy with validation; they leave the trap policy untouched.
import { describe, expect, it } from "bun:test";
import { INITIAL_EXTERNAL_GATE_STATE as S0, deferForExternal, externalGateOn } from "./external-gate";
import { DEFAULT_EXTERNAL_GATE_POLICY, EXTERNAL_GATE_OFF, parseExternalGatePolicy, parseSelectionTrapPolicy, DEFAULT_SELECTION_TRAP_POLICY } from "./selection-traps";

const NOW = Date.parse("2030-05-01T00:00:00Z");
const ON = { external_window_ms: 300_000, external_min_traces: 1, external_defer_max_ms: 600_000 };

describe("deferForExternal", () => {
  it("[MUST-FAIL] gate on, one external trace → defer, counted", () => {
    const d = deferForExternal(ON, { ok: true, external: 1 }, S0, NOW);
    expect(d.defer).toBe(true);
    expect(d.reason).toBe("external_active");
    expect(d.state.deferredTicks).toBe(1);
    expect(d.state.deferStartedAt).toBe(NOW);
  });

  it("[CONTROL] only boredom traffic (external 0) → dispatch, and the defer clock resets", () => {
    const d = deferForExternal(ON, { ok: true, external: 0 }, { ...S0, deferStartedAt: NOW - 1000 }, NOW);
    expect(d.defer).toBe(false);
    expect(d.reason).toBe("quiet");
    expect(d.state.deferStartedAt).toBeNull();
  });

  it("[CONTROL] the defer is bounded: past external_defer_max_ms the pool dispatches once and a fresh defer may start", () => {
    let st = deferForExternal(ON, { ok: true, external: 3 }, S0, NOW).state;
    st = deferForExternal(ON, { ok: true, external: 3 }, st, NOW + 599_999).state;
    expect(st.deferredTicks).toBe(2);
    const rel = deferForExternal(ON, { ok: true, external: 3 }, st, NOW + 600_000);
    expect(rel.defer).toBe(false);
    expect(rel.reason).toBe("defer_max_reached");
    expect(rel.state.boundReleases).toBe(1);
    expect(rel.state.deferStartedAt).toBeNull();
    expect(deferForExternal(ON, { ok: true, external: 3 }, rel.state, NOW + 600_001).defer).toBe(true);
  });

  it("[CONTROL] an unknown count is busy, never quiet — and still bounded", () => {
    const d = deferForExternal(ON, { ok: false, why: "HTTP 503" }, S0, NOW);
    expect(d.defer).toBe(true);
    expect(d.reason).toBe("count_unknown");
    expect(deferForExternal(ON, { ok: false, why: "x" }, d.state, NOW + 600_000).defer).toBe(false);
  });

  it("[CONTROL] policy absent or external_defer_max_ms 0 → off: no defer whatever the reading", () => {
    const absent = parseExternalGatePolicy(null).policy;
    for (const p of [absent, DEFAULT_EXTERNAL_GATE_POLICY, EXTERNAL_GATE_OFF, { ...ON, external_defer_max_ms: 0 }]) {
      expect(externalGateOn(p)).toBe(false);
      for (const r of [{ ok: true as const, external: 50 }, { ok: false as const, why: "x" }, null]) {
        const d = deferForExternal(p, r, S0, NOW);
        expect(d.defer).toBe(false);
        expect(d.reason).toBe("off");
        expect(d.state.deferredTicks).toBe(0);
      }
    }
  });
});

describe("parseExternalGatePolicy", () => {
  it("absent → defaults (off); valid fields are read; an invalid gate field → ok:false, defaults (off)", () => {
    expect(parseExternalGatePolicy(null)).toEqual({ ok: true, policy: { ...DEFAULT_EXTERNAL_GATE_POLICY } });
    expect(DEFAULT_EXTERNAL_GATE_POLICY.external_defer_max_ms).toBe(0);
    expect(parseExternalGatePolicy({ ...ON, idle_cost_decay: 0.8 }).policy).toEqual(ON);
    for (const bad of [{ external_window_ms: 5 }, { external_min_traces: 1.5 }, { external_min_traces: 0 }, { external_defer_max_ms: -1 }, { external_defer_max_ms: "10m" }, [1], "x"]) {
      const r = parseExternalGatePolicy(bad);
      expect(r.ok).toBe(false);
      expect(r.policy).toEqual({ ...DEFAULT_EXTERNAL_GATE_POLICY });
    }
  });

  it("the gate fields leave the trap policy exactly as it was", () => {
    expect(parseSelectionTrapPolicy({ ...ON }).policy).toEqual({ ...DEFAULT_SELECTION_TRAP_POLICY });
    expect(parseSelectionTrapPolicy({ ...ON }).ok).toBe(true);
  });
});
