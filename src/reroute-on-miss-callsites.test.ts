// A PINNED AUTONOMOUS DISPATCH MAY RETRY ON ANOTHER ARM (REALIGNMENT R:181, §3.4 #13; wiring item W1). boredom pinned
// its rotation goals to a template (AUTONOMOUS_GOAL_TARGET_TEMPLATES) without `reroute_on_miss`, so goal-host ran them
// with maxAttempts = 1 (index.ts runGoalWithRecovery: `opts.callerPinned || !goal ? 1 : opts.maxAttempts`): an arm that
// hollowed on attempt 1 was never followed by an attempt on another arm, and the next tick repeated the same pick.
// goal-host already honours the opt-in (/run-goal: `callerPinnedTarget = ... && !rerouteOnMiss`), so attempt 2 is
// chosen by its recovery loop with attempt 1's arm excluded; a reached attempt 1 breaks the loop (no retry).
// index.ts top-level-awaits main()/poolLoop(), so it cannot be imported in a test: these are source pins.
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

describe("boredom's pinned goal-host dispatches opt into reroute_on_miss", () => {
  const body = fnBody("async function dispatchGoal(");
  const goalHost = body.slice(body.indexOf("// goal-host"));

  test("[MUST-FAIL] a pinned template is sent together with reroute_on_miss: true", () => {
    expect(goalHost).toContain("if (targetTemplateId) { requestBody.targetTemplateId = targetTemplateId; requestBody.reroute_on_miss = true; }");
  });

  test("[CONTROL] an unpinned goal sends no reroute flag; light-dispatch is untouched; no learning mode is sent", () => {
    // every statement that sends the flag sits inside the pinned-template branch
    const sends = goalHost.split("\n").filter((l) => l.includes("reroute_on_miss") && !l.trim().startsWith("//"));
    expect(sends.every((l) => l.includes("if (targetTemplateId) {"))).toBe(true);
    const light = body.slice(0, body.indexOf("// goal-host"));
    expect(light).not.toContain("reroute_on_miss");
    // boredom sends no learning_mode, so its dispatches are learn-mode; observe-mode traffic comes from other callers
    // and is not touched by this flag
    expect(SRC).not.toContain("learning_mode");
  });

  test("[CONTROL] every pinned goal-host dispatch goes through dispatchGoal (the one /run-goal POST that names a template)", () => {
    const posts = SRC.split("`${GOAL_HOST_ENDPOINT}/run-goal`").length - 1;
    expect(posts).toBe(2); // dispatchGoal, and the gap-goal POST (a goal text with no template: never pinned)
    const gapPost = SRC.slice(SRC.indexOf("const res = await fetch(`${GOAL_HOST_ENDPOINT}/run-goal`"));
    expect(gapPost.slice(0, gapPost.indexOf("});"))).not.toContain("targetTemplateId");
  });
});
