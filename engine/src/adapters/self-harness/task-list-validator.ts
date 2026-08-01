import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { DispatchError, DispatchResult } from '../../domain/dispatch.js';
import type { Harness } from '../../domain/ports/harness.js';
import type { HarnessValidator } from '../../domain/ports/self-harness.js';
import { isOk } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import type { HarnessConfig, SplitScores } from '../../domain/self-harness.js';

export interface TaskListHarnessValidatorOptions<TCase> {
  readonly heldIn: readonly TCase[];
  readonly heldOut: readonly TCase[];
  readonly renderPrompt: (config: HarnessConfig, testCase: TCase) => string;
  readonly verify: (
    testCase: TCase,
    result: DispatchResult,
    workspace: string,
  ) => boolean | Promise<boolean>;
  readonly agent: string;
  readonly taskType?: string;
  /**
   * Repeats per case to denoise stochastic evaluation (default 1). Both pass counts
   * and totals scale by this, so the acceptance gate aggregates across repeats —
   * the paper's "repeat candidate evaluation and aggregate pass counts" — instead
   * of trusting a single noisy sample.
   */
  readonly samples?: number;
  /**
   * Root under which each case's ephemeral workspace is created. When set,
   * every (case, sample) evaluation runs in its own mkdtemp directory under
   * this root: `caseFiles` are copied in, the dispatch runs with that
   * directory as cwd, `verify` receives its path, and the directory is
   * removed afterwards. This kills cross-case contamination (stale artifacts,
   * PATH hijack via ./bin, mutated convention files, port ghosts) that a
   * shared cwd invites. When unset, dispatches inherit the harness cwd and
   * `verify` receives '' — the legacy shared-directory behavior.
   */
  readonly workspaceRoot?: string;
  /**
   * Absolute paths copied (flat, by basename) into each ephemeral workspace
   * before the dispatch — e.g. a CONVENTIONS.md the scored agent is expected
   * to discover. Ignored unless `workspaceRoot` is set. Copies are fresh per
   * case, so a candidate that mutates its copy cannot poison later cases.
   */
  readonly caseFiles?: readonly string[];
}

const DEFAULT_TASK_TYPE = 'self-harness-eval';

const normalizeSamples = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
};

/** Harness-backed Stage-3 validator over fixed held-in and held-out task lists. */
export class TaskListHarnessValidator<TCase> implements HarnessValidator {
  private readonly heldIn: readonly TCase[];
  private readonly heldOut: readonly TCase[];
  private readonly renderPrompt: (config: HarnessConfig, testCase: TCase) => string;
  private readonly verify: (
    testCase: TCase,
    result: DispatchResult,
    workspace: string,
  ) => boolean | Promise<boolean>;
  private readonly agent: string;
  private readonly taskType: string;
  private readonly samples: number;
  private readonly workspaceRoot: string | undefined;
  private readonly caseFiles: readonly string[];

  constructor(
    private readonly harness: Harness,
    options: TaskListHarnessValidatorOptions<TCase>,
  ) {
    this.heldIn = options.heldIn;
    this.heldOut = options.heldOut;
    this.renderPrompt = options.renderPrompt;
    this.verify = options.verify;
    this.agent = options.agent;
    this.taskType = options.taskType ?? DEFAULT_TASK_TYPE;
    this.samples = normalizeSamples(options.samples);
    this.workspaceRoot = options.workspaceRoot;
    this.caseFiles = options.caseFiles ?? [];
  }

  async score(config: HarnessConfig): Promise<SplitScores> {
    const inPass = await this.scoreSplit(config, this.heldIn);
    const outPass = await this.scoreSplit(config, this.heldOut);
    return {
      inPass,
      inTotal: this.heldIn.length * this.samples,
      outPass,
      outTotal: this.heldOut.length * this.samples,
    };
  }

  private async scoreSplit(config: HarnessConfig, cases: readonly TCase[]): Promise<number> {
    let passes = 0;
    for (const testCase of cases) {
      for (let sample = 0; sample < this.samples; sample += 1) {
        if (await this.scoreCase(config, testCase)) passes += 1;
      }
    }
    return passes;
  }

  private async scoreCase(config: HarnessConfig, testCase: TCase): Promise<boolean> {
    let prompt: string;
    try {
      prompt = this.renderPrompt(config, testCase);
    } catch {
      return false;
    }

    if (this.workspaceRoot === undefined) {
      const result = await this.dispatch(prompt, undefined);
      if (result === undefined || !isOk(result)) return false;
      try {
        return (await this.verify(testCase, result.value, '')) === true;
      } catch {
        return false;
      }
    }

    // Ephemeral per-case workspace: fresh dir, fresh caseFile copies, dispatch
    // and verify both scoped to it, destroyed afterwards. Workspace setup
    // failures are infrastructure errors, not candidate failures — but they
    // must not throw out of the scoring loop, so they score false like every
    // other expected failure.
    let workspace: string;
    try {
      workspace = await mkdtemp(join(this.workspaceRoot, 'sh-case-'));
    } catch {
      return false;
    }
    try {
      for (const file of this.caseFiles) {
        await copyFile(file, join(workspace, basename(file)));
      }
      const result = await this.dispatch(prompt, workspace);
      if (result === undefined || !isOk(result)) return false;
      try {
        return (await this.verify(testCase, result.value, workspace)) === true;
      } catch {
        return false;
      }
    } catch {
      return false;
    } finally {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async dispatch(
    prompt: string,
    cwd: string | undefined,
  ): Promise<Result<DispatchResult, DispatchError> | undefined> {
    try {
      return await this.harness.dispatch({
        agent: this.agent,
        prompt,
        taskType: this.taskType,
        ...(cwd !== undefined ? { cwd } : {}),
      });
    } catch {
      return undefined;
    }
  }
}
