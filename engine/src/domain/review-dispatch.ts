import { newRouteSeed } from './beta-sampler.js';
import { computeCandidateIdentities } from './candidate-identity.js';
import {
  DISPATCH_EXIT_CODES,
  dispatchReview,
  NO_ELIGIBLE_AGENT_MESSAGE,
  type DispatchState,
} from './dispatch-machine.js';
import { eligibleReviewers, rankReviewers } from './eligible-reviewers.js';
import {
  appendOutcomeEvent,
  assertNoSecretMaterial,
  computeAttemptId,
  computeRouteId,
  computeTaskId,
  MAX_RETRY_EPOCHS,
  OutcomeLogError,
  readOutcomeLog,
  resolveOutcomeLogPath,
  type OutcomeEvent,
} from './outcome-log.js';
import {
  buildOutcomeFinalized,
  buildRouteDecided,
  effectiveFinalForRoute,
  POLICY_ARMS,
  assertValidCohortIndex,
  type PolicyArm,
} from './route-posterior.js';
import { loadRoutingConfig } from './routing-config.js';
import {
  assertLiteralLoopbackOnly,
  computeProfileSha256,
  parseTaskProfile,
  profileFacets,
  type TaskProfile,
} from './task-profile.js';

/**
 * R2.4 wiring for the AgentDex PR-review slice (frozen baseline 2026-07-23,
 * §B1 hot path + §D seam): compose profile → config → filter → rank →
 * route.decided → spawn-boundary dispatch into ONE machine-JSON answer.
 *
 * This is the module behind `fuguectl dispatch --auto`: task JSON arrives on
 * stdin, exactly one JSON object leaves on stdout, and the exit code carries
 * the frozen taxonomy. Python (the AgentDex façade) parses the machine JSON
 * and displays it — it never re-routes, never retries, never writes state.
 *
 * Boundary rules enforced here, not merely documented:
 * - literal-loopback: any local endpoint in the config must be spelled
 *   `127.0.0.1` / `::1` (task-profile guard, INVALID_INPUT);
 * - secret scan: outbound machine JSON passes the same credential-shape
 *   tripwire as stored events — a candidate cannot smuggle a token through
 *   `result_ref` into the caller's terminal or logs (STATE_ERROR, and the
 *   tainted object is never printed);
 * - error text names types and field paths only, never raw input bytes.
 */

/** §B6: natural-outcome window, hours. deadline_at = routed_at + this. */
export const OUTCOME_WINDOW_HOURS = 168;

export const MACHINE_FORMAT = 1;

/**
 * Inclusive ceiling on retry_epoch (0..MAX). Epoch 4 is never created.
 * Canonical value lives in outcome-log.ts (shared identity module);
 * re-exported here for the existing public surface.
 */
export { MAX_RETRY_EPOCHS } from './outcome-log.js';

export type MachineStatus =
  | 'completed'
  | 'no_eligible_agent'
  | 'dispatch_failed'
  | 'effect_unknown'
  | 'invalid_input'
  | 'state_error'
  | 'duplicate_route';

const STATUS_BY_STATE: Record<DispatchState, MachineStatus> = {
  COMPLETED: 'completed',
  NO_ELIGIBLE_AGENT: 'no_eligible_agent',
  DISPATCH_FAILED: 'dispatch_failed',
  EFFECT_UNKNOWN: 'effect_unknown',
};

export type PriorTerminalState = 'COMPLETED' | 'EFFECT_UNKNOWN' | 'DISPATCH_FAILED' | null;

export interface ReviewDispatchDeps {
  readonly env: Record<string, string | undefined>;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
  /** Fixed route seed (tests/replay); production uses a fresh OS-random seed. */
  readonly seed?: string;
}

export interface ReviewDispatchOutcome {
  /** The one JSON object the CLI prints on stdout. */
  readonly machine: Record<string, unknown>;
  readonly exitCode: number;
}

const attemptMarker = (routeId: string, attemptId: string): string =>
  `<!-- agentdex:route=${routeId};attempt=${attemptId} -->`;

/** Per-candidate stdin payload (§B6: carries the per-attempt marker). */
const candidateTaskJson = (
  profile: TaskProfile,
  routeId: string,
  candidateName: string,
): string => {
  const attemptId = computeAttemptId(routeId, candidateName);
  return JSON.stringify({
    format: MACHINE_FORMAT,
    task_type: 'pr-review',
    route_id: routeId,
    attempt_id: attemptId,
    marker: attemptMarker(routeId, attemptId),
    profile: {
      repo: profile.repo,
      pr: profile.pr,
      head_sha: profile.headSha,
      author_lineage: profile.authorLineage,
      languages: profile.languages,
      changed_paths: profile.changedPaths,
      risk_tags: profile.riskTags,
    },
  });
};

/** Outbound guard: the machine JSON meets the same bar as stored events. */
const sealed = (machine: Record<string, unknown>, exitCode: number): ReviewDispatchOutcome => {
  assertNoSecretMaterial(machine, 'machine');
  return { machine, exitCode };
};

/**
 * Error envelope. Unlike sealed() this can NEVER throw: if the reason itself
 * trips the credential tripwire (e.g. a config path that happens to look like
 * a key reached an error message), the reason is replaced wholesale — a
 * failure inside the failure path must still produce one clean JSON object
 * and the frozen exit code, never a stack trace on stderr.
 */
const errorOutcome = (
  status: MachineStatus,
  exitCode: number,
  reason: string,
): ReviewDispatchOutcome => {
  let safeReason = reason;
  try {
    assertNoSecretMaterial(reason, 'reason');
  } catch {
    safeReason = 'error detail withheld: it matched a credential shape and is not echoed by design';
  }
  return { machine: { format: MACHINE_FORMAT, status, reason: safeReason }, exitCode };
};

/**
 * Parse the optional `--cohort-index` CLI string. undefined (flag genuinely
 * absent) → null (non-cohort). Empty string is a scripting slip (`--cohort-index
 * ""` / expanded empty var) and MUST fail closed — never silently dispatch as
 * non-cohort traffic. Range/parity checks live in assertValidCohortIndex.
 */
const parseCohortIndexRaw = (cohortIndexRaw: string | undefined): number | null => {
  if (cohortIndexRaw === undefined) return null;
  const trimmed = cohortIndexRaw.trim();
  if (!/^(0|[1-9][0-9]*)$/u.test(trimmed)) {
    throw new OutcomeLogError('INVALID_EVENT', 'cohort_index must be a decimal integer');
  }
  return Number(trimmed);
};

const readPriorTerminalState = (
  events: ReadonlyArray<OutcomeEvent>,
  routeId: string,
): PriorTerminalState => {
  for (const event of events) {
    if (event.event_type !== 'dispatch.terminal' || event.route_id !== routeId) continue;
    const state = event['terminal_state'];
    if (state === 'COMPLETED' || state === 'EFFECT_UNKNOWN' || state === 'DISPATCH_FAILED') {
      return state;
    }
  }
  return null;
};

const isEpochRetryable = (events: ReadonlyArray<OutcomeEvent>, routeId: string): boolean => {
  // Frozen invariant (§D4): BOTH unlock lanes exclude any terminal that is
  // not DISPATCH_FAILED. A COMPLETED/EFFECT_UNKNOWN terminal is structurally
  // final even when an operator_abandoned finalized ALSO exists for the same
  // route — the abandon/completion race must never open a new epoch after
  // the candidate provably (or possibly) ran. A duplicate review on a real
  // PR is worse than a missing one.
  const terminal = readPriorTerminalState(events, routeId);
  if (terminal === 'COMPLETED' || terminal === 'EFFECT_UNKNOWN') return false;
  if (terminal === 'DISPATCH_FAILED') return true;
  // Effective final, NOT a row scan (D9). A superseding amendment can lift an
  // operator_abandoned CENSORED to VERIFIED_SUCCESS — that is the canonical
  // amendment case, an abandon whose review turns out to have landed. Scanning
  // rows would still find the superseded abandon and open a fresh epoch,
  // re-dispatching a review onto a PR that already has one. A duplicate review
  // on a real PR is worse than a missing one, so the lifted verdict wins.
  const finalized = effectiveFinalForRoute(events, routeId);
  return (
    finalized !== undefined &&
    finalized['outcome'] === 'CENSORED' &&
    finalized['reason_code'] === 'operator_abandoned'
  );
};

const duplicateRouteReason = (prior: PriorTerminalState, capReached: boolean): string => {
  if (capReached) return 'retry epoch cap reached; refusing to re-dispatch';
  if (prior === 'COMPLETED') return 'route already completed; refusing to re-dispatch';
  if (prior === 'EFFECT_UNKNOWN') {
    return 'route terminated with unknown effect; refusing to re-dispatch';
  }
  if (prior === 'DISPATCH_FAILED') return 'retry epoch cap reached; refusing to re-dispatch';
  return 'route decided without a terminal receipt; refusing to re-dispatch';
};

export type RetryDispatchDecision =
  | {
      readonly kind: 'dispatch';
      readonly retryEpoch: number;
      readonly supersedesRouteId: string | null;
      readonly routeId: string;
    }
  | {
      readonly kind: 'duplicate_route';
      readonly retryEpoch: number;
      readonly routeId: string;
      readonly priorTerminalState: PriorTerminalState;
      readonly reason: string;
    };

/**
 * Pure pre-append retry gate over the events already read. Decides whether
 * this task may open a (possibly new) epoch, or must seal duplicate_route.
 */
export const resolveRetryDispatch = (
  events: ReadonlyArray<OutcomeEvent>,
  taskId: string,
): RetryDispatchDecision => {
  const highest = findHighestRouteEpoch(events, taskId);
  if (highest === null) {
    return {
      kind: 'dispatch',
      retryEpoch: 0,
      supersedesRouteId: null,
      routeId: computeRouteId(taskId, 0),
    };
  }
  const priorRouteId = computeRouteId(taskId, highest);
  const priorTerminalState = readPriorTerminalState(events, priorRouteId);
  const retryable = isEpochRetryable(events, priorRouteId);
  const nextEpoch = highest + 1;
  if (retryable && nextEpoch <= MAX_RETRY_EPOCHS) {
    return {
      kind: 'dispatch',
      retryEpoch: nextEpoch,
      supersedesRouteId: priorRouteId,
      routeId: computeRouteId(taskId, nextEpoch),
    };
  }
  return {
    kind: 'duplicate_route',
    retryEpoch: highest,
    routeId: priorRouteId,
    priorTerminalState,
    reason: duplicateRouteReason(priorTerminalState, retryable && nextEpoch > MAX_RETRY_EPOCHS),
  };
};

/** Highest epoch with a route.decided for this task, or null if none. */
export const findHighestRouteEpoch = (
  events: ReadonlyArray<OutcomeEvent>,
  taskId: string,
): number | null => {
  let highest: number | null = null;
  for (let epoch = 0; epoch <= MAX_RETRY_EPOCHS; epoch += 1) {
    const candidateRouteId = computeRouteId(taskId, epoch);
    if (
      events.some(
        (event) => event.event_type === 'route.decided' && event.route_id === candidateRouteId,
      )
    ) {
      highest = epoch;
    }
  }
  return highest;
};

const duplicateRouteOutcome = (
  taskId: string,
  decision: Extract<RetryDispatchDecision, { kind: 'duplicate_route' }>,
): ReviewDispatchOutcome =>
  sealed(
    {
      format: MACHINE_FORMAT,
      status: 'duplicate_route',
      task_id: taskId,
      route_id: decision.routeId,
      retry_epoch: decision.retryEpoch,
      prior_terminal_state: decision.priorTerminalState,
      retryable: false,
      reason: decision.reason,
    },
    DISPATCH_EXIT_CODES.STATE_ERROR,
  );

/**
 * Operator abandon: seal a crash-window route (route.decided, no terminal)
 * with CENSORED/operator_abandoned so a later dispatch may open epoch E+1.
 * Identity is repo+pr+head_sha only — never a raw route id.
 */
export const abandonReviewRoute = (
  identity: { readonly repo: string; readonly pr: number; readonly headSha: string },
  deps: ReviewDispatchDeps,
): ReviewDispatchOutcome => {
  const now = deps.now ?? ((): Date => new Date());
  try {
    const logPath = resolveOutcomeLogPath(deps.env);
    const { events } = readOutcomeLog(logPath);
    const taskId = computeTaskId(identity.repo, identity.pr, identity.headSha);
    const highest = findHighestRouteEpoch(events, taskId);
    if (highest === null) {
      return errorOutcome(
        'invalid_input',
        DISPATCH_EXIT_CODES.INVALID_INPUT,
        'no route.decided exists for task_id',
      );
    }
    const routeId = computeRouteId(taskId, highest);
    if (events.some((e) => e.event_type === 'dispatch.terminal' && e.route_id === routeId)) {
      return errorOutcome(
        'duplicate_route',
        DISPATCH_EXIT_CODES.STATE_ERROR,
        'dispatch.terminal already exists for route_id; refusing to abandon',
      );
    }
    if (events.some((e) => e.event_type === 'outcome.finalized' && e.route_id === routeId)) {
      return errorOutcome(
        'duplicate_route',
        DISPATCH_EXIT_CODES.STATE_ERROR,
        'outcome.finalized already exists for route_id; refusing to abandon',
      );
    }
    const decided = events.find((e) => e.event_type === 'route.decided' && e.route_id === routeId);
    if (decided === undefined) {
      return errorOutcome(
        'state_error',
        DISPATCH_EXIT_CODES.STATE_ERROR,
        'route.decided missing for route_id',
      );
    }
    appendOutcomeEvent(
      logPath,
      buildOutcomeFinalized({
        repo: identity.repo,
        prNumber: identity.pr,
        headSha: identity.headSha,
        outcome: 'CENSORED',
        reasonCode: 'operator_abandoned',
        actualExecutor: null,
        evidenceEventIds: [decided.event_id],
        verifiedAt: null,
        observedAt: now().toISOString(),
        retryEpoch: highest,
      }),
    );
    return sealed(
      {
        format: MACHINE_FORMAT,
        status: 'completed',
        task_id: taskId,
        route_id: routeId,
        retry_epoch: highest,
        reason: 'route abandoned; outcome.finalized recorded',
      },
      DISPATCH_EXIT_CODES.COMPLETED,
    );
  } catch (error) {
    if (error instanceof OutcomeLogError) {
      return error.kind === 'INVALID_EVENT'
        ? errorOutcome('invalid_input', DISPATCH_EXIT_CODES.INVALID_INPUT, error.message)
        : errorOutcome('state_error', DISPATCH_EXIT_CODES.STATE_ERROR, error.message);
    }
    const name = error instanceof Error ? error.constructor.name : 'UnknownError';
    return errorOutcome(
      'state_error',
      DISPATCH_EXIT_CODES.STATE_ERROR,
      `unexpected ${name}; no further detail is echoed by design`,
    );
  }
};

/**
 * Run the frozen five-step hot path once. Never throws: every failure folds
 * into a machine JSON + exit code pair (the caller's only jobs are printing
 * and exiting).
 */
export const runReviewDispatch = async (
  taskRaw: string,
  policyArmRaw: string,
  deps: ReviewDispatchDeps,
  cohortIndexRaw?: string,
): Promise<ReviewDispatchOutcome> => {
  const now = deps.now ?? ((): Date => new Date());
  try {
    // Parse before parseTaskProfile so a bad index fails closed with zero
    // side effects (no candidate spawn, no log write).
    const cohortIndex = parseCohortIndexRaw(cohortIndexRaw);

    if (!(POLICY_ARMS as ReadonlyArray<string>).includes(policyArmRaw)) {
      throw new OutcomeLogError('INVALID_EVENT', 'policy_arm must be "static" or "thompson"');
    }
    const policyArm = policyArmRaw as PolicyArm;
    // Range + parity BEFORE eligibleReviewers: the no_eligible early return
    // must not echo an unvalidated cohort_index into sealed machine JSON.
    assertValidCohortIndex(cohortIndex, policyArm);

    const profile = parseTaskProfile(taskRaw);
    const loaded = loadRoutingConfig(deps.env);
    assertLiteralLoopbackOnly(loaded.config, 'config');
    const logPath = resolveOutcomeLogPath(deps.env);
    // Read up front for BOTH arms: log corruption must stop a dispatch before
    // any candidate can run, not only when Thompson needs the posterior.
    const { events } = readOutcomeLog(logPath);

    const taskId = computeTaskId(profile.repo, profile.pr, profile.headSha);
    const retryDecision = resolveRetryDispatch(events, taskId);
    if (retryDecision.kind === 'duplicate_route') {
      return duplicateRouteOutcome(taskId, retryDecision);
    }
    const { routeId, retryEpoch, supersedesRouteId } = retryDecision;

    // R2 continuity across epochs: admission (cohort_index + policy_arm) is
    // byte-frozen at epoch 0's route.decided. A retry epoch re-states the
    // SAME admission — a different index, a null index, or the other arm
    // would let one task train both arms and corrupt the 25/25 audit. Fails
    // closed BEFORE any candidate spawn or log write.
    if (supersedesRouteId !== null) {
      const superseded = events.find(
        (e) => e.event_type === 'route.decided' && e.route_id === supersedesRouteId,
      );
      if (superseded !== undefined) {
        if (superseded['cohort_index'] !== cohortIndex) {
          throw new OutcomeLogError(
            'INVALID_EVENT',
            'cohort_index must match the superseded route.decided',
          );
        }
        if (superseded['policy_arm'] !== policyArm) {
          throw new OutcomeLogError(
            'INVALID_EVENT',
            'policy_arm must match the superseded route.decided',
          );
        }
      }
    }

    const eligible = eligibleReviewers(loaded.config.candidates, {
      authorLineage: profile.authorLineage,
      languages: profile.languages,
      riskTags: profile.riskTags,
    });
    if (eligible.length === 0) {
      // Frozen: exit 7, frozen sentence, and NO route is created.
      return sealed(
        {
          format: MACHINE_FORMAT,
          status: 'no_eligible_agent',
          task_id: taskId,
          route_id: routeId,
          policy_arm: policyArm,
          cohort_index: cohortIndex,
          config_sha256: loaded.configSha256,
          selected_agent: null,
          executed_agent: null,
          attempt_id: null,
          reason: NO_ELIGIBLE_AGENT_MESSAGE,
          result_ref: null,
          attempts: [],
        },
        DISPATCH_EXIT_CODES.NO_ELIGIBLE_AGENT,
      );
    }

    // §B2: every route gets a fresh 128-bit seed, both arms, recorded with
    // route.decided so a Thompson decision is exactly replayable.
    const seed = deps.seed ?? newRouteSeed();
    const rank = rankReviewers(eligible, policyArm, { seed, events });
    const candidateIdentities = computeCandidateIdentities(rank.ranked);

    const routedAtMs = now().getTime();
    const routedAt = new Date(routedAtMs).toISOString();
    const deadlineAt = new Date(routedAtMs + OUTCOME_WINDOW_HOURS * 3_600_000).toISOString();
    let appended: 'appended' | 'duplicate-noop';
    try {
      appended = appendOutcomeEvent(
        logPath,
        buildRouteDecided({
          repo: profile.repo,
          prNumber: profile.pr,
          headSha: profile.headSha,
          policyArm,
          cohortIndex,
          candidateId: rank.ranked[0]!.name,
          rankedCandidates: rank.ranked.map((c) => c.name),
          candidateIdentities,
          seed,
          configSha256: loaded.configSha256,
          profileSha256: computeProfileSha256(profile),
          profileFacets: profileFacets(profile),
          routedAt,
          deadlineAt,
          retryEpoch,
          supersedesRouteId,
          ...(rank.posteriors !== null ? { posteriors: rank.posteriors } : {}),
        }),
      );
    } catch (error) {
      // Concurrency race at the route.decided append only → duplicate_route.
      // DUPLICATE_ID_CONFLICT from any later append stays state_error via the
      // outer catch (this block does not wrap those calls).
      if (error instanceof OutcomeLogError && error.kind === 'DUPLICATE_ID_CONFLICT') {
        return duplicateRouteOutcome(taskId, {
          kind: 'duplicate_route',
          retryEpoch,
          routeId,
          priorTerminalState: readPriorTerminalState(events, routeId),
          reason: 'route already recorded for this task; refusing to re-dispatch',
        });
      }
      throw error;
    }
    if (appended === 'duplicate-noop') {
      // Race: another writer landed the identical epoch payload first.
      return duplicateRouteOutcome(taskId, {
        kind: 'duplicate_route',
        retryEpoch,
        routeId,
        priorTerminalState: readPriorTerminalState(events, routeId),
        reason: 'route already recorded for this task; refusing to re-dispatch',
      });
    }

    const result = await dispatchReview({
      routeId,
      ranked: rank.ranked,
      taskJson: '',
      taskJsonFor: (candidate) => candidateTaskJson(profile, routeId, candidate.name),
      maxAttempts: loaded.config.max_attempts,
      timeoutMs: loaded.config.dispatch_timeout_seconds * 1000,
      logPath,
      // The same injectable clock that stamped routedAt — read again at
      // terminal emission, so observed_at is the terminal time, not the
      // routing time (D10 no-regret half).
      now,
    });

    const resultRef = result.resultJson?.['result_ref'];
    return sealed(
      {
        format: MACHINE_FORMAT,
        status: STATUS_BY_STATE[result.state],
        task_id: taskId,
        route_id: routeId,
        policy_arm: policyArm,
        cohort_index: cohortIndex,
        config_sha256: loaded.configSha256,
        selected_agent: rank.ranked[0]!.name,
        executed_agent: result.actualExecutor,
        attempt_id:
          result.actualExecutor === null ? null : computeAttemptId(routeId, result.actualExecutor),
        reason: result.state === 'COMPLETED' ? rank.reason : result.message,
        result_ref: typeof resultRef === 'string' ? resultRef : null,
        attempts: result.attempts.map((a) => ({
          candidate: a.candidate,
          verdict: a.verdict,
          detail: a.detail,
        })),
        // Surfaced whenever the terminal append failed after the agent ran —
        // the caller must see the true COMPLETED/EFFECT_UNKNOWN state AND that
        // the receipt could not be persisted. null when emission succeeded.
        terminal_event_error:
          result.terminalEmission !== null && result.terminalEmission.emitted === false
            ? result.terminalEmission.reason
            : null,
      },
      result.exitCode,
    );
  } catch (error) {
    if (error instanceof OutcomeLogError) {
      // INVALID_EVENT covers profile/config/arm validation → caller fault.
      // Every other kind is store/state trouble → STATE_ERROR. Messages name
      // fields, paths, and types only — safe to surface.
      return error.kind === 'INVALID_EVENT'
        ? errorOutcome('invalid_input', DISPATCH_EXIT_CODES.INVALID_INPUT, error.message)
        : errorOutcome('state_error', DISPATCH_EXIT_CODES.STATE_ERROR, error.message);
    }
    // Unknown exception class: report the TYPE only. Interpolating the
    // message could replay foreign bytes (header values, key fragments) into
    // the caller's terminal and from there into pane snapshots.
    const name = error instanceof Error ? error.constructor.name : 'UnknownError';
    return errorOutcome(
      'state_error',
      DISPATCH_EXIT_CODES.STATE_ERROR,
      `unexpected ${name}; no further detail is echoed by design`,
    );
  }
};
