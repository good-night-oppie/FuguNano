import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeAttemptId, computeRouteId, readOutcomeLog } from './outcome-log.js';
import { runReviewDispatch, type ReviewDispatchDeps } from './review-dispatch.js';

let dir: string;
let configPath: string;
let stateDir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatch-'));
  configPath = path.join(dir, 'routing.json');
  stateDir = path.join(dir, 'state');
  logPath = path.join(stateDir, 'agentdex', 'pr-review-outcomes-v1.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string, script: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
};

const okScript = (name: string): string =>
  `cat > /dev/null; echo "{\\"format\\":1,\\"status\\":\\"completed\\",\\"executed_agent\\":\\"${name}\\",\\"result_ref\\":\\"gh-review-${name}\\"}"`;

interface CandidateSpec {
  readonly name: string;
  readonly argv: string[];
  readonly lineage?: string;
  readonly priority?: number;
}

const writeConfig = (candidates: CandidateSpec[]): void => {
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      format: 1,
      dispatch_timeout_seconds: 5,
      slot_wait_seconds: 300,
      max_attempts: 3,
      max_in_flight: 2,
      candidates: candidates.map((c, i) => ({
        name: c.name,
        argv: c.argv,
        lineage: c.lineage ?? c.name,
        capabilities: ['pr-review', 'lang:*', 'risk:*'],
        static_priority: c.priority ?? (i + 1) * 10,
        enabled: true,
      })),
    }),
  );
};

const PROFILE = {
  repo: 'acme/widgets',
  pr: 7,
  head_sha: 'e'.repeat(40),
  author_lineage: 'human:alice',
  languages: ['python'],
  changed_paths: ['src/app.py'],
  risk_tags: [],
};
const TASK_ID = `acme/widgets#7@${'e'.repeat(40)}`;
const ROUTE_ID = computeRouteId(TASK_ID);
const SEED = 'a'.repeat(32);

const deps = (overrides: Partial<ReviewDispatchDeps> = {}): ReviewDispatchDeps => ({
  env: {
    AGENTDEX_ROUTING_CONFIG: configPath,
    XDG_STATE_HOME: stateDir,
    HOME: dir,
  },
  now: () => new Date('2026-07-23T12:00:00Z'),
  seed: SEED,
  ...overrides,
});

const run = (
  profile: Record<string, unknown> = PROFILE,
  arm = 'static',
  d: ReviewDispatchDeps = deps(),
  cohortIndexRaw?: string,
): ReturnType<typeof runReviewDispatch> =>
  runReviewDispatch(JSON.stringify(profile), arm, d, cohortIndexRaw);

describe('cohort_index admission', () => {
  it('absent 4th arg → machine JSON and route.decided carry cohort_index: null', async () => {
    writeConfig([{ name: 'codex', argv: [fixture('codex.sh', okScript('codex'))] }]);
    const { machine, exitCode } = await run();
    expect(exitCode).toBe(0);
    expect(machine['cohort_index']).toBeNull();
    expect(readOutcomeLog(logPath).events[0]!['cohort_index']).toBeNull();
  });

  it('empty cohort_index string → invalid_input exit 2, zero side effects', async () => {
    const marker = path.join(dir, 'empty-cohort-spawn');
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('empty-c.sh', `cat > /dev/null; touch ${marker}; echo "{}"`)],
      },
    ]);
    const { machine, exitCode } = await run(PROFILE, 'static', deps(), '');
    expect(exitCode).toBe(2);
    expect(machine['status']).toBe('invalid_input');
    expect(machine['reason']).toMatch(/cohort_index must be a decimal integer/);
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('non-integer cohort_index → invalid_input exit 2, zero side effects', async () => {
    writeConfig([{ name: 'codex', argv: [fixture('x.sh', okScript('codex'))] }]);
    for (const raw of ['3.5', 'abc']) {
      const { machine, exitCode } = await run(PROFILE, 'static', deps(), raw);
      expect(exitCode).toBe(2);
      expect(machine['status']).toBe('invalid_input');
      expect(fs.existsSync(logPath)).toBe(false);
    }
  });

  it("'4' + static → parity fail, invalid_input, log untouched, candidate never ran", async () => {
    const marker = path.join(dir, 'parity-spawn');
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('parity.sh', `cat > /dev/null; touch ${marker}; echo "{}"`)],
      },
    ]);
    const { machine, exitCode } = await run(PROFILE, 'static', deps(), '4');
    expect(exitCode).toBe(2);
    expect(machine['status']).toBe('invalid_input');
    expect(machine['reason']).toMatch(/parity/);
    expect(fs.existsSync(logPath)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("'4' + thompson → exit 0, event carries cohort_index: 4", async () => {
    writeConfig([{ name: 'codex', argv: [fixture('ok.sh', okScript('codex'))] }]);
    const { machine, exitCode } = await run(PROFILE, 'thompson', deps(), '4');
    expect(exitCode).toBe(0);
    expect(machine['cohort_index']).toBe(4);
    expect(readOutcomeLog(logPath).events[0]!['cohort_index']).toBe(4);
  });

  it('replay guard: same index is duplicate-noop; different index is DUPLICATE_ID_CONFLICT', async () => {
    const marker = path.join(dir, 'cohort-replays');
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('creplay.sh', `cat > /dev/null; echo run >> ${marker}; echo "{}"`)],
      },
    ]);
    expect((await run(PROFILE, 'static', deps(), '5')).exitCode).toBe(0);
    // Same index → byte-identical route.decided → duplicate-noop refusal.
    const same = await run(PROFILE, 'static', deps(), '5');
    expect(same.exitCode).toBe(74);
    expect(same.machine['status']).toBe('state_error');
    expect(same.machine['reason']).toMatch(/refusing to re-dispatch/);
    // Different index → payload differs → DUPLICATE_ID_CONFLICT (same route_id).
    const different = await run(PROFILE, 'thompson', deps(), '6');
    expect(different.exitCode).toBe(74);
    expect(different.machine['status']).toBe('state_error');
    expect(fs.readFileSync(marker, 'utf8')).toBe('run\n');
  });

  it('no_eligible_agent with cohortIndex 5 echoes it but does not consume the index', async () => {
    writeConfig([
      { name: 'claude-code', argv: [fixture('z.sh', okScript('claude-code'))], lineage: 'claude' },
    ]);
    const { machine, exitCode } = await run(
      { ...PROFILE, author_lineage: 'claude' },
      'static',
      deps(),
      '5',
    );
    expect(exitCode).toBe(7);
    expect(machine['status']).toBe('no_eligible_agent');
    expect(machine['cohort_index']).toBe(5);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('no_eligible out-of-range cohort_index → invalid_input exit 2, not exit 7', async () => {
    writeConfig([
      { name: 'claude-code', argv: [fixture('z2.sh', okScript('claude-code'))], lineage: 'claude' },
    ]);
    const { machine, exitCode } = await run(
      { ...PROFILE, author_lineage: 'claude' },
      'static',
      deps(),
      '999',
    );
    expect(exitCode).toBe(2);
    expect(machine['status']).toBe('invalid_input');
    expect(machine['reason']).toMatch(/1\.\.50/);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('no_eligible parity-mismatched cohort_index → invalid_input exit 2, not exit 7', async () => {
    writeConfig([
      { name: 'claude-code', argv: [fixture('z3.sh', okScript('claude-code'))], lineage: 'claude' },
    ]);
    // 4 is even → thompson; policy_arm static is a parity miss.
    const { machine, exitCode } = await run(
      { ...PROFILE, author_lineage: 'claude' },
      'static',
      deps(),
      '4',
    );
    expect(exitCode).toBe(2);
    expect(machine['status']).toBe('invalid_input');
    expect(machine['reason']).toMatch(/parity/);
    expect(fs.existsSync(logPath)).toBe(false);
  });
});

describe('hot path', () => {
  it('static arm end-to-end: COMPLETED machine JSON + route.decided + dispatch.terminal', async () => {
    writeConfig([{ name: 'codex', argv: [fixture('codex.sh', okScript('codex'))] }]);
    const { machine, exitCode } = await run();
    expect(exitCode).toBe(0);
    expect(machine).toMatchObject({
      format: 1,
      status: 'completed',
      task_id: TASK_ID,
      route_id: ROUTE_ID,
      policy_arm: 'static',
      selected_agent: 'codex',
      executed_agent: 'codex',
      attempt_id: computeAttemptId(ROUTE_ID, 'codex'),
      reason:
        'Selected codex because it was eligible and holds the best fixed priority (lowest number wins).',
      result_ref: 'gh-review-codex',
    });
    const log = readOutcomeLog(logPath);
    expect(log.events.map((e) => e.event_type)).toStrictEqual([
      'route.decided',
      'dispatch.terminal',
    ]);
    expect(log.events[0]).toMatchObject({
      policy_arm: 'static',
      candidate_id: 'codex',
      seed: SEED,
      deadline_at: '2026-07-30T12:00:00.000Z', // routed_at + 168h
      profile_facets: {
        author_lineage: 'human:alice',
        languages: ['python'],
        risk_tags: [],
        changed_path_count: 1,
      },
    });
    expect(log.events[0]!['profile_sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('route.decided carries candidate_identities matching the fixture script digest', async () => {
    const scriptPath = fixture('codex.sh', okScript('codex'));
    writeConfig([{ name: 'codex', argv: [scriptPath] }]);
    const { exitCode } = await run();
    expect(exitCode).toBe(0);
    const decided = readOutcomeLog(logPath).events[0]!;
    const expectedSha = createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
    const identities = decided['candidate_identities'] as ReadonlyArray<Record<string, unknown>>;
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      candidate_id: 'codex',
      argv0_sha256: expectedSha,
    });
    expect(String(identities[0]!['argv0_realpath'])).toBe(fs.realpathSync(scriptPath));
    expect(identities[0]!['argv0_digest_error']).toBeUndefined();
  });

  it('missing-binary fallback: never-spawned candidate gets ENOENT identity; dispatch proceeds', async () => {
    const missing = path.join(dir, 'does-not-exist');
    const ok = fixture('ok.sh', okScript('claude'));
    writeConfig([
      { name: 'codex', argv: [missing], priority: 10 },
      { name: 'claude', argv: [ok], priority: 20 },
    ]);
    const { machine, exitCode } = await run();
    expect(exitCode).toBe(0);
    expect(machine['executed_agent']).toBe('claude');
    const decided = readOutcomeLog(logPath).events[0]!;
    const identities = decided['candidate_identities'] as ReadonlyArray<Record<string, unknown>>;
    expect(identities).toHaveLength(2);
    expect(identities[0]).toMatchObject({
      candidate_id: 'codex',
      argv0_sha256: null,
      argv0_digest_error: 'ENOENT',
    });
    expect(identities[1]).toMatchObject({
      candidate_id: 'claude',
      argv0_sha256: createHash('sha256').update(fs.readFileSync(ok)).digest('hex'),
    });
  });

  it('a credential-shaped changed_path rides only inside the profile digest, never the payload', async () => {
    writeConfig([{ name: 'codex', argv: [fixture('codex.sh', okScript('codex'))] }]);
    // Would trip the secret tripwire if the path appeared on the event; the
    // digest-only design is what keeps a large or hostile diff dispatchable.
    const trap = `docs/ghp_${'a'.repeat(20)}.md`;
    const { exitCode } = await run({ ...PROFILE, changed_paths: [trap, 'src/app.py'].sort() });
    expect(exitCode).toBe(0);
    const decided = readOutcomeLog(logPath).events[0]!;
    expect(JSON.stringify(decided)).not.toContain('ghp_');
    expect(decided['profile_sha256']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('thompson arm: seeded, deterministic, one-line explain', async () => {
    writeConfig([
      { name: 'codex', argv: [fixture('c1.sh', okScript('codex'))] },
      { name: 'claude', argv: [fixture('c2.sh', okScript('claude'))] },
    ]);
    const first = await run(PROFILE, 'thompson');
    expect(first.exitCode).toBe(0);
    expect(first.machine['reason']).toMatch(/ranked first under Thompson sampling for this PR\.$/);
    const ranked1 = readOutcomeLog(logPath).events[0]!['ranked_candidates'];
    // Same seed + same posterior (fresh log dir) → identical ranking for a
    // different PR: the draw depends only on seed and canonical order.
    const second = await run({ ...PROFILE, pr: 8 }, 'thompson');
    expect(second.exitCode).toBe(0);
    const ranked2 = readOutcomeLog(logPath).events[2]!['ranked_candidates'];
    expect(ranked2).toStrictEqual(ranked1);
  });

  it('a thompson route.decided carries the posterior snapshot it consumed (replay self-containment)', async () => {
    writeConfig([
      { name: 'codex', argv: [fixture('p1.sh', okScript('codex'))] },
      { name: 'claude', argv: [fixture('p2.sh', okScript('claude'))] },
    ]);
    expect((await run(PROFILE, 'thompson')).exitCode).toBe(0);
    const decided = readOutcomeLog(logPath).events[0]!;
    // canonical order: static_priority asc → codex(10), claude(20)
    expect(decided['posteriors']).toStrictEqual([
      { candidate_id: 'codex', alpha: 1, beta: 1 },
      { candidate_id: 'claude', alpha: 1, beta: 1 },
    ]);
    // static routes carry none
    const second = await run({ ...PROFILE, pr: 9 }, 'static');
    expect(second.exitCode).toBe(0);
    expect(readOutcomeLog(logPath).events[2]!['posteriors']).toBeUndefined();
  });

  it('the candidate stdin payload carries route_id, attempt_id, marker, and the full profile', async () => {
    const sink = path.join(dir, 'seen.json');
    writeConfig([{ name: 'codex', argv: [fixture('sink.sh', `cat > ${sink}; echo "{}"`)] }]);
    const { exitCode } = await run();
    expect(exitCode).toBe(0);
    const seen = JSON.parse(fs.readFileSync(sink, 'utf8')) as Record<string, unknown>;
    const attemptId = computeAttemptId(ROUTE_ID, 'codex');
    expect(seen).toStrictEqual({
      format: 1,
      task_type: 'pr-review',
      route_id: ROUTE_ID,
      attempt_id: attemptId,
      marker: `<!-- agentdex:route=${ROUTE_ID};attempt=${attemptId} -->`,
      profile: PROFILE,
    });
  });

  it('dispatch.terminal.observed_at is the terminal time, not a copy of routed_at', async () => {
    writeConfig([{ name: 'codex', argv: [fixture('codex.sh', okScript('codex'))] }]);
    // Advancing clock: every read is 1s later than the previous one. Routing
    // reads the first tick; terminal emission happens after the attempts ran
    // and must read a LATER tick. An observed_at copied from routing time
    // collapses the two and fails the inequality.
    let tick = 0;
    const clock = (): Date => new Date(Date.parse('2026-07-23T12:00:00Z') + 1000 * tick++);
    const { exitCode } = await run(PROFILE, 'static', deps({ now: clock }));
    expect(exitCode).toBe(0);
    const log = readOutcomeLog(logPath);
    const decided = log.events[0]!;
    const terminal = log.events[1]!;
    expect(decided['routed_at']).toBe('2026-07-23T12:00:00.000Z');
    expect(terminal['observed_at']).not.toBe(decided['routed_at']);
    // Fixed-precision ISO-8601 UTC compares lexicographically as time.
    expect(String(terminal['observed_at']) > String(decided['routed_at'])).toBe(true);
  });
});

describe('frozen failure taxonomy', () => {
  it('invalid profile → invalid_input exit 2, zero side effects', async () => {
    writeConfig([{ name: 'codex', argv: [fixture('x.sh', okScript('codex'))] }]);
    const { machine, exitCode } = await run({ ...PROFILE, repo: 'ACME/Widgets' });
    expect(exitCode).toBe(2);
    expect(machine['status']).toBe('invalid_input');
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('unknown policy arm and missing config are invalid_input', async () => {
    writeConfig([{ name: 'codex', argv: [fixture('y.sh', okScript('codex'))] }]);
    expect((await run(PROFILE, 'greedy')).exitCode).toBe(2);
    fs.rmSync(configPath);
    expect((await run()).exitCode).toBe(2);
  });

  it('no eligible candidate (same lineage) → exit 7, frozen sentence, NO route created', async () => {
    // A claude-family-authored PR with only a claude-family reviewer on file.
    writeConfig([
      { name: 'claude-code', argv: [fixture('z.sh', okScript('claude-code'))], lineage: 'claude' },
    ]);
    const { machine, exitCode } = await run({ ...PROFILE, author_lineage: 'claude' });
    expect(exitCode).toBe(7);
    expect(machine['status']).toBe('no_eligible_agent');
    expect(machine['reason']).toBe(
      'No eligible PR-review agent is available; no agent was started.',
    );
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('an exact replay (same seed + clock) → duplicate-noop refusal, state_error 74, agent NOT re-run', async () => {
    const marker = path.join(dir, 'replays');
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('replay.sh', `cat > /dev/null; echo run >> ${marker}; echo "{}"`)],
      },
    ]);
    expect((await run()).exitCode).toBe(0);
    // Identical deps → byte-identical route.decided → append is a no-op,
    // and the dispatch MUST NOT run again (duplicate external effect).
    const replay = await run();
    expect(replay.exitCode).toBe(74);
    expect(replay.machine['status']).toBe('state_error');
    expect(replay.machine['reason']).toMatch(/refusing to re-dispatch/);
    expect(fs.readFileSync(marker, 'utf8')).toBe('run\n');
  });

  it('re-dispatching the same task under a new seed → duplicate-route conflict, state_error 74, agent NOT re-run', async () => {
    const marker = path.join(dir, 'runs');
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('count.sh', `cat > /dev/null; echo run >> ${marker}; echo "{}"`)],
      },
    ]);
    expect((await run()).exitCode).toBe(0);
    const again = await run(PROFILE, 'static', deps({ seed: 'b'.repeat(32) }));
    expect(again.exitCode).toBe(74);
    expect(again.machine['status']).toBe('state_error');
    expect(fs.readFileSync(marker, 'utf8')).toBe('run\n'); // exactly one execution
  });

  it('corrupt log stops the dispatch before any candidate runs → state_error 74', async () => {
    const marker = path.join(dir, 'ran');
    writeConfig([
      { name: 'codex', argv: [fixture('mark.sh', `cat > /dev/null; touch ${marker}; echo "{}"`)] },
    ]);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '{"torn'); // no trailing newline: torn write
    const { machine, exitCode } = await run();
    expect(exitCode).toBe(74);
    expect(machine['status']).toBe('state_error');
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('secret-scan (pre-Task-1 test)', () => {
  it('a candidate smuggling a credential-shaped result_ref is caught; nothing tainted leaves', async () => {
    const canary = `sk-${'canary0123456789'.repeat(2)}`;
    writeConfig([
      {
        name: 'codex',
        argv: [
          fixture(
            'leak.sh',
            `cat > /dev/null; echo "{\\"format\\":1,\\"executed_agent\\":\\"codex\\",\\"result_ref\\":\\"${canary}\\"}"`,
          ),
        ],
      },
    ]);
    const { machine, exitCode } = await run();
    expect(exitCode).toBe(74);
    expect(machine['status']).toBe('state_error');
    // The reason names the FIELD PATH, never the value.
    expect(machine['reason']).toMatch(/machine\.result_ref/);
    expect(JSON.stringify(machine)).not.toContain(canary);
  });

  it('a credential-shaped byte sequence reaching an ERROR reason is withheld, not echoed (error path never throws)', async () => {
    // The config path itself carries a credential-shaped name; the
    // cannot-read error message would otherwise embed it in the reason.
    const canaryPath = path.join(dir, `sk-${'errcanary012345678'.repeat(2)}.json`);
    const d = deps();
    const result = await run(PROFILE, 'static', {
      ...d,
      env: { ...d.env, AGENTDEX_ROUTING_CONFIG: canaryPath },
    });
    expect(result.exitCode).toBe(2);
    expect(result.machine['status']).toBe('invalid_input');
    expect(result.machine['reason']).toMatch(/withheld/);
    expect(JSON.stringify(result.machine)).not.toContain('errcanary');
  });

  it('a canary credential in the environment reaches neither machine JSON nor the event log', async () => {
    const canary = `ghp_${'A1b2C3d4E5'.repeat(3)}`;
    writeConfig([{ name: 'codex', argv: [fixture('clean.sh', okScript('codex'))] }]);
    const d = deps();
    const result = await run(PROFILE, 'static', {
      ...d,
      env: { ...d.env, GITHUB_TOKEN: canary },
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.stringify(result.machine)).not.toContain(canary);
    expect(fs.readFileSync(logPath, 'utf8')).not.toContain(canary);
  });
});

describe('literal-loopback (pre-Task-1 test)', () => {
  it('a config naming a local endpoint as localhost fails closed before any spawn', async () => {
    const marker = path.join(dir, 'spawned');
    writeConfig([
      {
        name: 'codex',
        argv: [
          fixture('local.sh', `cat > /dev/null; touch ${marker}; echo "{}"`),
          '--endpoint',
          'http://localhost:3456/v1',
        ],
      },
    ]);
    const { machine, exitCode } = await run();
    expect(exitCode).toBe(2);
    expect(machine['status']).toBe('invalid_input');
    expect(machine['reason']).toMatch(/not literal 127\.0\.0\.1 or ::1/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('the literal spellings pass and the dispatch proceeds', async () => {
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('lit.sh', okScript('codex')), '--endpoint', 'http://127.0.0.1:3456/v1'],
      },
    ]);
    expect((await run()).exitCode).toBe(0);
  });
});
