import { describe, it, expect, afterEach } from "bun:test";
import { generateGapGoalCandidates } from "./goal-generation";

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

  // dv's cutover stamp (development-vessel src/resolvers/vessel-mitosis-cutover.ts stampPendingLand, the
  // classification_metadata it writes at :251-273): the stored metadata spread, then the landed sha and its
  // bookkeeping, and no disposition. Copied key for key for both arms of its landed_unverified ternary; the
  // removed-line predicate arm is left out (it needs a git show of the landing).
  const NEW_SHA = "0123456789abcdef0123456789abcdef01234567";
  const APPLIED_AT = "2026-10-23T00:00:00.000Z";
  function cutoverStamped(id: string, landedUnverifiedReason: string | null, measurable: boolean): Gap {
    const stampRow = ordinary(id);
    const stampMeta = stampRow.classification_metadata!;
    const unmeasurable = measurable ? null : { reason: "no_predicate", at: APPLIED_AT, sha: NEW_SHA, asked: `needs-human-${id}` };
    return {
      ...stampRow,
      status: "open",
      classification_metadata: {
        ...stampMeta,
        pending_outcome_verification: NEW_SHA,
        pending_set_at: APPLIED_AT,
        ...(landedUnverifiedReason !== null
          ? { landed_unverified: true, landed_unverified_reason: landedUnverifiedReason, landed_unverified_sha: NEW_SHA }
          : { landed_unverified: false, landed_unverified_reason: "", landed_unverified_sha: "" }),
        pending_unmeasurable: unmeasurable ?? "",
      },
    } as Gap;
  }

  it("MUST-FAIL a gap carrying dv's cutover pending-land stamp is not turned into a goal", async () => {
    expect(await goalGapIds([cutoverStamped("cutover-gap", null, true), ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("MUST-FAIL a gap carrying dv's cutover stamp of an unverified, unmeasurable landing is not turned into a goal", async () => {
    expect(await goalGapIds([cutoverStamped("cutover-unverified-gap", "no post-land check ran", false), ordinary("plain-gap")])).toEqual(["plain-gap"]);
  });

  it("CONTROL a cleared landed-sha stamp (\"\") does not drop a gap", async () => {
    const g = ordinary("sha-cleared-gap", {}, { pending_outcome_verification: "" });
    expect(await goalGapIds([g])).toEqual(["sha-cleared-gap"]);
  });
});
