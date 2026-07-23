import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DispatchAutoCommand } from './dispatch-auto.js';
import { DispatchCommand } from './dispatch.js';

let dir: string;
let configPath: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['AGENTDEX_ROUTING_CONFIG', 'XDG_STATE_HOME'] as const;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auto-'));
  configPath = path.join(dir, 'routing.json');
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env['AGENTDEX_ROUTING_CONFIG'] = configPath;
  process.env['XDG_STATE_HOME'] = path.join(dir, 'state');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const fixture = (name: string, script: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/bash\n${script}\n`);
  fs.chmodSync(file, 0o755);
  return file;
};

const writeConfig = (argv0: string): void => {
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
          argv: [argv0],
          lineage: 'codex',
          capabilities: ['pr-review', 'lang:*', 'risk:*'],
          static_priority: 10,
          enabled: true,
        },
      ],
    }),
  );
};

const PROFILE = JSON.stringify({
  repo: 'acme/widgets',
  pr: 7,
  head_sha: 'e'.repeat(40),
  author_lineage: 'human:alice',
  languages: ['python'],
  changed_paths: ['src/app.py'],
  risk_tags: [],
});

const buildCli = (): Cli => {
  const cli = new Cli({ binaryName: 'fugue' });
  cli.register(DispatchCommand);
  cli.register(DispatchAutoCommand);
  return cli;
};

const AUTO_ARGV = ['dispatch', '--auto', '--task-type', 'pr-review', '--policy-arm', 'static'];

const runAuto = async (
  argv: string[],
  stdinText: string,
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

describe('command resolution on the shared dispatch path', () => {
  it('--auto resolves to DispatchAutoCommand; a positional target resolves to DispatchCommand', () => {
    const cli = buildCli();
    expect(cli.process([...AUTO_ARGV, '--json'])).toBeInstanceOf(DispatchAutoCommand);
    expect(cli.process(['dispatch', 'cc-kimi', '--prompt', 'hi'])).toBeInstanceOf(DispatchCommand);
  });
});

describe('machine JSON contract', () => {
  it('happy path: exit 0, one machine-JSON object on stdout, --json accepted', async () => {
    writeConfig(
      fixture(
        'ok.sh',
        `cat > /dev/null; echo "{\\"format\\":1,\\"executed_agent\\":\\"codex\\",\\"result_ref\\":\\"r1\\"}"`,
      ),
    );
    const { code, machine } = await runAuto([...AUTO_ARGV, '--json'], PROFILE);
    expect(code).toBe(0);
    expect(machine).toMatchObject({
      format: 1,
      status: 'completed',
      selected_agent: 'codex',
      executed_agent: 'codex',
      result_ref: 'r1',
    });
  });

  it('rejects a task type other than pr-review with machine JSON, exit 2', async () => {
    writeConfig(fixture('x.sh', 'cat > /dev/null; echo "{}"'));
    const { code, machine } = await runAuto(
      ['dispatch', '--auto', '--task-type', 'weekly-report', '--policy-arm', 'static'],
      PROFILE,
    );
    expect(code).toBe(2);
    expect(machine['status']).toBe('invalid_input');
  });

  it('invalid stdin profile → machine JSON invalid_input, exit 2', async () => {
    writeConfig(fixture('y.sh', 'cat > /dev/null; echo "{}"'));
    const { code, machine } = await runAuto(AUTO_ARGV, 'not-json');
    expect(code).toBe(2);
    expect(machine['status']).toBe('invalid_input');
  });

  it('missing --policy-arm / --task-type still produce the machine-JSON envelope, exit 2 (never clipanion usage text)', async () => {
    writeConfig(fixture('m.sh', 'cat > /dev/null; echo "{}"'));
    const noArm = await runAuto(['dispatch', '--auto', '--task-type', 'pr-review'], PROFILE);
    expect(noArm.code).toBe(2);
    expect(noArm.machine['status']).toBe('invalid_input');
    const noType = await runAuto(['dispatch', '--auto', '--policy-arm', 'static'], PROFILE);
    expect(noType.code).toBe(2);
    expect(noType.machine['status']).toBe('invalid_input');
  });

  it('a credential-shaped unknown profile key still yields one machine-JSON object, exit 2, nothing echoed', async () => {
    writeConfig(fixture('s.sh', 'cat > /dev/null; echo "{}"'));
    const canaryKey = 'sk-AAAAAAAAAAAAAAAAAA';
    const poisoned = PROFILE.replace('{', `{"${canaryKey}":1,`);
    const { code, machine } = await runAuto(AUTO_ARGV, poisoned);
    expect(code).toBe(2); // frozen taxonomy — never clipanion's exit 1 + stack trace
    expect(machine['status']).toBe('invalid_input');
    expect(JSON.stringify(machine)).not.toContain(canaryKey);
  });

  it('unknown policy arm → machine JSON invalid_input, exit 2', async () => {
    writeConfig(fixture('z.sh', 'cat > /dev/null; echo "{}"'));
    const { code, machine } = await runAuto(
      ['dispatch', '--auto', '--task-type', 'pr-review', '--policy-arm', 'greedy'],
      PROFILE,
    );
    expect(code).toBe(2);
    expect(machine['status']).toBe('invalid_input');
  });
});
