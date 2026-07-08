/**
 * Output shape: vesselScaffoldDispatchResult
 *
 * Returned by the vessel-addition-scaffold-dispatch activity template
 * after dispatching to scaffold-and-publish-vessel via /run-goal.
 */
export interface VesselScaffoldDispatchResult {
  /** The name of the vessel that was scaffolded */
  vessel_name: string;
  /** The port assigned to the new vessel */
  port: number;
  /** The advertised shapes TypeScript literal for the new vessel */
  advertised_shapes_literal: string;
  /** One-sentence description of what the vessel resolves */
  description: string;
  /** Conventional commit message used for the scaffold commit */
  commit_message: string;
  /** Pull request title */
  pr_title: string;
  /** Pull request body including Substrate-Authored-By trailer */
  pr_body: string;
  /** The HTTP response from /run-goal dispatch */
  dispatch_response: unknown;
  /** ISO timestamp of when the dispatch completed */
  dispatched_at: string;
}

/**
 * Shape name constant used for resolver registration and output tagging.
 */
export const VESSEL_SCAFFOLD_DISPATCH_RESULT_SHAPE =
  "vesselScaffoldDispatchResult" as const;
