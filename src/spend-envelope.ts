// SPEND ENVELOPE read (value-per-cost-selection 4.3c), extracted from index.ts so it can be tested
// without starting the daemon. Pure over an injected fetch.
export type BoredomEnvelope = { allow: boolean; reason: string; unreadable?: boolean; seen?: boolean };
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
export type EnvelopeDeps = { discoveryEndpoint: string; apiKey: string; fetch?: FetchLike; timeoutMs?: number };

// NODE-LOCAL POLICY READS. spendEnvelope (a poolImpulse record) and llmSpendSummaryNode are this
// node's own policy and spend: only producers discovery stamps `origin: "local"` are authoritative.
// Federated rows (`origin: "peer:<discovery>"`) resolve through the federation-transport egress; a
// silent peer must never halt this node's lane, so peer rows are set aside before any read (and
// before the URL dedupe: every peer row shares the one egress URL). Matches development-vessel's
// own-producer policy reads (isOwnSubstrateProducer / catalogueLocality keys on the same field).
// Shaped to be lifted into a shared package: pure over the vesselCapability rows plus an injected fetch.
export type OwnProducers = { ok: true; urls: string[]; foreign: number } | { ok: false; why: string };
type CapabilityRow = { endpoint?: string; resolve_endpoint?: string; origin?: unknown };

export function ownResolveUrls(rows: readonly CapabilityRow[]): { urls: string[]; foreign: number } {
  const urls = new Set<string>();
  let foreign = 0;
  for (const v of rows) {
    if (v.origin !== "local") { foreign++; continue; }
    // resolve_endpoint is ABSOLUTE for some producers and a PATH for others: join only a path.
    const re = String(v.resolve_endpoint ?? "");
    if (/^https?:\/\//.test(re)) urls.add(re);
    else if (v.endpoint) urls.add(String(v.endpoint).replace(/\/+$/, "") + (re || "/resolve"));
  }
  return { urls: [...urls], foreign };
}

export async function discoverOwnResolveUrls(shape: string, deps: EnvelopeDeps): Promise<OwnProducers> {
  const f = deps.fetch ?? (fetch as unknown as FetchLike);
  try {
    const r = await f(`${deps.discoveryEndpoint}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${deps.apiKey}` },
      body: JSON.stringify({ pointer: { type: "vesselCapability", shape } }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 3000),
    });
    if (!r.ok) return { ok: false, why: `${shape} discovery lookup failed` };
    const vessels = ((await r.json()) as { content?: { vessels?: CapabilityRow[] } }).content?.vessels;
    if (!Array.isArray(vessels)) return { ok: false, why: `${shape} discovery answer has no vessels` };
    return { ok: true, ...ownResolveUrls(vessels) };
  } catch (err) { return { ok: false, why: `${shape} discovery lookup failed: ${String(err)}` }; }
}

const noOwn = (shape: string, p: OwnProducers): string =>
  "envelope unreadable: " + (p.ok ? `no own ${shape} producer` + (p.foreign > 0 ? ` (${p.foreign} non-own producer(s) ignored)` : "") : p.why);

async function post(url: string, body: unknown, deps: EnvelopeDeps): Promise<Record<string, unknown> | null> {
  const f = deps.fetch ?? (fetch as unknown as FetchLike);
  try {
    const r = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `ApiKey ${deps.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 3000),
    });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch { return null; }
}

export async function readBoredomEnvelope(deps: EnvelopeDeps, now: () => number = Date.now): Promise<BoredomEnvelope> {
  const [pool, spend] = await Promise.all([discoverOwnResolveUrls("poolImpulse", deps), discoverOwnResolveUrls("llmSpendSummaryNode", deps)]);
  if (!pool.ok || pool.urls.length === 0) return { allow: false, unreadable: true, reason: noOwn("poolImpulse", pool) };
  const poolUrls = pool.urls;
  let newest: { updated_at?: string; body?: unknown } | null = null;
  for (const u of poolUrls) {
    const res = await post(u, { impulse: { type: "poolImpulse", shape: "spendEnvelope", status: "open" } }, deps);
    const imps = (res?.["body"] as { impulses?: unknown } | undefined)?.impulses;
    if (!Array.isArray(imps)) return { allow: false, unreadable: true, reason: "envelope unreadable: no answer from " + u };
    for (const imp of imps as Array<{ shape?: string; updated_at?: string; body?: unknown }>) {
      if (imp.shape === "spendEnvelope" && (!newest || String(imp.updated_at ?? "") > String(newest.updated_at ?? ""))) newest = imp;
    }
  }
  const seen = newest !== null;
  if (!newest) return { allow: true, seen, reason: "no spendEnvelope record (no cap)" };
  const env = (newest.body ?? {}) as { usd_cap_per_hour?: unknown; paused?: unknown; reason?: unknown };
  if (env.paused === true) return { allow: false, seen, reason: "paused: " + String(env.reason ?? "no reason given") };
  const rawCap = env.usd_cap_per_hour;
  if (rawCap !== undefined && rawCap !== null && !(typeof rawCap === "number" && Number.isFinite(rawCap))) return { allow: false, seen, unreadable: true, reason: "envelope unreadable: usd_cap_per_hour is not a finite number" };
  if (typeof rawCap !== "number") return { allow: true, seen, reason: "spendEnvelope has no numeric usd_cap_per_hour (no cap)" };
  if (!spend.ok || spend.urls.length === 0) return { allow: false, seen, unreadable: true, reason: noOwn("llmSpendSummaryNode", spend) };
  const spendUrls = spend.urls;
  let spent = 0;
  for (const u of spendUrls) {
    const res = await post(u, { impulse: { pointer: { type: "llmSpendSummaryNode" } } }, deps);
    const b = res?.["body"] as { window_ms?: number; current?: { window_start?: string; cost_usd?: number }; previous?: { cost_usd?: number } | null } | undefined;
    if (!b || !b.current || typeof b.current.cost_usd !== "number") return { allow: false, seen, unreadable: true, reason: "envelope unreadable: no spend summary from " + u };
    const windowMs = Number(b.window_ms) > 0 ? Number(b.window_ms) : 3_600_000;
    const elapsed = now() - Date.parse(String(b.current.window_start ?? ""));
    const prevShare = Number.isFinite(elapsed) ? Math.max(0, 1 - elapsed / windowMs) : 1;
    spent += b.current.cost_usd + (typeof b.previous?.cost_usd === "number" ? b.previous.cost_usd * prevShare : 0);
  }
  if (spent >= rawCap) return { allow: false, seen, reason: "exhausted: spent " + spent.toFixed(3) + " USD of " + rawCap + " USD/h over " + spendUrls.length + " spend source(s)" };
  return { allow: true, seen, reason: "within envelope: spent " + spent.toFixed(3) + " USD of " + rawCap + " USD/h" };
}
