export async function generateGapGoalCandidates(
  activityApiEndpoint: string,
  apiKey: string,
): Promise<Array<{ templateId: string; goalText: string; shapes: string[]; source: "gap_generated" }>> {
  try {
    const DEV_VESSEL_ENDPOINT = process.env.DEV_VESSEL_ENDPOINT ?? "http://127.0.0.1:8090";
    const res = await fetch(`${DEV_VESSEL_ENDPOINT}/v2/impulses/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${apiKey}` },
      body: JSON.stringify({ impulse: { type: "substrateGap", status: "open", limit: 20 } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      body?: { gaps?: Array<{ id: string; summary: string; gap_subtype?: string }> };
      gaps?: Array<{ id: string; summary: string; gap_subtype?: string }>;
    };
    const gaps = (json.body?.gaps ?? json.gaps ?? []) as Array<{ id: string; summary: string; gap_subtype?: string }>;
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
        const dispatchJson = (await dispatchRes.json()) as { body?: { dispatches?: string[] } };
        const dispatches = dispatchJson.body?.dispatches ?? [];
        activeGoals = new Set(dispatches.map((d) => d));
      }
    } catch {
      // fail-open: use empty Set on any failure
    }
    const seen = new Set<string>();
    const out: Array<{ templateId: string; goalText: string; shapes: string[]; source: "gap_generated" }> = [];
    for (const g of gaps) {
      if (g.gap_subtype === "gap_backlog_unhealthy") continue;
      if (g.id.startsWith("auto_draft_decision")) continue;
      if (Array.from(activeGoals).some((goal) => goal.startsWith(`Close substrate gap ${g.id}`))) continue;
      if (!/capability|repair/i.test(g.summary)) continue;
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const firstSentence = g.summary.split(/(?<=[.!?])\s/)[0] ?? g.summary;
      out.push({
        templateId: `gap-goal:${g.id}`,
        goalText: `Close substrate gap ${g.id}: ${firstSentence}`,
        shapes: [],
        source: "gap_generated",
      });
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}
