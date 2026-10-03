// index.ts top-level-awaits main()/poolLoop(), so it cannot be imported in a
// test. These source pins hold both graders to the decision functions in
// dispatch-refusal.ts, which dispatch-refusal.test.ts drives with stubbed fetch.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

/** Body of a top-level function: from its declaration to the next top-level declaration. */
function fnBody(decl: string): string {
  const start = SRC.indexOf(decl);
  if (start < 0) throw new Error(`declaration not found: ${decl}`);
  const rest = SRC.slice(start + decl.length);
  const next = rest.search(/\n(?:async function |function |const |let |if \()/);
  return next < 0 ? rest : rest.slice(0, next);
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

describe("grader #1 call site — dispatchByTemplateId", () => {
  const body = fnBody("async function dispatchByTemplateId(");

  test("the POST verdict goes through settleGapGoalPost with recordOutcomeByTemplate injected", () => {
    expect(body).toContain("settleGapGoalPost(res, templateId, { recordOutcome: recordOutcomeByTemplate");
    expect(body).not.toContain("if (!res.ok && res.status !== 202)");
  });

  test("a non-ok verdict returns before the cooldown stamp, so a refusal retries next tick", () => {
    const settle = body.indexOf("settleGapGoalPost(");
    const stamp = body.indexOf("gapGoalLastDispatchAt.set(");
    expect(settle).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(settle);
    expect(body.slice(settle, stamp)).toMatch(/if \(verdict !== "ok"\) return null;/);
  });

  test("the only direct failure grade left is the network-error catch", () => {
    expect(count(body, "recordOutcomeByTemplate(templateId, false)")).toBe(1);
    const grade = body.indexOf("recordOutcomeByTemplate(templateId, false)");
    expect(body.lastIndexOf("} catch {", grade)).toBeGreaterThan(body.indexOf("gapGoalLastDispatchAt.set("));
  });
});

describe("failure counters are bumped only by recordOutcomeByTemplate", () => {
  test("every consecutiveFailureByTemplate increment lives inside recordOutcomeByTemplate", () => {
    const rec = fnBody("function recordOutcomeByTemplate(");
    const bump = /consecutiveFailureByTemplate\.set\([^;]*\+ 1\)/g;
    expect((SRC.match(bump) ?? []).length).toBe(1);
    expect((rec.match(bump) ?? []).length).toBe(1);
  });
});

describe("grader #2 call site — one-shot main()", () => {
  const body = fnBody("async function main(");

  test("the response verdict goes through settleOneShotDispatch", () => {
    expect(body).toContain("settleOneShotDispatch(res, dispatcher, {");
    expect(body).not.toContain("if (!res.ok && res.status !== 202 && res.status !== 207)");
  });

  test("the semantic_reject lesson is written only from the injected onFailure", () => {
    expect(count(body, 'handleDispatchGapFailure(')).toBe(1);
    const settle = body.indexOf("settleOneShotDispatch(");
    const lesson = body.indexOf("handleDispatchGapFailure(");
    const exit = body.indexOf("process.exit(settled.exitCode)");
    expect(lesson).toBeGreaterThan(settle);
    expect(exit).toBeGreaterThan(lesson);
    expect(body.slice(settle, lesson)).toContain("onFailure:");
  });

  test("the exit code is the one the settle function chose, before the body is parsed", () => {
    const exit = body.indexOf("if (settled.exitCode !== null) process.exit(settled.exitCode);");
    expect(exit).toBeGreaterThan(-1);
    expect(body.indexOf("await res.json()")).toBeGreaterThan(exit);
  });
});
