import { afterEach, describe, expect, it } from "bun:test";
import * as gg from "./goal-generation";

// A DECOMPOSED PARENT WAITS FOR ITS STEPS (a TEMPORARY lane filter, accepted as removal debt).
// A reached investigation wrote a parent's steps (classification_metadata.decomposition.children), and the success
// boosted the parent's arm: it was re-picked 3 times in 30 minutes, each pick refused "step-1 already exists". While any
// child is open in the gap list the supply already read, the parent is not offered; a child absent from that list counts
// as not open. It retires when a reached investigation's reward can be credited to the children instead of the parent,
// or when parent re-picks with open children stay at 0 with this read disabled after the row-change forgiveness soaks.
//   - MUST-FAIL: a parent with one open child is skipped, with one log line naming the open step count;
//   - MUST-FAIL: the child's openness is read from the whole list the supply read, before the ownership drop, and the
//     skip does not depend on the parent having an edit site;
//   - CONTROL: all children closed → the parent is offered;
//   - CONTROL: a child absent from the list → the parent is offered;
//   - CONTROL: no decomposition, or an empty one → offered as today.

type Gap = { id: string; summary: string; status?: string; category?: string; source?: string; directed?: boolean; classification_metadata?: Record<string, unknown> };
const realFetch = globalThis.fetch;
const realLog = console.log;
afterEach(() => { globalThis.fetch = realFetch; console.log = realLog; });
async function supply(gaps: Gap[]): Promise<{ ids: string[]; lines: string[] }> {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/v2/impulses/resolve")) return { ok: true, status: 200, json: async () => ({ body: { gaps } }) };
    if (u.endsWith("/resolve")) return { ok: true, status: 200, json: async () => ({ body: { dispatches: [] } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const out = await gg.generateGapGoalCandidates("http://activity-api.test", "test-key");
    return { ids: out.map((c) => c.gapId), lines };
  } finally { console.log = realLog; }
}
const parent = (children: string[], meta: Record<string, unknown> = {}): Gap => ({
  id: "fixture-parent", status: "open", category: "missing_capability", source: "substrate_detected",
  summary: "The fixture producer needs a repair so the walk reaches. Its body is empty.",
  classification_metadata: { falsifier: "none", decomposed_at: "2030-01-01T00:00:00.000Z", decomposition: { children, reason: `wrote ${children.length} step(s)` }, ...meta },
});
// A step row: ordinary prose (the supply's prose gate drops it), so only the parent can become a goal.
const step = (id: string, extra: Partial<Gap> = {}): Gap => ({ id, status: "open", category: "missing_capability", source: "substrate_detected", summary: `[step of fixture-parent] Edit one file for ${id}.`, classification_metadata: { parent_gap_id: "fixture-parent", falsifier: "class1" }, ...extra });

describe("the gap-goal supply skips a parent while any decomposition child is open", () => {
  it("MUST-FAIL a parent with one open child is not offered, and says why", async () => {
    const r = await supply([parent(["fixture-parent-step-1", "fixture-parent-step-2"]), step("fixture-parent-step-1")]);
    expect(r.ids).not.toContain("fixture-parent");
    expect(r.lines).toContain("[gap-goal-supply] SKIP fixture-parent: decomposed into 1 open step(s); their work comes first");
  });
  it("MUST-FAIL the child is read from the whole list (an owner-held child still counts), whatever the parent's edit site", async () => {
    const r = await supply([parent(["fixture-parent-step-1"], { edit_site: "repos/example-vessel/src/index.ts" }), step("fixture-parent-step-1", { directed: true })]);
    expect(r.ids).not.toContain("fixture-parent");
    expect(r.lines.some((l) => l.startsWith("[gap-goal-supply] SKIP fixture-parent: decomposed into 1 open step(s)"))).toBe(true);
  });
  it("CONTROL every child closed: the parent is offered", async () => {
    const r = await supply([parent(["fixture-parent-step-1"]), step("fixture-parent-step-1", { status: "closed" })]);
    expect(r.ids).toEqual(["fixture-parent"]);
  });
  it("CONTROL a child absent from the list counts as not open: the parent is offered", async () => {
    const r = await supply([parent(["fixture-parent-step-9"])]);
    expect(r.ids).toEqual(["fixture-parent"]);
    expect(r.lines.some((l) => l.includes("SKIP fixture-parent: decomposed"))).toBe(false);
  });
  it("CONTROL no decomposition, or an empty one: offered as today", async () => {
    expect((await supply([parent([])])).ids).toEqual(["fixture-parent"]);
    const plain = parent([]); delete (plain.classification_metadata as Record<string, unknown>).decomposition;
    expect((await supply([plain])).ids).toEqual(["fixture-parent"]);
  });
  it("openDecompositionChildren (the new helper) counts distinct open string children only", () => {
    const f = (gg as Record<string, unknown>)["openDecompositionChildren"] as ((m: unknown, s: Set<string>) => number) | undefined;
    expect(typeof f).toBe("function");
    const open = new Set(["a", "b"]);
    expect(f!({ decomposition: { children: ["a", "a", "b", "c", 7, null] } }, open)).toBe(2);
    expect(f!({ decomposition: { children: "a" } }, open)).toBe(0);
    expect(f!({ decomposition: null }, open)).toBe(0);
    expect(f!(undefined, open)).toBe(0);
  });
});
