import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as st from "./selection-traps";

// A RESTART UNDER on_row_change KEEPS THE HELD ARMS' OUTCOMES, AND SAYS SO ONCE.
// hydrateMomentum pruned every arm's outcomes by the TTL before the first policy read, so under gap_goal_forgive
// "on_row_change" a restart dropped exactly the outcomes the policy holds. It now reads boredomSelectionPolicy first
// (unreachable → the defaults, cold_window), keeps a gap-goal arm's outcomes through the prune when it has a stored row
// state, and logs one restart line naming the policy it ran under: the ABAB block boundary.
//   - MUST-FAIL: the hydration reads the policy before its prune, and a held arm is not pruned there;
//   - MUST-FAIL: one restart line per hydration, snapshot or not, naming gap_goal_forgive and outcome_ttl_ms;
//   - CONTROL: under the default (cold_window) nothing is held at a restart, so the prune is today's;
//   - CONTROL: the state refresh still reads the same row through the same function.

const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const H = 3_600_000;
const SA = "a".repeat(64);
const hydrate = (() => { const i = SRC.indexOf("async function hydrateMomentum("); return SRC.slice(i, SRC.indexOf("\n}\n", i)); })();
const held = () => {
  const f = (st as Record<string, unknown>)["heldAtRestart"];
  expect(typeof f).toBe("function");
  return f as (tid: string, s: string | undefined, p: unknown) => boolean;
};

describe("hydration under on_row_change", () => {
  it("MUST-FAIL a gap-goal arm with a stored row state is held at a restart under on_row_change", () => {
    const on = { gap_goal_forgive: "on_row_change", outcome_ttl_ms: H };
    expect(held()("gap-goal:fixture-row", SA, on)).toBe(true);
    expect(held()("gap-goal:fixture-row", undefined, on)).toBe(false);
    expect(held()("fixture-tick", SA, on)).toBe(false);
    const outcomes = [{ at: 0, reward: 0 }, { at: 1, reward: 0 }];
    st.pruneOutcomesByTtl(outcomes, 10 * H, H, held()("gap-goal:fixture-row", SA, on) ? "hold" : "clock");
    expect(outcomes.length).toBe(2);
  });
  it("MUST-FAIL the hydration reads the policy before its TTL prune, and prunes through the held decision", () => {
    const read = hydrate.indexOf("await readBoredomSelectionPolicy()");
    const prune = hydrate.indexOf('pruneOutcomesByTtl(m.outcomes, Date.now(), outcomeTtlMs(), held ? "hold" : "clock")');
    expect(read).toBeGreaterThan(-1);
    expect(prune).toBeGreaterThan(read);
    expect(hydrate).toContain("const held = heldAtRestart(tid, savedRowStates.get(tid), armMemoryPolicy);");
    expect(hydrate).not.toContain("pruneStaleOutcomes(m);");
  });
  it("MUST-FAIL one restart line per hydration, after the snapshot read whether or not it succeeded", () => {
    const line = "[pool/selection-traps] restart: arm memory hydrated under gap_goal_forgive=${armMemoryPolicy.gap_goal_forgive} outcome_ttl_ms=${armMemoryPolicy.outcome_ttl_ms}";
    expect(hydrate).toContain(line);
    expect(hydrate.indexOf(line)).toBeGreaterThan(hydrate.indexOf("/* no snapshot or unreadable — start fresh */"));
  });
  it("CONTROL under the default (cold_window) nothing is held at a restart: the prune is today's", () => {
    expect(held()("gap-goal:fixture-row", SA, st.DEFAULT_ARM_MEMORY_POLICY)).toBe(false);
    const outcomes = [{ at: 0, reward: 0 }, { at: 9.5 * H, reward: 1 }];
    st.pruneOutcomesByTtl(outcomes, 10 * H, H, "clock");
    expect(outcomes).toEqual([{ at: 9.5 * H, reward: 1 }]);
  });
  it("CONTROL the state refresh reads the same row through the same function", () => {
    const i = SRC.indexOf("async function refreshSubstrateState(");
    expect(SRC.slice(i, SRC.indexOf("\n}\n", i))).toContain("await readBoredomSelectionPolicy();");
    expect(SRC).toContain('shape: "boredomSelectionPolicy"');
  });
});
