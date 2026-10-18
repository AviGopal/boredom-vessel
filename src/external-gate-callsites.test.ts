// index.ts top-level-awaits main()/poolLoop(), so it cannot be imported in a test. These source pins hold the pool
// loop to the external-traffic gate (external-gate.test.ts drives the decision) and the pool's own dispatches to the
// boredom tag the gate's count excludes: untagged, the pool would count its own traffic as external and defer itself.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

/** Body of a top-level function: from its declaration to the next top-level declaration. */
function fnBody(decl: string): string {
  const start = SRC.indexOf(decl);
  if (start < 0) throw new Error(`declaration not found: ${decl}`);
  const rest = SRC.slice(start + decl.length);
  const next = rest.search(/\n(?:async function |function |const |let |interface |if \()/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("the pool's own dispatches carry BOREDOM_TAG", () => {
  const body = fnBody("async function dispatchByTemplateId(");
  test("[MUST-FAIL] the light-dispatch POST carries it", () => {
    expect(body).toContain("body: JSON.stringify({ template_id: templateId, variables: {}, tags: [BOREDOM_TAG] }),");
  });
  test("[MUST-FAIL] the gap-goal POST carries it", () => {
    expect(body).toContain('tags: ["boredom_autonomous", "gap_generated", BOREDOM_TAG]');
  });
});

describe("poolLoop runs the external-traffic gate", () => {
  const loop = fnBody("async function poolLoop(");
  const gateAt = loop.indexOf("if (externalGateOn(externalGatePolicy)) {");
  test("[MUST-FAIL] the gate sits after the envelope gate and the state refresh, before the exerciser and the fill loop", () => {
    expect(gateAt).toBeGreaterThan(-1);
    expect(loop.indexOf("const envelope = await boredomEnvelopeAllows();")).toBeLessThan(gateAt);
    expect(loop.indexOf("writeSelectorStateSnapshot();")).toBeGreaterThan(-1);
    expect(loop.indexOf("writeSelectorStateSnapshot();")).toBeLessThan(gateAt);
    expect(gateAt).toBeLessThan(loop.indexOf("await tickExerciseProposal();"));
    expect(gateAt).toBeLessThan(loop.indexOf("while (inFlight.size < MAX_CONCURRENT"));
    const gate = loop.slice(gateAt, loop.indexOf("// Exercise authored proposals", gateAt));
    expect(gate).toContain("const gate = deferForExternal(externalGatePolicy, reading, externalGateState, Date.now());");
    expect(gate).toContain("externalGateState = gate.state;");
    expect(gate).toMatch(/if \(gate\.defer\) \{[\s\S]*Date\.now\(\) - lastExternalGateLogAt > 300_000[\s\S]*continue;\s*\}/);
  });
  test("[CONTROL] off reads nothing: the trace-list read is inside the externalGateOn guard and nowhere else in the loop", () => {
    expect(loop.split("externalTracesSince(").length - 1).toBe(1);
    expect(loop.indexOf("externalTracesSince(")).toBeGreaterThan(gateAt);
    expect(SRC.split("deferForExternal(").length - 1).toBe(1);
  });
  test("the gate policy is read from the same boredomSelectionPolicy row as the trap policy", () => {
    expect(SRC).toContain("const gate = parseExternalGatePolicy(spData?.body?.impulses?.[0]?.body ?? null);");
    expect(SRC).toContain("let externalGatePolicy: ExternalGatePolicy = { ...DEFAULT_EXTERNAL_GATE_POLICY };");
  });
});
