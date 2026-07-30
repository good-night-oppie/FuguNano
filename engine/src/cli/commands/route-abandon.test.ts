import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendOutcomeEvent,
  computeRouteId,
  computeTaskId,
  readOutcomeLog,
} from '../../domain/outcome-log.js';
import { buildRouteDecided } from '../../domain/route-posterior.js';
import { computeCandidateIdentities } from '../../domain/candidate-identity.js';
import { eligibleReviewers, rankReviewers } from '../../domain/eligible-reviewers.js';
import { loadRoutingConfig } from '../../domain/routing-config.js';
import {
  computeProfileSha256,
  parseTaskProfile,
  profileFacets,
} from '../../domain/task-profile.js';
import { RouteAbandonCommand, RouteCommand } from './route.js';

let dir: string;
let configPath: string;
let stateDir: string;
let logPath: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['AGENTDEX_ROUTING_CONFIG', 'XDG_STATE_HOME'] as const;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-abandon-'));
  configPath = path.join(dir, 'routing.json');
  stateDir = path.join(dir, 'state');
  logPath = path.join(stateDir, 'agentdex', 'pr-review-outcomes-v1.jsonl');
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env['AGENTDEX_ROUTING_CONFIG'] = configPath;
  process.env['XDG_STATE_HOME'] = stateDir;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const PROFILE = {
  repo: 'acme/widgets',
  pr: 7,
  head_sha: 'e'.repeat(40),
  author_lineage: 'human:alice',
  languages: ['python'],
  changed_paths: ['src/app.py'],
  risk_tags: [],
};

const TASK_ID = computeTaskId(PROFILE.repo, PROFILE.pr, PROFILE.head_sha);
const SEED = 'a'.repeat(32);

const writeConfig = (): void => {
  const script = path.join(dir, 'codex.sh');
  fs.writeFileSync(
    script,
    `#!/bin/bash\ncat > /dev/null; echo '{"format":1,"executed_agent":"codex","result_ref":"r"}'\n`,
  );
  fs.chmodSync(script, 0o755);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      format: 1,
      dispatch_timeout_seconds: 5,
      slot_wait_seconds: 300,
      max_attempts: 3,
      max_in_flight: 2,
      candidates: [
        {
          name: 'codex',
          argv: [script],
          lineage: 'codex',
          capabilities: ['pr-review', 'lang:*', 'risk:*'],
          static_priority: 10,
          enabled: true,
        },
      ],
    }),
  );
};

const seedDecidedOnly = (): string => {
  writeConfig();
  const loaded = loadRoutingConfig(process.env);
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
    retryEpoch: 0,
    supersedesRouteId: null,
  });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  appendOutcomeEvent(logPath, event);
  return event.route_id;
};

const buildCli = (): Cli => {
  const cli = new Cli({ binaryName: 'fugue' });
  cli.register(RouteCommand);
  cli.register(RouteAbandonCommand);
  return cli;
};

const runAbandon = async (
  argv: string[],
  stdinText = '',
): Promise<{ code: number; machine: Record<string, unknown> }> => {
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
  });
  const code = await buildCli().run(argv, {
    stdin: Readable.from([stdinText]),
    stdout,
    stderr: new PassThrough(),
  });
  return { code, machine: JSON.parse(out) as Record<string, unknown> };
};

describe('fugue route abandon', () => {
  it('resolves to RouteAbandonCommand', () => {
    expect(buildCli().process(['route', 'abandon', '--task-id', 'x'])).toBeInstanceOf(
      RouteAbandonCommand,
    );
  });

  it('stdin profile abandons a crash-window route', async () => {
    const routeId = seedDecidedOnly();
    expect(routeId).toBe(computeRouteId(TASK_ID, 0));
    const { code, machine } = await runAbandon(['route', 'abandon'], JSON.stringify(PROFILE));
    expect(code).toBe(0);
    expect(machine).toMatchObject({
      status: 'completed',
      route_id: routeId,
      retry_epoch: 0,
    });
    const events = readOutcomeLog(logPath).events;
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      event_type: 'outcome.finalized',
      outcome: 'CENSORED',
      reason_code: 'operator_abandoned',
    });
  });

  it('--task-id form abandons without a full profile on stdin', async () => {
    seedDecidedOnly();
    const { code, machine } = await runAbandon(['route', 'abandon', '--task-id', TASK_ID]);
    expect(code).toBe(0);
    expect(machine['status']).toBe('completed');
    expect(machine['task_id']).toBe(TASK_ID);
  });

  it('refuses a malformed --task-id with invalid_input exit 2', async () => {
    const { code, machine } = await runAbandon(['route', 'abandon', '--task-id', 'not-a-task-id']);
    expect(code).toBe(2);
    expect(machine['status']).toBe('invalid_input');
    expect(machine['reason']).toMatch(/task-id must be repo#pr@head_sha/);
  });

  it('refuses a pr past MAX_SAFE_INTEGER — Number() would silently rename the task', async () => {
    const { code, machine } = await runAbandon([
      'route',
      'abandon',
      '--task-id',
      `acme/widgets#99999999999999999999@${'e'.repeat(40)}`,
    ]);
    expect(code).toBe(2);
    expect(machine['status']).toBe('invalid_input');
    expect(machine['reason']).toMatch(/safe integer/);
  });
});
