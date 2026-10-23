// THE POSTERIOR TRACE WINDOW, read for fetchPosteriorsForSignature and fetchDispatcherPosteriors (index.ts).
//
// Both asked the trace list for limit=500 over 24h, and the route clamps a page to 100 rows. At the measured ingest
// rate a 24h window holds thousands of rows, so one page was the newest 100: minutes of history, never the day the
// weights claim to summarise. The window is now read whole by offset paging on the same route (100 per page, newest
// first, `offset` → START): a short page is the end of the window. Rows are de-duplicated by execution_id, because
// traces landing between two page reads shift the newest-first offsets and repeat a boundary row (they never skip one).
// Each complete read logs one line with its row and page count, so the real window size is visible.
//
// A read that cannot stand for the window still weighs NOTHING, and says why: the page cap reached before a short page,
// the whole read past its wall-clock deadline, a full page that adds no new rows (the route ignored `offset`), a non-OK
// status, a body with no rows array, or a fetch error on any page. It is logged loudly and counted, and the caller gets
// no rows, so its posterior map is empty: one-shot goal selection is round-robin, the pool's signature-continuity boost
// is off, and the dispatcher choice is a uniform Beta(1,1) random draw. Only a complete window is weighed.
//
// ONE READ PER TICK. Deep offsets cost the route a scan that grows with the offset, so the two fetchers share one read:
// a call within TRACE_WINDOW_SHARE_MS of a read (same endpoint, a window start within the same span) gets that read,
// in flight or settled. What is shared is what was costly: a complete multi-page read, or a read declined at the page
// cap or the deadline. A one-page read is the old single fetch and is simply read again; a cheap early failure is
// retried by the next caller. A shared window can start up to TRACE_WINDOW_SHARE_MS before the caller's own `since`.
import { traceListRows } from "./idle-check";

/** The trace list route's page cap (GET /v2/activities/execution-traces clamps `limit` to this). */
export const TRACE_LIST_PAGE = 100;
/**
 * Pages one window read takes at most (a load bound on the hot list route): 10,000 rows. A window larger than this is
 * declined as capped, with the reason logged, never weighed from its newest slice.
 */
export const TRACE_WINDOW_PAGE_CAP = 100;
/** Wall-clock budget for one whole paged read; past it the read declines as exceeded. */
export const TRACE_WINDOW_DEADLINE_MS = 15_000;
/** How long one read serves later callers: under the pool's 60 s signature refresh, so each refresh reads afresh. */
export const TRACE_WINDOW_SHARE_MS = 30_000;
const PAGE_TIMEOUT_MS = 8_000;

type Row = Record<string, unknown>;
interface WindowRead { rows: Row[] | null; why: string; share: boolean }
interface Shared { endpoint: string; sinceMs: number; startedAt: number; read: Promise<WindowRead> }
let shared: Shared | null = null;

let truncatedWindows = 0;
/** How many windows this process has declined (capped, timed out, unpaged or unreadable). */
export function truncatedWindowCount(): number { return truncatedWindows; }
/** Forget the shared read (tests). */
export function resetTraceWindowShare(): void { shared = null; }

function decline(caller: string, sinceMs: number, why: string): null {
  truncatedWindows++;
  console.error(
    `[boredom-vessel] ${caller}: trace window truncated — ${why}, window since ${new Date(sinceMs).toISOString()} ` +
    `(truncated windows: ${truncatedWindows}); weighing nothing: goal selection round-robin, ` +
    `signature-continuity boost off, dispatcher choice a uniform random draw`,
  );
  return null;
}

function rowKey(row: Row): string | null {
  const id = row.execution_id ?? row.id;
  return typeof id === "string" && id ? id : null;
}

async function pagedRead(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  caller: string,
): Promise<WindowRead> {
  const startedAt = Date.now();
  const out: Row[] = [];
  const seen = new Set<string>();
  const exceeded = `read exceeded ${TRACE_WINDOW_DEADLINE_MS / 1000} s`;
  const fail = (why: string, share = false): WindowRead => ({ rows: decline(caller, sinceMs, why), why, share });
  for (let page = 0; page < TRACE_WINDOW_PAGE_CAP; page++) {
    const offset = page * TRACE_LIST_PAGE;
    const at = `page ${page + 1} (offset ${offset}, ${out.length} rows read)`;
    const remaining = TRACE_WINDOW_DEADLINE_MS - (Date.now() - startedAt);
    if (remaining <= 0) return fail(`${exceeded} before ${at}`, true);
    let body: unknown;
    try {
      const res = await fetch(
        `${endpoint}/v2/activities/execution-traces?limit=${TRACE_LIST_PAGE}&since=${sinceMs}` +
          (offset > 0 ? `&offset=${offset}` : ""),
        { headers, signal: AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, remaining)) },
      );
      if (!res.ok) return fail(`${at} answered HTTP ${res.status}`);
      body = await res.json();
    } catch (err) {
      if (Date.now() - startedAt >= TRACE_WINDOW_DEADLINE_MS) return fail(`${exceeded} at ${at}`, true);
      return fail(`${at} failed: ${(err as Error).message}`);
    }
    const rows = traceListRows(body) as Row[] | null;
    if (!rows) return fail(`${at} has no rows array`);
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
    if (rows.length < TRACE_LIST_PAGE) {
      console.log(
        `[boredom-vessel] ${caller}: trace window read whole — ${out.length} rows in ${page + 1} page(s) since ` +
        `${new Date(sinceMs).toISOString()} (${Date.now() - startedAt} ms)`,
      );
      return { rows: out, why: "", share: page > 0 };
    }
    if (added === 0) return fail(`${at}: a full page added no new rows (the route did not honour offset)`);
  }
  return fail(`read capped at ${TRACE_WINDOW_PAGE_CAP} pages of ${TRACE_LIST_PAGE} (${out.length} rows) before the window ended`, true);
}

/**
 * Every row of the trace list since `sinceMs`, read page by page with `offset` until a short page; or null, with the
 * reason logged and counted, when the read cannot stand for the window (see the header). A call within
 * TRACE_WINDOW_SHARE_MS of a costly read shares it.
 */
export async function readTraceWindow(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  caller: string,
): Promise<Array<Record<string, unknown>> | null> {
  const now = Date.now();
  const s = shared;
  if (s && s.endpoint === endpoint && now - s.startedAt <= TRACE_WINDOW_SHARE_MS
    && Math.abs(sinceMs - s.sinceMs) <= TRACE_WINDOW_SHARE_MS) {
    const got = await s.read;
    if (got.share) {
      return got.rows ?? decline(caller, sinceMs, `the shared read ${Math.round((now - s.startedAt) / 1000)} s ago declined: ${got.why}`);
    }
  }
  const read = pagedRead(endpoint, headers, sinceMs, caller);
  shared = { endpoint, sinceMs, startedAt: now, read };
  return (await read).rows;
}
