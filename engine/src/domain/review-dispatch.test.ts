import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendOutcomeEvent,
  computeAttemptId,
  computeRouteId,
  readOutcomeLog,
} from './outcome-log.js';
import { buildOutcomeFinalized, buildRouteDecided } from './route-posterior.js';
import {
  abandonReviewRoute,
  MAX_RETRY_EPOCHS,
  runReviewDispatch,
  type ReviewDispatchDeps,
} from './review-dispatch.js';
import { computeProfileSha256, profileFacets, parseTaskProfile } from './task-profile.js';
import { computeCandidateIdentities } from './candidate-identity.js';
import { loadRoutingConfig } from './routing-config.js';
import { eligibleReviewers, rankReviewers } from './eligible-reviewers.js';

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

  it('replay guard: same or different cohort index → duplicate_route 74, agent NOT re-run', async () => {
    const marker = path.join(dir, 'cohort-replays');
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('creplay.sh', `cat > /dev/null; echo run >> ${marker}; echo "{}"`)],
      },
    ]);
    expect((await run(PROFILE, 'static', deps(), '5')).exitCode).toBe(0);
    // Same index → prior COMPLETED → duplicate_route (pre-append gate).
    const same = await run(PROFILE, 'static', deps(), '5');
    expect(same.exitCode).toBe(74);
    expect(same.machine['status']).toBe('duplicate_route');
    expect(same.machine['prior_terminal_state']).toBe('COMPLETED');
    expect(same.machine['retryable']).toBe(false);
    // Different index would have been DUPLICATE_ID_CONFLICT under the old
    // append-site check; the pre-append gate now seals duplicate_route first.
    const different = await run(PROFILE, 'thompson', deps(), '6');
    expect(different.exitCode).toBe(74);
    expect(different.machine['status']).toBe('duplicate_route');
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

  it('an exact replay (same seed + clock) → duplicate_route 74, agent NOT re-run', async () => {
    const marker = path.join(dir, 'replays');
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('replay.sh', `cat > /dev/null; echo run >> ${marker}; echo "{}"`)],
      },
    ]);
    expect((await run()).exitCode).toBe(0);
    // Identical deps → prior COMPLETED → duplicate_route; agent MUST NOT re-run.
    const replay = await run();
    expect(replay.exitCode).toBe(74);
    expect(replay.machine['status']).toBe('duplicate_route');
    expect(replay.machine['prior_terminal_state']).toBe('COMPLETED');
    expect(replay.machine['retryable']).toBe(false);
    expect(replay.machine['reason']).toMatch(/refusing to re-dispatch/);
    expect(fs.readFileSync(marker, 'utf8')).toBe('run\n');
  });

  it('re-dispatching the same task under a new seed → duplicate_route 74, agent NOT re-run', async () => {
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
    expect(again.machine['status']).toBe('duplicate_route');
    expect(again.machine['prior_terminal_state']).toBe('COMPLETED');
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

describe('retry epoch + duplicate_route (D4)', () => {
  const missingBin = (): string => path.join(dir, 'does-not-exist-binary');

  const seedRouteDecidedOnly = (
    retryEpoch = 0,
    supersedesRouteId: string | null = null,
  ): string => {
    writeConfig([{ name: 'codex', argv: [fixture('seed-ok.sh', okScript('codex'))] }]);
    const loaded = loadRoutingConfig(deps().env);
    const profile = parseTaskProfile(JSON.stringify(PROFILE));
    const eligible = eligibleReviewers(loaded.config.candidates, {
      authorLineage: profile.authorLineage,
      languages: profile.languages,
      riskTags: profile.riskTags,
    });
    const rank = rankReviewers(eligible, 'static', { seed: SEED });
    const event = buildRouteDecided({
      repo: profile.repo,
      prNumber: profile.pr,
      headSha: profile.headSha,
      policyArm: 'static',
      cohortIndex: null,
      candidateId: rank.ranked[0]!.name,
      rankedCandidates: rank.ranked.map((c) => c.name),
      candidateIdentities: computeCandidateIdentities(rank.ranked),
      seed: SEED,
      configSha256: loaded.configSha256,
      profileSha256: computeProfileSha256(profile),
      profileFacets: profileFacets(profile),
      routedAt: '2026-07-23T12:00:00.000Z',
      deadlineAt: '2026-07-30T12:00:00.000Z',
      retryEpoch,
      supersedesRouteId,
    });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    appendOutcomeEvent(logPath, event);
    return event.route_id;
  };

  it('all-candidates preflight fail → DISPATCH_FAILED; re-dispatch opens epoch 1 and COMPLETED', async () => {
    const marker = path.join(dir, 'epoch1-runs');
    writeConfig([
      { name: 'codex', argv: [missingBin()], priority: 10 },
      { name: 'claude', argv: [missingBin()], priority: 20 },
    ]);
    const first = await run();
    expect(first.exitCode).toBe(7);
    expect(first.machine['status']).toBe('dispatch_failed');
    expect(first.machine['route_id']).toBe(ROUTE_ID);
    const afterFail = readOutcomeLog(logPath).events;
    expect(afterFail.map((e) => e.event_type)).toStrictEqual([
      'route.decided',
      'dispatch.terminal',
    ]);
    expect(afterFail[0]!['retry_epoch']).toBe(0);
    expect(afterFail[1]!['terminal_state']).toBe('DISPATCH_FAILED');

    // Repair config: one candidate that works.
    writeConfig([
      {
        name: 'codex',
        argv: [
          fixture(
            'repaired.sh',
            `cat > /dev/null; echo run >> ${marker}; echo "{\\"format\\":1,\\"executed_agent\\":\\"codex\\",\\"result_ref\\":\\"r1\\"}"`,
          ),
        ],
      },
    ]);
    const second = await run(PROFILE, 'static', deps({ seed: 'c'.repeat(32) }));
    expect(second.exitCode).toBe(0);
    expect(second.machine['status']).toBe('completed');
    const epoch1Id = computeRouteId(TASK_ID, 1);
    expect(second.machine['route_id']).toBe(epoch1Id);
    const log = readOutcomeLog(logPath).events;
    expect(log.filter((e) => e.event_type === 'route.decided')).toHaveLength(2);
    expect(log.filter((e) => e.event_type === 'dispatch.terminal')).toHaveLength(2);
    const decided1 = log.find((e) => e.event_type === 'route.decided' && e.route_id === epoch1Id)!;
    expect(decided1['retry_epoch']).toBe(1);
    expect(decided1['supersedes_route_id']).toBe(ROUTE_ID);
    expect(fs.readFileSync(marker, 'utf8')).toBe('run\n');
  });

  it('COMPLETED then re-dispatch → duplicate_route with prior_terminal_state COMPLETED', async () => {
    const marker = path.join(dir, 'completed-once');
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('once.sh', `cat > /dev/null; echo run >> ${marker}; echo "{}"`)],
      },
    ]);
    expect((await run()).exitCode).toBe(0);
    const again = await run();
    expect(again.exitCode).toBe(74);
    expect(again.machine).toMatchObject({
      status: 'duplicate_route',
      route_id: ROUTE_ID,
      retry_epoch: 0,
      prior_terminal_state: 'COMPLETED',
      retryable: false,
    });
    expect(readOutcomeLog(logPath).events).toHaveLength(2);
    expect(fs.readFileSync(marker, 'utf8')).toBe('run\n');
  });

  it('EFFECT_UNKNOWN is non-retryable; abandon refuses; re-dispatch stays duplicate_route', async () => {
    writeConfig([
      {
        name: 'codex',
        argv: [fixture('boom.sh', 'cat > /dev/null; echo nope; exit 1')],
      },
    ]);
    const first = await run();
    expect(first.exitCode).toBe(8);
    expect(first.machine['status']).toBe('effect_unknown');
    const again = await run();
    expect(again.exitCode).toBe(74);
    expect(again.machine['status']).toBe('duplicate_route');
    expect(again.machine['prior_terminal_state']).toBe('EFFECT_UNKNOWN');
    const abandoned = abandonReviewRoute(
      { repo: PROFILE.repo, pr: PROFILE.pr, headSha: PROFILE.head_sha },
      deps(),
    );
    expect(abandoned.exitCode).toBe(74);
    expect(abandoned.machine['status']).toBe('duplicate_route');
    expect(abandoned.machine['reason']).toMatch(/dispatch\.terminal already exists/);
    const still = await run();
    expect(still.machine['status']).toBe('duplicate_route');
    expect(still.machine['prior_terminal_state']).toBe('EFFECT_UNKNOWN');
    expect(readOutcomeLog(logPath).events.map((e) => e.event_type)).toStrictEqual([
      'route.decided',
      'dispatch.terminal',
    ]);
  });

  it('crash window: decided-only refuses; abandon unlocks epoch 1', async () => {
    const epoch0Id = seedRouteDecidedOnly();
    expect(epoch0Id).toBe(ROUTE_ID);
    const refused = await run(PROFILE, 'static', deps({ seed: 'd'.repeat(32) }));
    expect(refused.exitCode).toBe(74);
    expect(refused.machine).toMatchObject({
      status: 'duplicate_route',
      prior_terminal_state: null,
      retry_epoch: 0,
      retryable: false,
    });
    expect(readOutcomeLog(logPath).events).toHaveLength(1);

    const abandoned = abandonReviewRoute(
      { repo: PROFILE.repo, pr: PROFILE.pr, headSha: PROFILE.head_sha },
      deps(),
    );
    expect(abandoned.exitCode).toBe(0);
    expect(abandoned.machine['status']).toBe('completed');
    const afterAbandon = readOutcomeLog(logPath).events;
    expect(afterAbandon).toHaveLength(2);
    expect(afterAbandon[1]).toMatchObject({
      event_type: 'outcome.finalized',
      outcome: 'CENSORED',
      reason_code: 'operator_abandoned',
      actual_executor: null,
      route_id: ROUTE_ID,
    });

    const marker = path.join(dir, 'after-abandon');
    writeConfig([
      {
        name: 'codex',
        argv: [
          fixture(
            'post-abandon.sh',
            `cat > /dev/null; echo run >> ${marker}; echo "{\\"format\\":1,\\"executed_agent\\":\\"codex\\",\\"result_ref\\":\\"r\\"}"`,
          ),
        ],
      },
    ]);
    const retry = await run(PROFILE, 'static', deps({ seed: 'e'.repeat(32) }));
    expect(retry.exitCode).toBe(0);
    expect(retry.machine['route_id']).toBe(computeRouteId(TASK_ID, 1));
    expect(fs.readFileSync(marker, 'utf8')).toBe('run\n');
  });

  it('epoch cap: epochs 0..3 DISPATCH_FAILED → next attempt is duplicate_route, no epoch 4', async () => {
    for (let epoch = 0; epoch <= MAX_RETRY_EPOCHS; epoch += 1) {
      writeConfig([{ name: 'codex', argv: [missingBin()] }]);
      const result = await run(
        PROFILE,
        'static',
        deps({ seed: epoch.toString(16).padStart(32, '0') }),
      );
      expect(result.exitCode).toBe(7);
      expect(result.machine['status']).toBe('dispatch_failed');
      expect(result.machine['route_id']).toBe(computeRouteId(TASK_ID, epoch));
    }
    const capped = await run(PROFILE, 'static', deps({ seed: 'f'.repeat(32) }));
    expect(capped.exitCode).toBe(74);
    expect(capped.machine).toMatchObject({
      status: 'duplicate_route',
      retry_epoch: MAX_RETRY_EPOCHS,
      prior_terminal_state: 'DISPATCH_FAILED',
      retryable: false,
    });
    expect(capped.machine['reason']).toMatch(/retry epoch cap reached/);
    const decided = readOutcomeLog(logPath).events.filter((e) => e.event_type === 'route.decided');
    expect(decided).toHaveLength(MAX_RETRY_EPOCHS + 1);
    expect(decided.every((e) => (e['retry_epoch'] as number) <= MAX_RETRY_EPOCHS)).toBe(true);
    expect(computeRouteId(TASK_ID, 4)).not.toBe(decided[decided.length - 1]!.route_id);
  });

  it('abandon fails closed when outcome.finalized already exists with a different reason_code', () => {
    const routeId = seedRouteDecidedOnly();
    appendOutcomeEvent(
      logPath,
      buildOutcomeFinalized({
        repo: PROFILE.repo,
        prNumber: PROFILE.pr,
        headSha: PROFILE.head_sha,
        outcome: 'CENSORED',
        reasonCode: 'human_override',
        actualExecutor: null,
        evidenceEventIds: [routeId],
        verifiedAt: null,
        observedAt: '2026-07-23T12:05:00.000Z',
        retryEpoch: 0,
      }),
    );
    const before = fs.readFileSync(logPath, 'utf8');
    const result = abandonReviewRoute(
      { repo: PROFILE.repo, pr: PROFILE.pr, headSha: PROFILE.head_sha },
      deps(),
    );
    expect(result.exitCode).toBe(74);
    expect(result.machine['status']).toBe('duplicate_route');
    expect(result.machine['reason']).toMatch(/outcome\.finalized already exists/);
    expect(fs.readFileSync(logPath, 'utf8')).toBe(before);
  });
});
