// A CANDIDATE'S WORK MODE COMES FROM WHAT IT DECLARES, NOT FROM A SUBSTRING OF ITS ID (REALIGNMENT §2.0, law 1).
// Detectors named after drafting templates were classed develop by the id substring "draft" and took the develop
// emphasis weight (1.80) whenever the controller emphasised develop.
//
//   [MUST-FAIL] a detect-* / *-scan-tick / *-audit template whose id contains "draft" is not develop (so it never
//               takes the develop weight): its declared outputs and tags decide.
//   [MUST-FAIL] index.ts passes the candidate's declared output shapes to the classifier and keeps no id-substring copy.
//   [CONTROL]   a real drafting template (development-vessel:dispatch-latest-auto-draft) is still develop; the other
//               families still classify; a candidate declaring nothing falls back to its id.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CM = (await import("./candidate-mode").catch(() => ({}))) as Record<string, any>;
const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
// The tags build-signature-detector gives every detect-<class> template it registers.
const DETECTOR_TAGS = ["lift.autonomous.loop", "substrate.self.detection", "substrate.authored", "boredom_target_template"];

describe("a candidate's work mode is read from its declared outputs and tags", () => {
  test("[MUST-FAIL] detectors, scan ticks and audits named after drafting are not develop", () => {
    expect(typeof CM["candidateMode"]).toBe("function");
    for (const id of [
      "learned:detect-unclassified_failure_development-vessel_draft_gap_closing_activity",
      "learned:detect-unclassified_failure_development-vessel_dispatch_latest_auto_draft",
      "learned:detect-unclassified_failure_development-vessel_drafter_trigger_tick",
    ]) expect(CM.candidateMode(id, ["substrateGap"], DETECTOR_TAGS)).not.toBe("develop");
    expect(CM.candidateMode("learned:detect-unclassified_failure_x_draft", ["substrateGap"], DETECTOR_TAGS)).toBeNull();
    expect(CM.candidateMode("development-vessel:auto-draft-backlog-scan-tick", ["pendingWorkState"], ["boredom_target_template", "intent:observe"])).toBe("collect");
    expect(CM.candidateMode("development-vessel:draft-quality-audit", ["templateQualityAudit"], ["boredom_target_template"])).toBe("reflect");
  });

  test("[MUST-FAIL] index.ts classifies from the declared output shapes and keeps no id-substring copy", () => {
    expect(SRC).toContain('import { candidateMode, type LearningModeName } from "./candidate-mode";');
    expect(SRC).toContain("const mode = candidateMode(templateId, outputShapes, tags);");
    expect(SRC).not.toContain("const MODE_DEVELOP_MARKERS");
    expect(SRC).not.toContain("function candidateMode(");
  });

  test("[CONTROL] a real drafting template stays develop; the other families classify; nothing declared falls back to the id", () => {
    expect(typeof CM["candidateMode"]).toBe("function");
    // development-vessel src/seed/dispatch-latest-auto-draft.ts, as declared
    expect(CM.candidateMode("development-vessel:dispatch-latest-auto-draft", ["autoDraftDispatchResult"], ["intent:auto_draft_seed", "phase:execute", "topology.discovery.loop", "boredom_target_template"])).toBe("develop");
    // development-vessel src/seed/draft-gap-closing-activity.ts outputs
    expect(CM.candidateMode("development-vessel:draft-gap-closing-activity", ["activityTemplateProposal", "activityTemplateVariant"], ["boredom_target_template"])).toBe("develop");
    expect(CM.candidateMode("development-vessel:llm-api-health-observer-tick", ["llmApiHealth"], ["boredom_target_template"])).toBe("reflect");
    expect(CM.candidateMode("x", ["coverageSnapshot"], [])).toBe("collect");
    expect(CM.candidateMode("gap-goal:compose-the-thing", [], [])).toBe("develop");
    expect(CM.candidateMode("gap-goal:something", [], [])).toBeNull();
    expect(CM.nameWords("autoDraftDispatchResult")).toEqual(["auto", "draft", "dispatch", "result"]);
    expect(CM.nameWords("intent:auto_draft_seed")).toEqual(["intent", "auto", "draft", "seed"]);
  });
});
