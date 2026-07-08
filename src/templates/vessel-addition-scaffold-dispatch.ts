/**
 * vessel-addition-scaffold-dispatch template registration
 *
 * Registers the vessel-addition-scaffold-dispatch activity template with
 * discovery-vessel (not activity-api /v2/vessels/register which is deprecated).
 *
 * This is the deterministic consumer half of the routing decision made by
 * gap-to-scenario-bridge, enabling capability horizons that require new
 * resolvers (not recombination) to grow the action space (delta-S, delta-A, delta-R).
 */

import templateDefinition from "./vessel-addition-scaffold-dispatch.json";

export type VesselAdditionTemplateDefinition = typeof templateDefinition;

export const vesselAdditionScaffoldDispatchTemplate: VesselAdditionTemplateDefinition =
  templateDefinition;

export default vesselAdditionScaffoldDispatchTemplate;
