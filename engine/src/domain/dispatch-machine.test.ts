import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeDispatchTerminalId,
  dispatchReview,
  EFFECT_UNKNOWN_MESSAGE,
  NO_ELIGIBLE_AGENT_MESSAGE,
  type DispatchOptions,
} from './dispatch-machine.js';
import { computeRouteId, readOutcomeLog } from './outcome-log.js';
import type { CandidateConfig } from './routing-config.js';

let dir: string;
let logPath: string;

const ROUTE_ID = computeRouteId('acme/widgets#7@' + 'e'.repeat(40));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-'));
  logPath = path.join(dir, 'outcomes.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string, script: string, executable = true): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${script}\n`);
  fs.chmodSync(file, executable ? 0o755 : 0o644);
  return file;
};

const candidate = (name: string, argv0: string): CandidateConfig => ({
  name,
  argv: [argv0],
  lineage: name,
  capabilities: ['pr-review', 'lang:*', 'risk:*'],
  static_priority: 10,
  enabled: true,
});

const opts = (
  ranked: CandidateConfig[],
  overrides: Partial<DispatchOptions> = {},
): DispatchOptions => ({
  routeId: ROUTE_ID,
  ranked,
  taskJson: '{"repo":"acme/widgets","pr":7}',
  maxAttempts: 3,
  timeoutMs: 4000,
  logPath,
  observedAt: '2026-07-23T12:00:00Z',
  ...overrides,
});

const okScript = (name: string): string =>
  `cat > /dev/null; echo "{\\"format\\":1,\\"status\\":\\"completed\\",\\"executed_agent\\":\\"${name}\\"}"`;

describe('happy path', () => {
  it('rc=0 + parseable JSON + matching executor → COMPLETED exit 0 + terminal event', async () => {
    const result = await dispatchReview(
      opts([candidate('claude', fixture('ok.sh', okScript('claude')))]),
    );
    expect(result.state).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
    expect(result.actualExecutor).toBe('claude');
    expect(result.resultJson?.['status']).toBe('completed');
    const log = readOutcomeLog(logPath);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]!['terminal_state']).toBe('COMPLETED');
    expect(log.events[0]!.event_id).toBe(computeDispatchTerminalId(ROUTE_ID));
  });

  it('task JSON arrives on the agent stdin', async () => {
    const sink = path.join(dir, 'seen.json');
    const result = await dispatchReview(
      opts([candidate('claude', fixture('stdin.sh', `cat > ${sink}; echo "{}"`))]),
    );
    expect(result.state).toBe('COMPLETED');
    expect(fs.readFileSync(sink, 'utf8')).toBe('{"repo":"acme/widgets","pr":7}');
  });
});

describe('NO_ELIGIBLE_AGENT', () => {
  it('empty pool → exit 7, frozen message, zero side effects', async () => {
    const result = await dispatchReview(opts([]));
    expect(result.state).toBe('NO_ELIGIBLE_AGENT');
    expect(result.exitCode).toBe(7);
    expect(result.message).toBe(NO_ELIGIBLE_AGENT_MESSAGE);
    expect(fs.existsSync(logPath)).toBe(false);
  });
});

describe('prestart-fallback (pre-Task-1 test)', () => {
  it('missing binary (ENOENT) provably never spawned → falls back to next candidate', async () => {
    const result = await dispatchReview(
      opts([
        candidate('codex', path.join(dir, 'does-not-exist')),
        candidate('claude', fixture('ok2.sh', okScript('claude'))),
      ]),
    );
    expect(result.state).toBe('COMPLETED');
    expect(result.actualExecutor).toBe('claude');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ candidate: 'codex', verdict: 'never-spawned' });
    expect(result.attempts[0]!.detail).toMatch(/ENOENT|EACCES/);
    expect(result.attempts[1]).toStrictEqual({
      candidate: 'claude',
      verdict: 'completed',
      detail: 'exit:0',
    });
  });

  it('non-executable binary (EACCES) also falls back', async () => {
    const result = await dispatchReview(
      opts([
        candidate('codex', fixture('noexec.sh', 'echo hi', false)),
        candidate('claude', fixture('ok3.sh', okScript('claude'))),
      ]),
    );
    expect(result.state).toBe('COMPLETED');
    expect(result.attempts[0]!.verdict).toBe('never-spawned');
  });

  it('ALL candidates never spawned → DISPATCH_FAILED exit 7', async () => {
    const result = await dispatchReview(
      opts([
        candidate('codex', path.join(dir, 'nope-a')),
        candidate('claude', path.join(dir, 'nope-b')),
      ]),
    );
    expect(result.state).toBe('DISPATCH_FAILED');
    expect(result.exitCode).toBe(7);
    expect(readOutcomeLog(logPath).events[0]!['terminal_state']).toBe('DISPATCH_FAILED');
  });

  it('respects maxAttempts: at most N candidates tried', async () => {
    const result = await dispatchReview(
      opts(
        [
          candidate('a', path.join(dir, 'nope-1')),
          candidate('b', path.join(dir, 'nope-2')),
          candidate('c', fixture('ok4.sh', okScript('c'))),
        ],
        { maxAttempts: 2 },
      ),
    );
    expect(result.state).toBe('DISPATCH_FAILED');
    expect(result.attempts).toHaveLength(2);
  });
});

describe('post-spawn-no-fallback (pre-Task-1 test)', () => {
  it('non-zero exit after a real spawn → EFFECT_UNKNOWN exit 8, chain STOPS', async () => {
    const result = await dispatchReview(
      opts([
        candidate('codex', fixture('fail.sh', 'cat > /dev/null; exit 3')),
        candidate('claude', fixture('ok5.sh', okScript('claude'))),
      ]),
    );
    expect(result.state).toBe('EFFECT_UNKNOWN');
    expect(result.exitCode).toBe(8);
    expect(result.message).toBe(EFFECT_UNKNOWN_MESSAGE);
    // claude was NEVER tried — the chain stopped at the spawned failure
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      candidate: 'codex',
      verdict: 'effect-unknown',
      detail: 'exit:3',
    });
  });

  it('timeout after spawn → EFFECT_UNKNOWN, no fallback', async () => {
    const result = await dispatchReview(
      opts([
        candidate('codex', fixture('hang.sh', 'cat > /dev/null; sleep 30')),
        candidate('claude', fixture('ok6.sh', okScript('claude'))),
      ]),
    );
    expect(result.state).toBe('EFFECT_UNKNOWN');
    expect(result.attempts).toStrictEqual([
      { candidate: 'codex', verdict: 'effect-unknown', detail: 'timeout' },
    ]);
  }, 10_000);

  it('rc=0 but unparseable stdout → EFFECT_UNKNOWN (the agent DID run)', async () => {
    const result = await dispatchReview(
      opts([candidate('codex', fixture('garbage.sh', 'cat > /dev/null; echo not-json'))]),
    );
    expect(result.state).toBe('EFFECT_UNKNOWN');
    expect(result.attempts[0]!.detail).toBe('unparseable-output');
  });

  it('rc=0 but claimed executor mismatches → EFFECT_UNKNOWN', async () => {
    const result = await dispatchReview(
      opts([candidate('codex', fixture('liar.sh', okScript('somebody-else')))]),
    );
    expect(result.state).toBe('EFFECT_UNKNOWN');
    expect(result.attempts[0]!.detail).toBe('executor-mismatch');
    expect(readOutcomeLog(logPath).events[0]!['actual_executor']).toBeNull();
  });
});

describe('timeout override', () => {
  it('uses the configured timeout, not a hardcoded one', async () => {
    const started = Date.now();
    const result = await dispatchReview(
      opts([candidate('codex', fixture('hang2.sh', 'cat > /dev/null; sleep 30'))], {
        timeoutMs: 500,
      }),
    );
    expect(result.state).toBe('EFFECT_UNKNOWN');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
