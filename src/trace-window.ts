// THE POSTERIOR TRACE WINDOW, read for fetchPosteriorsForSignature and fetchDispatcherPosteriors (index.ts).
//
// Both asked the trace list for limit=500 over 24h, and the route clamps a page to 100 rows. At the measured ingest
// rate a 24h window holds thousands of rows, so one page was the newest 100: minutes of history, never the day the
// weights claim to summarise. The window is now read whole by offset paging on the same route (100 per page, newest
// first, `offset` → START): a short page is the end of the window. Rows are de-duplicated by execution_id, because
// traces landing between two page reads shift the newest-first offsets and repeat a boundary row (they never skip one).
//
// A read that cannot stand for the window still weighs NOTHING, and says why: the page cap reached before a short page,
// a full page that adds no new rows (the route ignored `offset`), a non-OK status, a body with no rows array, or a
// fetch error on any page. It is logged loudly and counted, and the caller gets no rows, so its posterior map is empty:
// one-shot goal selection is round-robin, the pool's signature-continuity boost is off, and the dispatcher choice is a
// uniform Beta(1,1) random draw. Only a complete window is weighed.
import { traceListRows } from "./idle-check";

/** The trace list route's page cap (GET /v2/activities/execution-traces clamps `limit` to this). */
export const TRACE_LIST_PAGE = 100;
/**
 * Pages one window read takes at most (a load bound on the hot list route): 10,000 rows. A window larger than this is
 * declined as capped, with the reason logged, never weighed from its newest slice.
 */
export const TRACE_WINDOW_PAGE_CAP = 100;

let truncatedWindows = 0;
/** How many windows this process has declined (capped, unpaged or unreadable). */
export function truncatedWindowCount(): number { return truncatedWindows; }

function decline(caller: string, sinceMs: number, why: string): null {
  truncatedWindows++;
  console.error(
    `[boredom-vessel] ${caller}: trace window truncated — ${why}, window since ${new Date(sinceMs).toISOString()} ` +
    `(truncated windows: ${truncatedWindows}); weighing nothing: goal selection round-robin, ` +
    `signature-continuity boost off, dispatcher choice a uniform random draw`,
  );
  return null;
}

function rowKey(row: Record<string, unknown>): string | null {
  const id = row.execution_id ?? row.id;
  return typeof id === "string" && id ? id : null;
}

/**
 * Every row of the trace list since `sinceMs`, read page by page with `offset` until a short page; or null, with the
 * reason logged and counted, when the read cannot stand for the window (see the header).
 */
export async function readTraceWindow(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  caller: string,
): Promise<Array<Record<string, unknown>> | null> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (let page = 0; page < TRACE_WINDOW_PAGE_CAP; page++) {
    const offset = page * TRACE_LIST_PAGE;
    const at = `page ${page + 1} (offset ${offset}, ${out.length} rows read)`;
    let body: unknown;
    try {
      const res = await fetch(
        `${endpoint}/v2/activities/execution-traces?limit=${TRACE_LIST_PAGE}&since=${sinceMs}` +
          (offset > 0 ? `&offset=${offset}` : ""),
        { headers, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) return decline(caller, sinceMs, `${at} answered HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      return decline(caller, sinceMs, `${at} failed: ${(err as Error).message}`);
    }
    const rows = traceListRows(body) as Array<Record<string, unknown>> | null;
    if (!rows) return decline(caller, sinceMs, `${at} has no rows array`);
    let added = 0;
    for (const row of rows) {
      const key = rowKey(row);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(row);
      added++;
    }
    if (rows.length < TRACE_LIST_PAGE) return out;
    if (added === 0) return decline(caller, sinceMs, `${at}: a full page added no new rows (the route did not honour offset)`);
  }
  return decline(
    caller, sinceMs,
    `read capped at ${TRACE_WINDOW_PAGE_CAP} pages of ${TRACE_LIST_PAGE} (${out.length} rows) before the window ended`,
  );
}
