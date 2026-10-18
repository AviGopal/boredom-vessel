// SELECTION TRAPS — the template score, as a pure function of what the selector knows.
//
// Two opposite traps lived in one code path (index.ts ucbScoreImpl):
//   (1) CHEAP IDLE MONOPOLY. A redundant or idle outcome earns IDLE_REWARD, and the score multiplies the yield by a
//       value-per-cost adjustment (combinedCostAdj, clamped [0.5, 2]). At equal idle-level yield the cheapest template
//       therefore always wins: cheapness alone held the slot, and a costlier template with the same (idle) yield was
//       never picked again. Value per cost only means something when there IS value: while a template's recent
//       outcomes are idle, its cost multiplier decays toward neutral (1) per consecutive idle outcome, from either
//       side, so UCB exploration (not cost) shares picks among templates that yield nothing new. A productive
//       record (no idle streak) keeps today's value-per-cost ranking.
//   (2) COLD FAILURE NEVER RECOVERS. A failure streak multiplies the score by 0.5^min(streak,10) and resets only on
//       a success, which needs a pick, which the debit prevents: a template that failed a few times while something
//       else was broken stayed unpickable forever (the streak is persisted across restarts). A streak now decays per
//       COLD WINDOW elapsed since its last failure; a template that keeps failing while picked never accrues a window
//       and keeps its full penalty.
// Both rates and the window are shaped (boredomSelectionPolicy), read at use time with defaults; nothing here names a
// template. The protected test (test/ratchet/selection-traps.test.ts) pins the contract by class.

import { EXTERNAL_SCAN_ROW_REACH } from "./idle-check";

export interface SelectionTrapPolicy {
  /** Per consecutive idle outcome, the fraction of the cost multiplier's distance from neutral (costAdj - 1) that is kept. */
  idle_cost_decay: number;
  /** A failure streak with no new failure for this long is one cold window older. */
  cold_window_ms: number;
  /** The fraction of a failure streak kept per elapsed cold window (0 = one quiet window forgives it). */
  cold_streak_keep: number;
}

export const DEFAULT_SELECTION_TRAP_POLICY: SelectionTrapPolicy = Object.freeze({
  idle_cost_decay: 0.5,
  cold_window_ms: 60 * 60 * 1000,
  cold_streak_keep: 0,
});

/** The rules switched off: today's score exactly (used to tell whether a rule changed a pick). */
export const SELECTION_TRAPS_OFF: SelectionTrapPolicy = Object.freeze({
  idle_cost_decay: 1,
  cold_window_ms: Number.POSITIVE_INFINITY,
  cold_streak_keep: 1,
});

/** Parse a boredomSelectionPolicy body. Absent → defaults (ok). Any present-but-invalid field → ok:false, defaults kept. */
export function parseSelectionTrapPolicy(body: unknown): { ok: boolean; policy: SelectionTrapPolicy; why?: string } {
  const policy: SelectionTrapPolicy = { ...DEFAULT_SELECTION_TRAP_POLICY };
  if (body === null || body === undefined) return { ok: true, policy };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, policy, why: "policy body is not an object" };
  const b = body as Record<string, unknown>;
  const frac = (k: "idle_cost_decay" | "cold_streak_keep"): string | null => {
    if (b[k] === undefined) return null;
    const v = b[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return `${k} must be a number in [0,1]`;
    policy[k] = v;
    return null;
  };
  const errs: string[] = [];
  for (const k of ["idle_cost_decay", "cold_streak_keep"] as const) { const e = frac(k); if (e) errs.push(e); }
  if (b["cold_window_ms"] !== undefined) {
    const v = b["cold_window_ms"];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 60_000 || v > 7 * 24 * 3_600_000) errs.push("cold_window_ms must be a number in [60000, 604800000]");
    else policy.cold_window_ms = v;
  }
  if (errs.length) return { ok: false, policy: { ...DEFAULT_SELECTION_TRAP_POLICY }, why: errs.join("; ") };
  return { ok: true, policy };
}

/** While outcomes are idle, the cost multiplier decays toward neutral (1) per consecutive idle outcome; productive is unchanged. */
export function idleCostAdj(costAdj: number, consecutiveIdle: number, decay: number): number {
  if (!Number.isFinite(costAdj) || !(consecutiveIdle >= 1)) return costAdj;
  return 1 + (costAdj - 1) * Math.pow(decay, consecutiveIdle);
}

/** The failure streak after the cold windows elapsed since its last failure. No timestamp → no recovery (unknown is not quiet). */
export function coldStreak(streak: number, lastFailureAt: number | undefined, now: number, windowMs: number, keep: number): number {
  if (!(streak > 0) || lastFailureAt === undefined || !Number.isFinite(lastFailureAt) || !(windowMs > 0)) return streak;
  const windows = Math.floor((now - lastFailureAt) / windowMs);
  if (!(windows >= 1) || !Number.isFinite(windows)) return streak;
  return Math.floor(streak * Math.pow(keep, windows));
}

export interface ScoreInput {
  /** In-window outcome rewards (already pruned to the outcome TTL). */
  rewards: readonly number[];
  totalPicks: number;
  explorationBoost: number;
  /** combinedCostAdj for the template (value-per-cost multiplier, clamped [0.5, 2]). */
  costAdj: number;
  shapeAvail: number;
  priorityWeight: number;
  consecutiveIdle: number;
  consecutiveFailures: number;
  lastFailureAt?: number;
  /** Cold picks in the last minute (crowding of the cold branch). */
  coldCrowd: number;
  idleReward: number;
  now: number;
  /** The expected-cost text the selector logs before the multiplier (e.g. "1234ms/56tok"). */
  costNote?: string;
}

/**
 * The template score (verbatim the selector's formula, plus the two trap rules). Returns the score, the reason text
 * the selector logs, and which rule (if any) moved the score.
 */
export function scoreTemplate(i: ScoreInput, policy: SelectionTrapPolicy): { score: number; reason: string; idle_cost_decayed: boolean; cold_recovered: boolean } {
  const pw = Number.isFinite(i.priorityWeight) && i.priorityWeight > 0 ? i.priorityWeight : 1.0;
  const cf = coldStreak(i.consecutiveFailures, i.lastFailureAt, i.now, policy.cold_window_ms, policy.cold_streak_keep);
  const coldRecovered = cf < i.consecutiveFailures;
  const picks = i.rewards.length;
  if (picks === 0) {
    const explorationBonus = (i.idleReward + 1.4 * i.explorationBoost) * Math.max(i.shapeAvail, 1) * pw;
    const failDebitCold = cf >= 2 ? Math.pow(0.5, Math.min(cf, 10)) : 1;
    return {
      score: (explorationBonus / (1 + i.coldCrowd)) * failDebitCold,
      reason: `ucb=cold picks=0 shape=${i.shapeAvail.toFixed(2)}${pw > 1.0 ? ` prio=${pw.toFixed(2)}` : ""} coldCrowd=${i.coldCrowd}${cf >= 2 ? ` fail×${cf}` : ""}${coldRecovered ? ` cold-recovered ${i.consecutiveFailures}→${cf}` : ""}`,
      idle_cost_decayed: false,
      cold_recovered: coldRecovered,
    };
  }
  const mean = i.rewards.reduce((s, r) => s + r, 0) / picks;
  const explore = 1.4 * i.explorationBoost * Math.sqrt(2 * Math.log(Math.max(1, i.totalPicks)) / picks);
  const baseScore = mean + explore;
  const pipelinePull = i.shapeAvail >= 2.0 ? 2.0 : 0.0;
  const costAdj = idleCostAdj(i.costAdj, i.consecutiveIdle, policy.idle_cost_decay);
  const idleCostDecayed = costAdj !== i.costAdj;
  const rawScore = baseScore * costAdj * Math.max(i.shapeAvail, 1.0) + pipelinePull;
  const finiteScore = Number.isFinite(rawScore) ? rawScore : baseScore;
  let score = finiteScore * pw;
  let reason = `mean=${mean.toFixed(2)} ucb=${explore.toFixed(2)} cost=${i.costNote ?? ""}×${costAdj.toFixed(2)}${idleCostDecayed ? `(idle-decayed from ${i.costAdj.toFixed(2)})` : ""}${Number.isFinite(rawScore) ? "" : "(NaN→base)"} picks=${picks} shape=${i.shapeAvail.toFixed(2)} pull=${pipelinePull}${pw > 1.0 ? ` prio=${pw.toFixed(2)}` : ""}`;
  if (i.consecutiveIdle >= 2) {
    score *= Math.pow(0.5, Math.min(i.consecutiveIdle, 4));
    reason += ` idle×${i.consecutiveIdle}`;
  }
  if (cf >= 2) {
    score *= Math.pow(0.5, Math.min(cf, 10));
    reason += ` fail×${cf}`;
  }
  if (coldRecovered) reason += ` cold-recovered ${i.consecutiveFailures}→${cf}`;
  return { score, reason, idle_cost_decayed: idleCostDecayed, cold_recovered: coldRecovered };
}

// EXTERNAL-TRAFFIC GATE POLICY — three more fields of the same boredomSelectionPolicy row, kept in their own object so
// the trap policy above (and its protected contract) is untouched. The pool defers dispatching while non-boredom traces
// are active (see external-gate.ts). external_defer_max_ms = 0 is OFF, and it is the default: an absent row, or an
// invalid gate field, leaves the pool exactly as it was.
export interface ExternalGatePolicy {
  /** How far back a non-boredom trace counts as active external work. */
  external_window_ms: number;
  /** External traces in the window at or above which the pool defers. */
  external_min_traces: number;
  /** The longest one continuous defer may last before the pool dispatches anyway (0 = gate off). */
  external_defer_max_ms: number;
}

export const DEFAULT_EXTERNAL_GATE_POLICY: ExternalGatePolicy = Object.freeze({
  external_window_ms: 5 * 60 * 1000,
  external_min_traces: 1,
  external_defer_max_ms: 0,
});

/** The gate switched off (the default is off too; this names it for callers and tests). */
export const EXTERNAL_GATE_OFF: ExternalGatePolicy = Object.freeze({ ...DEFAULT_EXTERNAL_GATE_POLICY, external_defer_max_ms: 0 });

/** Parse the gate fields of a boredomSelectionPolicy body. Absent → defaults (off, ok). Any invalid gate field → ok:false, defaults (off). */
export function parseExternalGatePolicy(body: unknown): { ok: boolean; policy: ExternalGatePolicy; why?: string } {
  const policy: ExternalGatePolicy = { ...DEFAULT_EXTERNAL_GATE_POLICY };
  if (body === null || body === undefined) return { ok: true, policy };
  if (typeof body !== "object" || Array.isArray(body)) return { ok: false, policy, why: "policy body is not an object" };
  const b = body as Record<string, unknown>;
  const errs: string[] = [];
  const num = (k: keyof ExternalGatePolicy, lo: number, hi: number, int: boolean): void => {
    if (b[k] === undefined) return;
    const v = b[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) errs.push(`${k} must be ${int ? "an integer" : "a number"} in [${lo}, ${hi}]`);
    else policy[k] = v;
  };
  num("external_window_ms", 10_000, 3_600_000, false);
  // Bounded by what one count can see (externalTracesSince's page cap): a higher threshold would make every reading
  // unknown (busy), so the gate would defer to its bound on every tick and mean nothing.
  num("external_min_traces", 1, EXTERNAL_SCAN_ROW_REACH, true);
  num("external_defer_max_ms", 0, 6 * 3_600_000, false);
  if (errs.length) return { ok: false, policy: { ...DEFAULT_EXTERNAL_GATE_POLICY }, why: errs.join("; ") };
  return { ok: true, policy };
}
