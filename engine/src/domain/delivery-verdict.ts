import { computeAttemptId } from './outcome-log.js';
import type { OutcomeEvent } from './outcome-log.js';
import type { PRReviewReceiptV1 } from './outcome-log.js';

/**
 * Delivery verdicts for outcome.sync (D2). DELIVERED is never stored and never
 * becomes a fifth event type — the frozen four-type EVENT_TYPES vocabulary
 * must not grow.
 */
export type DeliveryVerdict = 'DELIVERED' | 'PROCESS_COMPLETED' | 'DELIVERY_UNRESOLVABLE';

/**
 * Classify whether a completed dispatch resulted in an actual review delivery.
 *
 * Store facts, derive judgments. The receipt is the agent's self-attestation;
 * the `github.signal` is the independently-sourced external evidence. Both
 * must agree for DELIVERED.
 *
 * Marker-only evidence must NOT qualify as DELIVERED — the marker is leakable
 * and repostable (it appears in the PR body and in pane snapshots), so it
 * cannot authenticate an actor. A marker that matches `route_id` and
 * `attempt_id` is necessary but NOT sufficient for DELIVERED.
 *
 * @param terminal — the dispatch.terminal event (or null if absent)
 * @param signals — all `github.signal` events for this route
 */
export const classifyDelivery = (
  routeId: string,
  rankedCandidates: ReadonlyArray<string>,
  terminal: OutcomeEvent | null,
  signals: ReadonlyArray<OutcomeEvent>,
): DeliveryVerdict => {
  if (terminal === null) return 'PROCESS_COMPLETED';
  if (terminal.terminal_state !== 'COMPLETED') return 'PROCESS_COMPLETED';

  const receipt = terminal['receipt'] as PRReviewReceiptV1 | undefined;

  // Find an independently-sourced signal matching the route
  for (const signal of signals) {
    if (signal.event_type !== 'github.signal') continue;
    if (signal.route_id !== routeId) continue;

    const markerRouteId = signal['marker_route_id'] as string | null | undefined;
    if (markerRouteId !== routeId) continue;

    const markerAttemptId = signal['marker_attempt_id'] as string | null | undefined;
    if (typeof markerAttemptId !== 'string') continue;

    const matchingCandidate = rankedCandidates.find(
      (c) => computeAttemptId(routeId, c) === markerAttemptId,
    );
    if (matchingCandidate === undefined) {
      // Marker references an attempt that never ran — unresolvable
      return 'DELIVERY_UNRESOLVABLE';
    }

    // Marker matches a candidate. Without a receipt we have independent
    // evidence of an action but cannot authenticate who performed it.
    if (receipt == null) return 'DELIVERY_UNRESOLVABLE';

    // Marker matches and receipt exists — authenticate through actor + body_sha256
    const signalActor = signal['actor'] as string | undefined;
    const signalBodySha256 = signal['body_sha256'] as string | undefined;

    if (signalActor === receipt.actor && signalBodySha256 === receipt.body_sha256) {
      // All bindings match → DELIVERED
      return 'DELIVERED';
    }

    // Marker matches but authentication fails → unresolvable
    return 'DELIVERY_UNRESOLVABLE';
  }

  // No signal with matching marker found → process completed without delivery evidence
  return 'PROCESS_COMPLETED';
};
