// IDLE CHECK, extracted from index.ts so it can be tested without starting the daemon.
//
// activity-api's trace list (GET /v2/activities/execution-traces) answers `{ executions: [...] }`. The check read
// `body.traces ?? []`, a key the route never returns, so every page parsed as empty and the one-shot tick (main())
// took real traffic for idle. The pool daemon (--daemon) never calls this check. `traces` and a bare array stay
// accepted as legacy forms. Any other body is a LOUD failure that answers NOT idle: a page we cannot read says nothing
// about whether the system is quiet. An unreachable route or a non-OK status still assumes idle (fail-open for
// coverage), as before. RESIDUAL: one newest-first page of 20 rows, so 20 or more boredom rows in the window can hide
// an external one (a false idle).

export const BOREDOM_TAG = "intent:boredom_source";

type TraceRow = { tags?: string[] };

/** The trace rows of a list-route body, or null when the body is not a shape the route answers. */
export function traceListRows(body: unknown): TraceRow[] | null {
  if (Array.isArray(body)) return body as TraceRow[];
  if (!body || typeof body !== "object") return null;
  const b = body as { executions?: unknown; traces?: unknown };
  if (Array.isArray(b.executions)) return b.executions as TraceRow[];
  if (Array.isArray(b.traces)) return b.traces as TraceRow[];
  return null;
}

/**
 * Check whether the substrate has had recent external (non-boredom) activity.
 * Returns true if the substrate is idle (no recent external traces).
 */
export async function isIdle(endpoint: string, headers: Record<string, string>, windowSeconds: number): Promise<boolean> {
  const since = Date.now() - windowSeconds * 1000;

  let res: Response;
  try {
    res = await fetch(
      `${endpoint}/v2/activities/execution-traces?limit=20&since=${since}`,
      { headers },
    );
  } catch (err) {
    // If activity-api is unreachable, assume idle (fail-open for coverage).
    console.warn(`[boredom-vessel] activity-api unreachable, assuming idle: ${(err as Error).message}`);
    return true;
  }

  if (!res.ok) {
    console.warn(`[boredom-vessel] execution-traces query HTTP ${res.status}, assuming idle`);
    return true;
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    console.error(`[boredom-vessel] execution-traces answered a body that is not JSON (${(err as Error).message}); treating as NOT idle`);
    return false;
  }
  const traces = traceListRows(body);
  if (traces === null) {
    const keys = body && typeof body === "object" ? Object.keys(body).join(",") || "(none)" : typeof body;
    console.error(`[boredom-vessel] execution-traces body has no executions array (keys: ${keys}); treating as NOT idle`);
    return false;
  }

  // Filter out traces that were themselves boredom-initiated (tagged BOREDOM_TAG).
  const externalTraces = traces.filter((t) => !(t?.tags ?? []).includes(BOREDOM_TAG));

  if (externalTraces.length > 0) {
    console.log(
      `[boredom-vessel] ${externalTraces.length} external traces in last ${windowSeconds}s — skipping`,
    );
    return false;
  }

  return true;
}

/** Pages of 100 the external-traffic count reads at most per call (a load bound on the hot list route). */
export const EXTERNAL_SCAN_PAGE_CAP = 10;
const EXTERNAL_SCAN_PAGE = 100;

export type ExternalReading = { ok: true; external: number } | { ok: false; why: string };

/**
 * Count non-boredom traces since `sinceMs`, paging the list route by `offset` (100 per page, newest first) until a short
 * page, until `enough` external traces are seen, or until EXTERNAL_SCAN_PAGE_CAP pages. Anything that leaves the count
 * unknown — a fetch error, a non-OK status, a body with no rows array, or the page cap reached before `enough` — is
 * `ok:false`, which the gate reads as busy (conservative), never as quiet.
 */
export async function externalTracesSince(
  endpoint: string,
  headers: Record<string, string>,
  sinceMs: number,
  enough: number,
): Promise<ExternalReading> {
  let external = 0;
  for (let page = 0; page < EXTERNAL_SCAN_PAGE_CAP; page++) {
    let body: unknown;
    try {
      const res = await fetch(
        `${endpoint}/v2/activities/execution-traces?limit=${EXTERNAL_SCAN_PAGE}&since=${sinceMs}&offset=${page * EXTERNAL_SCAN_PAGE}`,
        { headers, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
      body = await res.json();
    } catch (err) {
      return { ok: false, why: (err as Error).message };
    }
    const rows = traceListRows(body);
    if (rows === null) return { ok: false, why: "body has no executions array" };
    external += rows.filter((t) => !(t?.tags ?? []).includes(BOREDOM_TAG)).length;
    if (external >= enough || rows.length < EXTERNAL_SCAN_PAGE) return { ok: true, external };
  }
  return { ok: false, why: `scan capped at ${EXTERNAL_SCAN_PAGE_CAP} pages with ${external} external` };
}
