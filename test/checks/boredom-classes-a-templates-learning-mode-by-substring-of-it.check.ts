// CHECK for gap boredom-classes-a-templates-learning-mode-by-substring-of-its-id-so-detectors-named-after-drafting-inherit-the-develop-emphasis.
//
// A candidate's work mode must come from what it declares (output shapes, tags), not from a substring of its id
// (REALIGNMENT §2.0, law 1): detectors named after drafting were classed develop by the id substring "draft" and took
// the develop emphasis weight.
//   [MUST-FAIL] a detect-* / *-scan-tick template whose id contains "draft" is not develop; its declared outputs and
//               tags decide.
//   [MUST-FAIL] index.ts keeps no id-substring marker list and no local copy of the classifier.
//   [CONTROL]   whichever classifier the tree has is found; a real drafting template is develop; an audit, a health
//               observer and a composing gap goal keep their families.
// The classifier is the exported candidateMode of src/candidate-mode.ts when that module exists. Otherwise it is the
// classing path index.ts carries (its MODE_*_MARKERS lists and its local candidateMode, which reads the id and tags),
// cut from the source and transpiled, since index.ts starts its loop on import. Cases from src/candidate-mode.test.ts.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../../src/index.ts"), "utf8");
const CM = (await import("../../src/candidate-mode").catch(() => ({}))) as Record<string, any>;

type Classify = (id: string, outputs: string[], tags: string[]) => string | null;
function indexClassifier(): Classify | null {
  const cut = (sig: string): string => {
    const i = SRC.indexOf(sig);
    if (i < 0) return "";
    const end = sig.startsWith("function") ? SRC.indexOf("\n}\n", i) + 2 : SRC.indexOf(";\n", i) + 1;
    return SRC.slice(i, end);
  };
  const parts = ["const MODE_DEVELOP_MARKERS", "const MODE_COLLECT_MARKERS", "const MODE_REFLECT_MARKERS", "function candidateMode("].map(cut);
  if (parts.some((p) => p === "")) return null;
  const tp = new Bun.Transpiler({ loader: "ts" });
  const fn = new Function(`${tp.transformSync(parts.join("\n"))}\nreturn candidateMode;`)() as (id: string, tags: string[]) => string | null;
  return (id, _outputs, tags) => fn(id, tags);
}
const classify: Classify | null = typeof CM["candidateMode"] === "function"
  ? (id, outputs, tags) => CM.candidateMode(id, outputs, tags)
  : indexClassifier();
const DETECTOR_TAGS = ["lift.autonomous.loop", "substrate.self.detection", "substrate.authored", "boredom_target_template"];

describe("a candidate's work mode is read from its declared outputs and tags", () => {
  test("[CONTROL] the tree's classifier is found", () => {
    expect(classify).not.toBeNull();
  });

  test("[MUST-FAIL] detectors and a scan tick named after drafting are not develop", () => {
    for (const id of [
      "learned:detect-unclassified_failure_development-vessel_draft_gap_closing_activity",
      "learned:detect-unclassified_failure_development-vessel_dispatch_latest_auto_draft",
      "learned:detect-unclassified_failure_development-vessel_drafter_trigger_tick",
    ]) expect(classify!(id, ["substrateGap"], DETECTOR_TAGS)).not.toBe("develop");
    expect(classify!("development-vessel:auto-draft-backlog-scan-tick", ["pendingWorkState"], ["boredom_target_template", "intent:observe"])).not.toBe("develop");
  });

  test("[MUST-FAIL] index.ts keeps no id-substring marker list and no local classifier", () => {
    expect(SRC).not.toContain("const MODE_DEVELOP_MARKERS");
    expect(SRC).not.toContain("function candidateMode(");
  });

  test("[CONTROL] a real drafting template is develop; other families keep their mode", () => {
    expect(classify!("development-vessel:dispatch-latest-auto-draft", ["autoDraftDispatchResult"], ["intent:auto_draft_seed", "phase:execute", "topology.discovery.loop", "boredom_target_template"])).toBe("develop");
    expect(classify!("development-vessel:draft-quality-audit", ["templateQualityAudit"], ["boredom_target_template"])).toBe("reflect");
    expect(classify!("development-vessel:llm-api-health-observer-tick", ["llmApiHealth"], ["boredom_target_template"])).toBe("reflect");
    expect(classify!("gap-goal:compose-the-thing", [], [])).toBe("develop");
  });
});
