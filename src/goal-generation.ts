import { rowStateFingerprint } from "./row-state";

/** Structured run-goal fields a gap goal carries (CHANGE-35): its target shapes and bound variables. */
export interface GapGoalRunFields { expected_output_shapes: string[]; variables: Record<string, string> }
/**
 * sanitizeGoalText — strip recursive gap/decompose prefix nesting and cap length.
 *
 * Gap-closing goals accumulate unbounded chains of `Close substrate gap <id>:`
 * prefixes as they are narrowed, decomposed, and re-dispatched. This makes goal
 * text unintelligible to both the target-inference LLM and the template selector,
 * explaining ~40% of reach failures. This function:
 *   1. Strips recursive `Close substrate gap <id>:` nesting beyond depth 1
 *   2. Strips recursive `investigate and decompose (gap|goal):` nesting
 *   3. Normalizes `[narrowed from <id>]` to `[narrowed]`
 *   4. Caps at 500 chars, cutting from the MIDDLE (see capGoalTextKeepingHead)
 */
export function sanitizeGoalText(raw: string): string {
  if (!raw || typeof raw !== "string") return raw ?? "";
  let text = raw;

  // Strip recursive "Close substrate gap <id>:" prefixes, keeping only the innermost
  // Pattern: "Close substrate gap <id>: Close substrate gap <id>: ... <actual content>"
  const CLOSE_GAP_RE = /^(?:Close substrate gap [\w:.!-]+:\s*)+/;
  const closeMatch = text.match(CLOSE_GAP_RE);
  if (closeMatch) {
    // Find all individual gap references
    const gapRefs = closeMatch[0].match(/Close substrate gap [\w:.!-]+:/g) ?? [];
    if (gapRefs.length > 1) {
      // Keep only the innermost (last) gap reference
      const innermost = gapRefs[gapRefs.length - 1];
      text = innermost + " " + text.slice(closeMatch[0].length).trimStart();
    }
  }

  // Strip recursive "investigate and decompose gap/goal <id>:" prefixes
  const DECOMPOSE_RE = /^(?:investigate and decompose (?:gap|goal)[:\s]+(?:[\w:.!-]+[:\s]+)?)+/i;
  const decompMatch = text.match(DECOMPOSE_RE);
  if (decompMatch && decompMatch[0].length > 60) {
    // Strip all but keep the remaining content
    text = text.slice(decompMatch[0].length).trimStart();
    // If the remaining starts with a gap close or meaningful content, prepend
    // a single "investigate and decompose: " marker
    if (text.length > 0 && !/^investigate/i.test(text)) {
      text = "investigate and decompose: " + text;
    }
  }

  // Normalize [narrowed from <id>] annotations to [narrowed]
  text = text.replace(/\[narrowed from [\w:.!-]+\]/g, "[narrowed]");

  // Cap at 500 chars, keeping the head (the ask and its gap id) and cutting the middle.
  // EXEMPT A WELL-FORMED EDIT GOAL. The cap exists to stop prefix-accreted prose from
  // growing without bound, and cutting is the right choice for that. But a
  // goal carrying an anchor fence and a replacement fence is structured, not verbose:
  // cutting it anywhere breaks the two-fence pair synthesizeVerbatimEditOps requires,
  // and keeping the TAIL specifically discards the anchor while retaining the
  // replacement — leaving an edit with nothing to match against. The prefix strippers
  // above already remove the unbounded-growth term for this class, so exempting it
  // does not reopen the accretion this cap was added to bound.
  const hasAnchorAndReplacement = (text.match(/```/g) ?? []).length >= 2;
  if (text.length > 500 && !hasAnchorAndReplacement) {
    text = capGoalTextKeepingHead(text, 500);
  }

  return text.trim();
}

// The gap-id token the prefix strippers above match (`[\w:.!-]+`), here unanchored.
const GOAL_ANCHOR_RES: RegExp[] = [
  /\bgap[:\s]+([\w:.!-]+)/gi,          // a gap id named after the word "gap"
  /\b(concept_[A-Za-z0-9_-]+)/g,        // a concept id
  /\b(repos\/[\w.-]+\/src\/[\w./-]+)/g, // an edit site: goal-host's edit-intent routing greps for it
];
function goalAnchors(text: string): string[] {
  const out: string[] = [];
  for (const re of GOAL_ANCHOR_RES) {
    for (const m of text.matchAll(re)) {
      const id = (m[1] ?? "").replace(/[:.!]+$/, "");
      // "gap failure", "gap in": a bare word is prose, not an id.
      if (id && /[-_:.\d/]/.test(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/**
 * capGoalTextKeepingHead — fit a goal into `cap` chars by cutting its MIDDLE.
 *
 * Keeping the tail cut the head, and the head is the ask ("Close substrate gap <id>: …"):
 * ~15% of generated goals reached the walk with no ask and no gap id. Priority within the
 * budget: the leading ask (through its first ": "), then every gap/concept id and edit site
 * that would otherwise be cut (listed in the marker), then as much tail as still fits.
 */
export function capGoalTextKeepingHead(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const askEnd = text.search(/:\s/);
  const minHead = askEnd >= 0 && askEnd < cap / 2 ? askEnd + 1 : 0;
  let head = Math.max(minHead, Math.floor(cap * 0.55));
  const sp = text.lastIndexOf(" ", head);
  if (sp > minHead && head - sp < 40) head = sp;
  const digits = String(text.length).length;
  const markerFor = (n: string, ids: string[], more: number) =>
    ` … [cut ${n} chars${ids.length ? "; ids: " + ids.join(" ") : ""}${more ? ` +${more} ids` : ""}] … `;
  // A tail starting at `len` chars from the end, moved forward to a word start.
  const tailStartFor = (len: number) => {
    const start = text.length - Math.max(0, len);
    const tsp = text.indexOf(" ", start);
    return len > 0 && tsp >= 0 && tsp - start < 40 ? tsp + 1 : start;
  };
  const tailFor = (ids: string[], more: number) => cap - head - markerFor("9".repeat(digits), ids, more).length;
  // Ids past the head; list the ones that fit (tail may shrink to nothing for them).
  const headText = text.slice(0, head);
  const rest = goalAnchors(text.slice(head)).filter((id) => !headText.includes(id));
  const kept: string[] = [];
  for (const id of rest) if (tailFor([...kept, id], rest.length - kept.length - 1) >= 0) kept.push(id);
  const more = rest.length - kept.length;
  // An id the tail already carries needs no listing; unlisting only grows the tail, so it stays kept.
  const inTail = text.slice(tailStartFor(tailFor(kept, more)));
  const listed = kept.filter((id) => !inTail.includes(id));
  const tailStart = tailStartFor(tailFor(listed, more));
  return text.slice(0, head) + markerFor(String(tailStart - head), listed, more) + text.slice(tailStart);
}

// ── ADMISSION MIRROR — one admission policy (wire D, 2026-07-30) ──────────────────────
// development-vessel's admitActionableGaps (repos/development-vessel/src/resolvers/
// gap-to-feature.ts, commit 76f44ca) is the AUTHORITATIVE admission gate for auto-selected
// gaps, but it is not resolvable through the shape plane: the substrateGap read resolver
// exposes only id/category/source/status/exclude_categories pointer filters — no admitted
// set. Boredom minting gap-goals from the RAW substrateGap window therefore ran a second,
// divergent admission policy.
// TODO-gap (missing resolvable shape): dev-vessel should serve the admitted set through the
// shape plane — either a substrateGap pointer flag (e.g. `admitted_only: true`) or a
// dedicated `actionableGaps` shape that runs admitActionableGaps server-side. When that
// exists, boredom must resolve THROUGH it and this mirror (plus the inline confab-producer
// guard below) must be DELETED.
// Until then this is a clearly-marked MIRROR of the gate's data-only predicate: the
// orphan/unreachable hard-exclusions, computable from gap data alone. The gate's other two
// arms — typecheck-phantom retire and proposal/cited-file admits — need dev-vessel-local
// state (tsc runs, proposal reports, repos dirs) and CANNOT be mirrored here; those gaps
// fall through ADMITTED, matching the gate's conservative default (unknown => admit).
const MIRROR_EXCLUDE_ORPHAN_AFTER_FAILS = 1; // mirrors EXCLUDE_ORPHAN_AFTER_FAILS
export function admitActionableGapsMirror<T extends { id: string; category?: string; classification_metadata?: Record<string, unknown> }>(gaps: T[]): T[] {
  return gaps.filter((g) => {
    const id = String(g.id ?? "");
    const cat = String(g.category ?? "");
    const meta = (g.classification_metadata ?? (g as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>;
    const failedAttempts = Number(meta.failed_attempts ?? 0);
    const isOrphanClass = cat === "orphaned_capability" || cat === "unreachable_producer" || /orphaned[_-]capability/i.test(id);
    if (!isOrphanClass) return true;
    // mirror: orphan_no_producer — one auto-shot only; a failed mint = structurally un-provisionable
    if (failedAttempts >= MIRROR_EXCLUDE_ORPHAN_AFTER_FAILS) return false;
    // mirror: orphan_missing_shape — its route needs meta.shape
    if (cat === "orphaned_capability" && !String(meta.shape ?? "").trim()) return false;
    return true;
  });
}

// ── OWNERSHIP FILTER — gaps this supply must not walk at ─────────────────────────────────
// This supply dispatches WALKS (POST /run-goal, tags boredom_autonomous + gap_generated), and a
// walk can write substrateGap_write on the gap it was dispatched at. Measured: two such walks
// closed, re-sourced and overwrote the summary of operator-owned gaps with no verdict. A gap
// that already has an owner is not idle work:
//   directed        — handed to a specific compose (top-level or classification_metadata flag)
//   operator_hold   — the operator froze it (dev-vessel also hides these from the default open
//                     read; this is the supply-side check in case a window ever carries one)
//   human_reported  — a human resolver filed it; the operator owns its disposition
//   operator_supply — classification_metadata.supply names an operator finding
//   excluded_site   — edit_site is marked "(excluded: operator)": outside the autonomy scope
//   class2_armed    — falsifier class2 with an evidence_resolve: the compose lane's
//                     (gap_to_feature) to close against its measured check, not a walk's
//   pending_verification — a landing awaits its verdict (isAwaitingLandVerification below):
//                     re-walking it re-lands a change the landing sweep is still judging
// NOT checked here: edit_site paths inside the autonomy scope's excluded list — this supply
// does not read the autonomy scope, so only the explicit "(excluded: operator)" marker is seen.
export type OwnershipDropReason = "directed" | "operator_hold" | "pending_verification" | "human_reported" | "operator_supply" | "excluded_site" | "class2_armed";
type OwnedGap = { source?: unknown; directed?: unknown; summary?: unknown; classification_metadata?: Record<string, unknown>; metadata?: Record<string, unknown> };
/** MIRROR of development-vessel's isAwaitingLandVerification (src/judge/gap-eligibility.ts:146), the predicate its
 *  compose eligibility and admission skip on: disposition pending_verification with nothing yet saying the landing
 *  failed (regressed_by, or a BEHAVIORAL VERIFICATION FAILED summary, makes the gap work again). WIDER by one form:
 *  a landed-sha stamp (pending_outcome_verification, read as dv's pending-land sweep reads it, length >= 7,
 *  src/judge/gap-landing-verdict.ts:300) also holds. dv's cutover stamp (stampPendingLand) writes only that sha, no
 *  disposition, so the disposition alone missed every cutover landing; the sweep clears the stamp with "". The
 *  shared fixtures (src/fixtures/land-verification-hold-fixtures.json) are the parity contract with dv's predicate. */
export function isAwaitingLandVerification(gap: OwnedGap): boolean {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  // A RELEASED stamp holds nothing: dv's release clears the disposition, keeps the sha and records it as
  // pending_released_sha, so a stamp equal to it is a landing already judged not to have fixed the gap.
  const landedSha = typeof meta.pending_outcome_verification === "string" && meta.pending_outcome_verification.length >= 7
    && meta.pending_outcome_verification !== meta.pending_released_sha;
  if (meta.disposition !== "pending_verification" && !landedSha) return false;
  if (meta.regressed_by !== undefined && meta.regressed_by !== null) return false;
  if (String(gap.summary ?? "").includes("BEHAVIORAL VERIFICATION FAILED")) return false;
  return true;
}
/** MIRROR of development-vessel's investigation-decline stamp (src/resolvers/gap-to-feature.ts, the decompose branch
 *  gapDecomposition reaches): a needs_information decline stamps classification_metadata.investigation_declined =
 *  { fingerprint: chronicEscalationFingerprint(row, "investigation_declined"), at, reason }. True while the stamped
 *  fingerprint's READABLE row parts are unchanged: falsifier (its class, lower-cased), edit_site (dv gapEditSite's order:
 *  edit_site, file_path, change_site, path, then a top-level file_path) and the last failure lesson's [class, reason sliced
 *  to 300, at]. Its arming part is dv's own and is taken as given. A row change earns the retry; a missing or unparseable
 *  stamp never skips. The shared fixtures (src/fixtures/investigation-decline-damper-fixtures.json) are the parity contract
 *  with dv's stamp. A stamp that also carries row_state (S) is compared by S instead (see below; the S vectors in
 *  src/fixtures/row-state-vectors.json are that parity contract). */
export function investigationDeclinedUnchanged(gap: OwnedGap & { file_path?: unknown }): boolean {
  const meta = (gap.classification_metadata ?? gap.metadata ?? {}) as Record<string, unknown>;
  const stamp = meta.investigation_declined as { fingerprint?: unknown; row_state?: unknown } | undefined;
  if (!stamp || typeof stamp !== "object") return false;
  // A1(S): development-vessel also stamps the row-input fingerprint S of the declined row (row_state, row-state.ts).
  // When present it decides alone: unchanged while the row's S is the same, so the decline's own write-back (a
  // decomposition_refusal lesson, decomposed_at / decomposition, any *_at) does not re-arm it. Absent: the legacy compare.
  if (typeof stamp.row_state === "string") return stamp.row_state === rowStateFingerprint(gap);
  if (typeof stamp.fingerprint !== "string") return false;
  let fp: { falsifier?: unknown; edit_site?: unknown; last_outcome?: unknown };
  try { fp = JSON.parse(stamp.fingerprint) as typeof fp; } catch { return false; }
  if (!fp || typeof fp !== "object") return false;
  const raw = meta.falsifier as unknown;
  const falsifier = String((raw && typeof raw === "object" ? (raw as { class?: unknown }).class : raw) ?? "").toLowerCase();
  let site = "";
  for (const f of ["edit_site", "file_path", "change_site", "path"]) { const v = meta[f]; if (typeof v === "string" && v.trim()) { site = v.trim(); break; } }
  if (!site && typeof gap.file_path === "string" && gap.file_path.trim()) site = gap.file_path.trim();
  const lessons = Array.isArray(meta.failure_lessons) ? meta.failure_lessons as Array<Record<string, unknown> | null> : [];
  const last = lessons[lessons.length - 1] ?? null;
  const lastOutcome = last ? [String(last.class ?? ""), String(last.reason ?? "").slice(0, 300), String(last.at ?? "")] : null;
  return fp.falsifier === falsifier && fp.edit_site === site && JSON.stringify(fp.last_outcome ?? null) === JSON.stringify(lastOutcome);
}
/** How many of a row's decomposition children (classification_metadata.decomposition.children) are in `openIds`.
 *  TEMPORARY: read only by the gap-goal supply's open-children skip (see its removal condition there). */
export function openDecompositionChildren(meta: Record<string, unknown> | null | undefined, openIds: ReadonlySet<string>): number {
  const d = meta?.decomposition as { children?: unknown } | null | undefined;
  const children = d && typeof d === "object" && Array.isArray(d.children) ? d.children : [];
  return new Set(children.filter((c): c is string => typeof c === "string" && openIds.has(c))).size;
}
export function operatorOwnedReason(g: OwnedGap): OwnershipDropReason | null {
  const meta = (g.classification_metadata ?? {}) as Record<string, unknown>;
  if (g.directed === true || meta.directed === true) return "directed";
  if (meta.operator_hold === true) return "operator_hold";
  if (isAwaitingLandVerification(g)) return "pending_verification";
  if (g.source === "human_reported") return "human_reported";
  if (/^operator/i.test(String(meta.supply ?? ""))) return "operator_supply";
  if (String(meta.edit_site ?? "").includes("(excluded: operator)")) return "excluded_site";
  if (meta.falsifier === "class2" && meta.evidence_resolve != null) return "class2_armed";
  return null;
}
export function dropOperatorOwnedGaps<T extends OwnedGap>(gaps: T[]): { kept: T[]; dropped: Record<OwnershipDropReason, number> } {
  const dropped: Record<OwnershipDropReason, number> = { directed: 0, operator_hold: 0, pending_verification: 0, human_reported: 0, operator_supply: 0, excluded_site: 0, class2_armed: 0 };
  const kept = gaps.filter((g) => {
    const reason = operatorOwnedReason(g);
    if (reason) dropped[reason]++;
    return reason === null;
  });
  return { kept, dropped };
}

// ── UNARMED SRC-SITE ROWS (gap-goal-unarmed-skip) ─────────────────────────────────────────
// MIRROR of development-vessel's compose eligibility (src/judge/gap-eligibility.ts composeEligibilitySkipReason, its
// "unarmed" verdict): a row whose falsifier class (an object's .class or a string, lower-cased) is neither class1 nor
// class2, or whose check_supply ledger refused the very test_suite file its evidence_resolve runs, is refused by
// feature_compose as ineligible (unarmed). A gap goal for such a row whose edit_site names a src/ file routes to that
// compose and is refused there. dv's own check supply already sends every such open row a check-writing goal (or holds
// it in its parity control arm, or marks it scope_excluded or exhausted), so a walk at it adds a refusal and nothing
// else, and on a control-arm row it also touches the supply's control. The shared fixtures
// (src/fixtures/unarmed-src-site-fixtures.json) are the parity contract with dv's predicate.
const vesselFileOf = (file: unknown, vessel: unknown): { vessel: string | null; rel: string } | null => {
  if (typeof file !== "string" || !file.trim()) return null;
  const m = /^(?:\.\/)*(?:repos\/([^/]+)\/)?(.+)$/.exec(file.trim());
  if (!m) return null;
  return { vessel: m[1] ?? (typeof vessel === "string" && vessel ? vessel.replace(/^repos\//, "") : null), rel: m[2]! };
};
export function unarmedForCompose(meta: Record<string, unknown>): boolean {
  const raw = meta.falsifier as unknown;
  const cls = String((raw && typeof raw === "object" ? (raw as { class?: unknown }).class : raw) ?? "").toLowerCase();
  if (cls !== "class1" && cls !== "class2") return true;
  const ledger = meta.check_supply as { state?: unknown; test_file?: unknown; vessel?: unknown } | null | undefined;
  if (!ledger || typeof ledger !== "object" || ledger.state !== "arm_refused") return false;
  const er = meta.evidence_resolve as { shape?: unknown; input?: { test_file?: unknown; vessel?: unknown } } | null | undefined;
  if (!er || typeof er !== "object" || er.shape !== "test_suite" || !er.input || typeof er.input !== "object") return false;
  const refused = vesselFileOf(ledger.test_file, ledger.vessel);
  const check = vesselFileOf(er.input.test_file, er.input.vessel);
  return !!refused && !!check && refused.rel === check.rel && (!refused.vessel || !check.vessel || refused.vessel === check.vessel);
}
/** A gap goal's row is unarmed for compose and its edit_site names a src/ file (repos/<vessel>/src/… or src/…). */
export function unarmedSrcSite(meta: Record<string, unknown>): boolean {
  const site = String(meta.edit_site ?? "").trim();
  return /^(?:\.\/)*(?:repos\/[^/]+\/)?src\//.test(site) && unarmedForCompose(meta);
}

// The decision: whether the pool dispatches a gap goal for such a row when it wins the pick (index.ts
// pickByShapeAvailability), an activity selected by the activityVariantMask pool impulse.
//   - variant-0 (`boredom-vessel:gap-goal-unarmed-skip`, the control): dispatch it as before; the pick is marked.
//   - variant-1 (`…-v1`): dispatch the best unflagged candidate of the same ranking instead (none: nothing this pass).
// Read only at a pick a flagged candidate wins. Each decision logs one line and posts its own trace (output
// gapGoalUnarmedSkip); its grade is decided by its consumer, the goal that filled the slot: goal-host's reached verdict
// for that dispatch (reached / not reached); a slot filled by no goal-host walk, no dispatch, or no terminal read
// leaves it ungraded, logged.
export const UNARMED_SKIP_ACTIVITY = "boredom-vessel:gap-goal-unarmed-skip";
export const UNARMED_SKIP_CREDIT_ACTIVITY = "boredom-vessel:gap-goal-unarmed-skip-credit";
export const unarmedSkipVariantId = (variant: number): string => (variant === 0 ? UNARMED_SKIP_ACTIVITY : `${UNARMED_SKIP_ACTIVITY}-v${variant}`);
const GUS_LOG = `[${UNARMED_SKIP_ACTIVITY}]`;
/** How long a decision may wait for its slot's verdict before it is dropped as ungraded. */
const GUS_PENDING_MAX_MS = 2 * 60 * 60_000;
type GusMaskRow = { id?: string; body?: unknown };
type GusPending = { traceId: string; variant: number; gapId: string; dispatched: string; at: number };
export type UnarmedSkipDeps = {
  readMasks?: () => Promise<GusMaskRow[]>;
  postTrace?: (t: Record<string, unknown>) => Promise<number | null>;
  nowMs?: () => number;
};
let gusDeps: UnarmedSkipDeps = {};
let gusApi: { endpoint: string; apiKey: string } | null = null;
const gusPending = new Map<string, GusPending>();
let lastGusPoolLog = -Infinity;
let gusSeq = 0;
/** Tests only: the seams the decision and its credit use; pending decisions are dropped. */
export function __setUnarmedSkipDepsForTests(d: UnarmedSkipDeps | null): void { gusDeps = d ?? {}; gusPending.clear(); lastGusPoolLog = -Infinity; }
const gusNowMs = (): number => gusDeps.nowMs?.() ?? Date.now();
async function gusReadMasks(): Promise<GusMaskRow[]> {
  const dv = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
  const res = await fetch(`${dv}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(gusApi?.apiKey ? { Authorization: `ApiKey ${gusApi.apiKey}` } : {}) },
    body: JSON.stringify({ impulse: { type: "poolImpulse", shape: "activityVariantMask", status: "open" } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`pool answered HTTP ${res.status}`);
  const imps = ((await res.json()) as { body?: { impulses?: unknown } })?.body?.impulses;
  if (!Array.isArray(imps)) throw new Error("pool answered no impulses");
  return imps as GusMaskRow[];
}
async function gusPost(t: Record<string, unknown>, what: string): Promise<void> {
  try {
    const st = gusDeps.postTrace ? await gusDeps.postTrace(t) : gusApi ? await (async () => {
      const r = await fetch(`${gusApi!.endpoint}/v2/activities/execution-traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${gusApi!.apiKey}` },
        body: JSON.stringify(t),
        signal: AbortSignal.timeout(5_000),
      });
      try { await r.body?.cancel(); } catch { /* swallow */ }
      return r.status;
    })() : null;
    if (st === null || st < 200 || st >= 300) console.warn(`${GUS_LOG} ${what} not posted (http=${st ?? "none"})`);
  } catch (err) { console.warn(`${GUS_LOG} ${what} not posted: ${String((err as Error)?.message ?? err).slice(0, 160)}`); }
}
/** The variant in force for this activity (the newest open mask row whose [from, until) holds now). Never throws. */
export async function unarmedSkipVariant(nowIso: string): Promise<{ variant: number; why: string }> {
  let rows: GusMaskRow[];
  try {
    rows = await (gusDeps.readMasks ?? gusReadMasks)();
  } catch (err) {
    if (Date.now() - lastGusPoolLog >= 30_000) { lastGusPoolLog = Date.now(); console.log(`${GUS_LOG} pool_read shape=activityVariantMask ok=false`); }
    const why = `mask_unread (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0`;
    console.warn(`${GUS_LOG} ${why}`);
    return { variant: 0, why };
  }
  if (Date.now() - lastGusPoolLog >= 30_000) { lastGusPoolLog = Date.now(); console.log(`${GUS_LOG} pool_read shape=activityVariantMask ok=true`); }
  const now = Date.parse(nowIso);
  for (const r of rows) {
    const b = (r?.body ?? {}) as Record<string, unknown>;
    if (b["activity_id"] !== UNARMED_SKIP_ACTIVITY) continue;
    const from = Date.parse(String(b["from"] ?? "")), until = Date.parse(String(b["until"] ?? ""));
    if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until) continue;
    const v = b["active_variant"];
    if (v !== 0 && v !== 1) return { variant: 0, why: `mask ${String(r.id)} names unknown variant ${JSON.stringify(v)}: variant-0` };
    return { variant: v, why: `mask ${String(r.id)} [${String(b["from"])}, ${String(b["until"])}) by ${String(b["by"])}: ${String(b["reason"])}` };
  }
  return { variant: 0, why: "no mask in force: variant-0" };
}
/**
 * A PICK a flagged gap goal won. `runnerUp` is the best unflagged candidate of the same ranking (null: none). Returns
 * the template to dispatch (null: nothing this pass) and the decision's trace id, which the dispatch carries to its
 * settle. Never throws (a failure is variant-0: the winner).
 */
export async function decideUnarmedSkip(winner: { template_id: string }, runnerUp: { template_id: string } | null): Promise<{ dispatch: string | null; decision: string; variant: number }> {
  const gapId = winner.template_id.replace(/^gap-goal:/, "");
  try {
    const now = gusNowMs();
    const nowIso = new Date(now).toISOString();
    const m = await unarmedSkipVariant(nowIso);
    const dispatch = m.variant === 1 ? (runnerUp?.template_id ?? null) : winner.template_id;
    const traceId = `gap-goal-unarmed-skip-${gapId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60)}-${now}-${process.pid}-${++gusSeq}`;
    console.log(m.variant === 1
      ? `${GUS_LOG} skipped ${winner.template_id} (unarmed src-site) → dispatched ${dispatch ?? "none"} variant=1 (${m.why}) decision=${traceId}`
      : `${GUS_LOG} would skip ${winner.template_id} (unarmed src-site) → dispatched ${winner.template_id} variant=0 (${m.why}) decision=${traceId}`);
    const id = unarmedSkipVariantId(m.variant);
    void gusPost({
      execution_id: traceId, template_id: id, activity_id: id, activity_variant_id: id, status: "completed", success: true, started_at: nowIso, duration_ms: 0,
      input_shapes: ["substrateGap"], output_shapes: ["gapGoalUnarmedSkip"],
      tasks: [{ id: "decide-pick", resolver_id: "deterministic", resolver_tier: "deterministic", success: true, input_impulse_ids: [], output_impulse_ids: [`gapGoalUnarmedSkip:${traceId}`] }],
      tags: [`gap_goal_unarmed_skip_variant:${m.variant}`],
      metadata: { gapGoalUnarmedSkip: { variant: m.variant, gap_id: gapId, winner: winner.template_id, dispatched: dispatch, decided_at: nowIso } },
    }, `own trace of ${gapId}`);
    for (const [k, p] of gusPending) if (now - p.at > GUS_PENDING_MAX_MS) { gusPending.delete(k); console.log(`${GUS_LOG} ungraded ${p.traceId}: no verdict for its slot within 2 h`); }
    gusPending.set(traceId, { traceId, variant: m.variant, gapId, dispatched: dispatch ?? "", at: now });
    if (dispatch === null) settleUnarmedSkip(traceId, null, "no dispatch in the pass");
    return { dispatch, decision: traceId, variant: m.variant };
  } catch (err) {
    console.warn(`${GUS_LOG} decision failed (${String((err as Error)?.message ?? err).slice(0, 160)}): variant-0, dispatching the winner`);
    return { dispatch: winner.template_id, decision: "", variant: 0 };
  }
}
/** The goal that filled a decision's slot settles it: reached (goal-host's verdict for that dispatch) -> reached,
 *  false -> not reached, null -> ungraded with `why`. Once per decision; an unknown decision settles nothing. */
export function settleUnarmedSkip(decision: string, reached: boolean | null, why: string, dispatchId?: string): boolean {
  try {
    const p = gusPending.get(decision);
    if (!p) return false;
    gusPending.delete(decision);
    if (reached === null) { console.log(`${GUS_LOG} ungraded ${p.traceId}: ${why}`); return true; }
    const now = gusNowMs();
    const impulse = `gapGoalUnarmedSkip:${p.traceId}`;
    console.log(`${GUS_LOG} settled ${p.traceId} reached=${reached} dispatched=${p.dispatched} dispatch=${dispatchId ?? "?"}`);
    void gusPost({
      execution_id: `gap-goal-unarmed-skip-credit-${p.traceId.replace(/^gap-goal-unarmed-skip-/, "")}`,
      template_id: UNARMED_SKIP_CREDIT_ACTIVITY, activity_id: UNARMED_SKIP_CREDIT_ACTIVITY, activity_variant_id: UNARMED_SKIP_CREDIT_ACTIVITY,
      status: reached ? "completed" : "failed", success: reached,
      ...(reached ? {} : { failure_mode: { type: "verifier_negative", reason: `the goal that filled the slot (${p.dispatched}) did not reach` } }),
      started_at: new Date(now).toISOString(), duration_ms: 0, composition_chain: [p.traceId],
      tasks: [{ id: "slot-reach", resolver_id: "deterministic", resolver_tier: "deterministic", success: reached, input_impulse_ids: [impulse], output_impulse_ids: [],
        consumed_provenance: [{ impulse_id: impulse, producer_execution_id: p.traceId, origin: "ancestor" }] }],
      tags: [reached ? "reached:true" : "reached:false", `gap_goal_unarmed_skip_variant:${p.variant}`],
      metadata: { producer_execution_id: p.traceId, variant: p.variant, gap_id: p.gapId, dispatched: p.dispatched, settled_by: dispatchId ?? null, after_ms: now - p.at },
    }, `credit of ${p.traceId}`);
    return true;
  } catch { return false; }
}

export async function generateGapGoalCandidates(
  activityApiEndpoint: string,
  apiKey: string,
  /** goal-host by discovery (index.ts goalHostBase); without it the in-flight read is skipped, never pinned. */
  goalHostBase?: () => Promise<string>,
): Promise<Array<{ templateId: string; goalText: string; shapes: string[]; source: "gap_generated"; gapId: string; classificationMetadata: { gap_subtype?: string; category?: string; detected_at?: string }; runGoal?: GapGoalRunFields; rowState?: string; unarmedSrcSite?: true }>> {
  // The decision's trace posts use this supply's activity-api and key (gap-goal-unarmed-skip).
  gusApi = { endpoint: activityApiEndpoint, apiKey };
  try {
    const DEV_VESSEL_ENDPOINT = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
    const res = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({ impulse: { type: "substrateGap", status: "open", limit: 100, sort: "disposition_scored" } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // SUPPLY FAILURE MUST BE AUDIBLE. Returning [] silently is indistinguishable
      // in the journal from "candidates existed but scored low" — and those need
      // opposite fixes. Observed: an hour with 165 boredom reservations and ZERO
      // `reserving gap-goal:`, with nothing in any log to say which case it was.
      console.warn(`[gap-goal-supply] dev-vessel substrateGap resolve returned ${res.status} — 0 gap-goal candidates this pass`);
      return [];
    }
    const json = (await res.json()) as {
      body?: { gaps?: Array<{ id: string; summary: string; gap_subtype?: string }> };
      gaps?: Array<{ id: string; summary: string; gap_subtype?: string }>;
    };
    const rawGaps = (json.body?.gaps ?? json.gaps ?? []) as Array<{ id: string; summary: string; status?: string; gap_subtype?: string; category?: string; detected_at?: string; source?: string; directed?: boolean; classification_metadata?: Record<string, unknown> }>;
    // ONE ADMISSION POLICY: pass the raw window through the mirrored dev-vessel admission
    // gate BEFORE any scoring/minting (see admitActionableGapsMirror above).
    const admitted = admitActionableGapsMirror(rawGaps);
    // Then drop gaps another owner holds (see OWNERSHIP FILTER above), audibly, per reason.
    const { kept: gaps, dropped: ownedDropped } = dropOperatorOwnedGaps(admitted);
    console.warn(`[gap-goal-supply] owner-held dropped ${Object.entries(ownedDropped).map(([r, n]) => `${r}=${n}`).join(" ")}`);
    const CATEGORY_WEIGHT: Record<string, number> = { missing_capability: 3, unreachable_producer: 2.5, operational_health: 2.5, detector_coverage_gap: 2, decision_without_action: 2, posterior_consistency_drift: 1.5, architectural_pattern: 1.5, residual_shape_proposal: 1, orphaned_capability: 0.5 };
    gaps.sort((a, b) => { const wa = CATEGORY_WEIGHT[a.category ?? ""] ?? 1; const wb = CATEGORY_WEIGHT[b.category ?? ""] ?? 1; if (wb !== wa) return wb - wa; const da = Number(a.detected_at ? Date.parse(a.detected_at) : 0); const db = Number(b.detected_at ? Date.parse(b.detected_at) : 0); if (db !== da) return db - da; return String(b.detected_at ?? "").localeCompare(String(a.detected_at ?? "")); });
    // Baseline doom-signals (a broken package baseline blocks ALL self-authoring
    // for that package) are high-leverage but score low on disposition; float them
    // to the front so the escalation seam emits them before the gap-goal cap.
    gaps.sort((a, b) => Number(String(b.id).startsWith("baseline-typecheck-broken-")) - Number(String(a.id).startsWith("baseline-typecheck-broken-")));
    let activeGoals = new Set<string>();
    try {
      if (!goalHostBase) throw new Error("goal-host undiscovered: no goal-host resolver given");
      const GOAL_HOST_ENDPOINT = await goalHostBase();
      const dispatchRes = await fetch(`${GOAL_HOST_ENDPOINT}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
        body: JSON.stringify({ impulse: { pointer: { type: "activeDispatches" } } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (dispatchRes.ok) {
        const dispatchJson = (await dispatchRes.json()) as { body?: { dispatches?: Array<{ goal?: string | null }> } };
        const dispatches = dispatchJson.body?.dispatches ?? [];
        activeGoals = new Set(dispatches.map((d) => d.goal).filter((g): g is string => typeof g === "string"));
      }
    } catch (err) {
      // fail-open: use empty Set on any failure, and say why
      console.warn(`[gap-goal-supply] in-flight goals unread: ${(err as Error).message}`);
    }
    // The ids this read shows open (the resolve asks for status "open"), for the open-children skip below.
    const openGapIds = new Set(rawGaps.filter((r) => String(r.status ?? "open") === "open").map((r) => String(r.id)));
    const seen = new Set<string>();
    const gapSignatures = new Set<string>();
    const out: Array<{ templateId: string; goalText: string; shapes: string[]; source: "gap_generated"; gapId: string; classificationMetadata: { gap_subtype?: string; category?: string; detected_at?: string; }; runGoal?: GapGoalRunFields; rowState?: string }> = [];
    for (const g of gaps) {
      const sig = `${g.gap_subtype ?? ""}:${g.summary.split(/(?<=[.!?])\s/)[0] ?? g.summary}`.toLowerCase().replace(/\s+/g, " ");
      if (gapSignatures.has(sig)) continue;
      gapSignatures.add(sig);
      // Baseline doom-signal -> pull_cutover repair goal (escalation seam WIRE 2):
      // the generic "capability|repair" filter below drops these, so handle them
      // first. pull_cutover re-syncs the vessel runtime to origin/dev — the baseline
      // gap's remedy. The gap-goal: prefix routes to /run-goal (dispatchByTemplateId)
      // and the pull_cutover substring makes it a gap-drain candidate (priority floor).
      if (g.id.startsWith("baseline-typecheck-broken-")) {
        if (seen.has(g.id)) continue;
        seen.add(g.id);
        // Stale-premise guard: a baseline break is re-detected (detected_at refreshed) by
        // every failing compose typecheck, so a baseline gap NOT re-detected for hours is
        // presumed already repaired — minting pull_cutover for it produced an observed
        // no-op echo (dozens of cheap-tick "successes" against a long-green baseline).
        // A gap whose premise is a measurable condition must be re-checked before acting.
        const detectedMs = g.detected_at ? Date.parse(g.detected_at) : 0;
        if (!detectedMs || Date.now() - detectedMs > 6 * 60 * 60 * 1000) continue;
        const vm = g.summary.match(/baseline of (\S+) failing/);
        const vessel = (vm ? vm[1] : g.id.replace(/^baseline-typecheck-broken-/, "")).replace(/^repos\//, "");
        out.push({
          templateId: `gap-goal:pull_cutover:${g.id}`,
          goalText: `run the pull_cutover activity for vessel ${vessel} to converge it to the latest origin/dev`,
          shapes: [],
          source: "gap_generated",
          gapId: g.id,
          rowState: rowStateFingerprint(g),
          classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
        });
        if (out.length >= 5) break;
        continue;
      }
      if (g.gap_subtype === "gap_backlog_unhealthy") continue;
      if (g.id.startsWith("auto_draft_decision")) continue;
      // ACTIONABILITY GUARD (2026-07-30) — boredom-MINT-PATH-specific, NOT part of the
      // dev-vessel admission gate (which would admit these as unknown-actionability); collapses
      // into the resolve-through gate once dev-vessel serves an admitted-gaps shape (see the
      // ADMISSION MIRROR TODO-gap above): a confabulated capability gap — "the goal-walk needs a
      // producer for shape <X>" where <X> is a walk-internal shape, not a real vessel — has NO
      // editable target. Routing it as a generic "Close substrate gap" edit makes the drafter
      // localize to a non-existent repos/<X> path (observed: 110 mis_localized_path + 37
      // out_of_mount_target dominated by vesselCapability/goal-walk/substrate). Skip minting these
      // here; a real producer needs the localizer-clamp author-new-resolver path (targets a real
      // vessel), not the boredom edit path — filed as a gap. Do not burn compose cycles mis-localizing.
      // CATEGORY-LAUNDERING HOLE (2026-08-06). The guard here was keyed on
      // `category === "missing_capability"`, but when the compose this route
      // dispatches fails, goal-host re-mints the SAME confabulated gap under
      // category "edit_intent_route" (goal-host-vessel/src/index.ts:7455) — so the
      // family escapes its own guard by changing category and is re-dispatched
      // forever. Measured on the live open corpus (655 gaps): 174 carry "needs a
      // producer for shape"; 53 are missing_capability (blocked here) and 121 are
      // edit_intent_route (escaping) — and 119 of those 121 name a shape discovery
      // ADVERTISES right now (feature_compose 115, gitDiff 4), so the gap's own
      // premise is false. The category is not evidence; predicate on the claim.
      // NOTE: this matches the phrase ANYWHERE in the summary, so a genuine gap
      // that quotes it — including a meta-gap about this hole — is also skipped;
      // the warn below is what makes that visible.
      // The warn fires only for the laundered case, so the journal distinguishes
      // "this widening is live and catching re-mints" from "guard unchanged".
      if (/needs a producer for shape/i.test(g.summary)) {
        if (g.category !== "missing_capability") {
          console.warn(`[gap-goal-supply] SKIP laundered missing-producer gap ${g.id} category=${g.category ?? "(none)"} — confabulated family re-minted under a non-missing_capability category`);
        }
        continue;
      }
      if (Array.from(activeGoals).some((goal) => goal.startsWith(`Close substrate gap ${g.id}`) || goal.startsWith(`investigate and decompose gap ${g.id}`))) continue;
      if (/^\s*Close substrate gap [-\w:.!]+:?\s*$/.test(g.summary)) continue;
      // ACTIONABILITY IS A PROPERTY OF THE GAP, NOT OF ITS PROSE.
      //
      // This gate was `/capability|repair/i.test(g.summary)` — a keyword match over free
      // text deciding whether a gap may become a goal at all. Measured on the live store:
      // it drops 247 of 524 open gaps (47%), including 100% of `ui_legibility`.
      //
      // That is fatal for the human-feedback funnel specifically. A person writing
      // "boldface the content section. And allow me to copy the contents to the Windows
      // clipboard" is filing a real, actionable interface gap — it just contains neither
      // the word "capability" nor "repair", so it could never be selected. The same
      // ui-feedback-<region>-<kind> keying carries substrate-DETECTED legibility
      // violations from ui_legibility_scan, so both halves of that funnel were excluded
      // by vocabulary. An open example sat unrouted for 8 hours with nothing having
      // attempted it.
      //
      // Predicate on the structured `category` first — that field is assigned by the
      // detector that filed the gap and means what it says — and keep the prose match
      // only as a fallback for gaps that carry no category. Same correction as the
      // laundering guard above, in the other direction: there the CATEGORY was not
      // evidence for the claim; here the PROSE is not evidence for actionability.
      //
      // Deliberately narrow. ui_legibility is added because it is a real, human-facing,
      // currently-100%-excluded class. edit_intent_route is deliberately NOT added even
      // though 73 of its members are dropped here — it is the autocatalytic family, and
      // widening it would re-open the loop 7868111 just closed. Ordering matters: cut the
      // autocatalysis first, then widen.
      const ACTIONABLE_CATEGORIES = new Set(["ui_legibility"]);
      const categoryActionable = ACTIONABLE_CATEGORIES.has(String(g.category ?? ""));
      if (!categoryActionable && !/capability|repair/i.test(g.summary)) continue;
      if (categoryActionable && !/capability|repair/i.test(g.summary)) {
        console.log(`[gap-goal-supply] ADMITTED by category ${g.category} (prose gate would have dropped it): ${g.id}`);
      }
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      // FIRST-SENTENCE IS A SUMMARISER, NOT A TRUNCATOR. Taking sentence one is right
      // for a prose gap summary, but a re-minted gap's summary IS a previously
      // well-formed edit goal — one file, a verbatim anchor fence and a replacement
      // fence. Sentence one of that is the instruction line, and the anchor and
      // replacement are discarded, so the re-mint can never satisfy
      // synthesizeVerbatimEditOps (which requires exactly two fences) and is
      // guaranteed to fail, escalate, and be re-minted again.
      // Detect the well-formed shape and pass it through whole. Median well-formed
      // goal is 1610 chars, p90 3588 — far past any single sentence.
      const summaryIsWellFormedGoal = (g.summary.match(/```/g) ?? []).length >= 2;
      const firstSentence = summaryIsWellFormedGoal
        ? g.summary
        : (g.summary.split(/(?<=[.!?])\s/)[0] ?? g.summary);
      if (g.gap_subtype === "semantic_reject") {
        out.push({
          templateId: `gap-goal:${g.id}`,
          goalText: sanitizeGoalText(`Address semantic rejection gap ${g.id}: ${firstSentence}`),
          shapes: ["canonical_gap_signature"],
          source: "gap_generated",
          gapId: g.id,
          rowState: rowStateFingerprint(g),
          classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
        });
        if (out.length >= 5) break;
        continue;
      }
      if (g.gap_subtype === "per_gap_failure_lessons_updated") {
  out.push({
    templateId: `gap-goal:${g.id}`,
    goalText: sanitizeGoalText(`Address gap failure lessons update ${g.id}: ${firstSentence}`),
    shapes: ["canonicalized_gap_identity", "per_gap_failure_lessons"],
    source: "gap_generated",
    gapId: g.id,
    rowState: rowStateFingerprint(g),
    classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
  });
  out.push({
    templateId: `gap-goal:${g.id}`,
    goalText: sanitizeGoalText(`Address gap failure lessons update ${g.id}: ${firstSentence}`),
    shapes: ["canonicalized_gap_identity"],
    source: "gap_generated",
    gapId: g.id,
    rowState: rowStateFingerprint(g),
    classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
  });
  if (out.length >= 5) break;
  continue;
}
      // CARRY THE EDIT SITE AND REGION INTO THE GOAL TEXT.
      //
      // This dispatch sends only { goal, tags } to /run-goal — no gap object — so
      // everything the gap knows is lost unless it is IN THE TEXT. Two consequences,
      // both observed on the live UI gap: goal-host's edit-intent detection greps the
      // goal for a repos/<vessel>/src path, finds none, and routes the walk generically
      // (it reached the floor emitting `uiFeedback_write` — writing more feedback rather
      // than changing the panel); and feature_compose receives no gapMeta, so neither
      // the region grounding nor the region-containment gate can fire, because both key
      // on classification_metadata.region. The drafter returned ops:[].
      //
      // Naming the file makes the goal edit-intent-routable; naming the region gives the
      // drafter the anchor and re-arms the containment check. Both are appended only
      // when present, so gaps without them are unchanged.
      const gMeta = (g.classification_metadata ?? {}) as Record<string, unknown>;
      const gSite = String(gMeta.edit_site ?? "").trim();
      const gRegion = String(gMeta.region ?? "").trim();
      const siteSuffix = gSite ? ` Edit ${gSite}` : "";
      const regionSuffix = gRegion ? ` in the region "${gRegion}"` : "";
      // A DECOMPOSED PARENT WAITS FOR ITS STEPS. TEMPORARY LANE FILTER (removal debt, accepted as such): while any child
      // in this row's decomposition.children is open in the gap list this pass already read, the parent is not offered;
      // its work is its children. A child absent from that list counts as not open (absence is not openness), so no
      // fetch is made per child. It retires when the selector's reward for a reached investigation can be credited to
      // the children instead of the parent, or when, after the row-change forgiveness (gap_goal_forgive: on_row_change)
      // has soaked, parent re-picks with open children stay at 0 with this read disabled.
      const openSteps = openDecompositionChildren(gMeta, openGapIds);
      if (openSteps > 0) {
        console.log(`[gap-goal-supply] SKIP ${g.id}: decomposed into ${openSteps} open step(s); their work comes first`);
        continue;
      }
      // ONE INVESTIGATION PER STATE: development-vessel stamped this siteless gap's last investigation as declined on
      // these same inputs (investigationDeclinedUnchanged); another walk would re-run that decline. A row change re-arms it.
      if (!gSite && investigationDeclinedUnchanged(g as OwnedGap)) {
        console.log(`[gap-goal-supply] SKIP ${g.id}: its investigation declined on unchanged inputs at ${String(((gMeta.investigation_declined ?? {}) as { at?: unknown }).at ?? "?")}; a row change re-arms it`);
        continue;
      }
      out.push({
        templateId: `gap-goal:${g.id}`,
        // No edit site: a Close goal is judged only by a landed edit, which nothing can produce here,
        // so ask for the investigation that decomposes it into sited, falsifiable steps instead.
        goalText: sanitizeGoalText(gSite
          ? `Close substrate gap ${g.id}: ${firstSentence}${siteSuffix}${regionSuffix}.`
          : `investigate and decompose gap ${g.id}: ${firstSentence}`),
        shapes: ["canonicalized_gap_identity"],
        source: "gap_generated",
        gapId: g.id,
        // The row-input fingerprint S of the row this goal was read from (row-state.ts): the arm's evidence belongs to it.
        rowState: rowStateFingerprint(g),
        classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
        // CHANGE-35: an investigation of a gap with no edit site asks for its DECOMPOSITION, structured: the target shape
        // and the gap id go on the run-goal body, so goal-host binds them instead of recovering them from the text.
        ...(gSite ? {} : { runGoal: { expected_output_shapes: ["gapDecomposition"], variables: { decompose_gap_id: String(g.id) } } }),
        // A compose would refuse it as unarmed (gap-goal-unarmed-skip): the pick decides whether it is dispatched.
        ...(gSite && unarmedSrcSite(gMeta) ? { unarmedSrcSite: true as const } : {}),
      });
      if (out.length >= 5) break;
    }
    // ── RECIPE CANDIDATES (observation → actionable goal): mint goals from the system's own
    // DETERMINISTIC reach-gate failure classes. Source = concept-db reach_gate_lesson concepts
    // whose class is deterministic_* — each names a GOAL class whose deterministic parse+command+
    // oracle produced a WRONG value (e.g. deterministic_wrong_registry_count, _wrong_derived_val,
    // _file_count_mismatch). These are EXACTLY what the reach_by_construction_recipe fixes (unlike
    // compose-failure classes like semantic_reject / mis_localized_path, which are DRAFTER quality
    // and already surface as substrateGap rows on the gap-goal path above — minting recipe goals for
    // THOSE dispatched hollow and β-poisoned the pool). The goal text names the goal-host file and an
    // edit verb so it ROUTES to feature_compose edit-intent (an abstract "close the class" goal does
    // not route and dispatches hollow). Fail-open: concept-db down or no deterministic classes ⇒ mint
    // NOTHING (never fall back to the un-routable compose-lessons source).
    try {
      const CONCEPT_DB_ENDPOINT = process.env.CONCEPT_DB_ENDPOINT ?? "http://127.0.0.1:8260";
      const cr = await fetch(`${CONCEPT_DB_ENDPOINT}/concepts/search?query=${encodeURIComponent("reach-gate hollow class")}&shape=reach_gate_lesson&limit=50`, {
        method: "GET",
        headers: { ...(apiKey ? { Authorization: `ApiKey ${apiKey}` } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
      if (cr.ok) {
        const cj = (await cr.json()) as { concepts?: Array<{ content?: string; summary?: string }> };
        const classCounts = new Map<string, number>();
        for (const c of cj.concepts ?? []) {
          const m = /reach-gate hollow class (deterministic_[a-z0-9_]+)/.exec(String(c.content ?? "")) ?? /lesson:\s*(deterministic_[a-z0-9_]+)/.exec(String(c.summary ?? ""));
          if (m && m[1]) classCounts.set(m[1], (classCounts.get(m[1]) ?? 0) + 1);
        }
        // The recipe (parse+command+oracle for a goal class) applies to WRONG-VALUE classes —
        // where a deterministic answer was computed but incorrect — not to pipeline/meta failures
        // (staged_not_landed, error_envelope, no_output, edit_intent_no_edit) which have no
        // goal-operand parse to fix. Filter to the applicable subset so recipe goals don't churn
        // the drafter on classes it cannot address by adding an oracle.
        const RECIPE_APPLICABLE = /(mismatch|wrong|unmeasurable|derived|count|registry|compute|placeholder)/;
        const top = [...classCounts.entries()].filter(([c]) => RECIPE_APPLICABLE.test(c)).sort((a, b) => b[1] - a[1]).slice(0, 3);
        for (const [cls] of top) {
          const templateId = `gap-goal:recipe:${cls}`;
          const goalText = `In repos/goal-host-vessel/src/index.ts, add or refine a deterministic parse+command+oracle for the "${cls}" goal-failure class following the reach_by_construction_recipe: parse the goal operands once into a shared function, emit a deterministic shell command that produces the answer, and add a matching independent oracle that recomputes from the authoritative source and verifies the produced value. The change must typecheck.`;
          if (Array.from(activeGoals).some((goal) => goal.includes(`"${cls}" goal-failure class`))) continue;
          out.push({
            templateId,
            goalText,
            shapes: [],
            source: "gap_generated",
            gapId: `recipe:${cls}`,
            classificationMetadata: { gap_subtype: "recipe_class", category: "systematic_failure" },
          });
        }
      }
    } catch { /* concept-db unreachable — fail open, mint no recipe candidates */ }
    // SUPPLY SHAPE MUST BE AUDIBLE ON THE SUCCESS PATH TOO. The two warnings above
    // only fire when the resolve ERRORS. A successful resolve that yields nothing
    // is still silent, so "the gap window was empty", "admission rejected every
    // gap" and "candidates existed but scored below the tick arms" remain
    // indistinguishable — and they need different fixes. These counts separate
    // them in one line, at no cost.
    console.warn(`[gap-goal-supply] candidates=${out.length} raw_gaps=${rawGaps.length} admitted=${admitted.length} unowned=${gaps.length}`);
    return out;
  } catch (e) {
    // Same reasoning as the !res.ok branch above: a silent [] here is
    // indistinguishable from "candidates scored low", and the two need opposite
    // fixes. Fail-open behaviour is unchanged — this only makes it audible.
    console.warn(`[gap-goal-supply] gap-goal candidate generation threw — 0 candidates this pass: ${(e as Error)?.message ?? e}`);
    return [];
  }
}
