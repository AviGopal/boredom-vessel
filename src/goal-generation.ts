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
 *   4. Caps at 500 chars (keeping the tail = the meaningful portion)
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

  // Cap at 500 chars, keeping the tail (meaningful portion)
  if (text.length > 500) {
    text = "…" + text.slice(text.length - 499);
  }

  return text.trim();
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

export async function generateGapGoalCandidates(
  activityApiEndpoint: string,
  apiKey: string,
): Promise<Array<{ templateId: string; goalText: string; shapes: string[]; source: "gap_generated"; gapId: string; classificationMetadata: { gap_subtype?: string; category?: string; detected_at?: string } }>> {
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
    const rawGaps = (json.body?.gaps ?? json.gaps ?? []) as Array<{ id: string; summary: string; gap_subtype?: string; category?: string; detected_at?: string; classification_metadata?: Record<string, unknown> }>;
    // ONE ADMISSION POLICY: pass the raw window through the mirrored dev-vessel admission
    // gate BEFORE any scoring/minting (see admitActionableGapsMirror above).
    const gaps = admitActionableGapsMirror(rawGaps);
    const CATEGORY_WEIGHT: Record<string, number> = { missing_capability: 3, unreachable_producer: 2.5, operational_health: 2.5, detector_coverage_gap: 2, decision_without_action: 2, posterior_consistency_drift: 1.5, architectural_pattern: 1.5, residual_shape_proposal: 1, orphaned_capability: 0.5 };
    gaps.sort((a, b) => { const wa = CATEGORY_WEIGHT[a.category ?? ""] ?? 1; const wb = CATEGORY_WEIGHT[b.category ?? ""] ?? 1; if (wb !== wa) return wb - wa; const da = Number(a.detected_at ? Date.parse(a.detected_at) : 0); const db = Number(b.detected_at ? Date.parse(b.detected_at) : 0); if (db !== da) return db - da; return String(b.detected_at ?? "").localeCompare(String(a.detected_at ?? "")); });
    // Baseline doom-signals (a broken package baseline blocks ALL self-authoring
    // for that package) are high-leverage but score low on disposition; float them
    // to the front so the escalation seam emits them before the gap-goal cap.
    gaps.sort((a, b) => Number(String(b.id).startsWith("baseline-typecheck-broken-")) - Number(String(a.id).startsWith("baseline-typecheck-broken-")));
    let activeGoals = new Set<string>();
    try {
      const GOAL_HOST_ENDPOINT = process.env.GOAL_HOST_ENDPOINT ?? "http://127.0.0.1:8210";
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
    } catch {
      // fail-open: use empty Set on any failure
    }
    const seen = new Set<string>();
    const gapSignatures = new Set<string>();
    const out: Array<{ templateId: string; goalText: string; shapes: string[]; source: "gap_generated"; gapId: string; classificationMetadata: { gap_subtype?: string; category?: string; detected_at?: string; } }> = [];
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
      if (g.category === "missing_capability" && /needs a producer for shape/i.test(g.summary)) continue;
      if (Array.from(activeGoals).some((goal) => goal.startsWith(`Close substrate gap ${g.id}`))) continue;
      if (!/capability|repair/i.test(g.summary)) continue;
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const firstSentence = g.summary.split(/(?<=[.!?])\s/)[0] ?? g.summary;
      if (g.gap_subtype === "semantic_reject") {
        out.push({
          templateId: `gap-goal:${g.id}`,
          goalText: sanitizeGoalText(`Address semantic rejection gap ${g.id}: ${firstSentence}`),
          shapes: ["canonical_gap_signature"],
          source: "gap_generated",
          gapId: g.id,
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
    classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
  });
  out.push({
    templateId: `gap-goal:${g.id}`,
    goalText: sanitizeGoalText(`Address gap failure lessons update ${g.id}: ${firstSentence}`),
    shapes: ["canonicalized_gap_identity"],
    source: "gap_generated",
    gapId: g.id,
    classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
  });
  if (out.length >= 5) break;
  continue;
}
      out.push({
        templateId: `gap-goal:${g.id}`,
        goalText: sanitizeGoalText(`Close substrate gap ${g.id}: ${firstSentence}`),
        shapes: ["canonicalized_gap_identity"],
        source: "gap_generated",
        gapId: g.id,
        classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
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
    console.warn(`[gap-goal-supply] candidates=${out.length} raw_gaps=${rawGaps.length} admitted=${gaps.length}`);
    return out;
  } catch (e) {
    // Same reasoning as the !res.ok branch above: a silent [] here is
    // indistinguishable from "candidates scored low", and the two need opposite
    // fixes. Fail-open behaviour is unchanged — this only makes it audible.
    console.warn(`[gap-goal-supply] gap-goal candidate generation threw — 0 candidates this pass: ${(e as Error)?.message ?? e}`);
    return [];
  }
}
