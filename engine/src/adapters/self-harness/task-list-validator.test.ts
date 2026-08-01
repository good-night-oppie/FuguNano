import { describe, expect, it } from 'vitest';
import { readdirSync as fsReaddirSync } from 'node:fs';
import {
  mkdtemp as fsMkdtemp,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { tmpdir as osTmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';

import type {
  DispatchError,
  DispatchRequest,
  DispatchResult,
  HealthStatus,
} from '../../domain/dispatch.js';
import type { Harness } from '../../domain/ports/harness.js';
import { err, ok } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import type { HarnessConfig } from '../../domain/self-harness.js';
import { TaskListHarnessValidator } from './task-list-validator.js';

interface Case {
  readonly id: string;
  readonly expected: string;
}

class SequencedHarness implements Harness {
  readonly name = 'codex';
  readonly requests: DispatchRequest[] = [];
  private index = 0;

  constructor(private readonly results: readonly Result<DispatchResult, DispatchError>[]) {}

  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    this.requests.push(request);
    const result =
      this.results[this.index] ??
      err({
        agent: request.agent,
        kind: 'unavailable',
        detail: 'missing fake result',
      });
    this.index += 1;
    return Promise.resolve(result);
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, detail: 'ok' });
  }
}

class RejectingOnceHarness implements Harness {
  readonly name = 'codex';
  readonly requests: DispatchRequest[] = [];
  private calls = 0;

  dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
    this.requests.push(request);
    this.calls += 1;
    if (this.calls === 1) return Promise.reject(new Error('dispatch rejected'));
    return Promise.resolve(pass('ok'));
  }

  health(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, detail: 'ok' });
  }
}

const config: HarnessConfig = {
  'system-prompt': 'Be precise.',
  'memory-sources': 'Use notes.',
  subagents: 'none',
  skills: 'none',
  bootstrap: 'start',
  execution: 'execute',
  verification: 'verify',
  'failure-recovery': 'recover',
  'runtime-policy': 'policy',
};

const pass = (output: string): Result<DispatchResult, DispatchError> =>
  ok({ agent: 'agent-1', output, exitCode: 0 });

const failDispatch = (): Result<DispatchResult, DispatchError> =>
  err({ agent: 'agent-1', kind: 'unavailable', detail: 'offline' });

const renderPrompt = (harnessConfig: HarnessConfig, testCase: Case): string =>
  `${harnessConfig['system-prompt']} :: ${testCase.id}`;

describe('TaskListHarnessValidator', () => {
  it('counts passes per split with a verify predicate', async () => {
    const harness = new SequencedHarness([pass('yes'), pass('no'), pass('ok')]);
    const validator = new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'yes' },
        { id: 'in-2', expected: 'yes' },
      ],
      heldOut: [{ id: 'out-1', expected: 'ok' }],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
    });

    const scores = await validator.score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 1, outTotal: 1 });
    expect(harness.requests.map((request) => request.prompt)).toEqual([
      'Be precise. :: in-1',
      'Be precise. :: in-2',
      'Be precise. :: out-1',
    ]);
    expect(harness.requests.every((request) => request.agent === 'agent-1')).toBe(true);
    expect(harness.requests.every((request) => request.taskType === 'self-harness-eval')).toBe(
      true,
    );
  });

  it('uses a custom task type for dispatches', async () => {
    const harness = new SequencedHarness([pass('ok')]);

    await new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'ok' }],
      heldOut: [],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
      taskType: 'custom-eval',
    }).score(config);

    expect(harness.requests[0]?.taskType).toBe('custom-eval');
  });

  it('counts dispatch errors as failures', async () => {
    const harness = new SequencedHarness([failDispatch(), pass('ok')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'ok' }],
      heldOut: [{ id: 'out-1', expected: 'ok' }],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 0, inTotal: 1, outPass: 1, outTotal: 1 });
  });

  it('counts dispatch promise rejections as failures and continues', async () => {
    const harness = new RejectingOnceHarness();
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'ok' },
        { id: 'in-2', expected: 'ok' },
      ],
      heldOut: [],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(2);
  });

  it('counts verifier exceptions as failures and continues', async () => {
    const harness = new SequencedHarness([pass('boom'), pass('yes'), pass('ok')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'yes' },
        { id: 'in-2', expected: 'yes' },
      ],
      heldOut: [{ id: 'out-1', expected: 'ok' }],
      renderPrompt,
      verify: (testCase, result) => {
        if (testCase.id === 'in-1') throw new Error('bad verifier');
        return result.output === testCase.expected;
      },
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 1, outTotal: 1 });
    expect(harness.requests).toHaveLength(3);
  });

  it('counts verifier promise rejections as failures and continues', async () => {
    const harness = new SequencedHarness([pass('boom'), pass('yes')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'yes' },
        { id: 'in-2', expected: 'yes' },
      ],
      heldOut: [],
      renderPrompt,
      verify: async (testCase, result) => {
        if (testCase.id === 'in-1') throw new Error('bad async verifier');
        return Promise.resolve(result.output === testCase.expected);
      },
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(2);
  });

  it('counts renderPrompt exceptions as failures and continues', async () => {
    const harness = new SequencedHarness([pass('yes')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [
        { id: 'in-1', expected: 'yes' },
        { id: 'in-2', expected: 'yes' },
      ],
      heldOut: [],
      renderPrompt: (harnessConfig, testCase) => {
        if (testCase.id === 'in-1') throw new Error('bad template');
        return renderPrompt(harnessConfig, testCase);
      },
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 2, outPass: 0, outTotal: 0 });
    expect(harness.requests.map((request) => request.prompt)).toEqual(['Be precise. :: in-2']);
  });

  it('awaits an async verify predicate', async () => {
    const harness = new SequencedHarness([pass('async-pass')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'async-pass' }],
      heldOut: [],
      renderPrompt,
      verify: async (testCase, result) => Promise.resolve(result.output === testCase.expected),
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 1, outPass: 0, outTotal: 0 });
  });

  it('reports split sizes as totals', async () => {
    const scores = await new TaskListHarnessValidator(new SequencedHarness([]), {
      heldIn: [
        { id: 'in-1', expected: 'x' },
        { id: 'in-2', expected: 'x' },
        { id: 'in-3', expected: 'x' },
      ],
      heldOut: [
        { id: 'out-1', expected: 'x' },
        { id: 'out-2', expected: 'x' },
      ],
      renderPrompt,
      verify: () => false,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 0, inTotal: 3, outPass: 0, outTotal: 2 });
  });

  it('repeats each case `samples` times and scales totals (denoise stochastic eval)', async () => {
    const harness = new SequencedHarness([pass('x'), pass('x'), pass('x')]);
    const validator = new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'x' }],
      heldOut: [],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
      samples: 3,
    });

    const scores = await validator.score(config);

    expect(scores).toEqual({ inPass: 3, inTotal: 3, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(3);
  });

  it('aggregates a flaky case across repeats (2 of 3 pass)', async () => {
    const harness = new SequencedHarness([pass('yes'), pass('no'), pass('yes')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'yes' }],
      heldOut: [],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
      samples: 3,
    }).score(config);

    expect(scores).toEqual({ inPass: 2, inTotal: 3, outPass: 0, outTotal: 0 });
  });

  it('normalizes a non-positive or non-finite samples to 1', async () => {
    const harness = new SequencedHarness([pass('x')]);
    const scores = await new TaskListHarnessValidator(harness, {
      heldIn: [{ id: 'in-1', expected: 'x' }],
      heldOut: [],
      renderPrompt,
      verify: (testCase, result) => result.output === testCase.expected,
      agent: 'agent-1',
      samples: 0,
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 1, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(1);
  });

  it('returns zeros for empty splits', async () => {
    const harness = new SequencedHarness([]);
    const scores = await new TaskListHarnessValidator<Case>(harness, {
      heldIn: [],
      heldOut: [],
      renderPrompt,
      verify: () => true,
      agent: 'agent-1',
    }).score(config);

    expect(scores).toEqual({ inPass: 0, inTotal: 0, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(0);
  });
});

const wsSetup = async () => {
  const root = await fsMkdtemp(pathJoin(osTmpdir(), 'sh-ws-root-'));
  const conventions = pathJoin(
    root,
    '..',
    `conv-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  await fsWriteFile(conventions, 'RULE: AHOY');
  return { root, conventions, join: pathJoin };
};

describe('TaskListHarnessValidator — ephemeral per-case workspaces', () => {
  it('dispatches each case in a fresh workspace with caseFiles copied in', async () => {
    const { root, conventions } = await wsSetup();

    const seen: string[] = [];
    class InspectingHarness implements Harness {
      readonly name = 'codex';
      async dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
        const cwd = request.cwd ?? '';
        seen.push(cwd);
        // The convention copy must be readable inside the workspace at dispatch time.
        const body = await fsReadFile(pathJoin(cwd, conventions.split('/').pop() ?? ''), 'utf8');
        return ok({ agent: request.agent, output: body, exitCode: 0 });
      }
      health(this: void): Promise<HealthStatus> {
        return Promise.resolve({ healthy: true, detail: 'ok' });
      }
    }

    const scores = await new TaskListHarnessValidator<Case>(new InspectingHarness(), {
      heldIn: [
        { id: 'a', expected: 'RULE: AHOY' },
        { id: 'b', expected: 'RULE: AHOY' },
      ],
      heldOut: [],
      renderPrompt: (_config, testCase) => testCase.id,
      verify: (testCase, result, workspace) =>
        result.output === testCase.expected && workspace !== '' && workspace.startsWith(root),
      agent: 'agent-1',
      workspaceRoot: root,
      caseFiles: [conventions],
    }).score(config);

    expect(scores).toEqual({ inPass: 2, inTotal: 2, outPass: 0, outTotal: 0 });
    // Each case saw a DIFFERENT fresh workspace under the root.
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    for (const cwd of seen) expect(cwd.startsWith(root)).toBe(true);
  });

  it('destroys the workspace after each case (no cross-case leakage)', async () => {
    const { root, conventions } = await wsSetup();

    class PollutingHarness implements Harness {
      readonly name = 'codex';
      async dispatch(request: DispatchRequest): Promise<Result<DispatchResult, DispatchError>> {
        // Simulate a candidate leaving stale artifacts + mutating its conventions copy.
        const cwd = request.cwd ?? '';
        await fsWriteFile(pathJoin(cwd, 'ghost.txt'), 'stale');
        await fsWriteFile(pathJoin(cwd, conventions.split('/').pop() ?? ''), 'RULE: MUTATED');
        return ok({ agent: request.agent, output: 'done', exitCode: 0 });
      }
      health(this: void): Promise<HealthStatus> {
        return Promise.resolve({ healthy: true, detail: 'ok' });
      }
    }

    const ghostsSeen: boolean[] = [];
    await new TaskListHarnessValidator<Case>(new PollutingHarness(), {
      heldIn: [
        { id: 'a', expected: 'x' },
        { id: 'b', expected: 'x' },
      ],
      heldOut: [],
      renderPrompt: (_config, testCase) => testCase.id,
      verify: (_testCase, _result, workspace) => {
        // At verify time, the CURRENT case's ghost exists, but no ghost from a
        // PRIOR case can — each workspace is fresh.
        const entries = fsReaddirSync(workspace);
        ghostsSeen.push(entries.includes('ghost.txt'));
        return true;
      },
      agent: 'agent-1',
      workspaceRoot: root,
      caseFiles: [conventions],
    }).score(config);

    expect(ghostsSeen).toEqual([true, true]);
    // After scoring, the root contains no leftover case workspaces.
    expect(fsReaddirSync(root)).toHaveLength(0);
  });

  it('scores false when a caseFile cannot be copied (infra failure, not a throw)', async () => {
    const { root } = await wsSetup();
    const harness = new SequencedHarness([pass('never-reached')]);

    const scores = await new TaskListHarnessValidator<Case>(harness, {
      heldIn: [{ id: 'a', expected: 'x' }],
      heldOut: [],
      renderPrompt: (_config, testCase) => testCase.id,
      verify: () => true,
      agent: 'agent-1',
      workspaceRoot: root,
      caseFiles: ['/nonexistent/convention-file.md'],
    }).score(config);

    expect(scores).toEqual({ inPass: 0, inTotal: 1, outPass: 0, outTotal: 0 });
    // The dispatch never ran: copy failure precedes it.
    expect(harness.requests).toHaveLength(0);
  });

  it('keeps legacy shared-cwd behavior when workspaceRoot is unset', async () => {
    const harness = new SequencedHarness([pass('ok')]);
    const workspaces: string[] = [];
    await new TaskListHarnessValidator<Case>(harness, {
      heldIn: [{ id: 'a', expected: 'ok' }],
      heldOut: [],
      renderPrompt: (_config, testCase) => testCase.id,
      verify: (_testCase, _result, workspace) => {
        workspaces.push(workspace);
        return true;
      },
      agent: 'agent-1',
    }).score(config);

    expect(workspaces).toEqual(['']);
    expect(harness.requests[0]?.cwd).toBeUndefined();
  });
});

describe('TaskListHarnessValidator — caseFile source-hash pins', () => {
  it('fails closed when a pinned caseFile source hash mismatches (tamper detection)', async () => {
    const { root, conventions } = await wsSetup();
    const harness = new SequencedHarness([pass('never-reached')]);

    const scores = await new TaskListHarnessValidator<Case>(harness, {
      heldIn: [{ id: 'a', expected: 'x' }],
      heldOut: [],
      renderPrompt: (_config, testCase) => testCase.id,
      verify: () => true,
      agent: 'agent-1',
      workspaceRoot: root,
      caseFiles: [conventions],
      caseFilePins: { [conventions]: 'deadbeef'.repeat(8) },
    }).score(config);

    expect(scores).toEqual({ inPass: 0, inTotal: 1, outPass: 0, outTotal: 0 });
    // Tamper detection precedes the dispatch.
    expect(harness.requests).toHaveLength(0);
  });

  it('passes the pin check when the source hash matches', async () => {
    const { createHash } = await import('node:crypto');
    const { root, conventions } = await wsSetup();
    const body = await fsReadFile(conventions);
    const pin = createHash('sha256').update(body).digest('hex');
    const harness = new SequencedHarness([pass('ok')]);

    const scores = await new TaskListHarnessValidator<Case>(harness, {
      heldIn: [{ id: 'a', expected: 'ok' }],
      heldOut: [],
      renderPrompt: (_config, testCase) => testCase.id,
      verify: (_testCase, result) => result.output === 'ok',
      agent: 'agent-1',
      workspaceRoot: root,
      caseFiles: [conventions],
      caseFilePins: { [conventions]: pin },
    }).score(config);

    expect(scores).toEqual({ inPass: 1, inTotal: 1, outPass: 0, outTotal: 0 });
    expect(harness.requests).toHaveLength(1);
  });
});
