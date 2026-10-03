/**
 * A dispatcher refusing work while it restarts is not a verdict on the work.
 *
 * goal-host answers POST /run-goal (and async dispatch) with HTTP 503 and a JSON
 * body during a graceful restart: `{draining:true}`, or `{quiesced:true,
 * retryable:true}` with a Retry-After header. Grading that as a failure debits
 * the arm (consecutive-failure streak, momentum) or writes a semantic_reject
 * lesson for a goal that was never looked at, so every restart would teach the
 * selector to avoid whatever it happened to be dispatching. Both graders in
 * index.ts decide through this module so the rule lives in one place.
 */

/** True when the response is a restart refusal the caller should retry, not grade. */
export function isRetryableRefusal(res: { status: number }, body: unknown): boolean {
  if (res.status !== 503) return false;
  if (!body || typeof body !== "object") return false;
  const b = body as { draining?: unknown; quiesced?: unknown; retryable?: unknown };
  return b.draining === true || b.quiesced === true || b.retryable === true;
}

/** The refusal flags that were set, for the log line ("draining", "quiesced", …). */
function refusalReason(body: unknown): string {
  const b = (body ?? {}) as { draining?: unknown; quiesced?: unknown; retryable?: unknown };
  const set = (["draining", "quiesced"] as const).filter((k) => b[k] === true);
  return set.length > 0 ? set.join("|") : "retryable";
}

/**
 * Read a response body once without consuming the caller's copy, and never
 * throw: a read or parse fault here must not land in a caller's catch, where it
 * would be graded as a network failure.
 */
async function peekBody(res: Response): Promise<{ text: string; json: unknown }> {
  let text = "(no body)";
  try {
    text = await res.clone().text();
  } catch {
    return { text, json: null };
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

export type DispatchVerdict = "ok" | "retryable" | "failure";

/** Classify a dispatch response. Reads the body only when the status is not ok. */
export async function classifyDispatchResponse(
  res: Response,
  okStatuses: readonly number[],
): Promise<{ verdict: DispatchVerdict; reason: string; text: string }> {
  if (res.ok || okStatuses.includes(res.status)) return { verdict: "ok", reason: "", text: "" };
  const { text, json } = await peekBody(res);
  if (isRetryableRefusal(res, json)) return { verdict: "retryable", reason: refusalReason(json), text };
  return { verdict: "failure", reason: "", text };
}

/**
 * Grader #1 (gap-goal supply): a failure is graded through `recordOutcome`; a
 * retryable refusal is logged and NOT graded. The caller must not stamp its
 * dispatch cooldown on anything but "ok", so a refusal retries next tick.
 */
export async function settleGapGoalPost(
  res: Response,
  templateId: string,
  deps: { recordOutcome: (templateId: string, ok: boolean) => void; log?: (line: string) => void },
): Promise<DispatchVerdict> {
  const c = await classifyDispatchResponse(res, [202]);
  if (c.verdict === "retryable") {
    (deps.log ?? console.log)(
      `[gap-goal-supply] goal-host refused (retryable: ${c.reason}) — not graded, retry next tick`,
    );
  } else if (c.verdict === "failure") {
    deps.recordOutcome(templateId, false);
  }
  return c.verdict;
}

/**
 * Grader #2 (one-shot main()): a failure writes the semantic_reject lesson via
 * `onFailure` and exits 1. A retryable refusal exits 0 with no lesson: the unit
 * is timer-fired, so the next tick is the retry, and a non-zero exit would mark
 * the unit failed on every goal-host restart (a distinct code would need
 * SuccessExitStatus= in a unit file this repo does not own). exitCode null
 * means the response is ok and the caller continues.
 */
export async function settleOneShotDispatch(
  res: Response,
  dispatcher: string,
  deps: {
    onFailure: () => Promise<void>;
    log?: (line: string) => void;
    logError?: (line: string) => void;
  },
): Promise<{ verdict: DispatchVerdict; exitCode: 0 | 1 | null }> {
  const c = await classifyDispatchResponse(res, [202, 207]);
  if (c.verdict === "ok") return { verdict: "ok", exitCode: null };
  if (c.verdict === "retryable") {
    (deps.log ?? console.log)(
      `[boredom-vessel] not dispatched: goal-host restarting (${dispatcher} HTTP ${res.status}, retryable: ${c.reason}) — no lesson recorded, next tick retries`,
    );
    return { verdict: "retryable", exitCode: 0 };
  }
  await deps.onFailure();
  (deps.logError ?? console.error)(`[boredom-vessel] ${dispatcher} HTTP ${res.status}: ${c.text}`);
  return { verdict: "failure", exitCode: 1 };
}
