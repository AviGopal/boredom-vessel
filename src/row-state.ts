// ROW-INPUT FINGERPRINT (S): one stable hash of the inputs of a gap row, the state a gap-goal arm's evidence belongs to.
//
// A gap-goal arm (`gap-goal:<row>`) is graded on what its walk did with the row. Its evidence should be forgiven when the
// row changes, not when a clock runs out (selection-traps.ts, gap_goal_forgive). S is that "row changed" test. It covers
// only fields something OTHER than the investigation writes, so the investigation's own write-back cannot re-arm it:
//   included: status, category; the falsifier (its class, lower-cased) plus evidence_resolve, verify_shape and
//             predicate_source; the edit site (gapEditSite's field order: edit_site, file_path, change_site, path, then a
//             top-level file_path); parent_gap_id; and each failure lesson whose class is not decomposition_refusal, as
//             [class, reason sliced to 300 UTF-16 code units] (no `at`).
//   excluded: decomposed_at, decomposition (children, reason, parent_check), investigated_at, investigation_declined, every
//             key ending in `_at` (at any depth), decomposition_refusal lessons, and every lesson's `at`; and the summary,
//             because a detector re-emitting the same stable-id row rewrites its summary with rolling counts on every
//             emission (as it does occurrence_count / example_trace_ids, also left out), and that is not a new input.
// A parent check rewrites evidence_resolve / verify_shape / predicate_source, so it changes S: a new check is a real change.
//
// CANONICAL SERIALIZATION (the parity contract with development-vessel's twin; src/fixtures/row-state-vectors.json):
//   1. Build the object { category, edit_site, evidence_resolve, failure_lessons, falsifier, parent_gap_id,
//      predicate_source, status, verify_shape } as below; drop every object key ending in `_at` at any depth.
//   2. Serialize it as JSON with no whitespace: object keys sorted at every depth in ascending UTF-16 code-unit order
//      (JavaScript's default Array.prototype.sort on strings; integer-like keys get no special place), keys whose value
//      is undefined omitted, arrays in their own order, each string, number, boolean and null exactly as JSON.stringify
//      writes it alone (non-ASCII characters written as themselves, not as \u escapes; a non-finite number is null).
//   3. S = lowercase hex sha256 of that string's UTF-8 bytes. Logs print its first 8 hex characters.

import { createHash } from "node:crypto";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** Canonical JSON (step 2 above), written out by hand: an engine's own JSON.stringify puts integer-like keys first in
 *  numeric order whatever the insertion order, so the key order is emitted explicitly here. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === "function" || typeof x === "symbol" ? "null" : canonicalJson(x))).join(",")}]`;
  if (isRec(v)) {
    const parts: string[] = [];
    for (const k of Object.keys(v).sort()) {
      const x = v[k];
      if (k.endsWith("_at") || x === undefined || typeof x === "function" || typeof x === "symbol") continue;
      parts.push(`${JSON.stringify(k)}:${canonicalJson(x)}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The fields S covers, before serialization. */
export function rowStateInputs(row: unknown): Rec {
  const r = isRec(row) ? row : {};
  const meta = isRec(r.classification_metadata) ? r.classification_metadata : isRec(r.metadata) ? r.metadata : {};
  const raw = meta.falsifier;
  const falsifier = String((raw && typeof raw === "object" ? (raw as { class?: unknown }).class : raw) ?? "").toLowerCase();
  let site = "";
  for (const f of ["edit_site", "file_path", "change_site", "path"]) { const v = meta[f]; if (typeof v === "string" && v.trim()) { site = v.trim(); break; } }
  if (!site && typeof r.file_path === "string" && r.file_path.trim()) site = r.file_path.trim();
  const lessons: Array<[string, string]> = [];
  for (const l of Array.isArray(meta.failure_lessons) ? meta.failure_lessons : []) {
    if (!isRec(l)) continue;
    const cls = String(l.class ?? "");
    if (cls === "decomposition_refusal") continue;
    lessons.push([cls, String(l.reason ?? "").slice(0, 300)]);
  }
  return {
    category: String(r.category ?? ""),
    edit_site: site,
    evidence_resolve: meta.evidence_resolve ?? null,
    failure_lessons: lessons,
    falsifier,
    parent_gap_id: String(meta.parent_gap_id ?? r.parent_gap_id ?? ""),
    predicate_source: meta.predicate_source ?? null,
    status: String(r.status ?? ""),
    verify_shape: meta.verify_shape ?? null,
  };
}

/** The canonical serialization S hashes (step 2 above). */
export function rowStateCanonical(row: unknown): string {
  return canonicalJson(rowStateInputs(row));
}

/** S: lowercase hex sha256 of the canonical serialization's UTF-8 bytes. */
export function rowStateFingerprint(row: unknown): string {
  return createHash("sha256").update(rowStateCanonical(row), "utf8").digest("hex");
}

/** The short form every log line carries (`S=<8 hex>`); "-" when there is no row. */
export function shortRowState(s: string | undefined | null): string {
  return typeof s === "string" && s.length >= 8 ? s.slice(0, 8) : "-";
}
