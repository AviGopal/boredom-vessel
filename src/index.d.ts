/**
 * boredom-vessel — autonomous topology-discovery loop, dispatch-pool daemon.
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 7, tasks 7.1–7.3.
 *
 * Runs as a long-running daemon that fills idle capacity with condition-driven
 * work. Each selection pass scores the pool of candidate templates (tagged
 * boredom_target_template) by learned momentum × input-shape availability ×
 * priority-weight folds derived from current conditions (open-gap demand,
 * timeShapedRhythm due-state, learning-mode boosts), then dispatches winners
 * concurrently up to MAX_CONCURRENT via light-dispatch or goal-host.
 *
 * Design:
 *   - Idle check: queries activity-api for traces in the last IDLE_WINDOW_SECONDS.
 *     If any non-boredom trace exists in that window, skips (substrate is busy).
 *   - No fixed rotation: measurement, probing, health, escalation, coverage, and
 *     gap-closing (draft-gap-closing-activity) all enter through the same pool.
 *   - Event-prompted: passes are triggered by events (activity-api task
 *     completions, in-process prompts after cheap ticks); the systemd timer
 *     (OnUnitActiveSec) serves only as a backstop, and MIN_DISPATCH_INTERVAL_MS
 *     acts as a cost governor rather than a cadence.
 *   - Momentum persists across restarts, so learned preferences survive cutovers.
 *   - Tags: traces produced via this path carry intent:topology_discovery
 *     (via the recommended templates) — satisfying IAL Phase 27.1.2.
 */
export {};
//# sourceMappingURL=index.d.ts.map