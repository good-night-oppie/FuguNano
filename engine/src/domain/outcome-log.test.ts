import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendOutcomeEvent,
  computeAttemptId,
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
