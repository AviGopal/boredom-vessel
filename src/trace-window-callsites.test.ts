// index.ts top-level-awaits main()/poolLoop(), so it cannot be imported in a test. These source pins hold both posterior
// fetchers to readTraceWindow (trace-window.test.ts drives it with a stubbed fetch): a truncated window yields no rows,
// and no rows means an empty map (one-shot goal selection round-robin, the pool's signature-continuity boost off, the
// dispatcher draw uniform). A short page still flows into the loop below.
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

describe("posterior fetchers read one honest trace window", () => {
  for (const name of ["fetchPosteriorsForSignature", "fetchDispatcherPosteriors"]) {
    test(`[MUST-FAIL] ${name} reads through readTraceWindow and returns the empty map on null`, () => {
      const body = fnBody(`async function ${name}(`);
      expect(body).toContain(`const arr = await readTraceWindow(ACTIVITY_API_ENDPOINT, authHeaders(), since, "${name}");`);
      expect(body).toContain("if (!arr) return cells;");
      expect(body).not.toContain("limit=500");
      expect(body).not.toContain("execution-traces?");
      // A short page still computes weights: the rows flow into the existing per-trace loop.
      expect(body).toContain("for (const t of arr) {");
    });
  }

  test("the module is imported", () => {
    expect(SRC).toContain('import { readTraceWindow } from "./trace-window";');
  });
});
