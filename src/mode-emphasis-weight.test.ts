// THE MODE-EMPHASIS WEIGHT, THROUGH priorityWeightForCandidate ITSELF (REALIGNMENT §2.0, law 1). With the shape-lattice
// controller emphasising develop (weight 1.80), a detector whose id names a drafting template ("feature", "compose")
// took 1.80 through the mode branch while its classifier read the id. index.ts top-level-awaits main()/poolLoop(), so it
// cannot be imported: the REAL priorityWeightForCandidate is cut out of index.ts and transpiled, with the module state
// it reads injected (the emphasis, the mode weights, no gap demand, no drain floor). Its classifier is the one index.ts
// uses: cut from index.ts when it is defined there, else the imported src/candidate-mode.ts.
//
//   [MUST-FAIL] emphasis develop: learned:detect-…_feature_compose declaring ["substrateGap"] and the detector tags -> 1.0.
//   [CONTROL]   emphasis develop: development-vessel:draft-gap-closing-activity, as its seed declares it -> 1.80.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
const tp = new Bun.Transpiler({ loader: "ts" });

/** A top-level declaration of index.ts: from its first line to the first closing brace at column 0. */
function cut(decl: string): string {
  const start = SRC.indexOf(decl);
  if (start < 0) throw new Error(`declaration not found: ${decl}`);
  const end = SRC.indexOf("\n}\n", start);
  return SRC.slice(start, end + 3);
}

async function weightFn(emphasis: "develop" | "collect" | "reflect", modeWeights: Record<string, number>) {
  let classifierTs = "";
  let classifier: unknown = null;
  if (SRC.includes("\nfunction candidateMode(")) {
    // defined in index.ts: its marker lists and the function, cut as written
    const markers = ["const MODE_DEVELOP_MARKERS", "const MODE_COLLECT_MARKERS", "const MODE_REFLECT_MARKERS"].map((m) => SRC.slice(SRC.indexOf(m), SRC.indexOf("\n", SRC.indexOf(m)) + 1)).join("");
    classifierTs = markers + cut("function candidateMode(");
  } else {
    classifier = (await import("./candidate-mode")).candidateMode;
  }
  const body = `${classifierTs}${cut("function priorityWeightForCandidate(")}\nreturn priorityWeightForCandidate;`;
  const js = tp.transformSync(classifier ? `const candidateMode = __classifier;\n${body}` : body);
  return new Function("__classifier", "priorityWeightByShape", "priorityFloorWeight", "isGapDrainCandidate", "learningModeEmphasis", "modeWeightByMode", js)(
    classifier, new Map<string, number>(), 1.0, () => false, emphasis, new Map(Object.entries(modeWeights)),
  ) as (templateId: string, outputShapes: string[], tags: string[]) => number;
}

// The tags build-signature-detector gives every detect-<class> template it registers.
const DETECTOR_TAGS = ["lift.autonomous.loop", "substrate.self.detection", "substrate.authored", "boredom_target_template"];
const DEVELOP = { develop: 1.8, collect: 0.5, reflect: 0.5 };

describe("the develop emphasis reaches drafting templates, not detectors named after them", () => {
  test("[MUST-FAIL] a detector named after feature_compose gets 1.0 under the develop emphasis", async () => {
    const w = await weightFn("develop", DEVELOP);
    expect(w("learned:detect-unclassified_failure_development-vessel_feature_compose", ["substrateGap"], DETECTOR_TAGS)).toBe(1.0);
  });

  test("[CONTROL] development-vessel:draft-gap-closing-activity, as its seed declares it, keeps 1.80", async () => {
    const w = await weightFn("develop", DEVELOP);
    // development-vessel src/seed/draft-gap-closing-activity.ts: outputShapes and tags as declared
    expect(w("development-vessel:draft-gap-closing-activity", ["activityTemplateProposal", "activityTemplateVariant"], ["lift.autonomous.loop", "validation.failure.modes", "gap.closing"])).toBe(1.8);
  });
});
