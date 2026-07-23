import { describe, expect, it } from 'vitest';

import type { OutcomeEvent } from './outcome-log.js';
import {
  buildOutcomeFinalized,
  buildRouteDecided,
  foldPosteriors,
  type OutcomeFinalizedInput,
  type RouteDecidedInput,
} from './route-posterior.js';

const CANDIDATES = ['claude', 'codex', 'gemini'] as const;
const SEED = '0123456789abcdef0123456789abcdef';

const routeInput = (pr: number, overrides: Partial<RouteDecidedInput> = {}): RouteDecidedInput => ({
  repo: 'acme/widgets',
  prNumber: pr,
  headSha: 'f'.repeat(40),
  policyArm: 'thompson',
  candidateId: 'claude',
  rankedCandidates: ['claude', 'codex', 'gemini'],
  seed: SEED,
  configSha256: 'c'.repeat(64),
  routedAt: '2026-07-23T12:00:00Z',
  deadlineAt: '2026-07-30T12:00:00Z',
  ...overrides,
});

const finalInput = (
  pr: number,
  overrides: Partial<OutcomeFinalizedInput> = {},
): OutcomeFinalizedInput => ({
  repo: 'acme/widgets',
  prNumber: pr,
  headSha: 'f'.repeat(40),
  outcome: 'VERIFIED_SUCCESS',
  reasonCode: 'CLEAN_MERGE',
  actualExecutor: 'claude',
  evidenceEventIds: [],
  verifiedAt: '2026-07-25T12:00:00Z',
  observedAt: '2026-07-25T12:00:00Z',
  ...overrides,
});

const pair = (
  pr: number,
  route: Partial<RouteDecidedInput> = {},
  final: Partial<OutcomeFinalizedInput> = {},
): OutcomeEvent[] => [
  buildRouteDecided(routeInput(pr, route)),
  buildOutcomeFinalized(finalInput(pr, final)),
];

describe('event builders', () => {
  it('route.decided records policy arm, seed, and replay material', () => {
    const event = buildRouteDecided(routeInput(1));
    expect(event.event_type).toBe('route.decided');
    expect(event['policy_arm']).toBe('thompson');
    expect(event['seed']).toBe(SEED);
    expect(event.event_id).toBe(event.route_id);
  });

  it('outcome.finalized derives the frozen final id from the route', () => {
    const [route, final] = pair(2);
    expect(final!.route_id).toBe(route!.route_id);
    expect(final!.event_id).not.toBe(route!.event_id);
  });

  it('rejects unknown arms, outcomes, and bad seeds', () => {
    expect(() => buildRouteDecided(routeInput(3, { policyArm: 'greedy' as never }))).toThrow(
      /unknown policy_arm/,
    );
    expect(() => buildOutcomeFinalized(finalInput(3, { outcome: 'MAYBE' as never }))).toThrow(
      /unknown outcome/,
    );
    expect(() => buildRouteDecided(routeInput(3, { seed: 'short' }))).toThrow(/invalid route seed/);
  });
});

describe('fold — learning rules', () => {
  it('starts every candidate at Beta(1,1)', () => {
    const { posteriors } = foldPosteriors([], [...CANDIDATES]);
    expect(posteriors).toStrictEqual([
      { candidateId: 'claude', alpha: 1, beta: 1 },
      { candidateId: 'codex', alpha: 1, beta: 1 },
      { candidateId: 'gemini', alpha: 1, beta: 1 },
    ]);
  });

  it('VERIFIED_SUCCESS → alpha+1; NOT_VERIFIED_WITHIN_WINDOW → beta+1; CENSORED → nothing', () => {
    const events = [
      ...pair(1, {}, { outcome: 'VERIFIED_SUCCESS', actualExecutor: 'claude' }),
      ...pair(2, {}, { outcome: 'NOT_VERIFIED_WITHIN_WINDOW', actualExecutor: 'claude' }),
      ...pair(3, {}, { outcome: 'CENSORED', reasonCode: 'HEAD_DRIFT', actualExecutor: 'claude' }),
    ];
    const { posteriors, diagnostics } = foldPosteriors(events, [...CANDIDATES]);
    expect(posteriors[0]).toStrictEqual({ candidateId: 'claude', alpha: 2, beta: 2 });
    expect(diagnostics.applied).toBe(2);
    expect(diagnostics.blockedNoSignal).toBe(1);
  });

  it('fold is deterministic and idempotent over the same stream', () => {
    const events = [
      ...pair(1),
      ...pair(2, {}, { outcome: 'NOT_VERIFIED_WITHIN_WINDOW', actualExecutor: 'codex' }),
    ];
    const a = foldPosteriors(events, [...CANDIDATES]);
    const b = foldPosteriors(events, [...CANDIDATES]);
    expect(b).toStrictEqual(a);
  });

  it('duplicate final events (defensive) count once', () => {
    const [route, final] = pair(1);
    const { posteriors } = foldPosteriors([route!, final!, final!], [...CANDIDATES]);
    expect(posteriors[0]!.alpha).toBe(2);
  });
});

describe('static-outcome-isolation (pre-Task-1 test)', () => {
  it('fixed-order-arm outcomes never touch the posterior', () => {
    const events = [
      ...pair(
        1,
        { policyArm: 'static' },
        { outcome: 'VERIFIED_SUCCESS', actualExecutor: 'claude' },
      ),
      ...pair(
        2,
        { policyArm: 'static' },
        { outcome: 'NOT_VERIFIED_WITHIN_WINDOW', actualExecutor: 'codex' },
      ),
    ];
    const { posteriors, diagnostics } = foldPosteriors(events, [...CANDIDATES]);
    for (const p of posteriors) {
      expect(p.alpha).toBe(1);
      expect(p.beta).toBe(1);
    }
    expect(diagnostics.applied).toBe(0);
    expect(diagnostics.blockedStaticArm).toBe(2);
  });

  it('mixed streams: only the learning arm moves the numbers', () => {
    const events = [
      ...pair(1, { policyArm: 'static' }, { actualExecutor: 'claude' }),
      ...pair(2, { policyArm: 'thompson' }, { actualExecutor: 'claude' }),
    ];
    const { posteriors, diagnostics } = foldPosteriors(events, [...CANDIDATES]);
    expect(posteriors[0]).toStrictEqual({ candidateId: 'claude', alpha: 2, beta: 1 });
    expect(diagnostics.applied).toBe(1);
    expect(diagnostics.blockedStaticArm).toBe(1);
  });
});

describe('fallback + attribution rules', () => {
  it('the update lands on the actual executor, not the selected candidate', () => {
    const events = pair(
      1,
      { candidateId: 'claude' },
      { outcome: 'VERIFIED_SUCCESS', actualExecutor: 'codex' },
    );
    const { posteriors } = foldPosteriors(events, [...CANDIDATES]);
    expect(posteriors.find((p) => p.candidateId === 'claude')).toStrictEqual({
      candidateId: 'claude',
      alpha: 1,
      beta: 1,
    });
    expect(posteriors.find((p) => p.candidateId === 'codex')).toStrictEqual({
      candidateId: 'codex',
      alpha: 2,
      beta: 1,
    });
  });

  it('missing executor, unknown executor, or orphan final → unattributable, no update', () => {
    const orphanFinal = buildOutcomeFinalized(finalInput(9));
    const events = [
      ...pair(1, {}, { actualExecutor: null }),
      ...pair(2, {}, { actualExecutor: 'not-a-candidate' }),
      orphanFinal,
    ];
    const { posteriors, diagnostics } = foldPosteriors(events, [...CANDIDATES]);
    for (const p of posteriors) {
      expect(p.alpha).toBe(1);
      expect(p.beta).toBe(1);
    }
    expect(diagnostics.applied).toBe(0);
    expect(diagnostics.blockedUnattributable).toBe(3);
  });
});
