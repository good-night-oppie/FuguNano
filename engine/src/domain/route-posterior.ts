import type { CandidateIdentity } from './candidate-identity.js';
import { computeDispatchTerminalId } from './dispatch-machine.js';
import {
  AMEND_LATTICE,
  AMEND_REASON_CODES,
  CANONICAL_UTC_RE,
  computeAttemptId,
  computeFinalAmendId,
  computeFinalId,
  computeRouteId,
  computeTaskId,
  MAX_AMEND_SEQ,
  MAX_RETRY_EPOCHS,
  OutcomeLogError,
  OUTCOME_LOG_FORMAT,
  TERMINAL_OUTCOMES,
  type AmendReasonCode,
  type OutcomeEvent,
  type TerminalOutcome,
} from './outcome-log.js';
import { parseRouteSeed, type PosteriorEntry } from './beta-sampler.js';

/**
 * Phase-aware routing plumbing for the AgentDex PR-review slice
 * (frozen baseline 2026-07-23, §B2 learning rules + §C gate isolation).
 *
 * The posterior is never stored: it is re-folded from the unique
 * `outcome.finalized` events of the single append-only log every time a
 * routing decision needs it. With content-derived event ids upstream there is
 * no mutable counter anywhere, so a retried sync cannot double-count — the
 * live gate's "duplicate effect = 0" criterion is structural, not procedural.
 *
 * Learning rules (frozen):
 *   VERIFIED_SUCCESS             → alpha += 1
 *   NOT_VERIFIED_WITHIN_WINDOW   → beta  += 1
 *   anything else                → no update
 * Isolation rules (frozen):
 *   - only routes decided under policy_arm="thompson" may update anything;
 *     the fixed-order arm's outcomes are measurement, never training data;
 *   - the update lands on the candidate that ACTUALLY executed (fallback
 *     rule); a selected-but-never-started candidate learns nothing;
 *   - a final event whose route.decided is missing from the log is
 *     unattributable and learns nothing.
 */

export const POLICY_ARMS = ['static', 'thompson'] as const;
export type PolicyArm = (typeof POLICY_ARMS)[number];

export { TERMINAL_OUTCOMES, type TerminalOutcome };

/**
 * D10 clock-skew gate for the (unbuilt) outcome-sync finalizer: a
 * route-bound `github.signal` whose `source_timestamp_at` is earlier than
 * `routed_at − 300s` ⇒ disposition CENSORED, reason_code
 * `'CLOCK_SKEW_SUSPECT'`. Fail closed to no-update; timestamps are never
 * "corrected". Named and frozen now; not consumed until the finalizer lands.
 */
export const ROUTED_AT_SKEW_TOLERANCE_SECONDS = 300;

/**
 * Sync-time orphan reconstruction reason codes (D17). Land in the existing
 * free-string `reason_code` field on `outcome.finalized`; both finalize as
 * `outcome: 'CENSORED'`. No new event type — the writer is dead by definition,
 * so ORPHANED can never be a dispatch-time terminal state.
 */
export const ORPHAN_REASON_CODES = ['ORPHANED_EFFECT', 'ORPHANED_SILENT'] as const;
export type OrphanReasonCode = (typeof ORPHAN_REASON_CODES)[number];

/**
 * Cohort tripwire (D17 schema-freeze amendment, operator-ratified 2026-07-28).
 *
 * An orphan-burned slot is NOT replaceable: replacement would systematically
 * evict large-diff PRs (CLI death correlates with task weight) and would mean
 * a 51st admission while the orphan's possibly-real review stays live, making
 * "zero duplicate external effects" unauditable. Instead, ≥3 orphan
 * finalizations invalidate the whole cohort as a machinery failure.
 */
export const MAX_ORPHANS_PER_COHORT = 3;

/**
 * Delivery-related reason codes (D2). Land in the existing free-string
 * `reason_code` field on `outcome.finalized`. Both are reachable only via
 * the (unbuilt) outcome-sync finalizer when `classifyDelivery` does not
 * return DELIVERED and the window expires.
 */
export const NO_DELIVERY_EVIDENCE = 'NO_DELIVERY_EVIDENCE' as const;
export const DELIVERY_UNRESOLVABLE = 'DELIVERY_UNRESOLVABLE' as const;

/**
 * Why a superseding amendment was written (D9, closed vocabulary). Defined in
 * `outcome-log.ts` so the append gate and this builder share one list without
 * an import cycle (the D4 `MAX_RETRY_EPOCHS` precedent); re-exported here
 * because this module is where amendment callers already look.
 */
export { AMEND_REASON_CODES, type AmendReasonCode };

/**
 * Finalizer emission policy (D9). The outcome-sync module is unbuilt; this
 * names and freezes the constant so it cannot be improvised later.
 *
 * A finalizer must NEVER emit `NOT_VERIFIED_WITHIN_WINDOW` before
 * `deadline_at + FINALIZE_GRACE_HOURS`, and then only with COMPLETE coverage
 * of the route's signal sources and a confirmed executor. Transient API or
 * pagination incompleteness emits NOTHING and retries next cycle — an
 * incomplete read is not evidence of absence. `CENSORED` is written only for
 * permanent conditions (head drift, operator abandon, unresolvable
 * disposition); it is the fail-closed floor the amendment lattice can lift.
 */
export const FINALIZE_GRACE_HOURS = 24;

/**
 * Assignment-time cohort parity rule (single source): odd index ⇒ static,
 * even ⇒ thompson. The engine records and cross-checks; it never derives
 * the arm from the index.
 */
export const armForCohortIndex = (index: number): PolicyArm =>
  index % 2 === 1 ? 'static' : 'thompson';

export interface RouteDecidedInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly policyArm: PolicyArm;
  /**
   * Assignment-time admission index of the 50-task cohort (1..50), assigned
   * by the external Python admission layer. null = non-cohort traffic.
   * Parity: odd ⇒ static, even ⇒ thompson (`armForCohortIndex`).
   */
  readonly cohortIndex: number | null;
  readonly candidateId: string;
  readonly rankedCandidates: ReadonlyArray<string>;
  /**
   * REQUIRED (schema-freeze v1): per-candidate implementation digests observed
   * at route time (argv0 realpath + file sha256 + argv sha256). Audit-only in
   * v1 — the fold stays name-keyed; identity policy consumers come later.
   */
  readonly candidateIdentities: ReadonlyArray<CandidateIdentity>;
  readonly seed: string;
  readonly configSha256: string;
  readonly routedAt: string;
  readonly deadlineAt: string;
  /**
   * REQUIRED (schema-freeze v1): computeProfileSha256 of the exact profile
   * the router consumed, plus its bounded facets projection. The profile is
   * built from live GitHub state at route time and is otherwise
   * unrecoverable once head_sha diffs vanish — see task-profile.ts.
   */
  readonly profileSha256: string;
  readonly profileFacets: {
    readonly authorLineage: string;
    readonly languages: ReadonlyArray<string>;
    readonly riskTags: ReadonlyArray<string>;
    readonly changedPathCount: number;
  };
  /**
   * Retry epoch (0..3). Epoch 0 is the first dispatch; each subsequent
   * epoch is a fresh route id after DISPATCH_FAILED or operator abandon.
   */
  readonly retryEpoch: number;
  /**
   * Prior epoch's route_id when retryEpoch ≥ 1; must be null at epoch 0.
   */
  readonly supersedesRouteId: string | null;
  /**
   * Posterior snapshot the Thompson draw consumed (canonical order). Makes
   * the replay tuple self-contained: (seed, posteriors, canonical order)
   * reproduces the draw even if concurrent appends land between this
   * route's fold and its fsync. Omitted for the static arm.
   */
  readonly posteriors?: ReadonlyArray<{
    readonly candidateId: string;
    readonly alpha: number;
    readonly beta: number;
  }>;
}

export interface OutcomeFinalizedInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly outcome: TerminalOutcome;
  readonly reasonCode: string;
  readonly actualExecutor: string | null;
  readonly evidenceEventIds: ReadonlyArray<string>;
  readonly verifiedAt: string | null;
  readonly observedAt: string;
  /**
   * Retry epoch of the route being finalized. Defaults to 0 so legacy
   * callers stay byte-identical; abandon of a crash-window epoch ≥1 must
   * pass the matching epoch so computeFinalId targets that route.
   */
  readonly retryEpoch?: number;
}

const assertNonEmpty = (value: string, name: string): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OutcomeLogError('INVALID_EVENT', `${name} required`);
  }
};

/**
 * Range (1..50) + parity cross-check for an admission-time cohort index.
 * Shared by the no-eligible early return and buildRouteDecided (defence in depth).
 */
export const assertValidCohortIndex = (cohortIndex: number | null, policyArm: PolicyArm): void => {
  if (cohortIndex === null) return;
  if (!Number.isInteger(cohortIndex) || cohortIndex < 1 || cohortIndex > 50) {
    throw new OutcomeLogError('INVALID_EVENT', 'cohort_index must be an integer in 1..50 or null');
  }
  if (armForCohortIndex(cohortIndex) !== policyArm) {
    throw new OutcomeLogError('INVALID_EVENT', 'cohort_index parity does not match policy_arm');
  }
};

/** Build a `route.decided` event; policy arm and replay seed are mandatory. */
export const buildRouteDecided = (input: RouteDecidedInput): OutcomeEvent => {
  if (!POLICY_ARMS.includes(input.policyArm)) {
    throw new OutcomeLogError('INVALID_EVENT', `unknown policy_arm ${String(input.policyArm)}`);
  }
  assertValidCohortIndex(input.cohortIndex, input.policyArm);
  assertNonEmpty(input.candidateId, 'candidateId');
  assertNonEmpty(input.configSha256, 'configSha256');
  assertNonEmpty(input.routedAt, 'routedAt');
  assertNonEmpty(input.deadlineAt, 'deadlineAt');
  if (!/^[0-9a-f]{64}$/u.test(input.profileSha256)) {
    throw new OutcomeLogError('INVALID_EVENT', 'profileSha256 must be 64 lowercase hex chars');
  }
  const facets = input.profileFacets as RouteDecidedInput['profileFacets'] | null | undefined;
  if (facets === null || facets === undefined) {
    throw new OutcomeLogError('INVALID_EVENT', 'profileFacets required');
  }
  assertNonEmpty(facets.authorLineage, 'profileFacets.authorLineage');
  // Validate through unknown aliases: Array.isArray would otherwise narrow
  // the ReadonlyArray<string> fields to any[] at the spread below.
  const languagesUnknown: unknown = facets.languages;
  const riskTagsUnknown: unknown = facets.riskTags;
  if (!Array.isArray(languagesUnknown) || !Array.isArray(riskTagsUnknown)) {
    throw new OutcomeLogError('INVALID_EVENT', 'profileFacets arrays required');
  }
  if (!Number.isInteger(facets.changedPathCount) || facets.changedPathCount < 0) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      'profileFacets.changedPathCount must be a non-negative integer',
    );
  }
  // Validate through an unknown alias: Array.isArray on ReadonlyArray narrows
  // to any[] and trips the eslint layering/any gate.
  const identitiesUnknown: unknown = input.candidateIdentities;
  if (!Array.isArray(identitiesUnknown)) {
    throw new OutcomeLogError('INVALID_EVENT', 'candidateIdentities required');
  }
  const identities = identitiesUnknown as ReadonlyArray<CandidateIdentity>;
  if (
    identities.length !== input.rankedCandidates.length ||
    identities.some((entry, i) => entry.candidateId !== input.rankedCandidates[i])
  ) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      'candidateIdentities must match ranked_candidates 1:1',
    );
  }
  const hex64 = /^[0-9a-f]{64}$/u;
  for (const entry of identities) {
    assertNonEmpty(entry.argv0Realpath, 'argv0Realpath');
    if (!hex64.test(entry.argvSha256)) {
      throw new OutcomeLogError('INVALID_EVENT', 'argvSha256 must be 64 lowercase hex chars');
    }
    if (entry.argv0Sha256 === null) {
      if (typeof entry.argv0DigestError !== 'string' || entry.argv0DigestError.length === 0) {
        throw new OutcomeLogError(
          'INVALID_EVENT',
          'argv0DigestError required when argv0Sha256 is null',
        );
      }
    } else if (!hex64.test(entry.argv0Sha256)) {
      throw new OutcomeLogError(
        'INVALID_EVENT',
        'argv0Sha256 must be 64 lowercase hex chars or null',
      );
    }
  }
  if (
    !Number.isInteger(input.retryEpoch) ||
    input.retryEpoch < 0 ||
    input.retryEpoch > MAX_RETRY_EPOCHS
  ) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      `retryEpoch must be an integer in 0..${String(MAX_RETRY_EPOCHS)}`,
    );
  }
  if (input.retryEpoch === 0) {
    if (input.supersedesRouteId !== null) {
      throw new OutcomeLogError(
        'INVALID_EVENT',
        'supersedesRouteId must be null when retryEpoch is 0',
      );
    }
  } else if (
    typeof input.supersedesRouteId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(input.supersedesRouteId)
  ) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      'supersedesRouteId must be 64 lowercase hex chars when retryEpoch >= 1',
    );
  }
  const taskId = computeTaskId(input.repo, input.prNumber, input.headSha);
  // The prior-epoch route id is fully derivable, so an arbitrary 64-hex
  // value is a caller bug: epoch n supersedes exactly epoch n-1 of the SAME
  // task, never anything else.
  if (
    input.supersedesRouteId !== null &&
    input.supersedesRouteId !== computeRouteId(taskId, input.retryEpoch - 1)
  ) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      'supersedesRouteId must be the prior epoch route id of the same task',
    );
  }
  const routeId = computeRouteId(taskId, input.retryEpoch);
  return {
    format: OUTCOME_LOG_FORMAT,
    event_type: 'route.decided',
    event_id: routeId,
    route_id: routeId,
    observed_at: input.routedAt,
    task_id: taskId,
    repo: input.repo,
    pr_number: input.prNumber,
    head_sha_at_route: input.headSha,
    policy_arm: input.policyArm,
    cohort_index: input.cohortIndex,
    retry_epoch: input.retryEpoch,
    supersedes_route_id: input.supersedesRouteId,
    candidate_id: input.candidateId,
    ranked_candidates: [...input.rankedCandidates],
    candidate_identities: identities.map((entry) => ({
      candidate_id: entry.candidateId,
      argv0_realpath: entry.argv0Realpath,
      argv0_sha256: entry.argv0Sha256,
      argv_sha256: entry.argvSha256,
      ...(entry.argv0DigestError !== undefined
        ? { argv0_digest_error: entry.argv0DigestError }
        : {}),
    })),
    seed: parseRouteSeed(input.seed),
    config_sha256: input.configSha256,
    profile_sha256: input.profileSha256,
    profile_facets: {
      author_lineage: facets.authorLineage,
      languages: [...facets.languages],
      risk_tags: [...facets.riskTags],
      changed_path_count: facets.changedPathCount,
    },
    routed_at: input.routedAt,
    deadline_at: input.deadlineAt,
    ...(input.posteriors !== undefined
      ? {
          posteriors: input.posteriors.map((p) => ({
            candidate_id: p.candidateId,
            alpha: p.alpha,
            beta: p.beta,
          })),
        }
      : {}),
  };
};

/** Build an `outcome.finalized` event; exactly one per route by construction. */
export const buildOutcomeFinalized = (input: OutcomeFinalizedInput): OutcomeEvent => {
  if (!TERMINAL_OUTCOMES.includes(input.outcome)) {
    throw new OutcomeLogError('INVALID_EVENT', `unknown outcome ${String(input.outcome)}`);
  }
  assertNonEmpty(input.reasonCode, 'reasonCode');
  const retryEpoch = input.retryEpoch ?? 0;
  if (!Number.isInteger(retryEpoch) || retryEpoch < 0 || retryEpoch > MAX_RETRY_EPOCHS) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      `retryEpoch must be an integer in 0..${String(MAX_RETRY_EPOCHS)}`,
    );
  }
  const taskId = computeTaskId(input.repo, input.prNumber, input.headSha);
  const routeId = computeRouteId(taskId, retryEpoch);
  return {
    format: OUTCOME_LOG_FORMAT,
    event_type: 'outcome.finalized',
    event_id: computeFinalId(routeId),
    route_id: routeId,
    observed_at: input.observedAt,
    task_id: taskId,
    outcome: input.outcome,
    reason_code: input.reasonCode,
    actual_executor: input.actualExecutor,
    evidence_event_ids: [...input.evidenceEventIds],
    verified_at: input.verifiedAt,
  };
};

export interface OutcomeFinalizedAmendmentInput extends OutcomeFinalizedInput {
  /** Sequence of this correction. v1 freezes the ceiling at MAX_AMEND_SEQ. */
  readonly amendSeq: number;
  /**
   * `event_id` of the event this one supersedes. Fully derivable (seq 1 ⇒ the
   * original's `computeFinalId`), so it is a cross-check, not a free pointer.
   */
  readonly amends: string;
  /** The outcome recorded by the event this one supersedes. */
  readonly priorOutcome: TerminalOutcome;
  /** Why the correction was written (closed vocabulary). */
  readonly amendReasonCode: AmendReasonCode;
  /** `deadline_at` of the route being amended, canonical UTC millis. */
  readonly deadlineAt: string;
  /**
   * Canonical timestamp of the evidence that justifies the upgrade — for a
   * `github.signal` that is its `source_timestamp_at`. Must fall on or before
   * `deadlineAt`: the window is about when the WORK happened, not when the
   * sync noticed it.
   */
  readonly evidenceCanonicalTimestamp: string;
  /**
   * Required `true` for `CENSORED → NOT_VERIFIED_WITHIN_WINDOW`. A negative
   * carries the same complete-coverage burden as an original negative, so it
   * may never be reached by default.
   */
  readonly coverageComplete?: boolean;
}

/**
 * Build a superseding `outcome.finalized` amendment (D9).
 *
 * The frozen four-type event vocabulary does NOT grow: an amendment is an
 * `outcome.finalized` with a different, seq-namespaced `event_id`. Every
 * constraint below is enforced at BUILD time so a malformed correction never
 * reaches the log; the fold stays a pure, clock-free reader.
 *
 * `deadline_at` gets its one principled reader here — at amend-build time
 * only. Reading it in the fold would make the posterior clock-dependent.
 */
export const buildOutcomeFinalizedAmendment = (
  input: OutcomeFinalizedAmendmentInput,
): OutcomeEvent => {
  if (!TERMINAL_OUTCOMES.includes(input.priorOutcome)) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      `unknown priorOutcome ${String(input.priorOutcome)}`,
    );
  }
  if (!AMEND_REASON_CODES.includes(input.amendReasonCode)) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      `unknown amendReasonCode ${String(input.amendReasonCode)}`,
    );
  }
  if (!Number.isInteger(input.amendSeq) || input.amendSeq < 1 || input.amendSeq > MAX_AMEND_SEQ) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      `amendSeq must be an integer in 1..${String(MAX_AMEND_SEQ)}`,
    );
  }

  // Base payload first: it re-runs every original-finalized invariant
  // (outcome vocabulary, reasonCode, retryEpoch range) and derives route_id,
  // so the amendment can never disagree with the shape the fold reads.
  const base = buildOutcomeFinalized(input);
  const routeId = base.route_id;

  const allowed = AMEND_LATTICE.get(input.priorOutcome);
  if (allowed === undefined || !allowed.has(input.outcome)) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      `outcome: ${input.priorOutcome} -> ${input.outcome} is not a monotone upgrade`,
    );
  }
  if (input.outcome === 'NOT_VERIFIED_WITHIN_WINDOW' && input.coverageComplete !== true) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      'coverageComplete required for a negative amendment',
    );
  }

  // String comparison is only sound on identical canonical forms, so pin both
  // to the D10 canonical-millis shape rather than assuming it. The regex alone
  // is NOT canonicality: '2026-13-45T99:99:99.999Z' matches it and parses to
  // NaN, and it sorts before every real date — so it would slip through the
  // window check as "in window". D10's own gate pairs the regex with
  // Date.parse for exactly this reason; mirror it.
  const canonical = (value: string): boolean =>
    CANONICAL_UTC_RE.test(value) && Number.isFinite(Date.parse(value));
  if (!canonical(input.deadlineAt)) {
    throw new OutcomeLogError('INVALID_EVENT', 'deadlineAt');
  }
  if (!canonical(input.evidenceCanonicalTimestamp)) {
    throw new OutcomeLogError('INVALID_EVENT', 'evidenceCanonicalTimestamp');
  }
  if (input.evidenceCanonicalTimestamp > input.deadlineAt) {
    throw new OutcomeLogError('INVALID_EVENT', 'evidenceCanonicalTimestamp');
  }

  // The superseded id is fully derivable: seq n supersedes seq n-1 of the SAME
  // route, and seq 1 supersedes the original (implicit seq 0). An arbitrary
  // 64-hex `amends` is a caller bug, exactly as with supersedes_route_id (D4).
  const expectedAmends =
    input.amendSeq === 1
      ? computeFinalId(routeId)
      : computeFinalAmendId(routeId, input.amendSeq - 1);
  if (input.amends !== expectedAmends) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      'amends must be the superseded event id of the same route',
    );
  }

  return {
    ...base,
    event_id: computeFinalAmendId(routeId, input.amendSeq),
    amend_seq: input.amendSeq,
    amends: input.amends,
    amend_reason_code: input.amendReasonCode,
  };
};

export interface FoldDiagnostics {
  /** Updates applied to the posterior. */
  readonly applied: number;
  /** Blocked: route ran under the fixed-order arm. */
  readonly blockedStaticArm: number;
  /** Blocked: no attributable executor, or no matching route.decided. */
  readonly blockedUnattributable: number;
  /** Blocked: outcome carries no learning signal (e.g. CENSORED). */
  readonly blockedNoSignal: number;
  /**
   * Finalized events that lost the per-route effective-final resolution (D9).
   * Every distinct `outcome.finalized` lands in exactly one of the five
   * counters, so `applied + blockedStaticArm + blockedUnattributable +
   * blockedNoSignal + superseded` is the distinct finalized-event total.
   * The live gate asserts `superseded === 0` — amendments during the cohort
   * are a machinery event, not routine.
   */
  readonly superseded: number;
}

export interface FoldResult {
  readonly posteriors: ReadonlyArray<PosteriorEntry>;
  readonly diagnostics: FoldDiagnostics;
}

/**
 * `amend_seq` as the fold sees it. This is a READER over bytes already on
 * disk, so it never throws: the builder is the authority that a stored
 * `amend_seq` is a valid integer ≥ 1, and anything else (absent, malformed,
 * pre-D9) is the original, i.e. seq 0.
 */
const readAmendSeq = (event: OutcomeEvent): number => {
  const raw = event['amend_seq'];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 0;
};

/**
 * The one `outcome.finalized` a route learns from: highest `amend_seq` wins.
 *
 * The tie-break is load-bearing rather than cosmetic. Two finalized events
 * with the SAME seq for one route cannot be produced by the builders — the id
 * is content-derived per seq, so a second write is a `DUPLICATE_ID_CONFLICT`
 * at append — but the fold must still be total and order-independent over
 * whatever bytes it is handed. Lowest `event_id` is an intrinsic, stable
 * property of the events themselves, so the winner does not depend on the
 * order they were read in.
 */
const effectiveFinal = (group: ReadonlyArray<OutcomeEvent>): OutcomeEvent => {
  let winner = group[0]!;
  let winnerSeq = readAmendSeq(winner);
  for (let i = 1; i < group.length; i += 1) {
    const candidate = group[i]!;
    const seq = readAmendSeq(candidate);
    if (seq > winnerSeq || (seq === winnerSeq && candidate.event_id < winner.event_id)) {
      winner = candidate;
      winnerSeq = seq;
    }
  }
  return winner;
};

/**
 * Group the DISTINCT `outcome.finalized` events by route. Shared so every
 * consumer of the effective-final rule resolves it identically — the rule is
 * frozen once, not re-implemented per call site.
 */
const groupFinalsByRoute = (events: ReadonlyArray<OutcomeEvent>): Map<string, OutcomeEvent[]> => {
  const byRoute = new Map<string, OutcomeEvent[]>();
  const seen = new Set<string>();
  for (const event of events) {
    if (event.event_type !== 'outcome.finalized') continue;
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    const group = byRoute.get(event.route_id);
    if (group === undefined) byRoute.set(event.route_id, [event]);
    else group.push(event);
  }
  return byRoute;
};

/**
 * The single `outcome.finalized` that speaks for a route, or `undefined` if
 * the route has none.
 *
 * EVERY reader that asks "how did this route end?" must go through here, not
 * scan finalized rows. Before D9 the two were equivalent — one final per route
 * by construction — so pre-existing readers scanned rows safely. Amendments
 * break that equivalence, and a row-scanning reader then sees a SUPERSEDED
 * verdict as if it still stood. Two merged units had exactly that bug latent
 * the moment amendments existed: D4's abandon-unlock (which would re-dispatch
 * a PR whose abandon had been lifted — a duplicate review on a live PR) and
 * D17's orphan tripwire (which would invalidate a cohort whose orphans had all
 * been corrected). Both now call this.
 */
export const effectiveFinalForRoute = (
  events: ReadonlyArray<OutcomeEvent>,
  routeId: string,
): OutcomeEvent | undefined => {
  const group = groupFinalsByRoute(events).get(routeId);
  return group === undefined ? undefined : effectiveFinal(group);
};

/**
 * Re-fold candidate posteriors from the event stream. `candidateIds` fixes
 * the universe (and output order — callers pass the frozen canonical order);
 * every candidate starts at the Beta(1,1) prior. Events are deduplicated by
 * event_id defensively even though the store already enforces uniqueness.
 */
export const foldPosteriors = (
  events: ReadonlyArray<OutcomeEvent>,
  candidateIds: ReadonlyArray<string>,
): FoldResult => {
  const armByRoute = new Map<string, PolicyArm>();
  for (const event of events) {
    if (event.event_type === 'route.decided') {
      const arm = event['policy_arm'];
      if (arm === 'static' || arm === 'thompson') armByRoute.set(event.route_id, arm);
    }
  }

  const counts = new Map<string, { alpha: number; beta: number }>(
    candidateIds.map((id) => [id, { alpha: 1, beta: 1 }]),
  );

  let applied = 0;
  let blockedStaticArm = 0;
  let blockedUnattributable = 0;
  let blockedNoSignal = 0;
  let superseded = 0;

  // Effective-final resolution (D9): learn from ONE final per route, so a
  // superseding amendment corrects the posterior instead of double-counting
  // against the original.
  for (const group of groupFinalsByRoute(events).values()) {
    superseded += group.length - 1;
    const event = effectiveFinal(group);

    const outcome = event['outcome'];
    const learns = outcome === 'VERIFIED_SUCCESS' || outcome === 'NOT_VERIFIED_WITHIN_WINDOW';
    if (!learns) {
      blockedNoSignal += 1;
      continue;
    }

    const arm = armByRoute.get(event.route_id);
    if (arm === undefined) {
      blockedUnattributable += 1;
      continue;
    }
    if (arm !== 'thompson') {
      blockedStaticArm += 1;
      continue;
    }

    const executor = event['actual_executor'];
    const bucket = typeof executor === 'string' ? counts.get(executor) : undefined;
    if (!bucket) {
      blockedUnattributable += 1;
      continue;
    }

    if (outcome === 'VERIFIED_SUCCESS') bucket.alpha += 1;
    else bucket.beta += 1;
    applied += 1;
  }

  return {
    posteriors: candidateIds.map((id) => {
      const c = counts.get(id)!;
      return { candidateId: id, alpha: c.alpha, beta: c.beta };
    }),
    diagnostics: { applied, blockedStaticArm, blockedUnattributable, blockedNoSignal, superseded },
  };
};

/**
 * Sync-time orphan classification (D17). Pure — the sync module itself stays
 * unbuilt. Never classifies before `deadlineAt`: the orphan child has no
 * timeout enforcement and may post its review days later; early finalization
 * forks the truth.
 *
 * Determinism (load-bearing): an orphan finalization stamps
 * `observed_at := deadlineAt` (NOT sync wall-clock), `verified_at := null`,
 * and `evidence_event_ids` as the route-bound `github.signal` event ids
 * sorted — so a retried sync hits the duplicate-noop lane.
 */
export type OrphanClassification =
  | { readonly kind: 'pending' }
  | { readonly kind: 'not_orphan' }
  | {
      readonly kind: 'orphan';
      readonly reasonCode: OrphanReasonCode;
      readonly actualExecutor: string | null;
      readonly evidenceEventIds: ReadonlyArray<string>;
      /** Always equal to `deadlineAt` — never sync wall-clock. */
      readonly observedAt: string;
    };

export const classifyOrphan = (
  routeId: string,
  events: ReadonlyArray<OutcomeEvent>,
  deadlineAt: string,
  nowIso: string,
): OrphanClassification => {
  const decided = events.find((e) => e.event_type === 'route.decided' && e.route_id === routeId);
  if (decided === undefined) return { kind: 'not_orphan' };

  const terminalId = computeDispatchTerminalId(routeId);
  if (events.some((e) => e.event_id === terminalId)) return { kind: 'not_orphan' };

  const nowMs = Date.parse(nowIso);
  const deadlineMs = Date.parse(deadlineAt);
  if (Number.isNaN(nowMs) || Number.isNaN(deadlineMs) || nowMs < deadlineMs) {
    return { kind: 'pending' };
  }

  const signals = events.filter((e) => e.event_type === 'github.signal' && e.route_id === routeId);
  if (signals.length === 0) {
    return {
      kind: 'orphan',
      reasonCode: 'ORPHANED_SILENT',
      actualExecutor: null,
      evidenceEventIds: [],
      observedAt: deadlineAt,
    };
  }

  const rankedUnknown: unknown = decided['ranked_candidates'];
  const ranked: ReadonlyArray<string> = Array.isArray(rankedUnknown)
    ? (rankedUnknown as ReadonlyArray<string>)
    : [];

  const matched = new Set<string>();
  for (const signal of signals) {
    const attemptId = signal['attempt_id'];
    if (typeof attemptId !== 'string') continue;
    for (const candidate of ranked) {
      if (computeAttemptId(routeId, candidate) === attemptId) matched.add(candidate);
    }
  }
  const actualExecutor = matched.size === 1 ? [...matched][0]! : null;
  const evidenceEventIds = [...signals.map((s) => s.event_id)].sort();

  return {
    kind: 'orphan',
    reasonCode: 'ORPHANED_EFFECT',
    actualExecutor,
    evidenceEventIds,
    observedAt: deadlineAt,
  };
};

/**
 * Count ROUTES whose EFFECTIVE final carries an orphan `reason_code`.
 * Non-orphan CENSORED finals (HEAD_DRIFT, operator_abandoned, …) do not count.
 * One log = one cohort; the tripwire is cohort-scoped.
 *
 * Routes, not rows (D9). Counting rows would count a superseded orphan
 * alongside the amendment that corrected it, so three orphans that were all
 * later resolved would invalidate an otherwise healthy cohort — discarding 50
 * tasks of real measurement over a failure that no longer exists.
 */
export const countOrphanFinalizations = (events: ReadonlyArray<OutcomeEvent>): number => {
  let n = 0;
  for (const group of groupFinalsByRoute(events).values()) {
    const code = effectiveFinal(group)['reason_code'];
    if (code === 'ORPHANED_EFFECT' || code === 'ORPHANED_SILENT') n += 1;
  }
  return n;
};

/** `true` when orphan finalizations in the log reach `MAX_ORPHANS_PER_COHORT`. */
export const isCohortInvalidatedByOrphans = (events: ReadonlyArray<OutcomeEvent>): boolean =>
  countOrphanFinalizations(events) >= MAX_ORPHANS_PER_COHORT;
