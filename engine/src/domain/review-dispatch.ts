import { newRouteSeed } from './beta-sampler.js';
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
  OutcomeLogError,
  readOutcomeLog,
  resolveOutcomeLogPath,
} from './outcome-log.js';
import { buildRouteDecided, POLICY_ARMS, type PolicyArm } from './route-posterior.js';
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

export type MachineStatus =
  | 'completed'
  | 'no_eligible_agent'
  | 'dispatch_failed'
  | 'effect_unknown'
  | 'invalid_input'
  | 'state_error';

const STATUS_BY_STATE: Record<DispatchState, MachineStatus> = {
  COMPLETED: 'completed',
  NO_ELIGIBLE_AGENT: 'no_eligible_agent',
  DISPATCH_FAILED: 'dispatch_failed',
  EFFECT_UNKNOWN: 'effect_unknown',
};

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
 * Run the frozen five-step hot path once. Never throws: every failure folds
 * into a machine JSON + exit code pair (the caller's only jobs are printing
 * and exiting).
 */
export const runReviewDispatch = async (
  taskRaw: string,
  policyArmRaw: string,
  deps: ReviewDispatchDeps,
): Promise<ReviewDispatchOutcome> => {
  const now = deps.now ?? ((): Date => new Date());
  try {
    if (!(POLICY_ARMS as ReadonlyArray<string>).includes(policyArmRaw)) {
      throw new OutcomeLogError('INVALID_EVENT', 'policy_arm must be "static" or "thompson"');
    }
    const policyArm = policyArmRaw as PolicyArm;

    const profile = parseTaskProfile(taskRaw);
    const loaded = loadRoutingConfig(deps.env);
    assertLiteralLoopbackOnly(loaded.config, 'config');
    const logPath = resolveOutcomeLogPath(deps.env);
    // Read up front for BOTH arms: log corruption must stop a dispatch before
    // any candidate can run, not only when Thompson needs the posterior.
    const { events } = readOutcomeLog(logPath);

    const taskId = computeTaskId(profile.repo, profile.pr, profile.headSha);
    const routeId = computeRouteId(taskId);

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

    const routedAtMs = now().getTime();
    const routedAt = new Date(routedAtMs).toISOString();
    const deadlineAt = new Date(routedAtMs + OUTCOME_WINDOW_HOURS * 3_600_000).toISOString();
    const appended = appendOutcomeEvent(
      logPath,
      buildRouteDecided({
        repo: profile.repo,
        prNumber: profile.pr,
        headSha: profile.headSha,
        policyArm,
        candidateId: rank.ranked[0]!.name,
        rankedCandidates: rank.ranked.map((c) => c.name),
        seed,
        configSha256: loaded.configSha256,
        profileSha256: computeProfileSha256(profile),
        profileFacets: profileFacets(profile),
        routedAt,
        deadlineAt,
        ...(rank.posteriors !== null ? { posteriors: rank.posteriors } : {}),
      }),
    );
    if (appended === 'duplicate-noop') {
      // A byte-identical route.decided already exists (a replay with pinned
      // seed/clock, or a crash-then-rerun). The agent may already have acted
      // on it; running again would be a duplicate external effect with zero
      // new evidence in the log. Fail closed — never re-dispatch.
      throw new OutcomeLogError(
        'DUPLICATE_ID_CONFLICT',
        'route already recorded for this task; refusing to re-dispatch',
      );
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
