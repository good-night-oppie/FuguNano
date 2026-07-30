import { describe, expect, it } from 'vitest';

import type { CandidateIdentity } from './candidate-identity.js';
import type { OutcomeEvent } from './outcome-log.js';
import {
  armForCohortIndex,
  buildOutcomeFinalized,
  buildRouteDecided,
  foldPosteriors,
  type OutcomeFinalizedInput,
  type RouteDecidedInput,
} from './route-posterior.js';

const CANDIDATES = ['claude', 'codex', 'gemini'] as const;
const SEED = '0123456789abcdef0123456789abcdef';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

const identity = (
  candidateId: string,
  overrides: Partial<CandidateIdentity> = {},
): CandidateIdentity => ({
  candidateId,
  argv0Realpath: `/bin/${candidateId}`,
  argv0Sha256: HEX_A,
  argvSha256: HEX_B,
  ...overrides,
});

const identitiesFor = (names: ReadonlyArray<string>): CandidateIdentity[] =>
  names.map((name, i) =>
    identity(name, {
      argv0Sha256: i === 0 ? HEX_A : i === 1 ? HEX_B : HEX_C,
      argvSha256: i === 0 ? HEX_B : i === 1 ? HEX_C : HEX_A,
    }),
  );

const routeInput = (pr: number, overrides: Partial<RouteDecidedInput> = {}): RouteDecidedInput => {
  const rankedCandidates = overrides.rankedCandidates ?? ['claude', 'codex', 'gemini'];
  return {
    repo: 'acme/widgets',
    prNumber: pr,
    headSha: 'f'.repeat(40),
    policyArm: 'thompson',
    cohortIndex: null,
    candidateId: 'claude',
    rankedCandidates,
    candidateIdentities: identitiesFor(rankedCandidates),
    seed: SEED,
    configSha256: 'c'.repeat(64),
    profileSha256: 'a'.repeat(64),
    profileFacets: {
      authorLineage: 'human:alice',
      languages: ['python'],
      riskTags: [],
      changedPathCount: 1,
    },
    routedAt: '2026-07-23T12:00:00Z',
    deadlineAt: '2026-07-30T12:00:00Z',
    retryEpoch: 0,
    supersedesRouteId: null,
    ...overrides,
    // Re-derive identities when rankedCandidates overridden without identities.
    ...(!('candidateIdentities' in overrides) && overrides.rankedCandidates !== undefined
      ? { candidateIdentities: identitiesFor(overrides.rankedCandidates) }
      : {}),
  };
};

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
    expect(event['retry_epoch']).toBe(0);
    expect(event['supersedes_route_id']).toBeNull();
  });

  it('retry_epoch namespaces the route id and records supersedes_route_id', () => {
    const epoch0 = buildRouteDecided(routeInput(31));
    const epoch1 = buildRouteDecided(
      routeInput(31, { retryEpoch: 1, supersedesRouteId: epoch0.route_id }),
    );
    expect(epoch1.route_id).not.toBe(epoch0.route_id);
    expect(epoch1['retry_epoch']).toBe(1);
    expect(epoch1['supersedes_route_id']).toBe(epoch0.route_id);
    expect(() =>
      buildRouteDecided(routeInput(31, { retryEpoch: 0, supersedesRouteId: epoch0.route_id })),
    ).toThrow(/supersedesRouteId/);
    expect(() =>
      buildRouteDecided(routeInput(31, { retryEpoch: 1, supersedesRouteId: null })),
    ).toThrow(/supersedesRouteId/);
    expect(() =>
      buildRouteDecided(routeInput(31, { retryEpoch: 4, supersedesRouteId: null })),
    ).toThrow(/retryEpoch/);
  });

  it('supersedes_route_id must be the derivable prior-epoch id, not any 64-hex', () => {
    const epoch0 = buildRouteDecided(routeInput(31));
    // A well-formed but WRONG id (another task's epoch 0) is a caller bug.
    expect(() =>
      buildRouteDecided(routeInput(31, { retryEpoch: 1, supersedesRouteId: 'a'.repeat(64) })),
    ).toThrow(/prior epoch route id/);
    // Epoch 2 must supersede epoch 1, not epoch 0.
    expect(() =>
      buildRouteDecided(routeInput(31, { retryEpoch: 2, supersedesRouteId: epoch0.route_id })),
    ).toThrow(/prior epoch route id/);
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

  it('route.decided carries profile_sha256 + profile_facets (schema-freeze v1)', () => {
    const event = buildRouteDecided(routeInput(4));
    expect(event['profile_sha256']).toBe('a'.repeat(64));
    expect(event['profile_facets']).toStrictEqual({
      author_lineage: 'human:alice',
      languages: ['python'],
      risk_tags: [],
      changed_path_count: 1,
    });
  });

  it('fails closed on a missing or malformed profile digest / facets, naming the field only', () => {
    expect(() => buildRouteDecided(routeInput(5, { profileSha256: '' }))).toThrow(
      /profileSha256 must be 64 lowercase hex/,
    );
    expect(() => buildRouteDecided(routeInput(5, { profileSha256: 'A'.repeat(64) }))).toThrow(
      /profileSha256 must be 64 lowercase hex/,
    );
    expect(() => buildRouteDecided(routeInput(5, { profileSha256: 'a'.repeat(63) }))).toThrow(
      /profileSha256 must be 64 lowercase hex/,
    );
    expect(() => buildRouteDecided(routeInput(5, { profileFacets: undefined as never }))).toThrow(
      /profileFacets required/,
    );
    expect(() =>
      buildRouteDecided(
        routeInput(5, {
          profileFacets: {
            authorLineage: 'human:alice',
            languages: ['python'],
            riskTags: [],
            changedPathCount: -1,
          },
        }),
      ),
    ).toThrow(/changedPathCount must be a non-negative integer/);
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

  it('foldPosteriors ignores cohort_index on route.decided (reader must not key on it)', () => {
    const without = [
      ...pair(1, { cohortIndex: null }, { actualExecutor: 'claude' }),
      ...pair(
        2,
        { cohortIndex: null },
        { outcome: 'NOT_VERIFIED_WITHIN_WINDOW', actualExecutor: 'codex' },
      ),
    ];
    const withIndex = [
      ...pair(1, { cohortIndex: 2 }, { actualExecutor: 'claude' }),
      ...pair(
        2,
        { cohortIndex: 4 },
        { outcome: 'NOT_VERIFIED_WITHIN_WINDOW', actualExecutor: 'codex' },
      ),
    ];
    expect(foldPosteriors(withIndex, [...CANDIDATES])).toStrictEqual(
      foldPosteriors(without, [...CANDIDATES]),
    );
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

describe('cohort_index (schema-freeze v1)', () => {
  it('cohortIndex 1 + static → event carries cohort_index: 1', () => {
    const event = buildRouteDecided(routeInput(10, { cohortIndex: 1, policyArm: 'static' }));
    expect(event['cohort_index']).toBe(1);
    expect(event['policy_arm']).toBe('static');
  });

  it('cohortIndex 2 + thompson is accepted', () => {
    const event = buildRouteDecided(routeInput(11, { cohortIndex: 2, policyArm: 'thompson' }));
    expect(event['cohort_index']).toBe(2);
  });

  it('cohortIndex 1 + thompson throws parity', () => {
    expect(() =>
      buildRouteDecided(routeInput(12, { cohortIndex: 1, policyArm: 'thompson' })),
    ).toThrow(/parity/);
  });

  it('cohortIndex 2 + static throws parity', () => {
    expect(() =>
      buildRouteDecided(routeInput(13, { cohortIndex: 2, policyArm: 'static' })),
    ).toThrow(/parity/);
  });

  it('cohortIndex null + each arm is accepted and serializes as null', () => {
    for (const arm of ['static', 'thompson'] as const) {
      const event = buildRouteDecided(routeInput(14, { cohortIndex: null, policyArm: arm }));
      expect(event['cohort_index']).toBeNull();
      expect(JSON.stringify(event)).toContain('"cohort_index":null');
    }
  });

  it('rejects out-of-range / non-integer cohortIndex', () => {
    for (const bad of [0, 51, -3, 2.5, Number.NaN]) {
      expect(() => buildRouteDecided(routeInput(15, { cohortIndex: bad }))).toThrow(
        /integer in 1\.\.50/,
      );
    }
  });

  it('armForCohortIndex(1..50) yields 25 static (odd) and 25 thompson (even)', () => {
    const arms = Array.from({ length: 50 }, (_, i) => armForCohortIndex(i + 1));
    expect(arms.filter((a) => a === 'static')).toHaveLength(25);
    expect(arms.filter((a) => a === 'thompson')).toHaveLength(25);
    for (let i = 1; i <= 50; i += 1) {
      expect(armForCohortIndex(i)).toBe(i % 2 === 1 ? 'static' : 'thompson');
    }
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

  it('fold isolation: epoch-0 CENSORED learns nothing; epoch-1 VERIFIED_SUCCESS updates its executor', () => {
    const epoch0 = buildRouteDecided(routeInput(32));
    const censored = buildOutcomeFinalized(
      finalInput(32, {
        outcome: 'CENSORED',
        reasonCode: 'operator_abandoned',
        actualExecutor: null,
        verifiedAt: null,
        retryEpoch: 0,
      }),
    );
    const epoch1 = buildRouteDecided(
      routeInput(32, {
        retryEpoch: 1,
        supersedesRouteId: epoch0.route_id,
        candidateId: 'codex',
      }),
    );
    const success = buildOutcomeFinalized(
      finalInput(32, {
        outcome: 'VERIFIED_SUCCESS',
        actualExecutor: 'codex',
        retryEpoch: 1,
      }),
    );
    const { posteriors, diagnostics } = foldPosteriors(
      [epoch0, censored, epoch1, success],
      [...CANDIDATES],
    );
    expect(diagnostics.blockedNoSignal).toBe(1);
    expect(diagnostics.applied).toBe(1);
    expect(posteriors.find((p) => p.candidateId === 'codex')).toStrictEqual({
      candidateId: 'codex',
      alpha: 2,
      beta: 1,
    });
    expect(posteriors.find((p) => p.candidateId === 'claude')).toStrictEqual({
      candidateId: 'claude',
      alpha: 1,
      beta: 1,
    });
  });
});

describe('candidate_identities (schema-freeze v1)', () => {
  it('event carries candidate_identities 1:1 with ranked_candidates, snake_case shape', () => {
    const event = buildRouteDecided(routeInput(20));
    expect(event['ranked_candidates']).toStrictEqual(['claude', 'codex', 'gemini']);
    expect(event['candidate_identities']).toStrictEqual([
      {
        candidate_id: 'claude',
        argv0_realpath: '/bin/claude',
        argv0_sha256: HEX_A,
        argv_sha256: HEX_B,
      },
      {
        candidate_id: 'codex',
        argv0_realpath: '/bin/codex',
        argv0_sha256: HEX_B,
        argv_sha256: HEX_C,
      },
      {
        candidate_id: 'gemini',
        argv0_realpath: '/bin/gemini',
        argv0_sha256: HEX_C,
        argv_sha256: HEX_A,
      },
    ]);
  });

  it('mismatched length/order/name → throws /1:1/', () => {
    expect(() =>
      buildRouteDecided(
        routeInput(21, {
          rankedCandidates: ['claude', 'codex'],
          candidateIdentities: identitiesFor(['claude']),
        }),
      ),
    ).toThrow(/1:1/);
    expect(() =>
      buildRouteDecided(
        routeInput(21, {
          rankedCandidates: ['claude', 'codex'],
          candidateIdentities: identitiesFor(['codex', 'claude']),
        }),
      ),
    ).toThrow(/1:1/);
  });

  it('null digest without error field → throws; bad hex → throws', () => {
    expect(() =>
      buildRouteDecided(
        routeInput(22, {
          rankedCandidates: ['claude'],
          candidateIdentities: [identity('claude', { argv0Sha256: null })],
        }),
      ),
    ).toThrow(/argv0DigestError/);
    expect(() =>
      buildRouteDecided(
        routeInput(22, {
          rankedCandidates: ['claude'],
          candidateIdentities: [identity('claude', { argvSha256: 'not-hex' })],
        }),
      ),
    ).toThrow(/argvSha256/);
    expect(() =>
      buildRouteDecided(
        routeInput(22, {
          rankedCandidates: ['claude'],
          candidateIdentities: [identity('claude', { argv0Sha256: 'ABCDEF' + '0'.repeat(58) })],
        }),
      ),
    ).toThrow(/argv0Sha256/);
  });

  it('foldPosteriors is identical with candidate_identities present vs stripped (audit-only)', () => {
    const withIds = [
      ...pair(1, {}, { actualExecutor: 'claude' }),
      ...pair(2, {}, { outcome: 'NOT_VERIFIED_WITHIN_WINDOW', actualExecutor: 'codex' }),
    ];
    const stripped: OutcomeEvent[] = withIds.map((event) => {
      if (event.event_type !== 'route.decided') return event;
      const rest = { ...event };
      delete rest['candidate_identities'];
      return rest;
    });
    expect(foldPosteriors(withIds, [...CANDIDATES])).toStrictEqual(
      foldPosteriors(stripped, [...CANDIDATES]),
    );
  });

  it('null digest WITH error field serializes argv0_digest_error conditionally', () => {
    const event = buildRouteDecided(
      routeInput(23, {
        rankedCandidates: ['claude'],
        candidateIdentities: [
          identity('claude', { argv0Sha256: null, argv0DigestError: 'ENOENT' }),
        ],
      }),
    );
    expect(event['candidate_identities']).toStrictEqual([
      {
        candidate_id: 'claude',
        argv0_realpath: '/bin/claude',
        argv0_sha256: null,
        argv_sha256: HEX_B,
        argv0_digest_error: 'ENOENT',
      },
    ]);
  });
});
