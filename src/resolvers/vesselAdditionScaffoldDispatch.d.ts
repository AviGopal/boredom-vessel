/**
 * Resolver: vesselAdditionScaffoldDispatch
 *
 * Implements the deterministic consumer half of the routing decision made by
 * gap-to-scenario-bridge. Reads vessel scenario files, generates a vessel
 * design via LLM, and dispatches to scaffold-and-publish-vessel.
 *
 * Tags: boredom_target_template, lift.autonomous.loop, vessel.addition
 * Output shape: vesselScaffoldDispatchResult
 */
import { type VesselScaffoldDispatchResult, VESSEL_SCAFFOLD_DISPATCH_RESULT_SHAPE } from "../shapes/vesselScaffoldDispatchResult";
interface LlmCompletionDispatchInput {
    prompt: string;
}
interface ResolverContext {
    llm_completion_dispatch: (input: LlmCompletionDispatchInput) => Promise<string>;
}
export declare function resolveVesselAdditionScaffoldDispatch(ctx: ResolverContext): Promise<{
    shape: typeof VESSEL_SCAFFOLD_DISPATCH_RESULT_SHAPE;
    body: VesselScaffoldDispatchResult;
}>;
export {};
//# sourceMappingURL=vesselAdditionScaffoldDispatch.d.ts.map