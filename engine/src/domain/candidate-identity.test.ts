import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeCandidateIdentities,
  computeCandidateIdentity,
  type CandidateIdentity,
} from './candidate-identity.js';
import type { CandidateConfig } from './routing-config.js';

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

const candidate = (
  name: string,
  argv: ReadonlyArray<string>,
  overrides: Partial<CandidateConfig> = {},
): CandidateConfig => ({
  name,
  argv,
  lineage: name,
  capabilities: ['pr-review'],
  static_priority: 10,
  enabled: true,
  ...overrides,
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-identity-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('computeCandidateIdentity', () => {
  it('readable file → digest equals independently computed sha256; no error field', () => {
    const file = path.join(dir, 'ok.sh');
    const body = Buffer.from('#!/bin/bash\necho hi\n');
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
    const id = computeCandidateIdentity(candidate('codex', [file]));
    expect(id.candidateId).toBe('codex');
    expect(id.argv0Realpath).toBe(fs.realpathSync(file));
    expect(id.argv0Sha256).toBe(sha256(body));
    expect(id.argv0DigestError).toBeUndefined();
    expect(id.argvSha256).toBe(sha256(JSON.stringify([file])));
  });

  it('argv[0] is a symlink → argv0Realpath is the resolved target; digest is of target bytes', () => {
    const target = path.join(dir, 'target.sh');
    const body = Buffer.from('#!/bin/bash\necho target\n');
    fs.writeFileSync(target, body);
    fs.chmodSync(target, 0o755);
    const link = path.join(dir, 'link.sh');
    fs.symlinkSync(target, link);
    const id = computeCandidateIdentity(candidate('codex', [link]));
    expect(id.argv0Realpath).toBe(fs.realpathSync(target));
    expect(id.argv0Sha256).toBe(sha256(body));
    expect(id.argv0DigestError).toBeUndefined();
  });

  it('unreadable file → argv0Sha256 null, argv0DigestError EACCES; does not throw', () => {
    const file = path.join(dir, 'no-read.sh');
    fs.writeFileSync(file, '#!/bin/bash\necho secret\n');
    fs.chmodSync(file, 0o111);
    let id: CandidateIdentity | undefined;
    expect(() => {
      id = computeCandidateIdentity(candidate('codex', [file]));
    }).not.toThrow();
    expect(id!.argv0Sha256).toBeNull();
    expect(id!.argv0DigestError).toBe('EACCES');
  });

  it('missing file → null + ENOENT', () => {
    const missing = path.join(dir, 'does-not-exist');
    const id = computeCandidateIdentity(candidate('codex', [missing]));
    expect(id.argv0Sha256).toBeNull();
    expect(id.argv0DigestError).toBe('ENOENT');
    expect(id.argv0Realpath).toBe(missing);
  });

  it('flag-only argv difference → argvSha256 differs, argv0Sha256 identical', () => {
    const file = path.join(dir, 'bin.sh');
    fs.writeFileSync(file, '#!/bin/bash\necho bin\n');
    fs.chmodSync(file, 0o755);
    const a = computeCandidateIdentity(candidate('a', [file]));
    const b = computeCandidateIdentity(candidate('b', [file, '--verbose']));
    expect(a.argv0Sha256).toBe(b.argv0Sha256);
    expect(a.argv0Sha256).not.toBeNull();
    expect(a.argvSha256).not.toBe(b.argvSha256);
  });

  it('memoization: two candidates sharing argv[0] → equal digests, one entry each', () => {
    const file = path.join(dir, 'shared.sh');
    fs.writeFileSync(file, '#!/bin/bash\necho shared\n');
    fs.chmodSync(file, 0o755);
    const ids = computeCandidateIdentities([
      candidate('codex', [file]),
      candidate('claude', [file, '--flag']),
    ]);
    expect(ids).toHaveLength(2);
    expect(ids[0]!.candidateId).toBe('codex');
    expect(ids[1]!.candidateId).toBe('claude');
    expect(ids[0]!.argv0Sha256).toBe(ids[1]!.argv0Sha256);
    expect(ids[0]!.argv0Realpath).toBe(ids[1]!.argv0Realpath);
    expect(ids[0]!.argvSha256).not.toBe(ids[1]!.argvSha256);
  });

  it('wrapper-drift: overwrite file bytes → different argv0Sha256, same path', () => {
    const file = path.join(dir, 'wrap.sh');
    fs.writeFileSync(file, '#!/bin/bash\necho v1\n');
    fs.chmodSync(file, 0o755);
    const before = computeCandidateIdentity(candidate('codex', [file]));
    fs.writeFileSync(file, '#!/bin/bash\necho v2-drifted\n');
    const after = computeCandidateIdentity(candidate('codex', [file]));
    expect(after.argv0Realpath).toBe(before.argv0Realpath);
    expect(after.argv0Sha256).not.toBe(before.argv0Sha256);
    expect(after.argv0Sha256).not.toBeNull();
  });
});

describe('candidate_identities non-consumption pin (D3)', () => {
  it('only builder/producer files mention candidate_identities / candidateIdentities', () => {
    // Audit-only in v1: fold stays name-keyed. This pin fails the moment a
    // consumer starts reading the field — delete it when an identity policy lands.
    const srcRoot = path.join(import.meta.dirname, '..');
    const producers = [
      path.join(srcRoot, 'domain', 'candidate-identity.ts'),
      path.join(srcRoot, 'domain', 'review-dispatch.ts'),
      path.join(srcRoot, 'domain', 'route-posterior.ts'),
    ].sort();
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          const text = fs.readFileSync(full, 'utf8');
          // Property ACCESS (.field / ['field']), not bare identifiers —
          // mirrors routing-config.test.ts reserved-fields (F4) pin.
          if (/(\.|\[')(candidate_identities|candidateIdentities)\b/u.test(text)) {
            found.push(full);
          }
        }
      }
    };
    walk(srcRoot);
    // SUBSET, not equality: the claim is that nothing OUTSIDE the producer
    // allowlist touches the field. Whether a given producer trips the
    // access-regex is incidental plumbing — demanding equality forced the
    // producers into wire-key ceremony purely to satisfy this pin.
    const outsiders = found.filter((f) => !producers.includes(f));
    expect(outsiders).toStrictEqual([]);
  });
});
