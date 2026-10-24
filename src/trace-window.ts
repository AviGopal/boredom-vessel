// THE POSTERIOR TRACE WINDOW, read for fetchPosteriorsForSignature and fetchDispatcherPosteriors (index.ts).
//
// Both asked the trace list for limit=500 over 24h, and the route clamps a page to 100 rows. At the measured ingest
// rate a 24h window holds thousands of rows, so the page was the newest 100: minutes of history, never the day the
// weights claim to summarise, and nothing said so. A FULL page therefore weighs nothing: it is logged loudly and
// counted, and the caller gets no rows, so its posterior map is empty. With empty maps the one-shot goal selection is
// round-robin, the pool's signature-continuity boost is off, and the dispatcher choice is a uniform Beta(1,1) random
// draw. A short page is the whole window and is read as before. (The route honours `offset`, so a window-complete
// read is possible later without a route change.)
import { traceListRows } from "./idle-check";

/** The trace list route's page cap (GET /v2/activities/execution-traces clamps `limit` to this). */
export const TRACE_LIST_PAGE = 100;

let truncatedWindows = 0;
/** How many windows this process has refused as truncated. */
export function truncatedWindowCount(): number { return truncatedWindows; }

/**
 * Rows of the trace list since `sinceMs`, or null when the page cannot stand for the window: a non-OK status, a body
 * with no rows array, or a full page (truncated). A fetch error propagates to the caller, as before.
 */
export async function readTraceWindow(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  caller: string,
): Promise<Array<Record<string, unknown>> | null> {
  const res = await fetch(
    `${endpoint}/v2/activities/execution-traces?limit=${TRACE_LIST_PAGE}&since=${sinceMs}`,
    { headers, signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) return null;
  const rows = traceListRows(await res.json()) as Array<Record<string, unknown>> | null;
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
