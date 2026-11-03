import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as st from "./selection-traps";
import * as gg from "./goal-generation";

// A GAP-GOAL ARM IS FORGIVEN BY ITS ROW CHANGING, NOT BY THE CLOCK (boredomSelectionPolicy.gap_goal_forgive).
// A `gap-goal:<row>` arm that failed its investigation came back about hourly: the one-hour outcome TTL emptied its
// mean and the cold window wiped its failure streak ("cold-recovered 8→0"), so the same unchanged row was re-picked as
// if new. Under "on_row_change" the arm's memory belongs to the row's input fingerprint S (row-state.ts): same S → no TTL
// prune and no cold-window recovery; different S → the arm is reset and earns a fresh try. The DEFAULT (no field) is
// "cold_window", today's behaviour byte for byte. The outcome TTL moves into the same row as outcome_ttl_ms.
//   - MUST-FAIL: under on_row_change, an arm with 3 failures on S still scores fail×3 two hours later (today it is
//     cold-recovered 3→0 and pruned to picks=0);
//   - MUST-FAIL: under on_row_change, a different S resets the arm (cold, streak 0);
//   - MUST-FAIL: the supply carries each gap goal's S, and every reservation and grade line logs S= on both values;
//   - MUST-FAIL: S survives the momentum snapshot's persist/reload round trip;
//   - CONTROL: under the default the selector's scores, reasons and kept outcomes equal the parent commit's
//     (src/fixtures/arm-memory-cold-window-golden.json, generated from the parent's scoreTemplate and one-hour prune);
//   - CONTROL: the new fields are validated and leave the trap and gate fields of the same row untouched.

const NOW = Date.parse("2030-05-01T00:00:00Z");
const H = 3_600_000, M = 60_000;
const SA = "a".repeat(64), SB = "b".repeat(64);
const ON = { gap_goal_forgive: "on_row_change", outcome_ttl_ms: H } as const;
const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

/** The seam this change adds, asserted present (at the parent it is absent, so these cases are red by assertion). */
function seam() {
  for (const k of ["gapGoalForgiveness", "trapPolicyForArm", "pruneOutcomesByTtl", "parseArmMemoryPolicy", "restoreRowStates"] as const) {
    expect(typeof (st as Record<string, unknown>)[k]).toBe("function");
  }
  expect(typeof (st as Record<string, unknown>)["DEFAULT_ARM_MEMORY_POLICY"]).toBe("object");
  return st as unknown as {
    gapGoalForgiveness: (id: string, cur: string | undefined, last: string | undefined, p: unknown) => "clock" | "hold" | "reset";
    trapPolicyForArm: (f: string, p: st.SelectionTrapPolicy) => st.SelectionTrapPolicy;
    pruneOutcomesByTtl: (o: Array<{ at: number }>, now: number, ttl: number, f: string) => void;
    parseArmMemoryPolicy: (b: unknown) => { ok: boolean; policy: { gap_goal_forgive: string; outcome_ttl_ms: number }; why?: string };
    restoreRowStates: (saved: unknown) => Map<string, string>;
    DEFAULT_ARM_MEMORY_POLICY: { gap_goal_forgive: string; outcome_ttl_ms: number };
  };
}

type Arm = { template_id: string; current_s?: string; last_s?: string; outcomes: Array<{ at: number; reward: number }>; consecutiveFailures: number; lastFailureAt?: number;
  consecutiveIdle: number; costAdj: number; shapeAvail: number; priorityWeight: number; coldCrowd: number; totalPicks: number; explorationBoost: number };
/** The selector's composition (index.ts ucbScoreImpl): forgiveness → TTL prune → scoreTemplate under the arm's trap policy. */
function score(a: Arm, mem: unknown) {
  const s = seam();
  const f = s.gapGoalForgiveness(a.template_id, a.current_s, a.last_s, mem);
  const outcomes = a.outcomes.map((o) => ({ ...o }));
  s.pruneOutcomesByTtl(outcomes, NOW, (mem as { outcome_ttl_ms: number }).outcome_ttl_ms, f);
  const r = st.scoreTemplate({ rewards: outcomes.map((o) => o.reward), totalPicks: a.totalPicks, explorationBoost: a.explorationBoost, costAdj: a.costAdj, shapeAvail: a.shapeAvail,
    priorityWeight: a.priorityWeight, consecutiveIdle: a.consecutiveIdle, consecutiveFailures: a.consecutiveFailures, lastFailureAt: a.lastFailureAt, coldCrowd: a.coldCrowd,
    idleReward: 0.2, now: NOW, costNote: "5000ms" }, s.trapPolicyForArm(f, st.DEFAULT_SELECTION_TRAP_POLICY));
  return { f, kept: outcomes.length, ...r };
}
const failedOnS = (s: string | undefined, current: string | undefined): Arm => ({
  template_id: "gap-goal:fixture-row", current_s: current, last_s: s, outcomes: [0, 1, 2].map((k) => ({ at: NOW - 2 * H - 3 * M + k * M, reward: 0 })),
  consecutiveFailures: 3, lastFailureAt: NOW - 2 * H - M, consecutiveIdle: 3, costAdj: 1, shapeAvail: 1, priorityWeight: 3, coldCrowd: 0, totalPicks: 2000, explorationBoost: 1,
});

describe("on_row_change: a gap-goal arm keeps its evidence while its row is unchanged", () => {
  it("MUST-FAIL an arm with 3 failures on S still scores fail×3 two hours later (no cold recovery, no TTL prune)", () => {
    const r = score(failedOnS(SA, SA), ON);
    expect(r.f).toBe("hold");
    expect(r.kept).toBe(3);
    expect(r.reason).toContain("picks=3");
    expect(r.reason).toContain("fail×3");
    expect(r.reason).not.toContain("cold-recovered");
    expect(r.cold_recovered).toBe(false);
  });
  it("MUST-FAIL the same arm on a different S is reset: the row changed, so it earns a fresh try", () => {
    expect(seam().gapGoalForgiveness("gap-goal:fixture-row", SB, SA, ON)).toBe("reset");
    // The reset (index.ts resetGapGoalArm) clears the outcomes and both streaks and records the new S: a cold arm.
    const body = SRC.slice(SRC.indexOf("function resetGapGoalArm("), SRC.indexOf("function resetGapGoalArm(") + 900);
    for (const k of ["m.outcomes.length = 0", "consecutiveFailureByTemplate.delete(templateId)", "lastFailureAtByTemplate.delete(templateId)", "consecutiveIdleByTemplate.delete(templateId)", "lastRowStateByTemplate.set(templateId, s)", "persistMomentum()"]) expect(body).toContain(k);
    const reset = score({ ...failedOnS(SB, SB), outcomes: [], consecutiveFailures: 0, lastFailureAt: undefined, consecutiveIdle: 0 }, ON);
    expect(reset.reason).toStartWith("ucb=cold picks=0");
    expect(reset.reason).not.toContain("fail×");
    // Both the selector (before any read of the arm's memory) and the grader apply it.
    expect(SRC).toContain('armForgiveness(c.template_id, c.row_state) === "reset") resetGapGoalArm(c.template_id, c.row_state, "at score")');
    expect(SRC).toContain('armForgiveness(templateId, rowState) === "reset") resetGapGoalArm(templateId, rowState, "at grade")');
  });
  it("MUST-FAIL unknown is not unchanged: no stored S, or no S in the current supply, is forgiven by the clock", () => {
    for (const a of [failedOnS(undefined, SA), failedOnS(SA, undefined)]) {
      const r = score(a, ON);
      expect(r.f).toBe("clock");
      expect(r.reason).toContain("cold-recovered 3→0");
    }
  });
  it("MUST-FAIL only gap-goal arms are held; every other arm family keeps the clock rules", () => {
    const tick = { ...failedOnS(SA, SA), template_id: "fixture-tick" };
    const r = score(tick, ON);
    expect(r.f).toBe("clock");
    expect(r.kept).toBe(0);
    expect(r.reason).toContain("cold-recovered 3→0");
  });
});

describe("cold_window (the default): today's behaviour byte for byte", () => {
  const G = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "arm-memory-cold-window-golden.json"), "utf-8")) as { now: number; cases: Array<Arm & { name: string }>; results: Array<Record<string, unknown>> };
  it("CONTROL the golden is the parent's scoreTemplate over the fixture arms (the scoring function is unchanged)", () => {
    expect(G.now).toBe(NOW);
    const results = G.cases.map((k) => {
      const cutoff = NOW - H; const o = k.outcomes.map((x) => ({ ...x })); while (o.length > 0 && o[0]!.at < cutoff) o.shift();
      const r = st.scoreTemplate({ rewards: o.map((x) => x.reward), totalPicks: k.totalPicks, explorationBoost: k.explorationBoost, costAdj: k.costAdj, shapeAvail: k.shapeAvail, priorityWeight: k.priorityWeight,
        consecutiveIdle: k.consecutiveIdle, consecutiveFailures: k.consecutiveFailures, lastFailureAt: k.lastFailureAt, coldCrowd: k.coldCrowd, idleReward: 0.2, now: NOW, costNote: "5000ms" }, st.DEFAULT_SELECTION_TRAP_POLICY);
      return { name: k.name, kept: o.length, score: r.score, reason: r.reason, cold_recovered: r.cold_recovered, idle_cost_decayed: r.idle_cost_decayed };
    });
    expect(JSON.stringify(results)).toBe(JSON.stringify(G.results));
  });
  it("MUST-FAIL the selector's composition under the default policy equals the golden exactly, whatever row states the arms carry", () => {
    const def = seam().DEFAULT_ARM_MEMORY_POLICY;
    expect(def).toEqual({ gap_goal_forgive: "cold_window", outcome_ttl_ms: H });
    const results = G.cases.map((k) => { const r = score(k, def); expect(r.f).toBe("clock"); return { name: k.name, kept: r.kept, score: r.score, reason: r.reason, cold_recovered: r.cold_recovered, idle_cost_decayed: r.idle_cost_decayed }; });
    expect(JSON.stringify(results)).toBe(JSON.stringify(G.results));
    // ...and the trap policy object passed to scoreTemplate is the caller's own (not a copy) under "clock".
    expect(seam().trapPolicyForArm("clock", st.DEFAULT_SELECTION_TRAP_POLICY)).toBe(st.DEFAULT_SELECTION_TRAP_POLICY);
  });
  it("MUST-FAIL an absent field, or an absent row, is the default; on_row_change is opt-in", () => {
    const p = seam().parseArmMemoryPolicy;
    expect(p(null)).toEqual({ ok: true, policy: { gap_goal_forgive: "cold_window", outcome_ttl_ms: H } });
    expect(p({ idle_cost_decay: 0.5 })).toEqual({ ok: true, policy: { gap_goal_forgive: "cold_window", outcome_ttl_ms: H } });
    expect(p({ gap_goal_forgive: "on_row_change", outcome_ttl_ms: 2 * H }).policy).toEqual({ gap_goal_forgive: "on_row_change", outcome_ttl_ms: 2 * H });
  });
});

describe("the policy fields are validated and leave the rest of the row untouched", () => {
  it("MUST-FAIL any invalid field → ok:false with the defaults kept", () => {
    const p = seam().parseArmMemoryPolicy;
    for (const bad of [{ gap_goal_forgive: "forever" }, { gap_goal_forgive: true }, { outcome_ttl_ms: 1000 }, { outcome_ttl_ms: "1h" }, { outcome_ttl_ms: 8 * 24 * H }, [1], "x"]) {
      const r = p(bad);
      expect(r.ok).toBe(false);
      expect(r.policy).toEqual({ gap_goal_forgive: "cold_window", outcome_ttl_ms: H });
    }
  });
  it("CONTROL the trap and gate fields of a row that also carries the new fields parse exactly as before", () => {
    const body = { idle_cost_decay: 0.8, cold_window_ms: 2 * H, cold_streak_keep: 0.5, external_defer_max_ms: 60_000, gap_goal_forgive: "on_row_change", outcome_ttl_ms: 2 * H };
    expect(st.parseSelectionTrapPolicy(body)).toEqual({ ok: true, policy: { idle_cost_decay: 0.8, cold_window_ms: 2 * H, cold_streak_keep: 0.5 } });
    expect(st.parseExternalGatePolicy(body).ok).toBe(true);
  });
  it("MUST-FAIL the selector reads the fields from the boredomSelectionPolicy row at use time; the TTL constant is gone; no env var", () => {
    const read = SRC.slice(SRC.indexOf('shape: "boredomSelectionPolicy"'), SRC.indexOf('shape: "boredomSelectionPolicy"') + 2200);
    expect(read).toContain("parseArmMemoryPolicy(spData?.body?.impulses?.[0]?.body ?? null)");
    expect(SRC).not.toMatch(/const OUTCOME_TTL_MS\b/);
    expect(SRC).not.toMatch(/const COST_TTL_MS\b/);
    expect(SRC).toContain("function outcomeTtlMs(): number { return armMemoryPolicy.outcome_ttl_ms; }");
    expect(SRC).not.toMatch(/process\.env[^\n]*(GAP_GOAL_FORGIVE|OUTCOME_TTL)/i);
  });
});

describe("S is carried from the supply to every log line and outcome, on both policy values", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  it("MUST-FAIL the gap-goal supply carries each goal's row-input fingerprint S (the shared vectors' supply_row)", async () => {
    const vec = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "row-state-vectors.json"), "utf-8")) as { vectors: Array<{ name: string; row: { id: string }; s: string }> }).vectors.find((v) => v.name === "supply_row")!;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v2/impulses/resolve")) return { ok: true, status: 200, json: async () => ({ body: { gaps: [vec.row] } }) };
      if (u.endsWith("/resolve")) return { ok: true, status: 200, json: async () => ({ body: { dispatches: [] } }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const out = await gg.generateGapGoalCandidates("http://activity-api.test", "test-key");
    expect(out.map((c) => c.gapId)).toEqual([vec.row.id]);
    expect((out[0] as { rowState?: string }).rowState).toBe(vec.s);
  });
  it("MUST-FAIL the reservation line and both grade lines carry S=, and every grade stores the reserved S", () => {
    expect(SRC).toContain('(shapePick.template_id.startsWith("gap-goal:") ? ` S=${shortRowState(shapePick.row_state)}` : "")');
    expect(SRC).toContain("after ${i + 1} polls S=${shortRowState(reservedS)}");
    expect(SRC).toContain("a deadline is not a verdict. S=${shortRowState(reservedS)}");
    expect(SRC).toContain("recordOutcomeByTemplate(templateId, rec.reached === true, { row_state: reservedS })");
    expect(SRC).toContain("reservedRowStateByTemplate.set(templateId, reservedS)");
    expect(SRC).toContain("m.outcomes.push({ outcome: reward > 0 ? \"success\" : \"failure\", at: Date.now(), reward, ...(rowState ? { row_state: rowState } : {}) });");
    // Recorded whatever the policy says: the S bookkeeping in recordOutcomeByTemplate is not gated on on_row_change.
    expect(SRC).toContain("if (isGapGoal) { if (rowState) lastRowStateByTemplate.set(templateId, rowState); else lastRowStateByTemplate.delete(templateId); }");
  });
  it("MUST-FAIL S survives the momentum snapshot's persist/reload round trip", () => {
    const s = seam();
    expect(SRC).toContain("failures_at: Object.fromEntries(lastFailureAtByTemplate), row_states: Object.fromEntries(lastRowStateByTemplate) });");
    expect(SRC).toContain("savedRowStates = restoreRowStates(saved.row_states);");
    expect(SRC).toContain("for (const [tid, s] of savedRowStates) lastRowStateByTemplate.set(tid, s);");
    // The outcome records keep their row_state through hydration's filter and its demotion copy ({ ...o, reward }).
    expect(SRC).toContain('(o) => o && typeof o.at === "number" && typeof o.reward === "number",');
    expect(SRC).toContain("...o,\n          reward: Math.min(o.reward, MOMENTUM_DEMOTION_FLOOR),");
    const live = new Map([["gap-goal:r1", SA], ["gap-goal:r2", SB]]);
    const snapshot = JSON.parse(JSON.stringify({ row_states: Object.fromEntries(live), templates: { "gap-goal:r1": [{ outcome: "failure", at: NOW, reward: 0, row_state: SA }] } })) as { row_states: unknown; templates: Record<string, Array<Record<string, unknown>>> };
    expect([...s.restoreRowStates(snapshot.row_states)]).toEqual([...live]);
    const restored: Record<string, unknown> = { ...snapshot.templates["gap-goal:r1"]![0]!, reward: 0 };
    expect(restored.row_state).toBe(SA);
    // A malformed or older snapshot restores nothing it cannot trust (unknown → the clock).
    expect([...s.restoreRowStates({ "gap-goal:x": "short", "gap-goal:y": 7, "gap-goal:z": SA.toUpperCase() })]).toEqual([]);
    expect([...s.restoreRowStates(undefined)]).toEqual([]);
  });
});
