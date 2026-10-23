import { describe, it, expect } from "bun:test";
import { sanitizeGoalText } from "./goal-generation";

// The 500-char goal cap kept the TAIL, so a long goal lost its head: the ask and the gap id
// ("Close substrate gap <id>: …") were cut, and the walk got a goal that names no gap. These
// pin the head-keeping cut: the ask survives verbatim, ids from the cut middle survive, and
// goals the cap never touched are unchanged.

const filler = (n: number, word = "context") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ");

describe("sanitizeGoalText cap keeps the head", () => {
  it("MUST-FAIL a 700-char Close goal keeps 'Close substrate gap <id>' verbatim", () => {
    const goal = `Close substrate gap gap-abc-123: the producer of the shape needs a repair so the walk reaches. ${filler(80)} Edit repos/goal-host-vessel/src/index.ts.`;
    expect(goal.length).toBeGreaterThan(650);
    const out = sanitizeGoalText(goal);
    expect(out.startsWith("Close substrate gap gap-abc-123:")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toMatch(/ … \[cut \d+ chars/);
  });

  it("ids and the edit site from the cut middle survive (fix property)", () => {
    const goal = `Close substrate gap gap-abc-123: ${filler(40)} see gap gap-mid-77 and concept_q2n0_Synthetic and repos/boredom-vessel/src/goal-generation.ts ${filler(60, "more")} done.`;
    const out = sanitizeGoalText(goal);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.startsWith("Close substrate gap gap-abc-123:")).toBe(true);
    for (const id of ["gap-mid-77", "concept_q2n0_Synthetic", "repos/boredom-vessel/src/goal-generation.ts"]) expect(out).toContain(id);
  });

  it("a long region quote does not push the edit site out of a Close goal", () => {
    const goal = `Close substrate gap gap-abc-123: ${filler(30)}. Edit repos/goal-host-vessel/src/index.ts in the region "${filler(50, "region")}".`;
    const out = sanitizeGoalText(goal);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toContain("Close substrate gap gap-abc-123:");
    expect(out).toContain("repos/goal-host-vessel/src/index.ts");
  });

  it("CONTROL a goal of exactly 500 chars is byte-unchanged", () => {
    const base = `Close substrate gap gap-abc-123: ${filler(80)}`;
    const goal = base.slice(0, 499) + "x";
    expect(goal.length).toBe(500);
    expect(sanitizeGoalText(goal)).toBe(goal);
  });

  it("CONTROL a short goal is byte-unchanged", () => {
    const goal = "Close substrate gap gap-abc-123: the producer needs a repair.";
    expect(sanitizeGoalText(goal)).toBe(goal);
  });

  it("CONTROL a long goal with an anchor and a replacement fence is unchanged", () => {
    const goal = `Close substrate gap gap-abc-123: in repos/goal-host-vessel/src/index.ts replace\n\`\`\`\n${filler(40, "anchor")}\n\`\`\`\nwith\n\`\`\`\n${filler(40, "replacement")}\n\`\`\``;
    expect(goal.length).toBeGreaterThan(500);
    expect(sanitizeGoalText(goal)).toBe(goal.trim());
  });
});
