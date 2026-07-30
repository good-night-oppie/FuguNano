import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendOutcomeEvent,
  computeAttemptId,
  computeFinalAmendId,
  computeFinalId,
  computeRouteId,
  computeSignalId,
  computeTaskId,
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  OutcomeLogError,
  readOutcomeLog,
  resolveOutcomeLogPath,
  type OutcomeEvent,
} from './outcome-log.js';
import {
  buildOutcomeFinalized,
  buildOutcomeFinalizedAmendment,
  buildRouteDecided,
  foldPosteriors,
} from './route-posterior.js';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-log-'));
  logPath = path.join(dir, 'agentdex', 'pr-review-outcomes-v1.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const routeId = computeRouteId(computeTaskId('acme/widgets', 42, 'a'.repeat(40)));

const ROUTED_AT = '2026-07-23T12:00:00.000Z';
const DEADLINE_AT = '2026-07-30T12:00:00.000Z';

const mkEvent = (overrides: Partial<OutcomeEvent> = {}): OutcomeEvent => ({
  format: 1,
  event_type: 'route.decided',
  event_id: computeAttemptId(routeId, 'claude'),
  route_id: routeId,
  observed_at: ROUTED_AT,
  routed_at: ROUTED_AT,
  deadline_at: DEADLINE_AT,
  policy_arm: 'thompson',
  candidate_id: 'claude',
  ...overrides,
});

const mkTerminal = (overrides: Partial<OutcomeEvent> = {}): OutcomeEvent => ({
  format: 1,
  event_type: 'dispatch.terminal',
  event_id: computeAttemptId(routeId, 'terminal'),
  route_id: routeId,
  observed_at: ROUTED_AT,
  terminal_state: 'COMPLETED',
  ...overrides,
});

const mkFinalized = (overrides: Partial<OutcomeEvent> = {}): OutcomeEvent => ({
  format: 1,
  event_type: 'outcome.finalized',
  event_id: computeFinalId(routeId),
  route_id: routeId,
  observed_at: '2026-07-25T12:00:00.000Z',
  outcome: 'VERIFIED_SUCCESS',
  reason_code: 'CLEAN_MERGE',
  actual_executor: 'claude',
  evidence_event_ids: [],
  verified_at: '2026-07-25T12:00:00.000Z',
  ...overrides,
});

describe('canonical ids — frozen formulas', () => {
  it('task/route/attempt/signal/final ids follow the spec byte layouts', () => {
    const taskId = computeTaskId('acme/widgets', 42, 'deadbeef');
    expect(taskId).toBe('acme/widgets#42@deadbeef');
    const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
    expect(computeRouteId(taskId)).toBe(h(`pr-review-v1\0${taskId}`));
    const r = computeRouteId(taskId);
    expect(computeAttemptId(r, 'codex')).toBe(h(`${r}\0codex`));
    expect(computeSignalId(r, 'thread-9', 'resolved')).toBe(
      h(`pr-review-signal-v1\0${r}\0thread-9\0resolved`),
    );
    expect(computeFinalId(r)).toBe(h(`pr-review-outcome-v1\0${r}`));
  });

  it('signal id delimiters prevent variable-length collisions', () => {
    const r = 'R';
    const a = computeSignalId(r, '12', '3APPROVED');
    const b = computeSignalId(r, '123', 'APPROVED');
    expect(a).not.toBe(b);
  });

  it('distinct inputs give distinct ids', () => {
    expect(computeRouteId('a')).not.toBe(computeRouteId('b'));
    expect(computeAttemptId(routeId, 'claude')).not.toBe(computeAttemptId(routeId, 'codex'));
  });

  it('retry epoch namespaces route id; epoch 0 stays byte-identical to the legacy call', () => {
    const taskId = computeTaskId('acme/widgets', 42, 'deadbeef');
    const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
    expect(computeRouteId(taskId, 0)).toBe(computeRouteId(taskId));
    expect(computeRouteId(taskId, 0)).toBe(h(`pr-review-v1\0${taskId}`));
    expect(computeRouteId(taskId, 1)).toBe(h(`pr-review-v1\0${taskId}\0retry\0${1}`));
    expect(computeRouteId(taskId, 1)).not.toBe(computeRouteId(taskId, 0));
  });
});

describe('path resolution', () => {
  it('honors XDG_STATE_HOME', () => {
    expect(resolveOutcomeLogPath({ XDG_STATE_HOME: '/var/state' })).toBe(
      '/var/state/agentdex/pr-review-outcomes-v1.jsonl',
    );
  });

  it('falls back to HOME/.local/state', () => {
    expect(resolveOutcomeLogPath({ HOME: '/home/eddie' })).toBe(
      '/home/eddie/.local/state/agentdex/pr-review-outcomes-v1.jsonl',
    );
  });

  it('fails closed with neither set, or a relative override', () => {
    expect(() => resolveOutcomeLogPath({})).toThrow(OutcomeLogError);
    expect(() => resolveOutcomeLogPath({ XDG_STATE_HOME: 'relative/path' })).toThrow(
      /not absolute/,
    );
  });
});

describe('append + read roundtrip', () => {
  it('appends, fsyncs, and reads back; dir 0700 file 0600', () => {
    expect(appendOutcomeEvent(logPath, mkEvent())).toBe('appended');
    const back = readOutcomeLog(logPath);
    expect(back.events).toHaveLength(1);
    expect(back.events[0]!.candidate_id).toBe('claude');
    expect(fs.statSync(path.dirname(logPath)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
  });

  it('frozen caps are the spec numbers', () => {
    expect(MAX_LINE_BYTES).toBe(65_536);
    expect(MAX_FILE_BYTES).toBe(67_108_864);
  });
});

describe('duplicate-id-conflict (pre-Task-1 test #2)', () => {
  it('same id + same payload is a no-op', () => {
    const event = mkEvent();
    expect(appendOutcomeEvent(logPath, event)).toBe('appended');
    expect(appendOutcomeEvent(logPath, event)).toBe('duplicate-noop');
    expect(readOutcomeLog(logPath).events).toHaveLength(1);
  });

  it('same id + different payload fails closed and writes nothing', () => {
    expect(appendOutcomeEvent(logPath, mkEvent())).toBe('appended');
    const conflicting = mkEvent({ candidate_id: 'codex' });
    expect(() => appendOutcomeEvent(logPath, conflicting)).toThrow(/DUPLICATE_ID_CONFLICT/);
    expect(readOutcomeLog(logPath).events).toHaveLength(1);
  });
});

describe('jsonl-torn-line (pre-Task-1 test)', () => {
  it('a non-newline-terminated tail blocks reads AND appends', () => {
    appendOutcomeEvent(logPath, mkEvent());
    fs.appendFileSync(logPath, '{"format":1,"event_type":"github.sig');
    expect(() => readOutcomeLog(logPath)).toThrow(/TORN_TRAILING_LINE/);
    const next = mkEvent({ event_id: computeAttemptId(routeId, 'gemini') });
    expect(() => appendOutcomeEvent(logPath, next)).toThrow(/TORN_TRAILING_LINE/);
  });

  it('an unparseable interior line is corruption, not skipped', () => {
    appendOutcomeEvent(logPath, mkEvent());
    fs.appendFileSync(logPath, 'not json at all\n');
    expect(() => readOutcomeLog(logPath)).toThrow(/CORRUPT_LINE/);
  });
});

describe('size caps', () => {
  it('rejects an oversized line', () => {
    const fat = mkEvent({ padding: 'x'.repeat(200) });
    expect(() => appendOutcomeEvent(logPath, fat, { maxLineBytes: 128 })).toThrow(/LINE_TOO_LARGE/);
  });

  it('rejects an append that would cross the file cap', () => {
    appendOutcomeEvent(logPath, mkEvent());
    const size = fs.statSync(logPath).size;
    const next = mkEvent({ event_id: computeAttemptId(routeId, 'gemini') });
    expect(() => appendOutcomeEvent(logPath, next, { maxFileBytes: size + 10 })).toThrow(
      /FILE_CAP_REACHED/,
    );
  });
});

describe('validation + secret-scan (pre-Task-1 test)', () => {
  it('rejects unknown format, type, and malformed ids', () => {
    expect(() => appendOutcomeEvent(logPath, mkEvent({ format: 2 } as never))).toThrow(
      /unknown format/,
    );
    expect(() =>
      appendOutcomeEvent(logPath, mkEvent({ event_type: 'route.chosen' } as never)),
    ).toThrow(/unknown event_type/);
    expect(() => appendOutcomeEvent(logPath, mkEvent({ event_id: 'abc' }))).toThrow(
      /64 lowercase hex/,
    );
  });

  it.each([
    ['github classic token', 'ghp_' + 'a1B2'.repeat(9)],
    ['api key shape', 'sk-' + 'a1B2'.repeat(8)],
    ['bearer header', 'Bearer abcdefghijklmnop0123456789'],
    ['private key block', '-----BEGIN RSA PRIVATE KEY-----'],
  ])('refuses credential-shaped values: %s', (_label, value) => {
    const poisoned = mkEvent({ reason_code: value });
    expect(() => appendOutcomeEvent(logPath, poisoned)).toThrow(/SECRET_MATERIAL/);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('never echoes the secret value in the error', () => {
    const token = 'ghp_' + 'zZ9y'.repeat(9);
    try {
      appendOutcomeEvent(logPath, mkEvent({ note: token }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).toContain('event.note');
    }
  });
});

describe('locking via util-linux flock', () => {
  it('a held exclusive lock makes the append time out (LOCK_TIMEOUT)', async () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const lockFile = `${logPath}.lock`;
    // Competing holder: flock <file> sleep — direct command form, no shell.
    const holder = spawn('flock', ['-x', lockFile, 'sleep', '30']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const started = Date.now();
      expect(() => appendOutcomeEvent(logPath, mkEvent())).toThrow(/LOCK_TIMEOUT/);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(4500);
    } finally {
      holder.kill('SIGKILL');
    }
  }, 20_000);

  it('lock is released after append — sequential appends succeed', () => {
    appendOutcomeEvent(logPath, mkEvent());
    const second = mkEvent({ event_id: computeAttemptId(routeId, 'gemini') });
    expect(appendOutcomeEvent(logPath, second)).toBe('appended');
    expect(readOutcomeLog(logPath).events).toHaveLength(2);
  });
});

describe('D10 append-side timestamp validation', () => {
  it('rejects second-precision observed_at on dispatch.terminal', () => {
    expect(() =>
      appendOutcomeEvent(logPath, mkTerminal({ observed_at: '2026-07-23T12:00:00Z' })),
    ).toThrow(/INVALID_EVENT: observed_at/);
  });

  it('accepts canonical-millis observed_at on dispatch.terminal', () => {
    expect(appendOutcomeEvent(logPath, mkTerminal())).toBe('appended');
  });

  it('rejects offset-form timestamps', () => {
    expect(() =>
      appendOutcomeEvent(logPath, mkTerminal({ observed_at: '2026-07-23T12:00:00+00:00' })),
    ).toThrow(/INVALID_EVENT: observed_at/);
  });

  it('rejects pattern-plausible but unparseable calendar values', () => {
    expect(() =>
      appendOutcomeEvent(logPath, mkTerminal({ observed_at: '2026-13-45T99:99:99.000Z' })),
    ).toThrow(/INVALID_EVENT: observed_at/);
  });

  it('route.decided requires deadline_at strictly after routed_at', () => {
    expect(() =>
      appendOutcomeEvent(
        logPath,
        mkEvent({
          routed_at: ROUTED_AT,
          deadline_at: ROUTED_AT,
          observed_at: ROUTED_AT,
        }),
      ),
    ).toThrow(/INVALID_EVENT: deadline_at/);
    expect(
      appendOutcomeEvent(
        logPath,
        mkEvent({
          routed_at: ROUTED_AT,
          deadline_at: DEADLINE_AT,
          observed_at: ROUTED_AT,
        }),
      ),
    ).toBe('appended');
  });

  it('route.decided requires observed_at === routed_at', () => {
    expect(() =>
      appendOutcomeEvent(
        logPath,
        mkEvent({
          routed_at: ROUTED_AT,
          deadline_at: DEADLINE_AT,
          observed_at: '2026-07-23T12:00:00.001Z',
        }),
      ),
    ).toThrow(/INVALID_EVENT: observed_at/);
  });

  it('dispatch.terminal observed_at equal to route.decided is allowed (>= pin)', () => {
    appendOutcomeEvent(logPath, mkEvent());
    expect(appendOutcomeEvent(logPath, mkTerminal({ observed_at: ROUTED_AT }))).toBe('appended');
  });

  it('dispatch.terminal observed_at 1ms before route.decided is rejected', () => {
    appendOutcomeEvent(logPath, mkEvent());
    expect(() =>
      appendOutcomeEvent(logPath, mkTerminal({ observed_at: '2026-07-23T11:59:59.999Z' })),
    ).toThrow(/INVALID_EVENT: observed_at/);
  });

  it('skips the route.decided cross-check when that route is absent', () => {
    const orphanRoute = computeRouteId(computeTaskId('acme/other', 1, 'b'.repeat(40)));
    expect(
      appendOutcomeEvent(
        logPath,
        mkTerminal({
          route_id: orphanRoute,
          event_id: computeAttemptId(orphanRoute, 'terminal'),
          observed_at: ROUTED_AT,
        }),
      ),
    ).toBe('appended');
  });

  it('outcome.finalized verified_at rules', () => {
    expect(() =>
      appendOutcomeEvent(
        logPath,
        mkFinalized({
          outcome: 'CENSORED',
          reason_code: 'CLOCK_SKEW_SUSPECT',
          verified_at: '2026-07-25T12:00:00.000Z',
        }),
      ),
    ).toThrow(/INVALID_EVENT: verified_at/);

    expect(
      appendOutcomeEvent(
        logPath,
        mkFinalized({
          event_id: computeFinalId(
            computeRouteId(computeTaskId('acme/widgets', 7, 'c'.repeat(40))),
          ),
          route_id: computeRouteId(computeTaskId('acme/widgets', 7, 'c'.repeat(40))),
          outcome: 'NOT_VERIFIED_WITHIN_WINDOW',
          reason_code: 'WINDOW_ELAPSED',
          verified_at: null,
        }),
      ),
    ).toBe('appended');

    expect(
      appendOutcomeEvent(
        logPath,
        mkFinalized({
          event_id: computeFinalId(
            computeRouteId(computeTaskId('acme/widgets', 8, 'd'.repeat(40))),
          ),
          route_id: computeRouteId(computeTaskId('acme/widgets', 8, 'd'.repeat(40))),
          outcome: 'VERIFIED_SUCCESS',
          verified_at: '2026-07-25T12:00:00.000Z',
        }),
      ),
    ).toBe('appended');
  });

  it('READ path still accepts pre-freeze second-precision bytes', () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const legacy = {
      format: 1,
      event_type: 'dispatch.terminal',
      event_id: computeAttemptId(routeId, 'legacy'),
      route_id: routeId,
      observed_at: '2026-07-23T12:00:00Z',
      terminal_state: 'COMPLETED',
    };
    fs.writeFileSync(logPath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
    const back = readOutcomeLog(logPath);
    expect(back.events).toHaveLength(1);
    expect(back.events[0]!.observed_at).toBe('2026-07-23T12:00:00Z');
  });
});

describe('D9 — amendment id + append-side amendment gate', () => {
  const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

  const mkCensoredOriginal = (overrides: Partial<OutcomeEvent> = {}): OutcomeEvent =>
    mkFinalized({
      outcome: 'CENSORED',
      reason_code: 'HEAD_DRIFT',
      verified_at: null,
      ...overrides,
    });

  const mkAmendment = (overrides: Partial<OutcomeEvent> = {}): OutcomeEvent =>
    mkFinalized({
      event_id: computeFinalAmendId(routeId, 1),
      outcome: 'VERIFIED_SUCCESS',
      reason_code: 'LATE_APPROVAL',
      amend_seq: 1,
      amends: computeFinalId(routeId),
      amend_reason_code: 'LATE_SIGNAL_IN_WINDOW',
      ...overrides,
    });

  it('(k) computeFinalAmendId follows the frozen byte layout and namespaces seq', () => {
    // The NUL before the seq digit is written with a unicode escape:
    // a backslash-zero followed by a digit is a legacy octal escape
    // and will not compile inside a template literal.
    expect(computeFinalAmendId(routeId, 1)).toBe(
      h(`pr-review-outcome-v1\0${routeId}\0amend\u00001`),
    );
    expect(computeFinalAmendId(routeId, 2)).toBe(
      h(`pr-review-outcome-v1\0${routeId}\0amend\u00002`),
    );
    // Seq 0 is the original's formula and must stay byte-identical.
    expect(computeFinalId(routeId)).toBe(h(`pr-review-outcome-v1\0${routeId}`));
    expect(computeFinalAmendId(routeId, 1)).not.toBe(computeFinalId(routeId));
    expect(computeFinalAmendId(routeId, 1)).not.toBe(computeFinalAmendId(routeId, 2));
    // seq 0 / negative / fractional are caller bugs, not silent seq-1.
    expect(() => computeFinalAmendId(routeId, 0)).toThrow(/amend_seq/);
    expect(() => computeFinalAmendId(routeId, -1)).toThrow(/amend_seq/);
    expect(() => computeFinalAmendId(routeId, 1.5)).toThrow(/amend_seq/);
  });

  it('(l) an amendment appends alongside its original and stays idempotent', () => {
    expect(appendOutcomeEvent(logPath, mkCensoredOriginal())).toBe('appended');
    const amendment = mkAmendment();
    expect(appendOutcomeEvent(logPath, amendment)).toBe('appended');
    expect(readOutcomeLog(logPath).events).toHaveLength(2);
    // Byte-identical re-append is the retried-sync lane.
    expect(appendOutcomeEvent(logPath, amendment)).toBe('duplicate-noop');
    expect(readOutcomeLog(logPath).events).toHaveLength(2);
    // Same seq, different payload → the id collides and fails closed.
    expect(() =>
      appendOutcomeEvent(logPath, mkAmendment({ reason_code: 'SOMETHING_ELSE' })),
    ).toThrow(/DUPLICATE_ID_CONFLICT/);
    expect(readOutcomeLog(logPath).events).toHaveLength(2);
  });

  it('the append gate rejects malformed amendment fields by field path', () => {
    expect(appendOutcomeEvent(logPath, mkCensoredOriginal())).toBe('appended');
    expect(() => appendOutcomeEvent(logPath, mkAmendment({ amend_seq: 0 }))).toThrow(
      /INVALID_EVENT: amend_seq/,
    );
    expect(() => appendOutcomeEvent(logPath, mkAmendment({ amend_seq: 2 }))).toThrow(
      /INVALID_EVENT: amend_seq/,
    );
    expect(() => appendOutcomeEvent(logPath, mkAmendment({ amend_seq: '1' }))).toThrow(
      /INVALID_EVENT: amend_seq/,
    );
    expect(() => appendOutcomeEvent(logPath, mkAmendment({ amends: 'not-a-sha' }))).toThrow(
      /INVALID_EVENT: amends/,
    );
    expect(() => appendOutcomeEvent(logPath, mkAmendment({ amend_reason_code: '' }))).toThrow(
      /INVALID_EVENT: amend_reason_code/,
    );
    // Amendment fields present but the id is the ORIGINAL's. Use a route whose
    // original is NOT on disk, so dedupe cannot fire first and mask the branch
    // under test (with the original present this is a DUPLICATE_ID_CONFLICT,
    // which is also a correct rejection but a different one).
    const fresh = computeRouteId(computeTaskId('acme/widgets', 55, 'e'.repeat(40)));
    expect(() =>
      appendOutcomeEvent(
        logPath,
        mkAmendment({ route_id: fresh, event_id: computeFinalId(fresh) }),
      ),
    ).toThrow(/INVALID_EVENT: event_id/);
    // A partial amendment (seq without pointer) is rejected, not ignored.
    expect(() => appendOutcomeEvent(logPath, mkAmendment({ amends: undefined }))).toThrow(
      /INVALID_EVENT: amends/,
    );
    expect(readOutcomeLog(logPath).events).toHaveLength(1);
  });

  it('an id in the amendment namespace with NO amend fields is rejected', () => {
    // Adversarial-review finding (high): the gate originally guarded only
    // "fields present => shape valid". A squatter carrying the seq-namespaced
    // id and no fields appended cleanly and burned the seq-1 slot forever —
    // the genuine amendment then died on DUPLICATE_ID_CONFLICT and the route
    // could never be corrected again.
    const squatter = mkFinalized({ event_id: computeFinalAmendId(routeId, 1) });
    expect(() => appendOutcomeEvent(logPath, squatter)).toThrow(/INVALID_EVENT: amend_seq/);
    expect(readOutcomeLog(logPath).events).toHaveLength(0);
    // The slot is still free, so the real amendment lands.
    expect(appendOutcomeEvent(logPath, mkCensoredOriginal())).toBe('appended');
    expect(appendOutcomeEvent(logPath, mkAmendment())).toBe('appended');
  });

  it('rejects an amends pointer to another route, and off-vocabulary reasons', () => {
    expect(appendOutcomeEvent(logPath, mkCensoredOriginal())).toBe('appended');
    const other = computeRouteId(computeTaskId('acme/widgets', 99, 'b'.repeat(40)));
    // Well-formed 64-hex, but it is a DIFFERENT route's final: durable-forever
    // caller bug, same discipline D4 applied to supersedes_route_id.
    expect(() =>
      appendOutcomeEvent(
        logPath,
        mkAmendment({
          route_id: other,
          event_id: computeFinalAmendId(other, 1),
          amends: computeFinalId(routeId),
        }),
      ),
    ).toThrow(/INVALID_EVENT: amends/);
    // The vocabulary is closed on the DURABLE artifact, not just in the builder.
    expect(() =>
      appendOutcomeEvent(logPath, mkAmendment({ amend_reason_code: 'BECAUSE_I_SAID_SO' })),
    ).toThrow(/INVALID_EVENT: amend_reason_code/);
    expect(readOutcomeLog(logPath).events).toHaveLength(1);
  });

  it('a BUILDER-produced amendment satisfies the append gate end to end', () => {
    // Adversarial-review finding: the two halves of D9 (build-time lattice and
    // append-time shape) were each tested alone and never against each other.
    // A drift between them would have shipped silently.
    const common = {
      repo: 'acme/widgets',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      actualExecutor: 'claude',
      evidenceEventIds: [],
    };
    const original = buildOutcomeFinalized({
      ...common,
      outcome: 'CENSORED',
      reasonCode: 'HEAD_DRIFT',
      verifiedAt: null,
      observedAt: '2026-07-25T12:00:00.000Z',
    });
    expect(original.route_id).toBe(routeId);
    expect(appendOutcomeEvent(logPath, original)).toBe('appended');

    const amendment = buildOutcomeFinalizedAmendment({
      ...common,
      outcome: 'VERIFIED_SUCCESS',
      reasonCode: 'LATE_APPROVAL',
      verifiedAt: '2026-07-29T09:00:00.000Z',
      observedAt: '2026-07-29T09:00:00.000Z',
      amendSeq: 1,
      amends: original.event_id,
      priorOutcome: 'CENSORED',
      amendReasonCode: 'LATE_SIGNAL_IN_WINDOW',
      deadlineAt: '2026-07-30T12:00:00.000Z',
      evidenceCanonicalTimestamp: '2026-07-29T09:00:00.000Z',
    });
    expect(appendOutcomeEvent(logPath, amendment)).toBe('appended');
    expect(appendOutcomeEvent(logPath, amendment)).toBe('duplicate-noop');

    const back = readOutcomeLog(logPath);
    expect(back.events).toHaveLength(2);
    // And the fold resolves the pair to exactly one learning update.
    const route = buildRouteDecided({
      repo: 'acme/widgets',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      policyArm: 'thompson',
      cohortIndex: null,
      candidateId: 'claude',
      rankedCandidates: ['claude'],
      candidateIdentities: [
        {
          candidateId: 'claude',
          argv0Realpath: '/bin/claude',
          argv0Sha256: 'a'.repeat(64),
          argvSha256: 'b'.repeat(64),
        },
      ],
      seed: '0123456789abcdef0123456789abcdef',
      configSha256: 'c'.repeat(64),
      profileSha256: 'a'.repeat(64),
      profileFacets: {
        authorLineage: 'human:alice',
        languages: ['python'],
        riskTags: [],
        changedPathCount: 1,
      },
      routedAt: '2026-07-23T12:00:00.000Z',
      deadlineAt: '2026-07-30T12:00:00.000Z',
      retryEpoch: 0,
      supersedesRouteId: null,
    });
    const fold = foldPosteriors([route, ...back.events], ['claude']);
    expect(fold.posteriors).toStrictEqual([{ candidateId: 'claude', alpha: 2, beta: 1 }]);
    expect(fold.diagnostics.applied).toBe(1);
    expect(fold.diagnostics.superseded).toBe(1);
  });

  it('the append gate enforces the LATTICE, not just the shape', () => {
    // Adversarial-review finding raised independently by three lenses: a
    // shape-only gate lets any writer that skips the builder land a forbidden
    // transition permanently, in an append-only log. The superseded event is
    // in the log, so the real prior outcome is known — not taken on trust.
    expect(appendOutcomeEvent(logPath, mkFinalized())).toBe('appended'); // VERIFIED_SUCCESS
    expect(() =>
      appendOutcomeEvent(
        logPath,
        mkAmendment({ outcome: 'NOT_VERIFIED_WITHIN_WINDOW', verified_at: null }),
      ),
    ).toThrow(/INVALID_EVENT: outcome/); // un-verifying a verified review
    expect(() =>
      appendOutcomeEvent(logPath, mkAmendment({ outcome: 'CENSORED', verified_at: null })),
    ).toThrow(/INVALID_EVENT: outcome/); // re-censoring a real observation
    expect(readOutcomeLog(logPath).events).toHaveLength(1);
  });

  it('an amendment whose superseded event is absent is a dangling pointer', () => {
    // Without the original present this amendment would become the effective
    // final for a route that never had one.
    expect(() => appendOutcomeEvent(logPath, mkAmendment())).toThrow(/INVALID_EVENT: amends/);
    expect(readOutcomeLog(logPath).events).toHaveLength(0);
  });

  it('the amendment gate is inert for pre-D9 finalized events', () => {
    expect(appendOutcomeEvent(logPath, mkFinalized())).toBe('appended');
    expect(readOutcomeLog(logPath).events).toHaveLength(1);
  });
});
