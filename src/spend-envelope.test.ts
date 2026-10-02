import { describe, it, expect } from "bun:test";
import { readBoredomEnvelope, type EnvelopeDeps } from "./spend-envelope";

// Discovery rows as the live vesselCapability answer carries them: this node's own producer is
// origin "local"; federated rows are origin "peer:<discovery>" and resolve through the local
// federation-transport egress (127.0.0.1:8401), which may be down.
const LOCAL = { vesselId: "development-vessel-local", endpoint: "http://localhost:8090", resolve_endpoint: "/v2/impulses/resolve", origin: "local" };
const PEER = (n: string) => ({ vesselId: `development-vessel-local@${n}`, endpoint: "http://127.0.0.1:8401", resolve_endpoint: "/v2/impulses/resolve", protocol: "libp2p", origin: "peer:http://syzygy.host:18100", discoveredVia: "peer", origin_upstream: "overlay" });
const LOCAL_URL = "http://localhost:8090/v2/impulses/resolve";
const PEER_URL = "http://127.0.0.1:8401/v2/impulses/resolve";
const NOW = Date.parse("2026-10-02T16:00:00Z");

type Rec = { usd_cap_per_hour?: number; paused?: boolean };
function world(o: { rows: unknown[]; localRecord?: () => Rec | null; localSilent?: boolean; localSpend?: number }) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init: { body: string }) => {
    calls.push(url);
    const body = JSON.parse(init.body);
    if (url.endsWith(":8100/resolve")) return { ok: true, json: async () => ({ content: { shape: body.pointer.shape, vessels: o.rows } }) };
    if (url === PEER_URL) throw new Error("The operation timed out."); // the egress is down
    if (url === LOCAL_URL) {
      if (o.localSilent) throw new Error("connect ECONNREFUSED");
      if (body.impulse?.type === "poolImpulse") {
        const rec = o.localRecord ? o.localRecord() : null;
        return { ok: true, json: async () => ({ body: { impulses: rec ? [{ shape: "spendEnvelope", updated_at: "2026-10-02T15:00:00Z", body: rec }] : [] } }) };
      }
      return { ok: true, json: async () => ({ body: { window_ms: 3_600_000, current: { window_start: new Date(NOW - 60_000).toISOString(), cost_usd: o.localSpend ?? 0 }, previous: null } }) };
    }
    throw new Error("unexpected url " + url);
  };
  const deps: EnvelopeDeps = { discoveryEndpoint: "http://127.0.0.1:8100", apiKey: "test", fetch: fetchImpl as unknown as EnvelopeDeps["fetch"] };
  return { deps, calls };
}

describe("spend envelope reads only this node's own producers", () => {
  it("RED: a peer row that times out does not block a readable local producer", async () => {
    const { deps, calls } = world({ rows: [LOCAL, PEER("syzygy-hub"), PEER("spoke-a")], localRecord: () => ({ usd_cap_per_hour: 5 }), localSpend: 1 });
    const v = await readBoredomEnvelope(deps, () => NOW);
    expect(v.unreadable).toBeUndefined();
    expect(v.allow).toBe(true);
    expect(v.reason).toContain("within envelope");
    expect(calls).not.toContain(PEER_URL);
  });

  it("RED: only peer rows is unreadable with a clear reason", async () => {
    const { deps, calls } = world({ rows: [PEER("syzygy-hub"), PEER("spoke-a")] });
    const v = await readBoredomEnvelope(deps, () => NOW);
    expect(v.allow).toBe(false);
    expect(v.unreadable).toBe(true);
    expect(v.reason).toContain("no own poolImpulse producer");
    expect(v.reason).toContain("2 non-own producer(s) ignored");
    expect(calls).not.toContain(PEER_URL);
  });

  it("CONTROL: the own producer silent stays fail-closed", async () => {
    const { deps } = world({ rows: [LOCAL, PEER("syzygy-hub")], localSilent: true });
    const v = await readBoredomEnvelope(deps, () => NOW);
    expect(v.allow).toBe(false);
    expect(v.unreadable).toBe(true);
    expect(v.reason).toContain("no answer from " + LOCAL_URL);
  });

  it("CONTROL: a cap exceeded on the local record refuses", async () => {
    const { deps } = world({ rows: [LOCAL, PEER("syzygy-hub")], localRecord: () => ({ usd_cap_per_hour: 2 }), localSpend: 3 });
    const v = await readBoredomEnvelope(deps, () => NOW);
    expect(v.allow).toBe(false);
    expect(v.unreadable).toBeUndefined();
    expect(v.reason).toContain("exhausted: spent 3.000 USD of 2 USD/h over 1 spend source(s)");
  });

  it("CONTROL: an update to the own producer's record is read on the next read", async () => {
    let rec: Rec = { usd_cap_per_hour: 5 };
    const { deps } = world({ rows: [LOCAL, PEER("syzygy-hub")], localRecord: () => rec, localSpend: 1 });
    expect((await readBoredomEnvelope(deps, () => NOW)).allow).toBe(true);
    rec = { paused: true };
    const v = await readBoredomEnvelope(deps, () => NOW);
    expect(v.allow).toBe(false);
    expect(v.reason).toStartWith("paused");
  });
});
