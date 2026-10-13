/**
 * SELECTION-TRAPS RATCHET — two selector traps, pinned by class (any template ids, any costs).
 *
 *   (a) CHEAP IDLE MONOPOLY: templates whose recent outcomes are all idle (IDLE_REWARD) share picks by exploration,
 *       not by cost: over 50 picks, a 40×-costlier idle template is picked at least once (before the fix: never).
 *   (b) COLD FAILURE RECOVERY: a template with a failure streak and no new failure for one cold window becomes
 *       pickable (before the fix: 0.5^10 forever, since the streak resets only on a success that needs a pick).
 * Controls (G6): a template with a genuinely higher mean still beats idle ones whatever their costs; a template that
 * keeps failing while picked keeps its full penalty; a productive (non-idle) record keeps today's value-per-cost
 * ranking; the rules switched off reproduce the old score exactly. Rates and the window are shaped
 * (boredomSelectionPolicy) and validated.
 *
 * This directory is operator-owned and closed to the autonomous lane (README.md): the selector source stays open, and
 * this test is what stops a change from re-opening either trap.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SELECTION_TRAP_POLICY as DEF, SELECTION_TRAPS_OFF as OFF, coldStreak, idleCostAdj, parseSelectionTrapPolicy, scoreTemplate,
  type ScoreInput, type SelectionTrapPolicy,
} from "../../src/selection-traps";

const IDLE = 0.2;
const NOW = Date.parse("2030-05-01T00:00:00Z");
const H = 3_600_000;
// combinedCostAdj = clamp(sqrt(median/cost), 0.5, 2): a 40x cost ratio straddling the pool median sits at the clamps.
const CHEAP = 2.0, COSTLY = 0.5;

type Arm = { id: string; rewards: number[]; costAdj: number; ci: number; cf: number; lastFailureAt?: number };
const input = (a: Arm, totalPicks: number, now = NOW): ScoreInput => ({
  rewards: a.rewards, totalPicks, explorationBoost: 1, costAdj: a.costAdj, shapeAvail: 1, priorityWeight: 1,
  consecutiveIdle: a.ci, consecutiveFailures: a.cf, lastFailureAt: a.lastFailureAt, coldCrowd: 0, idleReward: IDLE, now,
});
/** Run the selector's argmax for n picks; each pick yields `yieldOf(arm)` (the arm's next outcome reward). */
function simulate(arms: Arm[], n: number, policy: SelectionTrapPolicy, yieldOf: (a: Arm) => number, totalPicks0 = 2000): Record<string, number> {
  const count: Record<string, number> = Object.fromEntries(arms.map((a) => [a.id, 0]));
  let total = totalPicks0;
  for (let k = 0; k < n; k++) {
    let best: { a: Arm; s: number } | null = null;
    for (const a of arms) { const s = scoreTemplate(input(a, total), policy).score; if (!best || s > best.s) best = { a, s }; }
    const a = best!.a, r = yieldOf(a);
    count[a.id]! += 1;
    a.rewards.push(r); while (a.rewards.length > 50) a.rewards.shift();
    a.ci = r <= IDLE ? a.ci + 1 : 0;
    a.cf = r <= 0 ? a.cf + 1 : 0;
    total += 1;
  }
  return count;
}
// An idle template in the trap: every in-window outcome idle, and a long idle streak (outcomes older than the window are
// pruned, the streak is not), so both arms carry the same capped idle debit and only cost and exploration differ.
const idleArm = (id: string, picks: number, costAdj: number, streak = Math.max(picks, 10)): Arm => ({ id, rewards: Array(picks).fill(IDLE), costAdj, ci: streak, cf: 0 });

describe("(a) cheap idle monopoly: idle templates share picks by exploration, not cost", () => {
  // [cheap picks, costly picks]. Exactly equal windows are a pure tie broken by list order in either code: not a cost effect.
  const histories: Array<[number, number]> = [[20, 3], [50, 1], [10, 10], [50, 45], [5, 30]];
  for (const [cheapPicks, costlyPicks] of histories) {
    it(`MUST-FAIL: cheap idle (${cheapPicks} picks) vs 40x-costlier idle (${costlyPicks} picks) — the costlier is picked at least once in 50`, () => {
      const c = simulate([idleArm("cheap", cheapPicks, CHEAP), idleArm("costly", costlyPicks, COSTLY)], 50, DEF, () => IDLE);
      expect(c["costly"]!).toBeGreaterThanOrEqual(1);
    });
  }
  it("the trap is real: with the rules off, the costlier idle template is never picked from a cheap-dominated start", () => {
    const c = simulate([idleArm("cheap", 20, CHEAP), idleArm("costly", 3, COSTLY)], 50, OFF, () => IDLE);
    expect(c["costly"]).toBe(0);
  });
  it("idleCostAdj: decays toward neutral from either side per idle outcome; no idle streak → unchanged", () => {
    expect(idleCostAdj(2, 0, 0.5)).toBe(2);
    expect(idleCostAdj(0.5, 0, 0.5)).toBe(0.5);
    expect(idleCostAdj(2, 1, 0.5)).toBe(1.5);
    expect(idleCostAdj(0.5, 1, 0.5)).toBe(0.75);
    expect(Math.abs(idleCostAdj(2, 20, 0.5) - 1)).toBeLessThan(1e-5);
    expect(idleCostAdj(2, 5, 1)).toBe(2); // decay 1 = rule off
  });
});

describe("(b) cold failure recovery: a quiet cold window forgives a streak", () => {
  const failed = (lastFailureAt: number | undefined): Arm => ({ id: "failed", rewards: [], costAdj: 1, ci: 0, cf: 10, lastFailureAt });
  const clean: Arm = { id: "clean", rewards: [], costAdj: 1, ci: 0, cf: 0 };
  it("MUST-FAIL: failures=10, no outcomes, last failure one cold window ago → scores as a clean cold template", () => {
    const f = scoreTemplate(input(failed(NOW - DEF.cold_window_ms - 1), 2000), DEF);
    const c = scoreTemplate(input(clean, 2000), DEF);
    expect(f.score).toBe(c.score);
    expect(f.cold_recovered).toBe(true);
    expect(f.reason).toContain("cold-recovered 10→0");
  });
  it("MUST-FAIL: it becomes pickable — among idle sampled templates it is picked within 50 once its window has passed", () => {
    const arms = [failed(NOW - 2 * H), idleArm("idle-a", 30, 1), idleArm("idle-b", 30, 1)];
    expect(simulate(arms, 50, DEF, (a) => (a.id === "failed" ? IDLE : IDLE))["failed"]!).toBeGreaterThanOrEqual(1);
  });
  it("control: inside the window the full penalty stands (0.5^10)", () => {
    const f = scoreTemplate(input(failed(NOW - 60_000), 2000), DEF);
    const c = scoreTemplate(input(clean, 2000), DEF);
    expect(f.score).toBeCloseTo(c.score * Math.pow(0.5, 10), 12);
    expect(f.cold_recovered).toBe(false);
  });
  it("control: a template that keeps failing WHILE picked keeps its penalty (each failure restarts the window)", () => {
    const a: Arm = { id: "flaky", rewards: [0, 0, 0], costAdj: 1, ci: 3, cf: 3, lastFailureAt: NOW - 5 * 60_000 };
    const s = scoreTemplate(input(a, 2000), DEF);
    expect(s.cold_recovered).toBe(false);
    expect(s.reason).toContain("fail×3");
  });
  it("coldStreak: no timestamp → no recovery (unknown is not quiet); keep is applied per elapsed window", () => {
    expect(coldStreak(10, undefined, NOW, H, 0)).toBe(10);
    expect(coldStreak(10, NOW - 30 * 60_000, NOW, H, 0)).toBe(10);
    expect(coldStreak(10, NOW - H, NOW, H, 0)).toBe(0);
    expect(coldStreak(8, NOW - 2 * H, NOW, H, 0.5)).toBe(2);
    expect(coldStreak(10, NOW - 100 * H, NOW, Number.POSITIVE_INFINITY, 1)).toBe(10); // rules off
  });
});

describe("G6 controls: the rules move only what they name", () => {
  it("a genuinely higher mean beats idle templates whatever the costs", () => {
    const productive: Arm = { id: "productive", rewards: Array(20).fill(1), costAdj: COSTLY, ci: 0, cf: 0 };
    const c = simulate([productive, idleArm("cheap-idle", 20, CHEAP)], 20, DEF, (a) => (a.id === "productive" ? 1 : IDLE));
    expect(c["productive"]!).toBeGreaterThan(c["cheap-idle"]!);
  });
  it("a productive (non-idle) record keeps today's value-per-cost ranking: the score is unchanged by the rules", () => {
    for (const costAdj of [0.5, 0.8, 1, 1.4, 2]) {
      const a: Arm = { id: "p", rewards: [1, 1, 0.2, 1], costAdj, ci: 0, cf: 0 };
      expect(scoreTemplate(input(a, 500), DEF).score).toBe(scoreTemplate(input(a, 500), OFF).score);
    }
    const cheap: Arm = { id: "c", rewards: Array(10).fill(1), costAdj: CHEAP, ci: 0, cf: 0 };
    const costly: Arm = { id: "x", rewards: Array(10).fill(1), costAdj: COSTLY, ci: 0, cf: 0 };
    expect(scoreTemplate(input(cheap, 500), DEF).score).toBeGreaterThan(scoreTemplate(input(costly, 500), DEF).score);
  });
  it("rules off reproduce the old formula: (mean + 1.4·sqrt(2 ln N / n))·costAdj·shape + pull, ×prio, ×0.5^min(idle,4), ×0.5^min(fail,10)", () => {
    const a: Arm = { id: "o", rewards: [0.2, 0.2, 0.2, 0], costAdj: 1.7, ci: 3, cf: 2, lastFailureAt: NOW - 10 * H };
    const mean = 0.6 / 4, explore = 1.4 * Math.sqrt((2 * Math.log(900)) / 4);
    const old = (mean + explore) * 1.7 * Math.pow(0.5, 3) * Math.pow(0.5, 2);
    expect(scoreTemplate(input(a, 900), OFF).score).toBeCloseTo(old, 12);
    const cold = scoreTemplate({ ...input({ id: "k", rewards: [], costAdj: 1, ci: 0, cf: 4, lastFailureAt: NOW - 10 * H }, 900), coldCrowd: 2 }, OFF);
    expect(cold.score).toBeCloseTo(((IDLE + 1.4) / 3) * Math.pow(0.5, 4), 12);
  });
});

describe("G5: the rates and the window are shaped and validated", () => {
  it("absent → defaults; valid fields are read; any invalid field → ok:false with the defaults kept", () => {
    expect(parseSelectionTrapPolicy(null)).toEqual({ ok: true, policy: { ...DEF } });
    expect(parseSelectionTrapPolicy({ idle_cost_decay: 0.8, cold_window_ms: 2 * H, cold_streak_keep: 0.5 }).policy).toEqual({ idle_cost_decay: 0.8, cold_window_ms: 2 * H, cold_streak_keep: 0.5 });
    for (const bad of [{ idle_cost_decay: 1.5 }, { cold_streak_keep: -0.1 }, { cold_window_ms: 1000 }, { idle_cost_decay: "half" }, [1], "x"]) {
      const r = parseSelectionTrapPolicy(bad);
      expect(r.ok).toBe(false);
      expect(r.policy).toEqual({ ...DEF });
    }
  });
  it("wiring: the selector scores through scoreTemplate with the shaped policy, reads boredomSelectionPolicy, persists failure times, and logs a changed pick", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/index.ts"), "utf8");
    expect(src).toContain("return scoreTemplate({");
    expect(src).toContain('shape: "boredomSelectionPolicy"');
    expect(src).toContain("failures_at: Object.fromEntries(lastFailureAtByTemplate)");
    // each hard failure stamps its time (the window restarts), a success clears it, and a streak hydrated without a
    // time starts its clock at hydration (else an old persisted streak could never recover).
    expect(src).toMatch(/if \(reward <= 0\) \{\s*consecutiveFailureByTemplate\.set\([^;]+;\s*lastFailureAtByTemplate\.set\(templateId, Date\.now\(\)\);\s*\} else \{\s*consecutiveFailureByTemplate\.set\(templateId, 0\);\s*lastFailureAtByTemplate\.delete\(templateId\);/);
    expect(src).toMatch(/lastFailureAtByTemplate\.set\(tid, typeof at === "number" && Number\.isFinite\(at\) \? at : Date\.now\(\)\)/);
    expect(src).toMatch(/ucbScoreImpl\(c\.template_id, shapeAvail, priorityWeight, coldPool\.length, SELECTION_TRAPS_OFF\)/);
    expect(src).toContain("[pool/selection-traps] pick changed:");
    // G2: the rule names no template (the class, not the instance that exposed it).
    const rule = readFileSync(join(import.meta.dir, "../../src/selection-traps.ts"), "utf8");
    expect(rule).not.toMatch(/goal-reach|scenario-bridge|-tick\b|template_id ===/);
  });
});
