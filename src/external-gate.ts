// EXTERNAL-TRAFFIC GATE for the pool daemon, as a pure decision over what the loop knows.
//
// The pool loop dispatched on throughput alone: nothing in it looked at whether someone else's work was running. The
// one-shot tick's isIdle check is never called in daemon mode. This gate defers a pool tick while non-boredom traces
// are active in a shaped window (boredomSelectionPolicy: external_window_ms, external_min_traces,
// external_defer_max_ms), and it is BOUNDED: one continuous defer lasts at most external_defer_max_ms, after which the
// pool dispatches once and a fresh defer may start. An unknown count (ok:false) is busy, never quiet.
// external_defer_max_ms = 0 is off, and off is the default: the loop then never reads the trace list for the gate.
import type { ExternalGatePolicy } from "./selection-traps";
import type { ExternalReading } from "./idle-check";

export type ExternalGateState = { deferStartedAt: number | null; deferredTicks: number; boundReleases: number };
export const INITIAL_EXTERNAL_GATE_STATE: ExternalGateState = Object.freeze({ deferStartedAt: null, deferredTicks: 0, boundReleases: 0 });

export type ExternalGateDecision = {
  defer: boolean;
  reason: "off" | "quiet" | "external_active" | "count_unknown" | "defer_max_reached";
  state: ExternalGateState;
};

/** True when the gate is on: the loop reads the trace list only then. */
export function externalGateOn(policy: ExternalGatePolicy): boolean {
  return policy.external_defer_max_ms > 0;
}

export function deferForExternal(
  policy: ExternalGatePolicy,
  reading: ExternalReading | null,
  state: ExternalGateState,
  now: number,
): ExternalGateDecision {
  if (!externalGateOn(policy) || reading === null) return { defer: false, reason: "off", state: { ...state, deferStartedAt: null } };
  const busy = !reading.ok || reading.external >= policy.external_min_traces;
  if (!busy) return { defer: false, reason: "quiet", state: { ...state, deferStartedAt: null } };
  const startedAt = state.deferStartedAt ?? now;
  if (now - startedAt >= policy.external_defer_max_ms) {
    return { defer: false, reason: "defer_max_reached", state: { ...state, deferStartedAt: null, boundReleases: state.boundReleases + 1 } };
  }
  return {
    defer: true,
    reason: reading.ok ? "external_active" : "count_unknown",
    state: { ...state, deferStartedAt: startedAt, deferredTicks: state.deferredTicks + 1 },
  };
}
