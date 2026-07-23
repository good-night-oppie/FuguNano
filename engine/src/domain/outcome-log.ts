import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Four-event append-only outcome log for the AgentDex PR-review routing
 * slice (frozen baseline 2026-07-23, §B6 + R4-2).
 *
 * Contract highlights, all load-bearing for the 50-task live gate:
 * - ONE file, append-only, one JSON object per line. No rotation in v1:
 *   hitting the size caps is a typed STATE_ERROR (CLI exit 74), and archival
 *   is a manual, whole-file, between-cohorts operation.
 * - Idempotent by content-derived event id: same id + byte-identical payload
 *   is a no-op; same id + different payload fails closed. A retried write can
 *   therefore never double-count — there is no mutable counter anywhere.
 * - A torn trailing line (crash mid-write) is DETECTED and reported as
 *   corruption; it is never silently skipped.
 * - Locking (R4-2): Node has no flock(2) binding, so the lock is taken by
 *   spawning util-linux `flock -w 5` against an inherited file descriptor;
 *   the lock lives on the open file description we keep, and releases when
 *   we close it. Linux-only by design — matches the deploy host. The Python
 *   front door NEVER writes this file (contract invariant); the only writer
 *   is the FuguNano process launched by `adx outcome sync` / dispatch.
 * - No secrets, prompts, transcripts, or raw model output: events carry
 *   digests and references only, and a best-effort credential-shape guard
 *   rejects obviously secret-like values before they can reach disk.
 */

export const OUTCOME_LOG_FORMAT = 1;

export const EVENT_TYPES = [
  'route.decided',
  'dispatch.terminal',
  'github.signal',
  'outcome.finalized',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Frozen caps (spec §B6): single line 64 KiB, whole file 64 MiB. */
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

const LOCK_WAIT_SECONDS = 5;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface OutcomeEvent {
  readonly format: typeof OUTCOME_LOG_FORMAT;
  readonly event_type: EventType;
  /** sha256 hex, content-derived via the id helpers below. */
  readonly event_id: string;
  readonly route_id: string;
  readonly observed_at: string;
  readonly [key: string]: unknown;
}

/** Typed failure taxonomy; the CLI layer maps kind → exit code (74 for state). */
export type OutcomeLogErrorKind =
  | 'LOCK_TIMEOUT'
  | 'LINE_TOO_LARGE'
  | 'FILE_CAP_REACHED'
  | 'TORN_TRAILING_LINE'
  | 'CORRUPT_LINE'
  | 'DUPLICATE_ID_CONFLICT'
  | 'INVALID_EVENT'
  | 'SECRET_MATERIAL';

export class OutcomeLogError extends Error {
  readonly kind: OutcomeLogErrorKind;

  constructor(kind: OutcomeLogErrorKind, message: string) {
    super(`${kind}: ${message}`);
    this.kind = kind;
    this.name = 'OutcomeLogError';
  }
}

export type AppendResult = 'appended' | 'duplicate-noop';

// --- canonical ids (spec §B6, formulas frozen) -----------------------------

const sha256 = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

export const computeTaskId = (repo: string, prNumber: number, headSha: string): string =>
  `${repo}#${prNumber}@${headSha}`;

export const computeRouteId = (taskId: string): string => sha256(`pr-review-v1\0${taskId}`);

export const computeAttemptId = (routeId: string, candidateId: string): string =>
  sha256(`${routeId}\0${candidateId}`);

export const computeSignalId = (
  routeId: string,
  sourceObjectId: string,
  canonicalSourceState: string,
): string => sha256(`${routeId}${sourceObjectId}${canonicalSourceState}`);

export const computeFinalId = (routeId: string): string =>
  sha256(`pr-review-outcome-v1\0${routeId}`);

// --- path resolution -------------------------------------------------------

export const resolveOutcomeLogPath = (env: Record<string, string | undefined>): string => {
  const stateHome =
    env['XDG_STATE_HOME'] && env['XDG_STATE_HOME'].length > 0
      ? env['XDG_STATE_HOME']
      : env['HOME']
        ? path.join(env['HOME'], '.local', 'state')
        : undefined;
  if (!stateHome || !path.isAbsolute(stateHome)) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      'cannot resolve state dir: XDG_STATE_HOME/HOME missing or not absolute',
    );
  }
  return path.join(stateHome, 'agentdex', 'pr-review-outcomes-v1.jsonl');
};

// --- secret guard ----------------------------------------------------------

/**
 * Best-effort credential-shape guard. This is a tripwire, not the security
 * boundary (the boundary is: events are built from digests/refs only). It
 * refuses the obvious classes: Anthropic/OpenAI-style keys, GitHub tokens,
 * bearer headers, and private key blocks.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
];

/**
 * Recursive credential-shape tripwire, exported so the dispatch wiring can
 * hold outbound machine JSON to the same bar as stored events. Throws
 * SECRET_MATERIAL naming only the field path, never the match.
 */
export const assertNoSecretMaterial = (value: unknown, keyPath: string): void => {
  if (typeof value === 'string') {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        // Never echo the match — name only the field path.
        throw new OutcomeLogError('SECRET_MATERIAL', `credential-shaped value at ${keyPath}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertNoSecretMaterial(item, `${keyPath}[${i}]`);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoSecretMaterial(v, `${keyPath}.${k}`);
  }
};

// --- validation ------------------------------------------------------------

const validateEvent = (event: OutcomeEvent): void => {
  if (event.format !== OUTCOME_LOG_FORMAT) {
    throw new OutcomeLogError('INVALID_EVENT', `unknown format ${String(event.format)}`);
  }
  if (!EVENT_TYPES.includes(event.event_type)) {
    throw new OutcomeLogError('INVALID_EVENT', `unknown event_type ${String(event.event_type)}`);
  }
  if (!SHA256_HEX_RE.test(event.event_id)) {
    throw new OutcomeLogError('INVALID_EVENT', 'event_id must be 64 lowercase hex chars');
  }
  if (!SHA256_HEX_RE.test(event.route_id)) {
    throw new OutcomeLogError('INVALID_EVENT', 'route_id must be 64 lowercase hex chars');
  }
  if (typeof event.observed_at !== 'string' || event.observed_at.length === 0) {
    throw new OutcomeLogError('INVALID_EVENT', 'observed_at required');
  }
  assertNoSecretMaterial(event, 'event');
};

// --- read side -------------------------------------------------------------

export interface ReadResult {
  readonly events: ReadonlyArray<OutcomeEvent>;
  /** event_id → serialized payload, for dedupe checks. */
  readonly byId: ReadonlyMap<string, string>;
}

/**
 * Read and validate the whole log. A non-newline-terminated tail is a torn
 * write and fails closed; an unparseable interior line likewise.
 */
export const readOutcomeLog = (filePath: string): ReadResult => {
  if (!fs.existsSync(filePath)) return { events: [], byId: new Map() };
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.length === 0) return { events: [], byId: new Map() };
  if (!raw.endsWith('\n')) {
    throw new OutcomeLogError(
      'TORN_TRAILING_LINE',
      `${filePath} ends mid-record (crash during a previous append); manual repair required`,
    );
  }
  const events: OutcomeEvent[] = [];
  const byId = new Map<string, string>();
  const lines = raw.slice(0, -1).split('\n');
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new OutcomeLogError('CORRUPT_LINE', `line ${index + 1} is not valid JSON`);
    }
    const event = parsed as OutcomeEvent;
    validateEvent(event);
    byId.set(event.event_id, line);
    events.push(event);
  });
  return { events, byId };
};

// --- locking ---------------------------------------------------------------

/**
 * Take an exclusive lock via util-linux flock(1) on an fd we keep open.
 * flock(2) locks attach to the open file description: the child locks fd 3
 * (inherited from us) and exits; our copy keeps the description — and thus
 * the lock — alive until close. Returns the fd holding the lock.
 */
const acquireLock = (lockPath: string): number => {
  const lockFd = fs.openSync(lockPath, 'w', 0o600);
  const result = spawnSync('flock', ['-x', '-w', String(LOCK_WAIT_SECONDS), '3'], {
    stdio: ['ignore', 'ignore', 'ignore', lockFd],
  });
  if (result.error || result.status !== 0) {
    fs.closeSync(lockFd);
    throw new OutcomeLogError(
      'LOCK_TIMEOUT',
      `could not lock ${lockPath} within ${LOCK_WAIT_SECONDS}s` +
        (result.error ? ` (${result.error.message})` : ''),
    );
  }
  return lockFd;
};

// --- append side -----------------------------------------------------------

export interface AppendOptions {
  /** Test seam only; production callers use the frozen defaults. */
  readonly maxLineBytes?: number;
  readonly maxFileBytes?: number;
}

/**
 * Append one event under lock. Same id + same payload → 'duplicate-noop';
 * same id + different payload → DUPLICATE_ID_CONFLICT; torn tail → fail
 * closed before any write.
 */
export const appendOutcomeEvent = (
  filePath: string,
  event: OutcomeEvent,
  options: AppendOptions = {},
): AppendResult => {
  validateEvent(event);
  const maxLine = options.maxLineBytes ?? MAX_LINE_BYTES;
  const maxFile = options.maxFileBytes ?? MAX_FILE_BYTES;

  const serialized = JSON.stringify(event);
  const lineBytes = Buffer.byteLength(serialized, 'utf8') + 1;
  if (lineBytes > maxLine) {
    throw new OutcomeLogError(
      'LINE_TOO_LARGE',
      `event ${event.event_id} serializes to ${lineBytes} bytes`,
    );
  }

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const lockFd = acquireLock(`${filePath}.lock`);
  try {
    const existing = readOutcomeLog(filePath);
    const prior = existing.byId.get(event.event_id);
    if (prior !== undefined) {
      if (prior === serialized) return 'duplicate-noop';
      throw new OutcomeLogError(
        'DUPLICATE_ID_CONFLICT',
        `event ${event.event_id} already recorded with different payload`,
      );
    }
    const currentBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (currentBytes + lineBytes > maxFile) {
      throw new OutcomeLogError(
        'FILE_CAP_REACHED',
        `appending would exceed ${maxFile} bytes; archive the file between cohorts`,
      );
    }
    const fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
      0o600,
    );
    try {
      fs.chmodSync(filePath, 0o600);
      fs.writeSync(fd, `${serialized}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return 'appended';
  } finally {
    fs.closeSync(lockFd);
  }
};
