/**
 * Tests for vesselAdditionScaffoldDispatch resolver
 */
import { describe, it, expect, mock } from "bun:test";
import type { VesselScaffoldDispatchResult } from "../shapes/vesselScaffoldDispatchResult";

describe("vesselAdditionScaffoldDispatch shape contract", () => {
  it("result shape has all required fields", () => {
    const result: VesselScaffoldDispatchResult = {
      vessel_name: "test-vessel",
      port: 8301,
      advertised_shapes_literal: "{ kind: 'testShape' }",
      description: "Resolves test scenarios.",
      commit_message: "feat(test-vessel): scaffold new vessel",
      pr_title: "Add test-vessel",
      pr_body:
        "Adds test-vessel resolver.\n\nSubstrate-Authored-By: substrate-loop",
      dispatch_response: { ok: true },
      dispatched_at: new Date().toISOString(),
    };
    expect(result.vessel_name).toBe("test-vessel");
    expect(result.pr_body).toContain("Substrate-Authored-By:");
  });
});
