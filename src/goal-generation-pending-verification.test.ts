import { describe, it, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateGapGoalCandidates, isAwaitingLandVerification } from "./goal-generation";

// A gap whose landing awaits its verdict (disposition pending_verification) is held by
// development-vessel's compose eligibility and admission (isAwaitingLandVerification), but the
// gap-goal supply kept turning it into a walk, and a walk can re-land a change the landing sweep
// is still judging. The supply must skip exactly the rows that predicate holds, and no others.

type Gap = { id: string; summary: string; category?: string; source?: string; directed?: boolean; classification_metadata?: Record<string, unknown>; metadata?: Record<string, unknown> };

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

const SITE = "repos/goal-host-vessel/src/index.ts";
function ordinary(id: string, over: Partial<Gap> = {}, meta: Record<string, unknown> = {}): Gap {
  return {
    id,
    summary: `The ${id} producer needs a repair so the walk reaches.`,
    category: "missing_capability",
    source: "substrate_detected",
    ...over,
    classification_metadata: { falsifier: "none", edit_site: SITE, ...meta },
  };
}

describe("gap-goal supply skips a landing that awaits its verdict", () => {
  it("CONTROL an ordinary un-held open gap still becomes a goal", async () => {
    expect(await goalGapIds([ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a pending_verification gap (classification_metadata) is not turned into a goal", async () => {
    const g = ordinary("pending-gap", {}, { disposition: "pending_verification", pending_outcome_verification: "abcdef1234" });
    expect(await goalGapIds([g, ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a pending_verification gap carried in metadata is not turned into a goal", async () => {
    const g: Gap = { id: "pending-meta-gap", summary: "The pending-meta-gap producer needs a repair so the walk reaches.", category: "missing_capability", source: "substrate_detected", metadata: { falsifier: "none", edit_site: SITE, disposition: "pending_verification" } };
    expect(await goalGapIds([g, ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a pending_verification gap with regressed_by null is not turned into a goal", async () => {
    const g = ordinary("pending-null-regress-gap", {}, { disposition: "pending_verification", regressed_by: null });
    expect(await goalGapIds([g, ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("CONTROL a pending_verification gap whose landing regressed is a goal again", async () => {
    const g = ordinary("regressed-gap", {}, { disposition: "pending_verification", regressed_by: "1234567abc" });
    expect(await goalGapIds([g])).toEqual(["regressed-gap"]);
  });

  it("CONTROL a pending_verification gap whose behavioral verification failed is a goal again", async () => {
    const g = ordinary("verify-failed-gap", { summary: "The verify-failed-gap producer needs a repair so the walk reaches. BEHAVIORAL VERIFICATION FAILED after landing." }, { disposition: "pending_verification" });
    expect(await goalGapIds([g])).toEqual(["verify-failed-gap"]);
  });
});

// THE PARITY CONTRACT WITH development-vessel: the same fixture file, byte for byte, drives dv's
// isAwaitingLandVerification (src/judge/gap-eligibility.ts) and this mirror. Each case is a row's summary and
// classification_metadata (the cutover_* cases copy dv stampPendingLand's metadata write key for key) and whether
// the hold holds it. A case is checked on the predicate and through the supply: a held row is never a goal.
type HoldFixture = { summary: string; classification_metadata: Record<string, unknown>; expected_held: boolean };
const FIXTURES = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "land-verification-hold-fixtures.json"), "utf-8")) as Record<string, HoldFixture | string>;
const CASES = Object.entries(FIXTURES).filter((e): e is [string, HoldFixture] => !e[0].startsWith("_"));

describe("land-verification hold: the fixtures shared with development-vessel", () => {
  it("CONTROL the shared fixture set is present", () => {
    expect(CASES.length).toBeGreaterThan(0);
  });
  for (const [name, f] of CASES) {
    it(`${f.expected_held ? "held" : "not held"}: ${name}`, async () => {
      const row = { id: name, summary: f.summary, category: "missing_capability", source: "substrate_detected", classification_metadata: f.classification_metadata };
      expect(isAwaitingLandVerification(row)).toBe(f.expected_held);
      // Through the supply the summary is led by an ordinary gap sentence: a bare "fixture" summary is not one the
      // supply mints a goal from, held or not. The case's own summary follows it unchanged.
      const supplied = { ...row, summary: `The ${name} producer needs a repair so the walk reaches. ${f.summary}` };
      expect((await goalGapIds([supplied])).includes(name)).toBe(!f.expected_held);
    });
  }
});
