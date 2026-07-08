/**
 * Resolver: vesselAdditionScaffoldDispatch
 *
 * Implements the deterministic consumer half of the routing decision made by
 * gap-to-scenario-bridge. Reads vessel scenario files, generates a vessel
 * design via LLM, and dispatches to scaffold-and-publish-vessel.
 *
 * Tags: boredom_target_template, lift.autonomous.loop, vessel.addition
 * Output shape: vesselScaffoldDispatchResult
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import {
  type VesselScaffoldDispatchResult,
  VESSEL_SCAFFOLD_DISPATCH_RESULT_SHAPE,
} from "../shapes/vesselScaffoldDispatchResult";

const SCENARIOS_DIR =
  "/workspace/validation/failure-modes/vessel-scenarios";
const RUN_GOAL_URL = "http://127.0.0.1:8210/run-goal";
const SCAFFOLD_TEMPLATE_ID =
  "development-vessel:scaffold-and-publish-vessel";

interface VesselDesign {
  vessel_name: string;
  port: number;
  advertised_shapes_literal: string;
  description: string;
  commit_message: string;
  pr_title: string;
  pr_body: string;
}

interface LlmCompletionDispatchInput {
  prompt: string;
}

interface ResolverContext {
  llm_completion_dispatch: (input: LlmCompletionDispatchInput) => Promise<string>;
}

/** Fisher-Yates shuffle — returns a new shuffled array */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

export async function resolveVesselAdditionScaffoldDispatch(
  ctx: ResolverContext
): Promise<{ shape: typeof VESSEL_SCAFFOLD_DISPATCH_RESULT_SHAPE; body: VesselScaffoldDispatchResult }> {
  // 1. Read scenario files with shuffle:true
  const entries = await readdir(SCENARIOS_DIR);
  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  const shuffled = shuffle(jsonFiles);

  const firstFile = shuffled[0];
  if (firstFile === undefined) {
    throw new Error(
      `No .json scenario files found in ${SCENARIOS_DIR}`
    );
  }

  // 2. Extract first scenario path and read its content
  const scenarioPath = join(SCENARIOS_DIR, firstFile);
  const scenarioContent = await readFile(scenarioPath, "utf-8");

  // 3. Run llm_completion_dispatch to generate vessel design JSON
  const prompt = [
    "Given the following vessel scenario, generate a vessel design as a JSON object with these exact fields:",
    "  vessel_name (kebab-case, ends with -vessel),",
    "  port (integer between 8300 and 8399, unique),",
    "  advertised_shapes_literal (TypeScript type literal string for the shapes this vessel will expose),",
    "  description (one sentence describing what the vessel resolves),",
    "  commit_message (conventional commit format),",
    "  pr_title (short imperative title),",
    "  pr_body (markdown body including a 'Substrate-Authored-By: substrate-loop' trailer line).",
    "",
    "Scenario:",
    scenarioContent,
    "",
    "Respond with ONLY valid JSON, no markdown fences.",
  ].join("\n");

  const llmResponse = await ctx.llm_completion_dispatch({ prompt });

  // 4. Parse the LLM response as vessel design JSON
  const design: VesselDesign = JSON.parse(llmResponse) as VesselDesign;

  // 5. Extract each field via json_path_extract (direct property access per parsed JSON)
  const vessel_name = design.vessel_name;
  const port = design.port;
  const advertised_shapes_literal = design.advertised_shapes_literal;
  const description = design.description;
  const commit_message = design.commit_message;
  const pr_title = design.pr_title;
  const pr_body = design.pr_body;

  // Validate pr_body contains Substrate-Authored-By trailer
  if (!pr_body.includes("Substrate-Authored-By:")) {
    throw new Error(
      "LLM-generated pr_body missing required 'Substrate-Authored-By:' trailer"
    );
  }

  // 6. Dispatch to /run-goal with targetTemplateId and variables
  const variables = {
    vessel_name,
    port,
    advertised_shapes_literal,
    description,
    commit_message,
    pr_title,
    pr_body,
    dirPath: `/workspace/repos/${vessel_name}`,
    unitFilePath: `/etc/systemd/system/${vessel_name}.service`,
    owner: "substrate-loop",
    repo: vessel_name,
    base_branch: "main",
    target_branch: `feat/scaffold-${vessel_name}`,
  };

  const dispatchResponse = await fetch(RUN_GOAL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetTemplateId: SCAFFOLD_TEMPLATE_ID,
      variables,
    }),
  });

  const dispatchBody: unknown = await dispatchResponse.json();

  // 7. Build output with output shape vesselScaffoldDispatchResult
  const result: VesselScaffoldDispatchResult = {
    vessel_name,
    port,
    advertised_shapes_literal,
    description,
    commit_message,
    pr_title,
    pr_body,
    dispatch_response: dispatchBody,
    dispatched_at: new Date().toISOString(),
  };

  return {
    shape: VESSEL_SCAFFOLD_DISPATCH_RESULT_SHAPE,
    body: result,
  };
}
