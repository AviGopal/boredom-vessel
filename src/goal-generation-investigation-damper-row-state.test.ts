import { afterEach, describe, expect, it } from "bun:test";
import * as gg from "./goal-generation";
import { rowStateFingerprint } from "./row-state";

// A1(S): THE INVESTIGATION DAMPER COMPARES THE ROW-INPUT FINGERPRINT S WHEN THE STAMP CARRIES IT.
// development-vessel keeps its legacy decline stamp (investigation_declined.fingerprint, byte-identical) and adds
// investigation_declined.row_state = S (row-state.ts). The legacy fingerprint holds the LAST failure lesson with its `at`,
// and the decline itself writes a decomposition_refusal lesson, so the legacy compare re-armed the row after every
// refusal and the damper never held. S leaves those writes out.
//   - MUST-FAIL: a refusal-only change (a decomposition_refusal lesson, decomposed_at, decomposition) with row_state →
//     still skipped (the legacy compare dispatches it);
//   - MUST-FAIL: row_state equal while only an `at` moved → skipped;
//   - MUST-FAIL: row_state differs (a parent check rewrote the falsifier fields) while the legacy parts are equal →
//     dispatched;
//   - CONTROL: row_state absent → the legacy compare exactly (the existing damper fixtures pass unchanged, in their
//     own test file; here one equal and one changed legacy stamp).

type Gap = { id: string; summary: string; status?: string; category?: string; source?: string; classification_metadata?: Record<string, unknown> };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
async function offered(gaps: Gap[]): Promise<string[]> {
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/v2/impulses/resolve")) return { ok: true, status: 200, json: async () => ({ body: { gaps } }) };
    if (u.endsWith("/resolve")) return { ok: true, status: 200, json: async () => ({ body: { dispatches: [] } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return (await gg.generateGapGoalCandidates("http://activity-api.test", "test-key")).map((c) => c.gapId);
}
const verify = { at: "2030-01-01T01:00:00.000Z", class: "verify_failed", reason: "its check reads absent on the current tree" };
/** The row as development-vessel stamped it. */
const stamped = (): Gap => ({
  id: "fixture-declined", status: "open", category: "missing_capability", source: "substrate_detected",
  summary: "The fixture producer needs a repair so the walk reaches. Its body is empty.",
  classification_metadata: { falsifier: "none", evidence_resolve: { shape: "substrateGap" }, failure_lessons: [verify] },
});
/** dv's legacy fingerprint text for a row (its readable parts; arming is dv's own). */
const legacy = (g: Gap): string => {
  const ls = (g.classification_metadata!.failure_lessons as Array<{ class: string; reason: string; at: string }>);
  const last = ls[ls.length - 1]!;
  return JSON.stringify({ why: "investigation_declined", falsifier: "none", edit_site: "", arming: "unarmed", last_outcome: [last.class, last.reason.slice(0, 300), last.at] });
};
/** The row the supply reads now: `now`, carrying the stamp written for `then`. */
const withStamp = (now: Gap, then: Gap, rowState: boolean): Gap => ({
  ...now,
  classification_metadata: { ...now.classification_metadata, investigation_declined: { fingerprint: legacy(then), at: "2030-01-01T02:00:00.000Z", reason: "needs_information: no readable edit site", ...(rowState ? { row_state: rowStateFingerprint(then) } : {}) } },
});
const refusalOnly = (): Gap => {
  const g = stamped();
  const m = g.classification_metadata!;
  m.failure_lessons = [verify, { at: "2030-01-01T02:00:00.000Z", class: "decomposition_refusal", reason: "no valid step: step 1: no single source file or no change" }];
  m.decomposed_at = "2030-01-01T02:00:00.000Z";
  m.decomposition = { children: [], reason: "no valid step" };
  return g;
};

describe("the investigation damper compares S when the stamp carries row_state", () => {
  it("MUST-FAIL a refusal-only row change with row_state is still skipped", async () => {
    const row = withStamp(refusalOnly(), stamped(), true);
    expect(gg.investigationDeclinedUnchanged(row)).toBe(true);
    expect(await offered([row])).toEqual([]);
  });
  it("MUST-FAIL row_state equal while only an `at` moved: skipped", async () => {
    const now = stamped();
    now.classification_metadata!.failure_lessons = [{ ...verify, at: "2030-02-01T00:00:00.000Z" }];
    now.classification_metadata!.falsifier_classified_at = "2030-02-01T00:00:00.000Z";
    const row = withStamp(now, stamped(), true);
    expect(gg.investigationDeclinedUnchanged(row)).toBe(true);
    expect(await offered([row])).toEqual([]);
  });
  it("MUST-FAIL row_state differs (a parent check) while the legacy parts are equal: dispatched", async () => {
    const now = stamped();
    Object.assign(now.classification_metadata!, { predicate_source: "gap_falsify:parent_check", verify_shape: "gap_status", evidence_resolve: { shape: "substrateGap", pointer: { parent_gap_id: "fixture-declined" } } });
    const row = withStamp(now, stamped(), true);
    expect(gg.investigationDeclinedUnchanged(row)).toBe(false);
    expect(await offered([row])).toEqual(["fixture-declined"]);
  });
  it("CONTROL row_state absent: the legacy compare exactly (equal legacy parts skip; a refusal lesson re-arms)", async () => {
    const same = withStamp(stamped(), stamped(), false);
    expect(gg.investigationDeclinedUnchanged(same)).toBe(true);
    expect(await offered([same])).toEqual([]);
    const moved = withStamp(refusalOnly(), stamped(), false);
    expect(gg.investigationDeclinedUnchanged(moved)).toBe(false);
    expect(await offered([moved])).toEqual(["fixture-declined"]);
  });
  it("CONTROL a non-string row_state is ignored (the legacy compare decides); no stamp never skips", () => {
    const row = withStamp(stamped(), stamped(), false);
    (row.classification_metadata!.investigation_declined as Record<string, unknown>).row_state = 7;
    expect(gg.investigationDeclinedUnchanged(row)).toBe(true);
    expect(gg.investigationDeclinedUnchanged(stamped())).toBe(false);
  });
});
