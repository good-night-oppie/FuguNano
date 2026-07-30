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

/**
 * Canonical UTC millis form required on every timestamp field at append
 * time (D10). Matches `Date.prototype.toISOString()` output exactly —
 * second-precision, offsets, and unparseable calendar values are rejected.
 * Append-side only: the read path never applies this gate so pre-freeze
 * bytes on disk remain readable.
 */
export const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Frozen field name on `github.signal` (schema-freeze v1 / D10): GitHub
 * canonical timestamp of the source object, normalized via
 * `new Date(x).toISOString()` at ingest. No builder exists yet — this
 * pins the contract so a future builder cannot improvise an alternate name.
 */
export const GITHUB_SIGNAL_SOURCE_TIMESTAMP_FIELD = 'source_timestamp_at' as const;

/**
 * Agent-completed review receipt (D2 schema freeze). Optional on the agent's
 * machine JSON — absent receipt → COMPLETED unchanged (backward compatible;
 * agents that never emit one stay valid but can never reach DELIVERED).
 * All-or-nothing: present but malformed, or head_sha contradicting the
 * dispatch → attempt detail 'receipt-invalid' → EFFECT_UNKNOWN.
 *
 * The receipt rides through the existing `sealed()` path so the credential
 * tripwire covers it.
 */
export interface PRReviewReceiptV1 {
  readonly format: 1;
  /** GitHub review id (non-empty string at egress). */
  readonly review_id: string;
  /** GitHub login of the review author. */
  readonly actor: string;
  /** Must equal the dispatched profile's head_sha, else receipt-invalid. */
  readonly head_sha: string;
  /** sha256 hex of the exact posted review body bytes (64 lowercase hex). */
  readonly body_sha256: string;
}

/**
 * Frozen field set for `github.signal` events (D2). No builder exists yet —
 * these declarations pin the contract so a future builder cannot improvise an
 * alternate shape. The raw body is NEVER stored — only its digest.
 */
export interface GitHubSignalShape extends OutcomeEvent {
  readonly event_type: 'github.signal';
  readonly source_kind: 'pr-review' | 'review-thread' | 'issue-comment';
  readonly source_object_id: string;
  readonly canonical_source_state: string;
  readonly actor: string;
  readonly head_sha_at_signal: string;
  readonly marker_route_id: string | null;
  readonly marker_attempt_id: string | null;
  readonly body_sha256: string;
  readonly source_timestamp_at: string;
}

/** Frozen caps (spec §B6): single line 64 KiB, whole file 64 MiB. */
export const MAX_LINE_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

const LOCK_WAIT_SECONDS = 5;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Event types whose `observed_at` must be ≥ the matching route.decided's. */
const ROUTE_BOUND_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'dispatch.terminal',
  'github.signal',
  'outcome.finalized',
]);

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

/**
 * Retry-epoch ceiling (D4, frozen). Lives here — the shared identity module
 * — so the retry gate (review-dispatch), both event builders
 * (route-posterior), and route-id derivation agree on one value without an
 * import cycle (review-dispatch imports route-posterior imports this file).
 */
export const MAX_RETRY_EPOCHS = 3;

/**
 * Route identity. Epoch 0 is byte-identical to the pre-retry formula so
 * existing logs keep resolving; epoch n≥1 namespaces a fresh route after a
 * provably-never-started failure or an operator abandon.
 */
export const computeRouteId = (taskId: string, retryEpoch = 0): string =>
  retryEpoch === 0
    ? sha256(`pr-review-v1\0${taskId}`)
    : sha256(`pr-review-v1\0${taskId}\0retry\0${String(retryEpoch)}`);

export const computeAttemptId = (routeId: string, candidateId: string): string =>
  sha256(`${routeId}\0${candidateId}`);

export const computeSignalId = (
  routeId: string,
  sourceObjectId: string,
  canonicalSourceState: string,
): string => sha256(`pr-review-signal-v1\0${routeId}\0${sourceObjectId}\0${canonicalSourceState}`);

export const computeFinalId = (routeId: string): string =>
  sha256(`pr-review-outcome-v1\0${routeId}`);

/**
 * Superseding-amendment ceiling (D9, frozen for v1). One amendment per route:
 * a late verified signal is a single correction, not an editable field.
 */
export const MAX_AMEND_SEQ = 1;

/**
 * Terminal outcome vocabulary (frozen). Lives in the shared identity module so
 * the append gate can enforce the amendment lattice without importing
 * route-posterior (which imports this file). Re-exported from route-posterior.
 */
export const TERMINAL_OUTCOMES = [
  'VERIFIED_SUCCESS',
  'NOT_VERIFIED_WITHIN_WINDOW',
  'CENSORED',
] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * Monotone upgrade lattice (D9, frozen). An amendment may only move a route
 * TOWARD a decided signal, never away from one:
 *
 *   CENSORED                   -> VERIFIED_SUCCESS
 *   CENSORED                   -> NOT_VERIFIED_WITHIN_WINDOW
 *   NOT_VERIFIED_WITHIN_WINDOW -> VERIFIED_SUCCESS
 *
 * Never FROM `VERIFIED_SUCCESS` (a verified review cannot be un-verified by a
 * later sync) and never INTO `CENSORED` (censoring is the fail-closed floor, so
 * re-censoring would let a sync erase a real observation). Same-outcome
 * "amendments" carry no information and are absent by construction.
 */
export const AMEND_LATTICE: ReadonlyMap<TerminalOutcome, ReadonlySet<TerminalOutcome>> = new Map([
  ['CENSORED', new Set<TerminalOutcome>(['VERIFIED_SUCCESS', 'NOT_VERIFIED_WITHIN_WINDOW'])],
  ['NOT_VERIFIED_WITHIN_WINDOW', new Set<TerminalOutcome>(['VERIFIED_SUCCESS'])],
  ['VERIFIED_SUCCESS', new Set<TerminalOutcome>()],
]);

/**
 * Why a superseding amendment was written (D9, closed vocabulary). Distinct
 * from the terminal `reason_code`, which keeps describing the OUTCOME; this
 * describes the CORRECTION.
 *
 * Lives here — the shared identity module — for the same reason
 * `MAX_RETRY_EPOCHS` does (D4): the append gate and the builder must agree on
 * one list without an import cycle, since route-posterior imports this file
 * and not the other way round. Re-exported from route-posterior for callers.
 */
export const AMEND_REASON_CODES = [
  'LATE_SIGNAL_IN_WINDOW',
  'CENSOR_LIFTED_REOPENED',
  'OPERATOR_CORRECTION',
] as const;
export type AmendReasonCode = (typeof AMEND_REASON_CODES)[number];

/**
 * Amendment id for a superseding `outcome.finalized` (D9, formula frozen).
 * `computeFinalId` is the implicit seq 0 and stays byte-identical, so every
 * pre-D9 log keeps resolving. seq ≥ 1 namespaces the correction, which is
 * what makes an amendment a NEW append rather than an impossible rewrite of
 * the frozen original (`appendOutcomeEvent` rejects same-id/different-payload).
 */
export const computeFinalAmendId = (routeId: string, seq: number): string => {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new OutcomeLogError('INVALID_EVENT', 'amend_seq must be an integer >= 1');
  }
  return sha256(`pr-review-outcome-v1\0${routeId}\0amend\0${String(seq)}`);
};

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

/**
 * Append-side timestamp authority (D10). Field-path-only error text.
 * Must NOT be called from the read path — pre-freeze second-precision
 * bytes on disk must remain parseable.
 */
const assertCanonicalUtc = (value: unknown, fieldPath: string): void => {
  if (
    typeof value !== 'string' ||
    !CANONICAL_UTC_RE.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new OutcomeLogError('INVALID_EVENT', fieldPath);
  }
};

/**
 * Append-side amendment gate (D9). Field-path-only error text.
 *
 * The fold treats a malformed `amend_seq` as the original (seq 0) so it stays
 * total over arbitrary bytes; this gate is the other half — it stops a buggy
 * writer from ever putting such bytes there, where they would silently become
 * an un-supersedable event.
 *
 * The gate is TWO-DIRECTIONAL, and the second direction is the one that
 * matters most. Guarding only "amendment fields present ⇒ shape must be valid"
 * leaves the mirror hole open: an `outcome.finalized` carrying a
 * seq-namespaced `event_id` but NO amendment fields would append cleanly and
 * permanently squat the seq-n id. The genuine amendment then dies on
 * `DUPLICATE_ID_CONFLICT` and that route can never be corrected again — the
 * exact loss this whole finding exists to prevent. So an id in the amendment
 * namespace is itself a trigger, not just the fields.
 *
 * Pre-D9 events are unaffected in both directions: they carry no amendment
 * fields AND their `computeFinalId` is outside the amendment id namespace.
 */
const assertAmendmentShape = (
  event: OutcomeEvent,
  priorEvents: ReadonlyArray<OutcomeEvent>,
): void => {
  const seq = event['amend_seq'];
  const amends = event['amends'];
  const amendReason = event['amend_reason_code'];
  const declaresAmendment = seq !== undefined || amends !== undefined || amendReason !== undefined;

  // Direction 2: does this id sit in the amendment namespace regardless?
  let claimedSeq: number | null = null;
  for (let s = 1; s <= MAX_AMEND_SEQ; s += 1) {
    if (event.event_id === computeFinalAmendId(event.route_id, s)) {
      claimedSeq = s;
      break;
    }
  }
  if (!declaresAmendment) {
    if (claimedSeq === null) {
      // A NON-amendment final must carry the derivable seq-0 id. Without this
      // the effective-final rule is only deterministic, not safe: a second
      // seq-0 final for the same route with an arbitrary 64-hex id appends
      // cleanly, and if that id sorts below the real one it WINS the tie-break
      // and shadows the route's true verdict. computeFinalId is derivable, so
      // any other id is a caller bug. Inert for every builder-made event.
      if (event.event_id !== computeFinalId(event.route_id)) {
        throw new OutcomeLogError('INVALID_EVENT', 'event_id');
      }
      return;
    }
    // An id in the amendment namespace with no amendment fields would burn
    // that seq slot forever. Name the field that is missing, not the value.
    throw new OutcomeLogError('INVALID_EVENT', 'amend_seq');
  }

  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || seq > MAX_AMEND_SEQ) {
    throw new OutcomeLogError('INVALID_EVENT', 'amend_seq');
  }
  if (typeof amendReason !== 'string' || !AMEND_REASON_CODES.includes(amendReason as never)) {
    // The vocabulary is closed on the DURABLE artifact, not only in the
    // builder: the log outlives the process that wrote it.
    throw new OutcomeLogError('INVALID_EVENT', 'amend_reason_code');
  }
  // The id must be the seq-namespaced one, else the amendment would collide
  // with the original and be rejected as a conflict for the wrong reason.
  if (claimedSeq !== seq) {
    throw new OutcomeLogError('INVALID_EVENT', 'event_id');
  }
  // `amends` is fully derivable — seq 1 supersedes the original, seq n the
  // seq n-1 amendment of the SAME route. A well-formed but wrong pointer
  // (another route's final) is a caller bug, exactly as with
  // supersedes_route_id in D4, and it would otherwise be durable forever.
  const expectedAmends =
    seq === 1 ? computeFinalId(event.route_id) : computeFinalAmendId(event.route_id, seq - 1);
  if (typeof amends !== 'string' || amends !== expectedAmends) {
    throw new OutcomeLogError('INVALID_EVENT', 'amends');
  }

  // Lattice on the DURABLE artifact, not only in the builder. A shape-only
  // gate would let any writer that skips buildOutcomeFinalizedAmendment land a
  // forbidden transition — un-verifying a verified review, or re-censoring a
  // real observation — permanently, in an append-only log. The superseded
  // event is right here in `priorEvents`, so the real prior outcome is known
  // and does not have to be taken on the caller's word.
  const superseded = priorEvents.find((e) => e.event_id === amends);
  if (superseded === undefined) {
    // A dangling pointer would make this amendment the effective final for a
    // route that never had one.
    throw new OutcomeLogError('INVALID_EVENT', 'amends');
  }
  const priorOutcome = superseded['outcome'];
  const nextOutcome = event['outcome'];
  const allowed = AMEND_LATTICE.get(priorOutcome as TerminalOutcome);
  if (allowed === undefined || !allowed.has(nextOutcome as TerminalOutcome)) {
    throw new OutcomeLogError('INVALID_EVENT', 'outcome');
  }
};

const assertAppendTimestampRules = (
  event: OutcomeEvent,
  priorEvents: ReadonlyArray<OutcomeEvent>,
): void => {
  assertCanonicalUtc(event.observed_at, 'observed_at');

  if (event.event_type === 'route.decided') {
    assertCanonicalUtc(event['routed_at'], 'routed_at');
    assertCanonicalUtc(event['deadline_at'], 'deadline_at');
    const routedAt = event['routed_at'] as string;
    const deadlineAt = event['deadline_at'] as string;
    if (!(deadlineAt > routedAt)) {
      throw new OutcomeLogError('INVALID_EVENT', 'deadline_at');
    }
    if (event.observed_at !== routedAt) {
      throw new OutcomeLogError('INVALID_EVENT', 'observed_at');
    }
  }

  if (event.event_type === 'github.signal') {
    assertCanonicalUtc(event[GITHUB_SIGNAL_SOURCE_TIMESTAMP_FIELD], 'source_timestamp_at');
  }

  if (event.event_type === 'outcome.finalized') {
    const verifiedAt = event['verified_at'];
    if (verifiedAt !== null && verifiedAt !== undefined) {
      assertCanonicalUtc(verifiedAt, 'verified_at');
      if (event['outcome'] !== 'VERIFIED_SUCCESS') {
        throw new OutcomeLogError('INVALID_EVENT', 'verified_at');
      }
    }
  }

  if (ROUTE_BOUND_EVENT_TYPES.has(event.event_type)) {
    const decided = priorEvents.find(
      (e) => e.event_type === 'route.decided' && e.route_id === event.route_id,
    );
    if (decided !== undefined && !(event.observed_at >= decided.observed_at)) {
      throw new OutcomeLogError('INVALID_EVENT', 'observed_at');
    }
  }
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
    // D10 append-side clock gate: after dedupe so a pre-freeze payload that
    // is already on disk can still idempotent-noop without re-validation.
    assertAppendTimestampRules(event, existing.events);
    // D9 amendment gate — a sibling of the clock gate, not part of it. Same
    // after-dedupe placement, and deliberately called from here rather than
    // from inside assertAppendTimestampRules, whose name promises timestamps.
    if (event.event_type === 'outcome.finalized') {
      assertAmendmentShape(event, existing.events);
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
