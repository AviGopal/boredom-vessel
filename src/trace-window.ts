// THE POSTERIOR TRACE WINDOW, read for fetchPosteriorsForSignature and fetchDispatcherPosteriors (index.ts).
//
// Both fetchers name their signature and get the window from the aggregate (THE AGGREGATE READ, below). The list read
// described here is what a read with no signature gets, and the fallback when the aggregate is unavailable.
//
// Both asked the trace list for limit=500 over 24h, and the route clamps a page to 100 rows. At the measured ingest
// rate a 24h window holds thousands of rows, so the page was the newest 100: minutes of history, never the day the
// weights claim to summarise, and nothing said so. A FULL page therefore weighs nothing: it is logged loudly and
// counted, and the caller gets no rows, so its posterior map is empty. With empty maps the one-shot goal selection is
// round-robin, the pool's signature-continuity boost is off, and the dispatcher choice is a uniform Beta(1,1) random
// draw. A short page is the whole window and is read as before. The list read is ONE page, never paged by offset:
// offset paging (with a shared read per tick and a 15 s wall-clock deadline over it) was reverted after it crossed the
// pre-registered database CPU rule, so the only full-window path is the aggregate. Each request is bounded by its own
// timeout, not by a wall-clock budget over the whole read.
//
// THE AGGREGATE READ, for a fetcher that names its signature (traceWindowSignature, set just before the call). The list
// route rebuilds and sorts the whole 24 h window for every page (~1-1.4 s at any offset), so paging could not read a
// day whole. The window is instead counted in the database: activity-api's traceAggregateReport, posted to the trace
// store's resolve route, filtered to the signature's tag, grouped by activity_id and the dispatcher_used tag, success
// by the judge's verdict (success_rule reached: reached = true is a success, reached = false a failure, no verdict
// neither). Two calls, success_count and failure_count, one after the other (and a count only when both are empty, to
// tell an all-ungraded window from an empty one); a report is used only when it is measured, not truncated, and echoes
// the tag, the grouping, the observe switch and the rule (a producer that predates them would ignore them and count a
// different window, so it is treated as unavailable). Its cells come back as one row per graded trace they count,
// carrying the signature tag, the dispatcher tag, the activity_id and the verdict, so the fetchers' loops weigh them.
//
// SUCCESS IS REACHED, NOT EXIT STATUS (traceOutcome). Both fetchers used to count status success/completed (or
// success = true) as a success, so a hollow completion (completed, reached:false) earned alpha and selection learned to
// prefer what completes over what reaches. They now grade every row, aggregate or list, by its reach verdict, the one
// reader activity-api's learner uses (classifyReach: reached / not-reached / ungraded); an ungraded row is no sample.
// OBSERVE TRACES ARE COUNTED like any run (exclude_observe: false, echoed back): an observe execution still resolves
// impulses, which make real changes, so it is evidence about the arm, exactly as the list read always counted it.
// An unavailable aggregate falls back to the one-page list read: a short page is weighed, a full page weighs nothing.
import { traceListRows } from "./idle-check";

/**
 * A posterior row's outcome by the judge's verdict: true when it reached, false when it did not, null when it carries
 * no verdict (ungraded: neither a success nor a failure, so no sample). Exit status and the success flag are not read.
 */
export function traceOutcome(row: Record<string, unknown>): boolean | null {
  return row.reached === true ? true : row.reached === false ? false : null;
}

/** The trace list route's page cap (GET /v2/activities/execution-traces clamps `limit` to this). */
export const TRACE_LIST_PAGE = 100;
/** Per-request timeout for the list page, the list probe and each aggregate call. */
const REQUEST_TIMEOUT_MS = 8_000;
/** The trace store's aggregate shape (activity-api trace-aggregate-report.ts). */
export const TRACE_AGGREGATE_SHAPE = "traceAggregateReport";
/** The aggregate's own group cap: a reader that needs every group asks for this many and still checks `truncated`. */
const AGGREGATE_GROUP_LIMIT = 20_000;

type Row = Record<string, unknown>;
let nextSignature: string | null = null;

/**
 * Name the state signature the NEXT readTraceWindow call weighs, so it reads the aggregate for that signature. Set it
 * immediately before the call: the call takes it synchronously and clears it, so it never leaks into a later read.
 */
export function traceWindowSignature(signature: string): void { nextSignature = signature || null; }

let truncatedWindows = 0;
/** How many windows this process has refused as truncated. */
export function truncatedWindowCount(): number { return truncatedWindows; }

/**
 * Rows of the trace list since `sinceMs` (one page), or null when the page cannot stand for the window: a non-OK
 * status, a body with no rows array, or a full page (truncated). A fetch error propagates to the caller, as before.
 */
async function listRead(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  caller: string,
): Promise<Row[] | null> {
  const res = await fetch(
    `${endpoint}/v2/activities/execution-traces?limit=${TRACE_LIST_PAGE}&since=${sinceMs}`,
    { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!res.ok) return null;
  const rows = traceListRows(await res.json()) as Row[] | null;
  if (!rows) return null;
  if (rows.length >= TRACE_LIST_PAGE) {
    truncatedWindows++;
    console.error(
      `[boredom-vessel] ${caller}: trace window truncated — a full page of ${rows.length} rows since ` +
      `${new Date(sinceMs).toISOString()} (truncated windows: ${truncatedWindows}); weighing nothing: goal selection round-robin, ` +
      `signature-continuity boost off, dispatcher choice a uniform random draw`,
    );
    return null;
  }
  return rows;
}

type AggregateRow = { key: string; tag_value: string | null; value: number };

/** One traceAggregateReport for the signature over the window: its rows, or why it is not usable. */
async function aggregateCall(
  endpoint: string,
  headers: Record<string, string>,
  pointer: Record<string, unknown>,
): Promise<{ rows: AggregateRow[] } | { why: string; noEcho?: true }> {
  const metric = String(pointer.metric);
  let wire: { success?: boolean; content?: unknown; error?: string };
  try {
    const res = await fetch(`${endpoint}/v2/impulses/resolve`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ impulse: { pointer } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { why: `${metric} answered HTTP ${res.status}` };
    wire = await res.json() as typeof wire;
  } catch (err) {
    return { why: `${metric} failed: ${(err as Error).message}` };
  }
  if (wire?.success !== true || typeof wire.content !== "string") return { why: `${metric} did not resolve: ${wire?.error ?? "no content"}` };
  let report: Record<string, unknown>;
  try { report = JSON.parse(wire.content) as Record<string, unknown>; } catch { return { why: `${metric} report unparseable` }; }
  if (report.measured !== true) return { why: `${metric} unmeasured: ${String(report.reason ?? "no reason")}` };
  if (report.truncated !== false) return { why: `${metric} truncated` };
  // A producer that predates the tag filter, the grouping, the observe switch or the rule ignores them and counts a
  // different window.
  for (const k of ["tag", "group_by_tag", "exclude_observe", "success_rule"]) {
    if (report[k] !== pointer[k]) return { why: `${metric} report does not serve ${k} (echoed ${JSON.stringify(report[k])})`, noEcho: true };
  }
  if (!Array.isArray(report.rows)) return { why: `${metric} report has no rows array` };
  const rows: AggregateRow[] = [];
  for (const r of report.rows as Array<Record<string, unknown>>) {
    if (typeof r.key !== "string" || typeof r.value !== "number" || !Number.isFinite(r.value) || r.value < 0) continue;
    rows.push({ key: r.key, tag_value: typeof r.tag_value === "string" ? r.tag_value : null, value: Math.trunc(r.value) });
  }
  return { rows };
}

/**
 * The window for one signature from the aggregate, as one row per counted trace; or the reason, when the aggregate is
 * unavailable (the caller then reads the list page).
 */
async function aggregateRead(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  signature: string,
): Promise<{ rows: Row[]; ungraded?: number } | { why: string; noEcho?: true }> {
  const sigTag = `state_signature:${signature}`;
  const base = {
    type: TRACE_AGGREGATE_SHAPE, group_by: "activity_id", tag: sigTag, group_by_tag: "dispatcher_used",
    exclude_observe: false, // Observe runs resolve impulses that make real changes: they are counted like any run.
    success_rule: "reached", // Rounded: the caller's `since` is a few ms older than this call's clock, and a ceil would read 25 h.
    window_hours: Math.max(1, Math.round((Date.now() - sinceMs) / 3_600_000)),
    limit: AGGREGATE_GROUP_LIMIT,
  };
  const call = async (metric: string) => {
    const got = await aggregateCall(endpoint, headers, { ...base, metric });
    return "why" in got ? { ...got, why: `aggregate ${got.why}` } : got;
  };
  const rows: Row[] = [];
  for (const [metric, reached] of [["success_count", true], ["failure_count", false]] as const) {
    const got = await call(metric);
    if ("why" in got) return got;
    for (const r of got.rows) {
      const tags = r.tag_value === null ? [sigTag] : [sigTag, `dispatcher_used:${r.tag_value}`];
      for (let i = 0; i < r.value; i++) {
        // "(none)" is the aggregate's key for a row with no activity_id: the list served such a row with none, too.
        rows.push({ ...(r.key === "(none)" ? {} : { activity_id: r.key }), tags, reached, success: reached, status: reached ? "success" : "failure" });
      }
    }
  }
  if (rows.length === 0) {
    // No graded trace. Whether the window holds ungraded ones decides whether "empty" needs checking (signatureRead).
    const got = await call("count");
    if ("why" in got) return got;
    return { rows, ungraded: got.rows.reduce((n, r) => n + r.value, 0) };
  }
  return { rows };
}

/** Whether the list holds any trace in the window: one page of one row. Null when it cannot be read. */
async function listProbe(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
): Promise<boolean | null> {
  try {
    const res = await fetch(`${endpoint}/v2/activities/execution-traces?limit=1&since=${sinceMs}`, {
      headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const rows = traceListRows(await res.json());
    return rows === null ? null : rows.length > 0;
  } catch {
    return null;
  }
}

/** The aggregate for `signature`, falling back to the one-page list read when it is unavailable. */
async function signatureRead(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  caller: string,
  signature: string,
): Promise<Row[] | null> {
  const startedAt = Date.now();
  const agg = await aggregateRead(endpoint, headers, sinceMs, signature);
  if ("rows" in agg && agg.rows.length === 0 && !agg.ungraded) {
    // EMPTY BUT MEASURED IS NOT TAKEN ON TRUST. A tenant scope the aggregate applies and the list does not (an
    // account_id equality on rows that carry none) makes every aggregate empty, which would weigh nothing silently.
    // One bounded probe (one row of the window): if the list has traces, the empty report is a scope mismatch, said
    // loudly, and the window is read from the list page instead.
    const probe = await listProbe(endpoint, headers, sinceMs);
    if (probe !== false) {
      console.error(
        `[boredom-vessel] ${caller}: trace window: aggregate empty while list has traces: scope mismatch ` +
        `(${TRACE_AGGREGATE_SHAPE} counted 0 for state_signature:${signature}${probe === null ? "; the probe could not read the list" : ""}); ` +
        `reading the trace list page`,
      );
      return listRead(endpoint, headers, sinceMs, caller);
    }
  }
  if ("rows" in agg) {
    console.log(
      `[boredom-vessel] ${caller}: trace window read whole — ${agg.rows.length} graded rows` +
      `${agg.ungraded ? ` (${agg.ungraded} ungraded, weighed as neither)` : ""} from ${TRACE_AGGREGATE_SHAPE} ` +
      `for state_signature:${signature} since ${new Date(sinceMs).toISOString()} (${Date.now() - startedAt} ms)`,
    );
    return agg.rows;
  }
  if (agg.noEcho) {
    console.error(
      `[boredom-vessel] ${caller}: trace window: aggregate producer lacks tag/success_rule echo: aa extension not live, ` +
      `using list (${agg.why})`,
    );
  } else {
    console.error(`[boredom-vessel] ${caller}: ${TRACE_AGGREGATE_SHAPE} unavailable (${agg.why}); reading the trace list page`);
  }
  return listRead(endpoint, headers, sinceMs, caller);
}

/**
 * The window since `sinceMs`: for a signature named by traceWindowSignature, one row per trace the aggregate counts
 * (falling back to the list page when it is unavailable); otherwise the rows of one list page. Null when the read
 * cannot stand for the window (see the header). A fetch error on the list page propagates to the caller, as before.
 */
export async function readTraceWindow(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  caller: string,
): Promise<Array<Record<string, unknown>> | null> {
  const signature = nextSignature;
  nextSignature = null;
  return signature === null
    ? listRead(endpoint, headers, sinceMs, caller)
    : signatureRead(endpoint, headers, sinceMs, caller, signature);
}
