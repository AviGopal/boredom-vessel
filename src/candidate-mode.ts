// A CANDIDATE'S WORK MODE, FROM WHAT IT DECLARES (REALIGNMENT §2.0, law 1: behaviour is steered by shapes).
//
// The pool's mode-emphasis promotion (index.ts priorityWeightForCandidate) applies the shape-lattice controller's
// emphasised-mode weight to the candidates of that mode. The mode used to be read from a SUBSTRING of the template id
// (and tags): "draft" is a develop marker, so every detector NAMED after a drafting template
// (detect-unclassified_failure_…_draft_gap_closing_activity, …_dispatch_latest_auto_draft) was classed develop and took
// the develop weight while the controller emphasised develop. A name says what a template is about, not what it does.
//
// The mode is now read from the template's declared OUTPUT SHAPES and TAGS, matched as whole words (camelCase,
// snake_case, kebab-case and dotted names split into words): a drafting template declares a drafting output
// (autoDraftDispatchResult, activityTemplateVariant) or tag (intent:auto_draft_seed); a detector declares substrateGap
// and substrate.self.detection, which name no work mode. The template id is read ONLY when the candidate declares
// neither outputs nor tags (a shapeless gap goal), with the same whole-word rule. Same marker families, same order.
export type LearningModeName = "develop" | "collect" | "reflect";

export const MODE_DEVELOP_MARKERS = ["author", "compose", "draft", "mint", "create", "feature", "variant", "bridge", "scaffold"];
export const MODE_COLLECT_MARKERS = ["probe", "scan", "observe", "measure", "coverage", "snapshot", "discover", "explore", "sample"];
export const MODE_REFLECT_MARKERS = ["audit", "health", "reconcile", "report", "completeness", "consistency", "reflect", "reach-gate", "review"];

/** The words of a declared name: `autoDraftDispatchResult` -> auto draft dispatch result; `intent:auto_draft_seed` -> intent auto draft seed. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function modeOfWords(words: string[]): LearningModeName | null {
  const hay = ` ${words.join(" ")} `;
  const has = (markers: string[]) => markers.some((m) => hay.includes(` ${nameWords(m).join(" ")} `));
  // reflect is the most specific family; check it first, then develop, then collect.
  if (has(MODE_REFLECT_MARKERS)) return "reflect";
  if (has(MODE_DEVELOP_MARKERS)) return "develop";
  if (has(MODE_COLLECT_MARKERS)) return "collect";
  return null;
}

/** The candidate's work mode from its declared output shapes and tags; its id only when it declares neither. */
export function candidateMode(templateId: string, outputShapes: readonly string[], tags: readonly string[]): LearningModeName | null {
  const declared = [...outputShapes, ...tags];
  if (declared.length > 0) return modeOfWords(declared.flatMap(nameWords));
  return modeOfWords(nameWords(templateId));
}
