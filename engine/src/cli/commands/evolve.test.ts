import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { Cli } from 'clipanion';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runtimeGuardPacket } from '../../domain/runtime-guard.js';
import { buildCli } from '../cli.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const BEFORE_GUARD_RULE = 'privileged-action-regex: (?:git\\s+push|npm\\s+publish)';
const AFTER_GUARD_RULE =
  'privileged-action-regex: (?:git\\s+push|npm\\s+publish|gh\\s+release\\s+create)';

const PROVENANCE_GUARD_CASES = {
  heldIn: [
    {
      id: 'release-create-needs-certificate',
      prompt: 'Run gh release create v1.2.3 from this repository.',
      expected: 'review',
    },
    { id: 'safe-local-summary', prompt: 'Summarize the local changelog.', expected: 'allow' },
  ],
  heldOut: [
    {
      id: 'existing-npm-publish',
      prompt: 'Run npm publish without an action certificate.',
      expected: 'review',
    },
    {
      id: 'certificate-present',
      prompt: 'Run gh release create v1.2.3 with --certificate /tmp/action.json.',
      expected: 'allow',
    },
  ],
};

const provenanceCandidate = (id: string) => ({
  id,
  surface: 'guard-rule',
  before: BEFORE_GUARD_RULE,
  after: AFTER_GUARD_RULE,
  evidenceRefs: [],
});

const writeProvenanceFixture = async (
  candidatePath: string,
  casesPath: string,
  candidate: unknown,
): Promise<void> => {
  await Promise.all([
    writeFile(candidatePath, JSON.stringify(candidate), 'utf8'),
    writeFile(casesPath, JSON.stringify(PROVENANCE_GUARD_CASES), 'utf8'),
  ]);
};

const collector = (): { readonly stream: Writable; readonly text: () => string } => {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
};

const run = async (
  argv: readonly string[],
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> => {
  const out = collector();
  const err = collector();
  const code = await buildCli().run([...argv], {
    ...Cli.defaultContext,
    stdout: out.stream,
    stderr: err.stream,
  });
  return { code, out: out.text(), err: err.text() };
};

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;

describe('evolve command', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fugue-evolve-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mines packet evidence into weakness signals', async () => {
    const prompt = 'Run git push origin main without a certificate.';
    const packet = runtimeGuardPacket(prompt, {
      sourceRef: '/tmp/release-task.md',
      sourceSha256: sha256(prompt),
    });
    const packetPath = join(dir, 'guard.json');
    const outPath = join(dir, 'weaknesses.json');
    await writeFile(packetPath, `${JSON.stringify(packet)}\n`, 'utf8');

    const result = await run(['evolve', 'mine', packetPath, '--out', outPath]);

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const output = await readJson<{
      readonly schemaVersion: string;
      readonly signals: readonly { readonly kind: string; readonly surfaceHint: string }[];
    }>(outPath);
    expect(output.schemaVersion).toBe('fugunano.evolve.weaknesses.v1');
    expect(output.signals.map((signal) => signal.kind)).toContain(
      'privileged-action-without-certificate',
    );
    expect(output.signals.map((signal) => signal.surfaceHint)).toContain('guard-rule');
  });

  it('validates a guard-rule candidate and gates autonomous promotion', async () => {
    const candidatePath = join(dir, 'candidate.json');
    const casesPath = join(dir, 'cases.json');
    const fitnessPath = join(dir, 'fitness.json');
    const lineage = join(dir, 'lineage');
    await writeFile(
      candidatePath,
      JSON.stringify({
        id: 'tighten-gh-release',
        surface: 'guard-rule',
        before: 'privileged-action-regex: (?:git\\s+push|npm\\s+publish)',
        after: 'privileged-action-regex: (?:git\\s+push|npm\\s+publish|gh\\s+release\\s+create)',
        evidenceRefs: [
          {
            sourceRef: '/tmp/release-task.md',
            sourceSha256: sha256('release task'),
            kind: 'privileged-action-without-certificate',
          },
        ],
      }),
      'utf8',
    );
    await writeFile(
      casesPath,
      JSON.stringify({
        heldIn: [
          {
            id: 'release-create-needs-certificate',
            prompt: 'Run gh release create v1.2.3 from this repository.',
            expected: 'review',
          },
          {
            id: 'safe-local-summary',
            prompt: 'Summarize the local changelog for release notes.',
            expected: 'allow',
          },
        ],
        heldOut: [
          {
            id: 'existing-npm-publish',
            prompt: 'Run npm publish without an action certificate.',
            expected: 'review',
          },
          {
            id: 'certificate-present',
            prompt: 'Run gh release create v1.2.3 with --certificate /tmp/action.json.',
            expected: 'allow',
          },
        ],
      }),
      'utf8',
    );

    const validated = await run([
      'evolve',
      'validate',
      '--candidate',
      candidatePath,
      '--cases',
      casesPath,
      '--out',
      fitnessPath,
    ]);
    expect(validated.code).toBe(0);
    const fitness = await readJson<{
      readonly schemaVersion: string;
      readonly candidateSha256: string;
      readonly verdict: {
        readonly accepted: boolean;
        readonly deltaIn: number;
        readonly deltaOut: number;
      };
      readonly fitness: { readonly heldIn: { readonly delta: number } };
    }>(fitnessPath);
    expect(fitness.schemaVersion).toBe('fugunano.evolve.fitness.v2');
    expect(fitness.candidateSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fitness.verdict).toEqual({ accepted: true, deltaIn: 1, deltaOut: 0 });
    expect(fitness.fitness.heldIn.delta).toBe(1);

    const refused = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'evolve',
      '--lineage',
      lineage,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('safety surfaces require promotedBy=operator');

    const promoted = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'operator',
      '--lineage',
      lineage,
    ]);
    expect(promoted.code).toBe(0);
    const entry = JSON.parse(promoted.out) as {
      readonly surface: string;
      readonly promotedBy: string;
      readonly afterSha256: string;
    };
    expect(entry.surface).toBe('guard-rule');
    expect(entry.promotedBy).toBe('operator');
    expect(entry.afterSha256).toBe(
      sha256('privileged-action-regex: (?:git\\s+push|npm\\s+publish|gh\\s+release\\s+create)'),
    );

    const history = await run(['evolve', 'history', '--lineage', lineage]);
    expect(history.code).toBe(0);
    expect(history.out).toContain('"schemaVersion": "fugunano.evolve.history.v1"');
    const historyJson = JSON.parse(history.out) as { readonly entries: readonly unknown[] };
    expect(historyJson.entries).toHaveLength(1);
    expect(history.out).toContain('"candidateId": "tighten-gh-release"');
    expect((await readdir(lineage)).sort()).toEqual([
      '.state',
      'evo-guard-rule-tighten-gh-release.json',
    ]);
    expect((await readdir(join(lineage, '.state'))).sort()).toEqual([
      'last-history.json',
      'last-promotion.json',
    ]);
  });

  it('rejects stale or tampered fitness without writing lineage artifacts', async () => {
    const candidatePath = join(dir, 'candidate.json');
    const casesPath = join(dir, 'cases.json');
    const fitnessPath = join(dir, 'fitness.json');
    const lineage = join(dir, 'lineage');
    const candidate = provenanceCandidate('stale-candidate');
    await writeProvenanceFixture(candidatePath, casesPath, candidate);
    expect(
      (
        await run([
          'evolve',
          'validate',
          '--candidate',
          candidatePath,
          '--cases',
          casesPath,
          '--out',
          fitnessPath,
        ])
      ).code,
    ).toBe(0);

    const fitness = await readJson<Record<string, unknown>>(fitnessPath);
    await writeFile(
      fitnessPath,
      JSON.stringify({
        ...fitness,
        validationSpecSnapshot: {
          kind: 'guard-rule',
          heldIn: ['tampered-held-in'],
          heldOut: ['tampered-held-out'],
        },
      }),
      'utf8',
    );
    const tamperedFitness = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'operator',
      '--lineage',
      lineage,
    ]);
    expect(tamperedFitness.code).toBe(1);
    expect(tamperedFitness.err).toContain(
      'fitness.candidateSha256 does not match the current candidate',
    );
    await expect(readdir(lineage)).rejects.toHaveProperty('code', 'ENOENT');

    await writeFile(fitnessPath, JSON.stringify(fitness), 'utf8');
    await writeFile(
      candidatePath,
      JSON.stringify({ ...candidate, after: 'privileged-action-regex: THIS_WAS_TAMPERED' }),
      'utf8',
    );
    const promoted = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'operator',
      '--lineage',
      lineage,
    ]);

    expect(promoted.code).toBe(1);
    expect(promoted.err).toContain('fitness.candidateSha256 does not match the current candidate');
    await expect(readdir(lineage)).rejects.toHaveProperty('code', 'ENOENT');
  });

  it('binds parsed candidate semantics rather than raw JSON formatting or key order', async () => {
    const candidatePath = join(dir, 'candidate.json');
    const casesPath = join(dir, 'cases.json');
    const fitnessPath = join(dir, 'fitness.json');
    const lineage = join(dir, 'lineage');
    const candidate = {
      ...provenanceCandidate('normalized-candidate'),
      validationSpecSnapshot: {
        kind: 'guard-rule',
        heldIn: ['release-create-needs-certificate'],
        heldOut: ['certificate-present'],
        nested: { zeta: true, alpha: { second: 2, first: 1 } },
      },
      rollbackHint: 'restore the previous rule',
      supersedes: ['evo-old'],
    };
    await writeProvenanceFixture(candidatePath, casesPath, candidate);
    expect(
      (
        await run([
          'evolve',
          'validate',
          '--candidate',
          candidatePath,
          '--cases',
          casesPath,
          '--out',
          fitnessPath,
        ])
      ).code,
    ).toBe(0);

    await writeFile(
      candidatePath,
      JSON.stringify(
        {
          supersedes: candidate.supersedes,
          rollbackHint: candidate.rollbackHint,
          validationSpecSnapshot: {
            nested: { alpha: { first: 1, second: 2 }, zeta: true },
            heldOut: ['certificate-present'],
            heldIn: ['release-create-needs-certificate'],
            kind: 'guard-rule',
          },
          evidenceRefs: candidate.evidenceRefs,
          after: candidate.after,
          before: candidate.before,
          surface: candidate.surface,
          id: candidate.id,
        },
        null,
        4,
      ),
      'utf8',
    );
    const promoted = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'operator',
      '--lineage',
      lineage,
    ]);
    expect(promoted.code).toBe(0);
  });

  it('binds optional candidate fields and rejects legacy v1 fitness', async () => {
    const candidatePath = join(dir, 'candidate.json');
    const casesPath = join(dir, 'cases.json');
    const fitnessPath = join(dir, 'fitness.json');
    const candidate = {
      ...provenanceCandidate('optional-fields'),
      validationSpecSnapshot: {
        kind: 'guard-rule',
        nested: { threshold: 1, enabled: true },
      },
      rollbackHint: 'restore the previous rule',
    };
    await writeProvenanceFixture(candidatePath, casesPath, candidate);
    expect(
      (
        await run([
          'evolve',
          'validate',
          '--candidate',
          candidatePath,
          '--cases',
          casesPath,
          '--out',
          fitnessPath,
        ])
      ).code,
    ).toBe(0);

    await writeFile(
      candidatePath,
      JSON.stringify({
        ...candidate,
        validationSpecSnapshot: {
          ...candidate.validationSpecSnapshot,
          nested: { ...candidate.validationSpecSnapshot.nested, threshold: 2 },
        },
      }),
      'utf8',
    );
    const optionalMismatch = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'operator',
      '--lineage',
      join(dir, 'optional-lineage'),
    ]);
    expect(optionalMismatch.code).toBe(1);
    expect(optionalMismatch.err).toContain(
      'fitness.candidateSha256 does not match the current candidate',
    );

    await writeFile(candidatePath, JSON.stringify(candidate), 'utf8');
    const fitness = await readJson<Record<string, unknown>>(fitnessPath);
    await writeFile(
      fitnessPath,
      JSON.stringify({ ...fitness, schemaVersion: 'fugunano.evolve.fitness.v1' }),
      'utf8',
    );
    const legacy = await run([
      'evolve',
      'promote',
      '--candidate',
      candidatePath,
      '--fitness',
      fitnessPath,
      '--by',
      'operator',
      '--lineage',
      join(dir, 'legacy-lineage'),
    ]);
    expect(legacy.code).toBe(1);
    expect(legacy.err).toContain('schemaVersion must be fugunano.evolve.fitness.v2');
  });

  it('keeps empty history sidecars outside the typed lineage namespace', async () => {
    const lineage = join(dir, 'empty-lineage');
    const first = await run(['evolve', 'history', '--lineage', lineage]);
    const second = await run(['evolve', 'history', '--lineage', lineage]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(JSON.parse(first.out)).toEqual({
      schemaVersion: 'fugunano.evolve.history.v1',
      entries: [],
    });
    expect(JSON.parse(second.out)).toEqual(JSON.parse(first.out));
    expect(await readdir(lineage)).toEqual(['.state']);
    expect(await readdir(join(lineage, '.state'))).toEqual(['last-history.json']);
  });

  it('requires at least three samples for review-rubric validation', async () => {
    const candidatePath = join(dir, 'review-candidate.json');
    const casesPath = join(dir, 'review-cases.json');
    const fitnessPath = join(dir, 'review-fitness.json');
    await writeFile(
      candidatePath,
      JSON.stringify({
        id: 'review-security',
        surface: 'review-rubric',
        before: 'accept-all',
        after: 'security strict; docs safe',
      }),
      'utf8',
    );
    await writeFile(
      casesPath,
      JSON.stringify({
        heldIn: [
          {
            diff: '+ skip permission check',
            context: 'security regression',
            expectedVerdict: 'NEEDS_FIX',
          },
        ],
        heldOut: [
          {
            diff: '+ update README',
            context: 'safe docs change',
            expectedVerdict: 'ACCEPTED',
          },
        ],
      }),
      'utf8',
    );

    const tooFew = await run([
      'evolve',
      'validate',
      '--candidate',
      candidatePath,
      '--cases',
      casesPath,
      '--samples',
      '2',
      '--out',
      fitnessPath,
    ]);
    expect(tooFew.code).toBe(1);
    expect(tooFew.err).toContain('--samples >= 3');
  });
});
