import { expect, spyOn, test } from "bun:test";
import * as mod from "../../src/goal-generation";

test("DEV_VESSEL_ENDPOINT unset: discovery reaches the own development-vessel and reports its HTTP 409", async () => {
  const previousEndpoint = process.env.DEV_VESSEL_ENDPOINT;
  const activityEndpoint = "http://activity.node-under-test.invalid";
  const ownDevelopmentEndpoint = "http://development.node-under-test.invalid";
  const warnings: string[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
  const warn = spyOn(console, "warn").mockImplementation((...values: unknown[]): void => {
    warnings.push(values.map(String).join(" "));
  });
  const fetchStub = spyOn(globalThis, "fetch").mockImplementation(async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const input = args[0];
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === activityEndpoint) {
      // The only advertised development-vessel producer belongs to this node.
      return Response.json({
        shape: "vesselEndpoint",
        body: { vessel: "development-vessel", endpoint: ownDevelopmentEndpoint },
      });
    }
    if (url.href === `${ownDevelopmentEndpoint}/v2/impulses/resolve`) {
      // Distinguish reaching the discovered producer from reaching the pinned fallback.
      return new Response(null, { status: 409 });
    }
    return new Response(null, { status: 503 });
  });

  try {
    delete process.env.DEV_VESSEL_ENDPOINT;
    await mod.generateGapGoalCandidates(activityEndpoint, "test-api-key");
    expect(warnings).toContain(
      "[gap-goal-supply] dev-vessel substrateGap resolve returned 409 — 0 gap-goal candidates this pass",
    );
  } finally {
    fetchStub.mockRestore();
    warn.mockRestore();
    timeout.mockRestore();
    if (previousEndpoint === undefined) delete process.env.DEV_VESSEL_ENDPOINT;
    else process.env.DEV_VESSEL_ENDPOINT = previousEndpoint;
  }
});

test("CONTROL: sanitizeGoalText preserves 'Keep the existing behaviour.'", () => {
  expect(mod.sanitizeGoalText("Keep the existing behaviour.")).toBe("Keep the existing behaviour.");
});
