import { describe, it, expect, afterEach } from "bun:test";
import { generateGapGoalCandidates } from "./goal-generation";

// The gap-goal supply dispatches WALKS. A gap that belongs to the operator or to the compose
// lane must never become one: two such walks wrote substrateGap_write on the very gap they
// were dispatched at (closing, re-sourcing and overwriting it) with no verdict.
//
// Each world serves one window of open gaps from the dev-vessel resolve, an empty
// activeDispatches list from goal-host, and nothing from concept-db, so the only candidates
// come from the gap window under test.

type Gap = { id: string; summary: string; category?: string; source?: string; directed?: boolean; classification_metadata?: Record<string, unknown> };

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

async function goalGapIds(gaps: Gap[]): Promise<string[]> {
  serve(gaps);
  const out = await generateGapGoalCandidates("http://activity-api.test", "test-key");
  return out.map((c) => c.gapId);
}

// An ordinary, admissible gap: substrate-detected, unarmed, in-scope edit site, and prose the
// actionability gate accepts. Each variant below differs from it in exactly one ownership mark.
function ordinary(id: string, over: Partial<Gap> = {}, meta: Record<string, unknown> = {}): Gap {
  return {
    id,
    summary: `The ${id} producer needs a repair so the walk reaches.`,
    category: "missing_capability",
    source: "substrate_detected",
    ...over,
    classification_metadata: { falsifier: "none", edit_site: "repos/goal-host-vessel/src/index.ts", ...meta },
  };
}

describe("gap-goal supply leaves operator-owned and compose-lane gaps alone", () => {
  it("CONTROL an ordinary substrate_detected unarmed gap with an in-scope site still becomes a goal", async () => {
    expect(await goalGapIds([ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a directed gap at top level is not turned into a goal", async () => {
    expect(await goalGapIds([ordinary("directed-top", { directed: true }), ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a directed gap in classification metadata is not turned into a goal", async () => {
    expect(await goalGapIds([ordinary("directed-meta", {}, { directed: true }), ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL an operator_hold gap is not turned into a goal", async () => {
    expect(await goalGapIds([ordinary("held-gap", {}, { operator_hold: true }), ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a human_reported gap is not turned into a goal", async () => {
    expect(await goalGapIds([ordinary("human-gap", { source: "human_reported" }), ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a gap whose supply is an operator finding is not turned into a goal", async () => {
    expect(await goalGapIds([ordinary("op-supply-gap", {}, { supply: "operator builder finding 2026-10-03" }), ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a gap whose edit site is marked excluded operator is not turned into a goal", async () => {
    const g = ordinary("excluded-site-gap", {}, { edit_site: "repos/development-vessel/src/resolvers/substrate-gap.ts (excluded: operator)" });
    expect(await goalGapIds([g, ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a class2 gap armed with an evidence_resolve is not turned into a goal", async () => {
    const g = ordinary("class2-armed-gap", {}, { falsifier: "class2", evidence_resolve: { shape: "test_suite", input: { vessel: "development-vessel" } } });
    expect(await goalGapIds([g, ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("CONTROL a class2 gap without an evidence_resolve is still a goal", async () => {
    expect(await goalGapIds([ordinary("class2-unarmed-gap", {}, { falsifier: "class2" })])).toEqual(["class2-unarmed-gap"]);
  });

  it("CONTROL directed false and a non-operator supply do not drop a gap", async () => {
    const g = ordinary("explicit-undirected-gap", { directed: false }, { directed: false, operator_hold: false, supply: "gap_lifecycle_scan" });
    expect(await goalGapIds([g])).toEqual(["explicit-undirected-gap"]);
  });
});
