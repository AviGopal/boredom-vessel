// CHECK for gap boredoms-pinned-autonomous-dispatches-never-retry-on-a-miss-so-attempt-two-repeats-attempt-one.
//
// boredom pinned its autonomous goals to a template without reroute_on_miss, so goal-host ran them with
// maxAttempts = 1 and an arm that hollowed on attempt 1 was never followed by an attempt on another arm. The fix
// re-wires the existing option: a pinned dispatch carries reroute_on_miss: true, and goal-host's existing recovery
// loop picks attempt 2 with attempt 1's arm excluded.
//   [MUST-FAIL] a pinned template is sent together with reroute_on_miss: true.
//   [CONTROL]   an unpinned goal sends no reroute flag, and light-dispatch is untouched.
// index.ts top-level-awaits its main loop, so it cannot be imported in a test: these are source pins, reused from
// the fix's own test (src/reroute-on-miss-callsites.test.ts).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "../../src/index.ts"), "utf8");

function fnBody(decl: string): string {
  const start = SRC.indexOf(decl);
  if (start < 0) throw new Error(`declaration not found: ${decl}`);
  const rest = SRC.slice(start + decl.length);
  const next = rest.search(/\n(?:async function |function |const |let |interface |if \()/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("boredom's pinned goal-host dispatches opt into reroute_on_miss", () => {
  const body = fnBody("async function dispatchGoal(");
  const goalHost = body.slice(body.indexOf("// goal-host"));

  test("[MUST-FAIL] a pinned template is sent together with reroute_on_miss: true", () => {
    expect(goalHost).toMatch(/if \(targetTemplateId\) \{[^}]*requestBody\.targetTemplateId = targetTemplateId;[^}]*requestBody\.reroute_on_miss = true;/);
  });

  test("[CONTROL] an unpinned goal sends no reroute flag; light-dispatch is untouched", () => {
    const sends = goalHost.split("\n").filter((l) => l.includes("reroute_on_miss") && !l.trim().startsWith("//"));
    expect(sends.every((l) => l.includes("if (targetTemplateId) {"))).toBe(true);
    const light = body.slice(0, body.indexOf("// goal-host"));
    expect(light).not.toContain("reroute_on_miss");
  });
});
