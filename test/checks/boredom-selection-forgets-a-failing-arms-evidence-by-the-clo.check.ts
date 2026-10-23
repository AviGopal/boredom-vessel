import { test, expect, describe } from "bun:test";
import * as mod from "../../src/selection-traps";
import type { ScoreInput } from "../../src/selection-traps";

describe("boredom-vessel selection defect", () => {
  test("forgets a failing template's evidence on a clock, making it look new and winning selection", () => {
    const now = Date.now();
    // The default cold_window_ms is 1 hour. We go just past that.
    const oneHourAndOneMs = 60 * 60 * 1000 + 1;

    // This arm has a history of 5 consecutive failures.
    // But its last failure was over an hour ago.
    // Its in-window rewards have been TTL-pruned, so it's treated as a cold-start arm.
    const historicallyFailingArm: ScoreInput = {
      rewards: [], // TTL-pruned rewards, so picks = 0
      totalPicks: 100, // Global picks for UCB calculation
      explorationBoost: 1.0,
      costAdj: 1.0,
      shapeAvail: 1.0,
      priorityWeight: 1.0,
      consecutiveIdle: 0,
      consecutiveFailures: 5,
      lastFailureAt: now - oneHourAndOneMs,
      coldCrowd: 0,
      idleReward: 0.1,
      now: now,
    };

    // For comparison, a genuinely new arm with no failure history.
    const genuinelyNewArm: ScoreInput = {
      ...historicallyFailingArm,
      consecutiveFailures: 0,
      lastFailureAt: undefined,
    };

    // Under the default policy, the failure streak is completely forgotten.
    const { score: failingScore } = mod.scoreTemplate(
      historicallyFailingArm,
      mod.DEFAULT_SELECTION_TRAP_POLICY,
    );

    const { score: newScore } = mod.scoreTemplate(
      genuinelyNewArm,
      mod.DEFAULT_SELECTION_TRAP_POLICY,
    );

    // The bug: The policy `cold_streak_keep: 0` wipes the failure streak to 0 after one `cold_window_ms`.
    // This makes `failingScore` identical to `newScore`, as if the failures never happened.
    // A correct implementation would retain some memory of failure, resulting in a penalized score.

    // This assertion will FAIL because of the bug. `failingScore` will be high (equal to `newScore`), not low.
    // We expect the score to be heavily penalized (e.g., less than 10% of a new arm's score).
    // The actual score will be equal to newScore, so `expect(high_score).toBeLessThan(high_score * 0.1)` fails.
    expect(failingScore).toBeLessThan(newScore * 0.1);
  });
});
