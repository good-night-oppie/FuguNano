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
const isValidReceiptObject = (value: unknown): value is object =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>)['format'] === 1;

/**
 * Validate receipt shape and extract bindings for authentication. Returns
 * undefined when receipt is absent — distinguishing absent from invalid
 * (returns undefined) so the caller can differentiate "no self-attestation
 * at all" from "self-attestation exists but can't authenticate". Receipt
 * validation here is thin (shape + format guard); full cross-field
 * consistency is checked during authentication.
 */
const extractReceipt = (terminal: OutcomeEvent): PRReviewReceiptV1 | undefined => {
  const raw = terminal['receipt'];
  if (!isValidReceiptObject(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const review_id = typeof r['review_id'] === 'string' ? r['review_id'] : '';
  const actor = typeof r['actor'] === 'string' ? r['actor'] : '';
  const head_sha = typeof r['head_sha'] === 'string' ? r['head_sha'] : '';
  const body_sha256 = typeof r['body_sha256'] === 'string' ? r['body_sha256'] : '';
  if (!review_id || !actor || !head_sha || !body_sha256) return undefined;
  return { format: 1, review_id, actor, head_sha, body_sha256 };
};

/**
 * Check whether a candidate was the actual executor for this dispatch.
 * Uses terminal.actual_executor (authoritative) then falls back to the
 * attempt list for multi-attempt dispatches.
 */
const wasExecutor = (
  candidateName: string,
  actualExecutor: string | undefined,
  attempts: ReadonlyArray<{ candidate: string; verdict: string }> | undefined,
): boolean => {
  if (actualExecutor === candidateName) return true;
  if (!attempts) return false;
  return attempts.some((a) => a.candidate === candidateName && a.verdict === 'completed');
};

export const classifyDelivery = (
  routeId: string,
  rankedCandidates: ReadonlyArray<string>,
  terminal: OutcomeEvent | null,
  signals: ReadonlyArray<OutcomeEvent>,
): DeliveryVerdict => {
  if (terminal === null) return 'PROCESS_COMPLETED';
  if (terminal.terminal_state !== 'COMPLETED') return 'PROCESS_COMPLETED';

  const receipt = extractReceipt(terminal);
  const actualExecutor = terminal['actual_executor'] as string | undefined;
  const terminalAttempts = terminal['attempts'] as
    | ReadonlyArray<{ candidate: string; verdict: string }>
    | undefined;

  // Order-independent scan: DELIVERED beats unresolvable beats completed.
  // Scan every signal so a later authentically-matching signal wins over an
  // earlier unresolvable one (no first-match-wins on evidence).
  let anyMatchingSignal = false;
  let unresolvable = false;
  let unknownAttempt = false;

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
      // Marker references an attempt that never ran — evidence exists
      // but cannot be attributed to a known candidate.
      unknownAttempt = true;
      continue;
    }

    // Marker identifies a ranked candidate — verify it was the actual
    // executor, not merely listed.
    if (!wasExecutor(matchingCandidate, actualExecutor, terminalAttempts)) continue;

    anyMatchingSignal = true;

    // Without a receipt, independent evidence exists but can't be
    // authenticated — unresolvable.
    if (receipt === undefined) {
      unresolvable = true;
      continue;
    }

    // Full authentication: actor + body_sha256 + review_id + head_sha
    // must all agree between the agent's receipt and the signal.
    const signalActor = signal['actor'] as string | undefined;
    const signalBodySha256 = signal['body_sha256'] as string | undefined;
    const signalReviewId = signal['source_object_id'] as string | undefined;
    const signalHeadSha = signal['head_sha_at_signal'] as string | undefined;

    if (
      signalActor === receipt.actor &&
      signalBodySha256 === receipt.body_sha256 &&
      signalReviewId === receipt.review_id &&
      signalHeadSha === receipt.head_sha
    ) {
      // All bindings match → DELIVERED. Early return justified:
      // no later signal can produce a better outcome.
      return 'DELIVERED';
    }

    // Marker matches, receipt exists, but authentication fails.
    unresolvable = true;
  }

  // After scanning all signals: unresolvable beats completed, but only
  // if a matching signal was actually found (not just unknown-attempt ones).
  if (anyMatchingSignal && unresolvable) return 'DELIVERY_UNRESOLVABLE';
  if (unknownAttempt) return 'DELIVERY_UNRESOLVABLE';

  // No matching signal found → process completed without delivery evidence.
  return 'PROCESS_COMPLETED';
};
