import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as rs from "./row-state";

// THE ROW-INPUT FINGERPRINT S (row-state.ts): one stable hash of a gap row's inputs. A gap-goal arm's evidence belongs
// to S (selection-traps.ts gap_goal_forgive), so S must not move when only the investigation's own write-back moves.
// The vectors (src/fixtures/row-state-vectors.json) are the parity contract with development-vessel's twin, byte for
// byte: each names its row, the canonical serialization and S.
//   - (a) a decomposition_refusal lesson plus a new decomposed_at / decomposition only → SAME S;
//   - (b) a parent check (predicate_source / verify_shape / evidence_resolve rewritten) → DIFFERENT S;
//   - (c) a lesson of another class (a compose attempt) → DIFFERENT S (a pinned design choice);
//   - (d) only *_at keys change, at any depth, including a lesson's `at` → SAME S;
//   - (f) a re-emission of the same row rewriting only the summary's rolling counts and occurrence_count /
//     example_trace_ids → SAME S (the summary is not in S).

type Vector = { name: string; note: string; row: unknown; canonical: string; s: string; same_as?: string; differs_from?: string };
const FIX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "row-state-vectors.json"), "utf-8")) as { vectors: Vector[] };
const V = new Map(FIX.vectors.map((v) => [v.name, v]));
const S = (name: string): string => rs.rowStateFingerprint(V.get(name)!.row);

describe("row-state fingerprint: the shared vectors", () => {
  it("CONTROL the vector set is present and names fixtures a to d", () => {
    expect(FIX.vectors.length).toBeGreaterThanOrEqual(8);
    for (const n of ["base", "a_refusal_only_change", "b_parent_check", "c_other_lesson_class", "d_only_at_keys_changed", "f_reemission_counts_only"]) expect(V.has(n)).toBe(true);
  });
  for (const v of FIX.vectors) {
    it(`vector ${v.name}: canonical serialization and S match byte for byte`, () => {
      expect(rs.rowStateCanonical(v.row)).toBe(v.canonical);
      expect(rs.rowStateFingerprint(v.row)).toBe(v.s);
      expect(createHash("sha256").update(v.canonical, "utf8").digest("hex")).toBe(v.s);
      if (v.same_as) expect(v.s).toBe(V.get(v.same_as)!.s);
      if (v.differs_from) expect(v.s).not.toBe(V.get(v.differs_from)!.s);
    });
  }
});

describe("row-state fingerprint: fixtures a to d by behaviour", () => {
  it("(a) a refusal-only change (decomposition_refusal lesson, decomposed_at, decomposition) keeps S", () => {
    expect(S("a_refusal_only_change")).toBe(S("base"));
  });
  it("(b) a parent check changes S: a new check is a real change", () => {
    expect(S("b_parent_check")).not.toBe(S("base"));
  });
  it("(c) a lesson of another class changes S", () => {
    expect(S("c_other_lesson_class")).not.toBe(S("base"));
  });
  it("(d) only *_at keys changed keeps S", () => {
    expect(S("d_only_at_keys_changed")).toBe(S("base"));
  });
  it("(f) a detector re-emission that rewrites only the summary's rolling counts and occurrence_count / example_trace_ids keeps S", () => {
    expect(S("f_reemission_counts_only")).toBe(S("base"));
  });
  it("the excluded fields are absent from the canonical form; the included ones are present", () => {
    const c = rs.rowStateCanonical(V.get("base")!.row);
    for (const k of ["\"summary\"", "occurrence_count", "example_trace_ids", "decomposition", "decomposed_at", "investigated_at", "investigation_declined", "falsifier_classified_at", "checked_at", "decomposition_refusal", "\"at\""]) expect(c).not.toContain(k);
    for (const k of ["\"status\"", "\"category\"", "\"falsifier\":\"class1\"", "\"evidence_resolve\"", "\"verify_shape\"", "\"predicate_source\"", "\"edit_site\"", "\"parent_gap_id\":\"fixture-row-parent\"", "verify_failed"]) expect(c).toContain(k);
  });
  it("shortRowState prints the first 8 hex characters, or '-' when there is no S", () => {
    expect(rs.shortRowState(S("base"))).toBe(S("base").slice(0, 8));
    expect(rs.shortRowState(undefined)).toBe("-");
  });
});
