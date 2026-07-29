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
    if (!res.ok) return [];
    const json = (await res.json()) as {
      body?: { gaps?: Array<{ id: string; summary: string; gap_subtype?: string }> };
      gaps?: Array<{ id: string; summary: string; gap_subtype?: string }>;
    };
    const gaps = (json.body?.gaps ?? json.gaps ?? []) as Array<{ id: string; summary: string; gap_subtype?: string; category?: string; detected_at?: string }>;
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
      if (Array.from(activeGoals).some((goal) => goal.startsWith(`Close substrate gap ${g.id}`))) continue;
      if (!/capability|repair/i.test(g.summary)) continue;
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const firstSentence = g.summary.split(/(?<=[.!?])\s/)[0] ?? g.summary;
      if (g.gap_subtype === "per_gap_failure_lessons_updated") {
  out.push({
    templateId: `gap-goal:${g.id}`,
    goalText: `Address gap failure lessons update ${g.id}: ${firstSentence}`,
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
        goalText: `Close substrate gap ${g.id}: ${firstSentence}`,
        shapes: ["canonicalized_gap_identity"],
        source: "gap_generated",
        gapId: g.id,
        classificationMetadata: { gap_subtype: g.gap_subtype, category: g.category, detected_at: g.detected_at },
      });
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}
