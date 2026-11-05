// GAP-GOAL-UNARMED-SKIP: the pool's pick decides, as a masked variant, whether a gap goal for a row a compose would
// refuse as unarmed (its edit_site a src/ file) fills the slot.
//
// The gap-goal supply walked such rows into feature_compose, which refused them as ineligible (unarmed), and re-picked
// them after each refusal; dv's check supply already sends every such row a check-writing goal. Variant-1 fills the slot
// with the best unflagged candidate of the same ranking; variant-0 dispatches the flagged winner as before, marked. Each
// decision settles on the goal that filled its slot: goal-host's reached verdict for that dispatch.
//   [MUST-FAIL] fail at the parent (the exports, the flag and the wiring do not exist there).
//   [CONTROL]   variant-0 and an unflagged winner are unchanged.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as gg from "./goal-generation";

const ACT = "boredom-vessel:gap-goal-unarmed-skip";
const P = `[${ACT}]`;
const T0 = Date.now() - (Date.now() % 1000);
const FX = JSON.parse(readFileSync(new URL("./fixtures/unarmed-src-site-fixtures.json", import.meta.url), "utf8")) as { cases: Array<{ name: string; meta: Record<string, unknown>; unarmed: boolean; flag: boolean }> };
const IDX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const g = gg as any;

type Trace = Record<string, unknown>;
let lines: string[] = [];
let traces: Trace[] = [];
let reads = 0;
const origLog = console.log, origWarn = console.warn, realFetch = globalThis.fetch;
function mask(variant: unknown, activity = ACT) {
  return { id: `mask-${String(variant)}`, body: { activity_id: activity, active_variant: variant, from: new Date(T0 - 60_000).toISOString(), until: new Date(T0 + 7 * 86_400_000).toISOString(), by: "operator:test", reason: "test" } };
}
function seams(masks: unknown[] | (() => unknown[])) {
  g.__setUnarmedSkipDepsForTests({
    readMasks: async () => { reads += 1; return typeof masks === "function" ? (masks as () => unknown[])() : masks; },
    postTrace: async (t: Trace) => { traces.push(t); return 200; },
    nowMs: () => T0 + 60_000,
  });
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const WIN = { template_id: "gap-goal:row-unarmed" };
const RUNNER = { template_id: "gap-goal:row-armed" };

beforeEach(() => {
  lines = []; traces = []; reads = 0;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog; console.warn = origWarn; globalThis.fetch = realFetch;
  g.__setUnarmedSkipDepsForTests?.(null);
});

describe("which rows are flagged", () => {
  it("[MUST-FAIL] the mirror agrees with dv's compose eligibility on every shared fixture", () => {
    expect(FX.cases.length).toBeGreaterThanOrEqual(14);
    for (const c of FX.cases) {
      expect([c.name, g.unarmedForCompose(c.meta)]).toEqual([c.name, c.unarmed]);
      expect([c.name, g.unarmedSrcSite(c.meta)]).toEqual([c.name, c.flag]);
    }
  });

  it("[MUST-FAIL] the supply flags a sited unarmed src row's candidate, and only that one", async () => {
    const gaps = [
      { id: "row-unarmed", summary: "The row-unarmed producer needs a repair.", category: "missing_capability", source: "substrate_detected", classification_metadata: { falsifier: "none", edit_site: "repos/development-vessel/src/a.ts" } },
      { id: "row-armed", summary: "The row-armed producer needs a repair.", category: "missing_capability", source: "substrate_detected", classification_metadata: { falsifier: { class: "class1" }, edit_site: "repos/development-vessel/src/b.ts" } },
      { id: "row-test-site", summary: "The row-test-site producer needs a repair.", category: "missing_capability", source: "substrate_detected", classification_metadata: { falsifier: "none", edit_site: "repos/development-vessel/test/c.test.ts" } },
      { id: "row-no-site", summary: "The row-no-site producer needs a repair.", category: "missing_capability", source: "substrate_detected", classification_metadata: { falsifier: "none" } },
    ];
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/v2/impulses/resolve")) return { ok: true, status: 200, json: async () => ({ body: { gaps } }) };
      if (u.endsWith("/resolve")) return { ok: true, status: 200, json: async () => ({ body: { dispatches: [] } }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const out = await gg.generateGapGoalCandidates("http://activity-api.test", "test-key");
    const by = (id: string) => out.find((x) => x.gapId === id) as Record<string, unknown> | undefined;
    expect(by("row-unarmed")?.unarmedSrcSite).toBe(true);
    for (const id of ["row-armed", "row-test-site", "row-no-site"]) {
      expect(by(id)).toBeDefined();
      expect(by(id)?.unarmedSrcSite).toBeUndefined();
    }
    // The flag reaches the pick's candidate.
    expect(IDX).toContain("...(g.unarmedSrcSite ? { unarmed_src_site: true as const } : {})");
  });
});

describe("the decision at a pick a flagged candidate won", () => {
  it("[MUST-FAIL] variant-1 fills the slot with the runner-up and says so; with no runner-up nothing is dispatched, ungraded", async () => {
    seams([mask(1)]);
    const d = await g.decideUnarmedSkip(WIN, RUNNER);
    await flush();
    expect(d.dispatch).toBe(RUNNER.template_id);
    expect(d.variant).toBe(1);
    expect(reads).toBe(1);
    expect(lines.filter((l) => l.startsWith(`${P} skipped ${WIN.template_id} (unarmed src-site) → dispatched ${RUNNER.template_id} variant=1 (mask mask-1 [`)).length).toBe(1);
    expect(traces.length).toBe(1);
    expect(traces[0]!["template_id"]).toBe(`${ACT}-v1`);
    expect(traces[0]!["output_shapes"]).toEqual(["gapGoalUnarmedSkip"]);
    expect((traces[0]!["metadata"] as any).gapGoalUnarmedSkip).toMatchObject({ variant: 1, gap_id: "row-unarmed", winner: WIN.template_id, dispatched: RUNNER.template_id });
    const none = await g.decideUnarmedSkip(WIN, null);
    expect(none.dispatch).toBeNull();
    expect(lines.filter((l) => l.startsWith(`${P} ungraded ${none.decision}: no dispatch in the pass`)).length).toBe(1);
    expect(g.settleUnarmedSkip(none.decision, true, "")).toBe(false);
  });

  it("[CONTROL] variant-0 dispatches the flagged winner, marked: no mask in force, a mask naming 0 or an unknown variant, an unreadable pool", async () => {
    const cases: Array<[unknown[] | (() => unknown[]), string]> = [
      [[], "no mask in force: variant-0"],
      [[mask(1, "development-vessel:check-landing-restart")], "no mask in force: variant-0"],
      [[mask(0)], "mask mask-0 ["],
      [[mask(7)], "names unknown variant 7: variant-0"],
      [() => { throw new Error("pool down"); }, "mask_unread (pool down): variant-0"],
    ];
    for (const [masks, why] of cases) {
      lines = []; reads = 0;
      seams(masks);
      const d = await g.decideUnarmedSkip(WIN, RUNNER);
      expect(d.dispatch).toBe(WIN.template_id);
      expect(d.variant).toBe(0);
      expect(reads).toBe(1);
      const marks = lines.filter((l) => l.startsWith(`${P} would skip ${WIN.template_id} (unarmed src-site) → dispatched ${WIN.template_id} variant=0 (`));
      expect(marks.length).toBe(1);
      expect(marks[0]).toContain(why);
    }
    expect(lines.filter((l) => l === `${P} mask_unread (pool down): variant-0`).length).toBe(1);
  });
});

describe("the decision's credit (the goal that filled its slot)", () => {
  it("[MUST-FAIL] the slot's reached verdict settles a decision once: reached, not reached, or ungraded", async () => {
    seams([mask(1)]);
    const a = await g.decideUnarmedSkip(WIN, RUNNER);
    const b = await g.decideUnarmedSkip(WIN, RUNNER);
    const c = await g.decideUnarmedSkip(WIN, RUNNER);
    await flush(); traces = [];
    expect(g.settleUnarmedSkip(a.decision, true, "", "dispatch-1")).toBe(true);
    expect(g.settleUnarmedSkip(a.decision, true, "", "dispatch-1")).toBe(false);
    expect(g.settleUnarmedSkip(b.decision, false, "", "dispatch-2")).toBe(true);
    expect(g.settleUnarmedSkip(c.decision, null, "its dispatch reached no terminal status")).toBe(true);
    expect(g.settleUnarmedSkip("gap-goal-unarmed-skip-unknown", true, "")).toBe(false);
    await flush();
    expect(traces.length).toBe(2);
    expect(traces[0]).toMatchObject({ template_id: `${ACT}-credit`, success: true, composition_chain: [a.decision] });
    expect(traces[0]!["tags"]).toContain("reached:true");
    expect((traces[0]!["metadata"] as any)).toMatchObject({ variant: 1, settled_by: "dispatch-1", dispatched: RUNNER.template_id });
    expect(traces[1]).toMatchObject({ success: false, composition_chain: [b.decision] });
    expect(traces[1]!["tags"]).toContain("reached:false");
    expect(lines.filter((l) => l === `${P} ungraded ${c.decision}: its dispatch reached no terminal status`).length).toBe(1);
  });
});

describe("index.ts wiring (it top-level-awaits its loop, so it is pinned by source)", () => {
  /** Body of a top-level function: from its declaration to the next top-level declaration. */
  const fnBody = (decl: string): string => {
    const start = IDX.indexOf(decl);
    if (start < 0) throw new Error(`declaration not found: ${decl}`);
    const rest = IDX.slice(start + decl.length);
    const next = rest.search(/\n(?:async function |function |const |let )/);
    return next < 0 ? rest : rest.slice(0, next);
  };

  it("[MUST-FAIL] the pick: one ranking, its unflagged best tracked in the same loop, the decision only for a flagged winner", () => {
    const pick = fnBody("async function pickByShapeAvailability(");
    // No new scoring: the same two score calls as before, and the unflagged best keeps ucb.score.
    expect(pick.split("ucbScore(").length - 1).toBe(1);
    expect(pick.split("ucbScoreImpl(").length - 1).toBe(1);
    expect(pick).toContain("if (c.unarmed_src_site !== true && (!bestUnflagged || ucb.score > bestUnflagged.score)) {");
    expect(pick).toContain("bestFlagged = c.unarmed_src_site === true;");
    // The decision comes after the ranking and its trap log; an unflagged winner returns `best` as before.
    const traps = pick.indexOf("[pool/selection-traps] pick changed");
    const decide = pick.indexOf("if (best && bestFlagged) {\n    const d = await decideUnarmedSkip(best, bestUnflagged);");
    expect(traps).toBeGreaterThan(0);
    expect(decide).toBeGreaterThan(traps);
    expect(pick.slice(decide)).toContain("if (d.dispatch !== best.template_id) unarmedSkipCooledAt.set(best.template_id, Date.now());\n    if (d.dispatch === null) return null;");
    // A skipped winner cools like a dispatched gap goal, so a row yields at most one decision per cooldown in either arm.
    expect(pick).toContain("!(Date.now() - (unarmedSkipCooledAt.get(c.template_id) ?? -Infinity) < GAP_GOAL_COOLDOWN_MS));");
    expect(IDX.split("unarmedSkipCooledAt.set(").length - 1).toBe(1);
    expect(pick.slice(decide)).toContain("const pick: ShapeDrivenPick = d.dispatch === best.template_id ? best : bestUnflagged!;");
    expect(pick.slice(decide)).toContain("    return d.decision ? { ...pick, unarmed_skip: d.decision } : pick;\n  }\n  return best;\n}\n");
  });

  it("[MUST-FAIL] the settle: bound at the dispatch, fired by the gap-goal grader's terminal read or its no-verdict line, nowhere else", () => {
    expect(IDX).toContain("if (shapePick.unarmed_skip) bindUnarmedSkipDecision(shapePick.unarmed_skip, shapePick.template_id, result);");
    expect(IDX).toContain('settleUnarmedSkipForDispatch(dispatchId, rec.reached === true, "");');
    expect(IDX).toContain('settleUnarmedSkipForDispatch(dispatchId, null, "its dispatch reached no terminal status");');
    expect(IDX.split("settleUnarmedSkipForDispatch(").length - 1).toBe(3); // its definition and the two grader calls
    expect(IDX.split("bindUnarmedSkipDecision(").length - 1).toBe(2); // its definition and the one dispatch site
    const bind = fnBody("function bindUnarmedSkipDecision(");
    expect(bind).toContain("settleUnarmedSkip(decision, null, `no dispatch of ${templateId}`)");
    expect(bind).toContain("settleUnarmedSkip(decision, null, `${templateId} runs no goal-host walk`)");
  });
});
