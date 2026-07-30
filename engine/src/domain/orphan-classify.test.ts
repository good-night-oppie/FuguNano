import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CandidateIdentity } from './candidate-identity.js';
import { computeDispatchTerminalId } from './dispatch-machine.js';
import {
  appendOutcomeEvent,
  computeAttemptId,
  computeSignalId,
  OUTCOME_LOG_FORMAT,
  type OutcomeEvent,
} from './outcome-log.js';
import {
  buildOutcomeFinalized,
  buildRouteDecided,
  classifyOrphan,
  countOrphanFinalizations,
  foldPosteriors,
  isCohortInvalidatedByOrphans,
  MAX_ORPHANS_PER_COHORT,
  ORPHAN_REASON_CODES,
  type OrphanClassification,
  type RouteDecidedInput,
} from './route-posterior.js';

const CANDIDATES = ['claude', 'codex', 'gemini'] as const;
const SEED = '0123456789abcdef0123456789abcdef';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);
const HEAD = 'f'.repeat(40);
const REPO = 'acme/widgets';

const ROUTED_AT = '2026-07-23T12:00:00.000Z';
const DEADLINE_AT = '2026-07-30T12:00:00.000Z';
const BEFORE_DEADLINE = '2026-07-30T11:59:59.999Z';
const AFTER_DEADLINE = '2026-07-30T12:00:00.000Z';
const WELL_AFTER = '2026-08-01T00:00:00.000Z';
const SYNC_WALL = '2026-08-05T15:22:33.444Z';

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
    repo: REPO,
    prNumber: pr,
    headSha: HEAD,
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
    routedAt: ROUTED_AT,
    deadlineAt: DEADLINE_AT,
    retryEpoch: 0,
    supersedesRouteId: null,
    ...overrides,
    ...(!('candidateIdentities' in overrides) && overrides.rankedCandidates !== undefined
      ? { candidateIdentities: identitiesFor(overrides.rankedCandidates) }
      : {}),
  };
};

const mkSignal = (routeId: string, attemptId: string, sourceObjectId: string): OutcomeEvent => ({
  format: OUTCOME_LOG_FORMAT,
  event_type: 'github.signal',
  event_id: computeSignalId(routeId, sourceObjectId, 'COMMENTED'),
  route_id: routeId,
  observed_at: '2026-07-24T12:00:00.000Z',
  attempt_id: attemptId,
  source_timestamp_at: '2026-07-24T11:55:00.000Z',
});

const mkTerminal = (routeId: string): OutcomeEvent => ({
  format: OUTCOME_LOG_FORMAT,
  event_type: 'dispatch.terminal',
  event_id: computeDispatchTerminalId(routeId),
  route_id: routeId,
  observed_at: '2026-07-23T12:05:00.000Z',
  state: 'COMPLETED',
});

const orphanFinal = (
  pr: number,
  classification: Extract<OrphanClassification, { kind: 'orphan' }>,
): OutcomeEvent =>
  buildOutcomeFinalized({
    repo: REPO,
    prNumber: pr,
    headSha: HEAD,
    outcome: 'CENSORED',
    reasonCode: classification.reasonCode,
    actualExecutor: classification.actualExecutor,
    evidenceEventIds: classification.evidenceEventIds,
    verifiedAt: null,
    observedAt: classification.observedAt,
  });

describe('ORPHAN_REASON_CODES vocabulary', () => {
  it('freezes the two sync-time reconstruction codes', () => {
    expect(ORPHAN_REASON_CODES).toStrictEqual(['ORPHANED_EFFECT', 'ORPHANED_SILENT']);
  });
});

describe('classifyOrphan', () => {
  it('F1 orphan-silent: route.decided only, past deadline → CENSORED / ORPHANED_SILENT', () => {
    const route = buildRouteDecided(routeInput(101));
    const verdict = classifyOrphan(route.route_id, [route], DEADLINE_AT, AFTER_DEADLINE);
    expect(verdict).toStrictEqual({
      kind: 'orphan',
      reasonCode: 'ORPHANED_SILENT',
      actualExecutor: null,
      evidenceEventIds: [],
      observedAt: DEADLINE_AT,
    });
    if (verdict.kind !== 'orphan') throw new Error('expected orphan');
    const final = orphanFinal(101, verdict);
    expect(final['outcome']).toBe('CENSORED');
    expect(final['reason_code']).toBe('ORPHANED_SILENT');
    expect(final['actual_executor']).toBeNull();
    expect(final.observed_at).toBe(DEADLINE_AT);
    expect(final['verified_at']).toBeNull();

    const { posteriors, diagnostics } = foldPosteriors([route, final], [...CANDIDATES]);
    expect(diagnostics.blockedNoSignal).toBe(1);
    expect(diagnostics.applied).toBe(0);
    for (const p of posteriors) {
      expect(p.alpha).toBe(1);
      expect(p.beta).toBe(1);
    }
  });

  it('F2 orphan-effect attributable: signal attempt_id resolves to ranked candidate', () => {
    const route = buildRouteDecided(routeInput(102, { candidateId: 'codex' }));
    const attemptId = computeAttemptId(route.route_id, 'codex');
    const signal = mkSignal(route.route_id, attemptId, 'review-1');
    const verdict = classifyOrphan(route.route_id, [route, signal], DEADLINE_AT, WELL_AFTER);
    expect(verdict.kind).toBe('orphan');
    if (verdict.kind !== 'orphan') return;
    expect(verdict.reasonCode).toBe('ORPHANED_EFFECT');
    expect(verdict.actualExecutor).toBe('codex');
    expect(verdict.evidenceEventIds).toStrictEqual([signal.event_id]);
    expect(verdict.observedAt).toBe(DEADLINE_AT);

    const final = orphanFinal(102, verdict);
    const { posteriors, diagnostics } = foldPosteriors([route, signal, final], [...CANDIDATES]);
    expect(diagnostics.blockedNoSignal).toBe(1);
    expect(diagnostics.applied).toBe(0);
    for (const p of posteriors) {
      expect(p.alpha).toBe(1);
      expect(p.beta).toBe(1);
    }
  });

  it('F3 orphan-effect unattributable: marker resolves to no ranked candidate', () => {
    const route = buildRouteDecided(routeInput(103));
    const foreignAttempt = computeAttemptId(route.route_id, 'not-in-ranked');
    const signal = mkSignal(route.route_id, foreignAttempt, 'review-ghost');
    const verdict = classifyOrphan(route.route_id, [route, signal], DEADLINE_AT, WELL_AFTER);
    expect(verdict).toMatchObject({
      kind: 'orphan',
      reasonCode: 'ORPHANED_EFFECT',
      actualExecutor: null,
    });
    if (verdict.kind !== 'orphan') return;
    expect(verdict.evidenceEventIds).toStrictEqual([signal.event_id]);
  });

  it('F5 pending-not-orphan: before deadline → pending; at/after → orphan', () => {
    const route = buildRouteDecided(routeInput(105));
    expect(classifyOrphan(route.route_id, [route], DEADLINE_AT, BEFORE_DEADLINE)).toStrictEqual({
      kind: 'pending',
    });
    expect(classifyOrphan(route.route_id, [route], DEADLINE_AT, AFTER_DEADLINE).kind).toBe(
      'orphan',
    );
    expect(classifyOrphan(route.route_id, [route], DEADLINE_AT, WELL_AFTER).kind).toBe('orphan');
  });

  it('F6 negative control: dispatch.terminal COMPLETED present → never an orphan', () => {
    const route = buildRouteDecided(routeInput(106));
    const terminal = mkTerminal(route.route_id);
    const attemptId = computeAttemptId(route.route_id, 'claude');
    const signal = mkSignal(route.route_id, attemptId, 'review-late');
    expect(
      classifyOrphan(route.route_id, [route, terminal, signal], DEADLINE_AT, WELL_AFTER),
    ).toStrictEqual({ kind: 'not_orphan' });
    expect(
      classifyOrphan(route.route_id, [route, terminal], DEADLINE_AT, WELL_AFTER),
    ).toStrictEqual({ kind: 'not_orphan' });
  });
});

describe('orphan finalization determinism (F4)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-f4-'));
    logPath = path.join(dir, 'outcomes.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('classify + build twice past the deadline → second append is duplicate-noop', () => {
    const route = buildRouteDecided(routeInput(104));
    appendOutcomeEvent(logPath, route);

    const attemptId = computeAttemptId(route.route_id, 'gemini');
    // Two signals (unsorted discovery order) — evidence ids must sort for byte-identity.
    const signalB = mkSignal(route.route_id, attemptId, 'obj-b');
    const signalA = mkSignal(route.route_id, attemptId, 'obj-a');
    appendOutcomeEvent(logPath, signalB);
    appendOutcomeEvent(logPath, signalA);

    const events = [route, signalB, signalA];
    const first = classifyOrphan(route.route_id, events, DEADLINE_AT, WELL_AFTER);
    const second = classifyOrphan(route.route_id, events, DEADLINE_AT, SYNC_WALL);
    expect(first).toStrictEqual(second);
    if (first.kind !== 'orphan' || second.kind !== 'orphan') {
      throw new Error('expected orphan');
    }

    const finalA = orphanFinal(104, first);
    const finalB = orphanFinal(104, second);
    expect(finalA).toStrictEqual(finalB);
    expect(finalA.observed_at).toBe(DEADLINE_AT);
    expect(finalA['evidence_event_ids']).toStrictEqual([signalA.event_id, signalB.event_id].sort());

    expect(appendOutcomeEvent(logPath, finalA)).toBe('appended');
    expect(appendOutcomeEvent(logPath, finalB)).toBe('duplicate-noop');
  });

  it('wall-clock observed_at (NOT deadlineAt) produces a DIFFERENT payload', () => {
    const route = buildRouteDecided(routeInput(104));
    const verdict = classifyOrphan(route.route_id, [route], DEADLINE_AT, WELL_AFTER);
    if (verdict.kind !== 'orphan') throw new Error('expected orphan');

    const correct = orphanFinal(104, verdict);
    const wallClockVariant = buildOutcomeFinalized({
      repo: REPO,
      prNumber: 104,
      headSha: HEAD,
      outcome: 'CENSORED',
      reasonCode: 'ORPHANED_SILENT',
      actualExecutor: null,
      evidenceEventIds: [],
      verifiedAt: null,
      observedAt: SYNC_WALL, // the forbidden "simplification"
    });

    expect(correct.event_id).toBe(wallClockVariant.event_id);
    expect(JSON.stringify(correct)).not.toBe(JSON.stringify(wallClockVariant));
    expect(correct.observed_at).toBe(DEADLINE_AT);
    expect(wallClockVariant.observed_at).toBe(SYNC_WALL);

    appendOutcomeEvent(logPath, correct);
    expect(() => appendOutcomeEvent(logPath, wallClockVariant)).toThrow(/DUPLICATE_ID_CONFLICT/);
  });
});

describe('fold pin — CENSORED orphans never update posteriors (D17 §5)', () => {
  it('ORPHANED_EFFECT with attributable executor still hits blockedNoSignal before lookup', () => {
    const route = buildRouteDecided(routeInput(107, { policyArm: 'thompson', cohortIndex: 2 }));
    const attemptId = computeAttemptId(route.route_id, 'claude');
    const signal = mkSignal(route.route_id, attemptId, 'pin-effect');
    const verdict = classifyOrphan(route.route_id, [route, signal], DEADLINE_AT, WELL_AFTER);
    if (verdict.kind !== 'orphan') throw new Error('expected orphan');
    expect(verdict.actualExecutor).toBe('claude');

    const final = orphanFinal(107, verdict);
    const baseline = foldPosteriors([], [...CANDIDATES]);
    const after = foldPosteriors([route, signal, final], [...CANDIDATES]);
    expect(after.posteriors).toStrictEqual(baseline.posteriors);
    expect(after.diagnostics.blockedNoSignal).toBe(1);
    expect(after.diagnostics.applied).toBe(0);
  });
});

describe('cohort orphan tripwire (F7)', () => {
  it(`2 orphans → valid; ${String(MAX_ORPHANS_PER_COHORT)} → invalidated; ignores non-orphan CENSORED`, () => {
    expect(MAX_ORPHANS_PER_COHORT).toBe(3);

    const events: OutcomeEvent[] = [];
    for (let i = 0; i < 2; i += 1) {
      const pr = 200 + i;
      const route = buildRouteDecided(routeInput(pr, { cohortIndex: (i + 1) * 2 }));
      const verdict = classifyOrphan(route.route_id, [route], DEADLINE_AT, WELL_AFTER);
      if (verdict.kind !== 'orphan') throw new Error('expected orphan');
      events.push(route, orphanFinal(pr, verdict));
    }
    // Non-orphan CENSORED must not count toward the tripwire.
    events.push(
      ...[
        buildRouteDecided(routeInput(210, { cohortIndex: 4 })),
        buildOutcomeFinalized({
          repo: REPO,
          prNumber: 210,
          headSha: HEAD,
          outcome: 'CENSORED',
          reasonCode: 'HEAD_DRIFT',
          actualExecutor: 'claude',
          evidenceEventIds: [],
          verifiedAt: null,
          observedAt: '2026-07-25T12:00:00.000Z',
        }),
      ],
    );

    expect(countOrphanFinalizations(events)).toBe(2);
    expect(isCohortInvalidatedByOrphans(events)).toBe(false);

    const thirdRoute = buildRouteDecided(routeInput(202, { cohortIndex: 6 }));
    const thirdVerdict = classifyOrphan(thirdRoute.route_id, [thirdRoute], DEADLINE_AT, WELL_AFTER);
    if (thirdVerdict.kind !== 'orphan') throw new Error('expected orphan');
    events.push(thirdRoute, orphanFinal(202, thirdVerdict));

    expect(countOrphanFinalizations(events)).toBe(3);
    expect(isCohortInvalidatedByOrphans(events)).toBe(true);
  });
});
