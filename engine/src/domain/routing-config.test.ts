import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoDuplicateKeys,
  CONFIG_ENV_OVERRIDE,
  loadRoutingConfig,
  parseRoutingConfig,
  resolveConfigPath,
} from './routing-config.js';

const good = (): Record<string, unknown> => ({
  format: 1,
  dispatch_timeout_seconds: 3600,
  slot_wait_seconds: 300,
  max_attempts: 3,
  max_in_flight: 2,
  candidates: [
    {
      name: 'codex',
      argv: ['/opt/agentdex/bin/codex-review'],
      lineage: 'codex',
      capabilities: ['pr-review', 'lang:*', 'risk:*'],
      static_priority: 10,
      enabled: true,
    },
    {
      name: 'claude',
      argv: ['/opt/agentdex/bin/claude-review'],
      lineage: 'claude',
      capabilities: ['pr-review', 'lang:*', 'risk:*'],
      static_priority: 20,
      enabled: true,
    },
  ],
});

const raw = (mutate: (config: Record<string, unknown>) => void = () => undefined): string => {
  const config = good();
  mutate(config);
  return JSON.stringify(config);
};

describe('resolveConfigPath (R4-1 rules)', () => {
  it('canonical path under XDG_CONFIG_HOME, else HOME/.config', () => {
    expect(resolveConfigPath({ XDG_CONFIG_HOME: '/etc/xdg' })).toBe(
      '/etc/xdg/agentdex/pr-review-routing-v1.json',
    );
    expect(resolveConfigPath({ HOME: '/home/eddie' })).toBe(
      '/home/eddie/.config/agentdex/pr-review-routing-v1.json',
    );
  });

  it('override must be a non-empty absolute path — no relative, no tilde, no empty', () => {
    expect(resolveConfigPath({ [CONFIG_ENV_OVERRIDE]: '/abs/config.json' })).toBe(
      '/abs/config.json',
    );
    for (const bad of ['', 'relative/config.json', '~/config.json']) {
      expect(() => resolveConfigPath({ [CONFIG_ENV_OVERRIDE]: bad })).toThrow(/absolute/);
    }
  });

  it('fails closed with no HOME, or relative XDG_CONFIG_HOME', () => {
    expect(() => resolveConfigPath({})).toThrow(/HOME missing/);
    expect(() => resolveConfigPath({ XDG_CONFIG_HOME: 'rel' })).toThrow(/must be absolute/);
  });
});

describe('duplicate-key rejection before JSON.parse (R4-1 catch)', () => {
  it('rejects root-level duplicates that JSON.parse would silently last-win', () => {
    expect(() => assertNoDuplicateKeys('{"a":1,"a":2}')).toThrow(/duplicate object key/);
  });

  it('compares keys DECODED: an escape-spelled twin cannot shadow a live key', () => {
    // "\u0061" decodes to "a" — JSON.parse would last-win silently.
    expect(() => assertNoDuplicateKeys('{"a":1,"\\u0061":2}')).toThrow(/duplicate object key/);
    expect(() => assertNoDuplicateKeys('{"a\\tb":1,"a\tb":2}')).toThrow(/duplicate object key/);
    // distinct decoded keys stay legal even when escape-spelled
    expect(() => assertNoDuplicateKeys('{"a":1,"\\u0062":2}')).not.toThrow();
  });

  it('rejects duplicates at any depth', () => {
    expect(() => assertNoDuplicateKeys('{"outer":{"list":[{"x":1,"y":2,"x":3}]}}')).toThrow(
      /duplicate object key/,
    );
  });

  it('same key in sibling objects is fine; braces inside strings do not confuse it', () => {
    expect(() => assertNoDuplicateKeys('[{"a":1},{"a":2}]')).not.toThrow();
    expect(() => assertNoDuplicateKeys('{"a":"}{","b":"{\\"a\\":1}"}')).not.toThrow();
    expect(() => assertNoDuplicateKeys('{"a":"x","b":{"a":1}}')).not.toThrow();
  });

  it('parseRoutingConfig runs the scan (duplicate inside a candidate)', () => {
    const poisoned = raw().replace('"static_priority":10', '"static_priority":10,"enabled":false');
    expect(poisoned).not.toBe(raw()); // replace must have matched
    // poisoned now has two "enabled" keys in candidate 0 once the original follows
    expect(() => parseRoutingConfig(poisoned)).toThrow(/duplicate object key/);
  });
});

describe('schema validation — fail closed', () => {
  it('accepts the frozen example shape', () => {
    const config = parseRoutingConfig(raw());
    expect(config.candidates).toHaveLength(2);
    expect(config.candidates[0]!.name).toBe('codex');
  });

  it.each([
    ['unknown root field', (c: Record<string, unknown>) => (c['extra'] = 1), /unknown field extra/],
    [
      'missing root field',
      (c: Record<string, unknown>) => delete c['max_attempts'],
      /missing field max_attempts/,
    ],
    ['unknown format', (c: Record<string, unknown>) => (c['format'] = 2), /unknown format 2/],
    [
      'non-integer timeout',
      (c: Record<string, unknown>) => (c['dispatch_timeout_seconds'] = 3.5),
      /positive integer/,
    ],
    [
      'zero max_in_flight',
      (c: Record<string, unknown>) => (c['max_in_flight'] = 0),
      /positive integer/,
    ],
    ['empty candidates', (c: Record<string, unknown>) => (c['candidates'] = []), /non-empty array/],
  ])('rejects %s', (_label, mutate, pattern) => {
    expect(() => parseRoutingConfig(raw(mutate))).toThrow(pattern);
  });

  const candidateMutant = (
    change: (candidate: Record<string, unknown>) => void,
  ): ((config: Record<string, unknown>) => void) => {
    return (config) => {
      change((config['candidates'] as Record<string, unknown>[])[0]!);
    };
  };

  it.each([
    ['unknown candidate field', candidateMutant((c) => (c['model'] = 'x')), /unknown field model/],
    ['relative argv[0]', candidateMutant((c) => (c['argv'] = ['bin/review'])), /absolute path/],
    ['empty argv', candidateMutant((c) => (c['argv'] = [])), /non-empty array/],
    ['empty capabilities', candidateMutant((c) => (c['capabilities'] = [])), /non-empty array/],
    [
      'free-form lineage alias (ER-1)',
      candidateMutant((c) => (c['lineage'] = 'claude-code')),
      /known worker family/,
    ],
    [
      'miscased capability token (ER-2)',
      candidateMutant((c) => (c['capabilities'] = ['pr-review', 'lang:Python', 'risk:*'])),
      /not a known capability token/,
    ],
    [
      'misspelled capability token (ER-2)',
      candidateMutant((c) => (c['capabilities'] = ['pr-review', 'lang:pyton', 'risk:*'])),
      /not a known capability token/,
    ],
    [
      'unknown capability namespace (ER-2)',
      candidateMutant((c) => (c['capabilities'] = ['pr-review', 'bug-triage'])),
      /not a known capability token/,
    ],
    [
      'missing pr-review capability (ER-2)',
      candidateMutant((c) => (c['capabilities'] = ['lang:*', 'risk:*'])),
      /must include pr-review/,
    ],
    ['non-boolean enabled', candidateMutant((c) => (c['enabled'] = 'yes')), /boolean/],
    ['zero priority', candidateMutant((c) => (c['static_priority'] = 0)), /positive integer/],
  ])('rejects %s', (_label, mutate, pattern) => {
    expect(() => parseRoutingConfig(raw(mutate))).toThrow(pattern);
  });

  it('rejects duplicate candidate names and duplicate priorities', () => {
    expect(() =>
      parseRoutingConfig(
        raw((c) => {
          (c['candidates'] as { name: string }[])[1]!.name = 'codex';
        }),
      ),
    ).toThrow(/duplicate candidate name codex/);
    expect(() =>
      parseRoutingConfig(
        raw((c) => {
          (c['candidates'] as { static_priority: number }[])[1]!.static_priority = 10;
        }),
      ),
    ).toThrow(/duplicate static_priority 10/);
  });

  it('rejects non-object top level and invalid JSON', () => {
    expect(() => parseRoutingConfig('[1,2]')).toThrow(/top level must be a JSON object/);
    expect(() => parseRoutingConfig('{oops')).toThrow(/not valid JSON|duplicate|unterminated/);
    expect(() => parseRoutingConfig('{"format": NaN}')).toThrow(/not valid JSON/);
  });
});

describe('loadRoutingConfig — bytes hash', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads via override and hashes the exact bytes', () => {
    const file = path.join(dir, 'config.json');
    const body = raw();
    fs.writeFileSync(file, body);
    const loaded = loadRoutingConfig({ [CONFIG_ENV_OVERRIDE]: file });
    expect(loaded.configPath).toBe(file);
    expect(loaded.config.candidates).toHaveLength(2);
    // whitespace-only change → different hash (bytes, not semantics)
    fs.writeFileSync(file, `${body}\n`);
    const reloaded = loadRoutingConfig({ [CONFIG_ENV_OVERRIDE]: file });
    expect(reloaded.configSha256).not.toBe(loaded.configSha256);
  });

  it('missing file fails closed with the path named', () => {
    const missing = path.join(dir, 'nope.json');
    expect(() => loadRoutingConfig({ [CONFIG_ENV_OVERRIDE]: missing })).toThrow(/cannot read/);
  });
});
