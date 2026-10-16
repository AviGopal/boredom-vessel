// A GAP GOAL WITH NO EDIT SITE ASKS FOR ITS DECOMPOSITION, STRUCTURED (CHANGE-35, Class A).
//
// The gap-goal supply sent "investigate and decompose gap X: …" as prose only; goal-host had to recover the target and
// the gap from the text, and the walk wrote nothing onto X (RUN 0, 2026-10-16). The supply KNOWS both, so it says so.
//   [MUST-FAIL] a gap with no edit site yields a candidate carrying runGoal {expected_output_shapes ["gapDecomposition"],
//               variables {decompose_gap_id: X}}, and the gap-goal dispatch sends those fields on the run-goal body.
//   [CONTROL]   a gap WITH an edit site keeps its "Close substrate gap" goal and carries no runGoal.
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { generateGapGoalCandidates } from "./goal-generation";

type Gap = { id: string; summary: string; category?: string; source?: string; classification_metadata?: Record<string, unknown> };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function serve(gaps: Gap[]) {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/v2/impulses/resolve")) return { ok: true, status: 200, json: async () => ({ body: { gaps } }) };
    if (u.endsWith("/resolve")) return { ok: true, status: 200, json: async () => ({ body: { dispatches: [] } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
}
const gap = (id: string, meta: Record<string, unknown>): Gap => ({ id, summary: `The ${id} producer needs a repair so the walk reaches.`, category: "missing_capability", source: "substrate_detected", classification_metadata: { falsifier: "none", ...meta } });

describe("gap goals ask for their decomposition structured", () => {
  it("[MUST-FAIL] no edit site: the candidate carries the target shape and the gap id; the dispatch sends them", async () => {
    serve([gap("gap-no-site", {})]);
    const out = await generateGapGoalCandidates("http://activity-api.test", "test-key");
    const c = out.find((x) => x.gapId === "gap-no-site") as Record<string, any> | undefined;
    expect(c?.goalText).toMatch(/^investigate and decompose gap gap-no-site:/);
    expect(c?.runGoal).toEqual({ expected_output_shapes: ["gapDecomposition"], variables: { decompose_gap_id: "gap-no-site" } });
    const idx = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(idx).toContain("...(cand.run_goal ? { expected_output_shapes: cand.run_goal.expected_output_shapes, variables: cand.run_goal.variables } : {})");
    expect(idx).toContain("...(g.runGoal ? { run_goal: g.runGoal } : {})");
  });

  it("[CONTROL] an edit site keeps the Close goal and no runGoal", async () => {
    serve([gap("gap-with-site", { edit_site: "repos/goal-host-vessel/src/index.ts" })]);
    const out = await generateGapGoalCandidates("http://activity-api.test", "test-key");
    const c = out.find((x) => x.gapId === "gap-with-site") as Record<string, any> | undefined;
    expect(c?.goalText).toMatch(/^Close substrate gap gap-with-site:/);
    expect(c?.runGoal).toBeUndefined();
  });
});
