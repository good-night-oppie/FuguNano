import { describe, expect, it } from 'vitest';

import { computeAttemptId, computeSignalId, OUTCOME_LOG_FORMAT } from './outcome-log.js';
import type { OutcomeEvent } from './outcome-log.js';
import type { PRReviewReceiptV1 } from './outcome-log.js';
import { classifyDelivery } from './delivery-verdict.js';

const ROUTE_ID = 'a'.repeat(64);
const CANDIDATES = ['codex', 'gemini'];
const RECEIPT: PRReviewReceiptV1 = {
  format: 1,
  review_id: 'review-42',
  actor: 'github-user',
  head_sha: 'deadbeef',
  body_sha256: 'b'.repeat(64),
};

interface MkTerminalOpts {
  receipt?: PRReviewReceiptV1 | null;
  terminal_state?: string;
  actual_executor?: string;
}

const mkTerminal = (opts: MkTerminalOpts = {}): OutcomeEvent => ({
  format: OUTCOME_LOG_FORMAT,
  event_type: 'dispatch.terminal',
  event_id: 'terminal-1',
  route_id: ROUTE_ID,
  observed_at: '2026-07-30T12:00:00.000Z',
  terminal_state: opts.terminal_state ?? 'COMPLETED',
  actual_executor: opts.actual_executor ?? 'codex',
  attempts: [],
  ...(opts.receipt !== undefined ? { receipt: opts.receipt } : {}),
});

const mkSignal = (overrides: Partial<OutcomeEvent>): OutcomeEvent => ({
  format: OUTCOME_LOG_FORMAT,
  event_type: 'github.signal',
  event_id: computeSignalId(ROUTE_ID, 'obj-1', 'COMMENTED'),
  route_id: ROUTE_ID,
  observed_at: '2026-07-30T11:00:00.000Z',
  source_kind: 'pr-review',
  source_object_id: 'review-42',
  canonical_source_state: 'COMMENTED',
  actor: 'github-user',
  head_sha_at_signal: 'deadbeef',
  marker_route_id: ROUTE_ID,
  marker_attempt_id: computeAttemptId(ROUTE_ID, 'codex'),
  body_sha256: RECEIPT.body_sha256,
  source_timestamp_at: '2026-07-30T10:30:00.000Z',
  ...overrides,
});

describe('classifyDelivery', () => {
  // (a) receipt-empty: agent prints {} → COMPLETED, receipt null → PROCESS_COMPLETED
  it('receipt-empty — null receipt → PROCESS_COMPLETED', () => {
    const terminal = mkTerminal({ receipt: null });
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [])).toBe('PROCESS_COMPLETED');
  });

  // (a) variant: no receipt field at all → PROCESS_COMPLETED
  it('receipt-empty — absent receipt → PROCESS_COMPLETED', () => {
    const terminal = mkTerminal({});
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [])).toBe('PROCESS_COMPLETED');
  });

  // (b) receipt-ids-no-artifact: machine JSON carries route/attempt/executor ids but no receipt
  // → downstream IDENTICAL to (a). This pins that self-reported identity never upgrades delivery.
  it('receipt-ids-no-artifact — no receipt even with valid ids → PROCESS_COMPLETED', () => {
    const terminal = mkTerminal({ receipt: null, actual_executor: 'codex' });
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [])).toBe('PROCESS_COMPLETED');
  });

  // (c) receipt-marker-only: valid receipt + signal with matching marker but different actor
  // → DELIVERY_UNRESOLVABLE
  it('receipt-marker-only — marker mismatch on actor → DELIVERY_UNRESOLVABLE', () => {
    const terminal = mkTerminal({ receipt: RECEIPT });
    const signal = mkSignal({ actor: 'other-user', body_sha256: RECEIPT.body_sha256 });
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [signal])).toBe(
      'DELIVERY_UNRESOLVABLE',
    );
  });

  // (c) variant: marker-bearing signal but NO receipt → unresolvable (no authentication)
  it('receipt-marker-only — marker with no receipt → DELIVERY_UNRESOLVABLE', () => {
    const terminal = mkTerminal({ receipt: null });
    const attemptId = computeAttemptId(ROUTE_ID, 'codex');
    const signal = mkSignal({ marker_attempt_id: attemptId });
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [signal])).toBe(
      'DELIVERY_UNRESOLVABLE',
    );
  });

  // (d) receipt-delivered: receipt + independently-sourced signal matching every binding
  it('receipt-delivered — all bindings match → DELIVERED', () => {
    const terminal = mkTerminal({ receipt: RECEIPT });
    const signal = mkSignal({});
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [signal])).toBe('DELIVERED');
  });

  // (d) variant: multiple non-matching signals + one matching → DELIVERED
  it('receipt-delivered — one matching among many → DELIVERED', () => {
    const terminal = mkTerminal({ receipt: RECEIPT });
    const matchSignal = mkSignal({});
    const noiseSignal = mkSignal({ actor: 'bot' });
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [matchSignal, noiseSignal])).toBe(
      'DELIVERED',
    );
  });

  // (f) DELIVERY_UNRESOLVABLE route must fold to no posterior update (fail-closed ruling)
  it('DELIVERY_UNRESOLVABLE candidate not in ranked list → DELIVERY_UNRESOLVABLE', () => {
    const terminal = mkTerminal({ receipt: RECEIPT });
    const unknownCandidateId = computeAttemptId(ROUTE_ID, 'unknown-agent');
    const signal = mkSignal({
      marker_attempt_id: unknownCandidateId,
      actor: RECEIPT.actor,
      body_sha256: RECEIPT.body_sha256,
    });
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [signal])).toBe(
      'DELIVERY_UNRESOLVABLE',
    );
  });

  // Non-COMPLETED terminal → PROCESS_COMPLETED
  it('non-COMPLETED terminal → PROCESS_COMPLETED', () => {
    const terminal = mkTerminal({ terminal_state: 'EFFECT_UNKNOWN' });
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, terminal, [])).toBe('PROCESS_COMPLETED');
  });

  // null terminal → PROCESS_COMPLETED
  it('null terminal → PROCESS_COMPLETED', () => {
    expect(classifyDelivery(ROUTE_ID, CANDIDATES, null, [])).toBe('PROCESS_COMPLETED');
  });
});
