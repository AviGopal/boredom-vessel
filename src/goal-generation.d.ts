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
export declare function sanitizeGoalText(raw: string): string;
export declare function admitActionableGapsMirror<T extends {
    id: string;
    category?: string;
    classification_metadata?: Record<string, unknown>;
}>(gaps: T[]): T[];
export declare function generateGapGoalCandidates(activityApiEndpoint: string, apiKey: string): Promise<Array<{
    templateId: string;
    goalText: string;
    shapes: string[];
    source: "gap_generated";
    gapId: string;
    classificationMetadata: {
        gap_subtype?: string;
        category?: string;
        detected_at?: string;
    };
}>>;
//# sourceMappingURL=goal-generation.d.ts.map