import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

import {
  appendOutcomeEvent,
  computeAttemptId,
  OUTCOME_LOG_FORMAT,
  type OutcomeEvent,
} from './outcome-log.js';
import { killProcessGroup, shouldUseProcessGroup } from './process-group.js';
import type { CandidateConfig } from './routing-config.js';

/**
 * Spawn-boundary dispatch state machine for the AgentDex PR-review slice
 * (frozen baseline 2026-07-23, §B3).
 *
 * The single load-bearing distinction: did the candidate PROVABLY NEVER
 * START?  Only then may the machine fall back to the next ranked candidate.
 * The moment a child process may have touched the outside world (a PID
 * existed), any failure — non-zero exit, timeout, unparseable output,
 * executor mismatch — is EFFECT_UNKNOWN: the chain stops, nothing retries,
 * because a duplicate review on a real PR is worse than a missing one.
 *
 * Terminal taxonomy (exit codes are the CLI contract):
 *   NO_ELIGIBLE_AGENT  exit 7  — empty ranked pool; no route side effects
 *   DISPATCH_FAILED    exit 7  — every attempt provably never spawned
 *   EFFECT_UNKNOWN     exit 8  — an attempt may have started; chain stopped
 *   COMPLETED          exit 0  — rc=0, machine JSON parsed, executor matches
 *   (INVALID_INPUT exit 2 and STATE_ERROR exit 74 belong to callers/store.)
 *
 * Every dispatch writes one `dispatch.terminal` event — the minimal fact
 * layer distinguishing never-spawned from may-have-started; a route decision
 * must never impersonate an execution receipt.
 */

export const DISPATCH_EXIT_CODES = {
  COMPLETED: 0,
  INVALID_INPUT: 2,
  NO_ELIGIBLE_AGENT: 7,
  DISPATCH_FAILED: 7,
  EFFECT_UNKNOWN: 8,
  STATE_ERROR: 74,
} as const;

export type DispatchState =
  'COMPLETED' | 'NO_ELIGIBLE_AGENT' | 'DISPATCH_FAILED' | 'EFFECT_UNKNOWN';

/** Frozen user-facing strings (spec §B3). */
export const NO_ELIGIBLE_AGENT_MESSAGE =
  'No eligible PR-review agent is available; no agent was started.';
export const EFFECT_UNKNOWN_MESSAGE =
  'Agent execution may have started; no fallback or retry was attempted.';

export type AttemptVerdict = 'never-spawned' | 'completed' | 'effect-unknown';

export interface AttemptRecord {
  readonly candidate: string;
  readonly verdict: AttemptVerdict;
  /** Exception/exit detail — type/code names only, never raw output. */
  readonly detail: string;
}

export interface DispatchResult {
  readonly state: DispatchState;
  readonly exitCode: number;
  readonly message: string;
  readonly actualExecutor: string | null;
  /** Parsed machine JSON from the completed agent, if any. */
  readonly resultJson: Record<string, unknown> | null;
  readonly attempts: ReadonlyArray<AttemptRecord>;
}

export interface DispatchOptions {
  readonly routeId: string;
  /** Ranked eligible candidates; empty → NO_ELIGIBLE_AGENT. */
  readonly ranked: ReadonlyArray<CandidateConfig>;
  /** Task JSON delivered on the agent's stdin. */
  readonly taskJson: string;
  /**
   * Per-candidate task JSON override (§B6: the payload embeds the per-attempt
   * marker, so it varies with the candidate). Wins over taskJson when set.
   */
  readonly taskJsonFor?: (candidate: CandidateConfig) => string;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  /** Outcome-log path for the dispatch.terminal event; null skips emission (unit seams). */
  readonly logPath: string | null;
  readonly observedAt: string;
}

export const computeDispatchTerminalId = (routeId: string): string =>
  createHash('sha256').update(`pr-review-dispatch-v1\0${routeId}`, 'utf8').digest('hex');

interface SpawnOutcome {
  readonly verdict: AttemptVerdict;
  readonly detail: string;
  readonly stdout: string;
}

/**
 * Run one candidate. Never-spawned requires BOTH: a spawn-level error of the
 * ENOENT/EACCES class AND no PID ever assigned. Everything after a PID is
 * effect-unknown territory.
 */
const runCandidate = (
  candidate: CandidateConfig,
  taskJson: string,
  timeoutMs: number,
): Promise<SpawnOutcome> =>
  new Promise((resolve) => {
    // Preflight (spec: 3s availability check, trivially synchronous here):
    // a missing or non-executable binary is a provable never-spawn without
    // paying the spawn attempt.
    try {
      fs.accessSync(candidate.argv[0]!, fs.constants.X_OK);
    } catch (error) {
      resolve({
        verdict: 'never-spawned',
        detail: `preflight:${(error as NodeJS.ErrnoException).code ?? 'EACCES'}`,
        stdout: '',
      });
      return;
    }

    // detached makes the child a process-group leader so the timeout below can
    // signal its descendants too. Killing only the direct child bounds neither
    // effects nor wall clock: a grandchild keeps running AND holds the inherited
    // stdout pipe open, so the caller waits on a descriptor nobody will close.
    const useProcessGroup = shouldUseProcessGroup(timeoutMs);
    const child = spawn(candidate.argv[0]!, candidate.argv.slice(1), {
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
      ...(useProcessGroup ? { detached: true } : {}),
    });

    let settled = false;
    let stdout = '';
    const settle = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      // A PID existed; the group is killed but its effects are unknown.
      // EFFECT_UNKNOWN semantics are deliberately unchanged — process-group
      // termination makes the kill actually cover descendants, it does not
      // turn an unknown effect into a known one.
      killProcessGroup(child, 'SIGKILL', useProcessGroup);
      settle({ verdict: 'effect-unknown', detail: 'timeout', stdout });
    }, timeoutMs);

    child.on('error', (error: NodeJS.ErrnoException) => {
      const neverSpawned =
        child.pid === undefined && (error.code === 'ENOENT' || error.code === 'EACCES');
      settle(
        neverSpawned
          ? { verdict: 'never-spawned', detail: `spawn:${error.code}`, stdout: '' }
          : { verdict: 'effect-unknown', detail: `error:${error.code ?? 'unknown'}`, stdout },
      );
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.on('close', (code) => {
      settle(
        code === 0
          ? { verdict: 'completed', detail: 'exit:0', stdout }
          : { verdict: 'effect-unknown', detail: `exit:${String(code)}`, stdout },
      );
    });

    child.stdin.on('error', () => {
      // EPIPE while writing stdin: the child had a PID; close/error settles it.
    });
    child.stdin.write(taskJson);
    child.stdin.end();
  });

const emitTerminal = (
  options: DispatchOptions,
  state: DispatchState,
  actualExecutor: string | null,
  attempts: ReadonlyArray<AttemptRecord>,
): void => {
  if (options.logPath === null) return;
  const event: OutcomeEvent = {
    format: OUTCOME_LOG_FORMAT,
    event_type: 'dispatch.terminal',
    event_id: computeDispatchTerminalId(options.routeId),
    route_id: options.routeId,
    observed_at: options.observedAt,
    terminal_state: state,
    actual_executor: actualExecutor,
    attempts: attempts.map((a) => ({
      candidate: a.candidate,
      verdict: a.verdict,
      detail: a.detail,
    })),
  };
  appendOutcomeEvent(options.logPath, event);
};

/**
 * Drive the ranked list through the spawn-boundary rules. Fallback advances
 * only past provably-never-spawned candidates, at most maxAttempts tries,
 * each candidate at most once per route.
 */
export const dispatchReview = async (options: DispatchOptions): Promise<DispatchResult> => {
  if (options.ranked.length === 0) {
    const result: DispatchResult = {
      state: 'NO_ELIGIBLE_AGENT',
      exitCode: DISPATCH_EXIT_CODES.NO_ELIGIBLE_AGENT,
      message: NO_ELIGIBLE_AGENT_MESSAGE,
      actualExecutor: null,
      resultJson: null,
      attempts: [],
    };
    // Frozen: no route side effects at all — no event is written.
    return result;
  }

  const attempts: AttemptRecord[] = [];
  const tried = new Set<string>();
  const limit = Math.min(options.maxAttempts, options.ranked.length);

  for (const candidate of options.ranked.slice(0, limit)) {
    if (tried.has(candidate.name)) continue; // same candidate max 1 try per route
    tried.add(candidate.name);

    const payload = options.taskJsonFor ? options.taskJsonFor(candidate) : options.taskJson;
    const outcome = await runCandidate(candidate, payload, options.timeoutMs);
    attempts.push({ candidate: candidate.name, verdict: outcome.verdict, detail: outcome.detail });

    if (outcome.verdict === 'never-spawned') continue; // the ONLY fallback lane

    if (outcome.verdict === 'completed') {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(outcome.stdout);
      } catch {
        parsed = null;
      }
      const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
      const record: Record<string, unknown> = isObject ? (parsed as Record<string, unknown>) : {};
      // §B3 COMPLETED requires route/attempt/executor 一致: every id the agent
      // CLAIMS must match THIS dispatch; absent claims stay acceptable. A
      // receipt bound to some other route is not evidence this task was done.
      const executorOk =
        record['executed_agent'] === undefined || record['executed_agent'] === candidate.name;
      const routeOk = record['route_id'] === undefined || record['route_id'] === options.routeId;
      const attemptOk =
        record['attempt_id'] === undefined ||
        record['attempt_id'] === computeAttemptId(options.routeId, candidate.name);
      if (isObject && executorOk && routeOk && attemptOk) {
        emitTerminal(options, 'COMPLETED', candidate.name, attempts);
        return {
          state: 'COMPLETED',
          exitCode: DISPATCH_EXIT_CODES.COMPLETED,
          message: `Dispatch completed by ${candidate.name}.`,
          actualExecutor: candidate.name,
          resultJson: parsed as Record<string, unknown>,
          attempts,
        };
      }
      // rc=0 but garbage or mismatched output: the agent RAN — effect unknown.
      attempts[attempts.length - 1] = {
        candidate: candidate.name,
        verdict: 'effect-unknown',
        detail: !isObject
          ? 'unparseable-output'
          : executorOk
            ? 'receipt-mismatch'
            : 'executor-mismatch',
      };
    }

    emitTerminal(options, 'EFFECT_UNKNOWN', null, attempts);
    return {
      state: 'EFFECT_UNKNOWN',
      exitCode: DISPATCH_EXIT_CODES.EFFECT_UNKNOWN,
      message: EFFECT_UNKNOWN_MESSAGE,
      actualExecutor: null,
      resultJson: null,
      attempts,
    };
  }

  emitTerminal(options, 'DISPATCH_FAILED', null, attempts);
  return {
    state: 'DISPATCH_FAILED',
    exitCode: DISPATCH_EXIT_CODES.DISPATCH_FAILED,
    message: 'No candidate could be started; nothing ran.',
    actualExecutor: null,
    resultJson: null,
    attempts,
  };
};
