import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  createBetaSampler,
  newRouteSeed,
  parseRouteSeed,
  type PosteriorEntry,
} from './beta-sampler.js';

const SEED_A = '0123456789abcdef0123456789abcdef';
const SEED_B = 'fedcba9876543210fedcba9876543210';

const seedArb = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((bytes) => Buffer.from(bytes).toString('hex'));

describe('parseRouteSeed — strict 128-bit hex', () => {
  it('accepts exactly 32 lowercase hex chars', () => {
    expect(parseRouteSeed(SEED_A)).toBe(SEED_A);
  });

  it.each([
    ['too short', '0123456789abcdef'],
    ['too long', `${SEED_A}00`],
    ['uppercase', SEED_A.toUpperCase()],
    ['non-hex', 'g123456789abcdef0123456789abcdef'],
    ['empty', ''],
  ])('rejects %s', (_label, bad) => {
    expect(() => parseRouteSeed(bad)).toThrow(/invalid route seed/);
  });

  it('newRouteSeed emits valid, distinct seeds', () => {
    const a = newRouteSeed();
    const b = newRouteSeed();
    expect(parseRouteSeed(a)).toBe(a);
    expect(a).not.toBe(b);
  });
});

describe('exact-sampler-replay (pre-Task-1 test #1)', () => {
  it('same seed → bit-identical draw sequence', () => {
    const first = createBetaSampler(SEED_A);
    const second = createBetaSampler(SEED_A);
    for (let i = 0; i < 200; i += 1) {
      const alpha = (i % 7) + 1;
      const beta = (i % 5) + 1;
      expect(second.betaSample(alpha, beta)).toBe(first.betaSample(alpha, beta));
    }
  });

  it('a stored-seed replay of a ranked posterior draw is bit-identical', () => {
    const posteriors: PosteriorEntry[] = [
      { candidateId: 'claude', alpha: 4, beta: 2 },
      { candidateId: 'codex', alpha: 1, beta: 1 },
      { candidateId: 'gemini', alpha: 2, beta: 5 },
    ];
    const live = createBetaSampler(SEED_B).drawPosteriors(posteriors);
    const replay = createBetaSampler(SEED_B).drawPosteriors(posteriors);
    expect(replay).toStrictEqual(live);
  });

  it('property: any valid seed and integer params replay identically', () => {
    fc.assert(
      fc.property(
        seedArb,
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        (seed, alpha, beta) => {
          const a = createBetaSampler(seed).betaSample(alpha, beta);
          const b = createBetaSampler(seed).betaSample(alpha, beta);
          expect(b).toBe(a);
          expect(a).toBeGreaterThan(0);
          expect(a).toBeLessThan(1);
        },
      ),
    );
  });

  it('different seeds diverge', () => {
    const a = createBetaSampler(SEED_A);
    const b = createBetaSampler(SEED_B);
    const draws = 8;
    let identical = 0;
    for (let i = 0; i < draws; i += 1) {
      if (a.betaSample(1, 1) === b.betaSample(1, 1)) identical += 1;
    }
    expect(identical).toBe(0);
  });

  it('regression: hi==lo seeds must not collapse onto one stream', () => {
    // Both halves equal — the seed class that cancelled a two-parallel-chain
    // XOR expansion in the first draft. Distinct such seeds must diverge.
    const a = createBetaSampler('0123456789abcdef0123456789abcdef');
    const b = createBetaSampler('fedcba9876543210fedcba9876543210');
    const c = createBetaSampler('00000000000000000000000000000000');
    const draws = [a, b, c].map((s) => s.betaSample(1, 1));
    expect(new Set(draws).size).toBe(3);
  });

  it('property: seeds differing in only one half diverge', () => {
    fc.assert(
      fc.property(seedArb, seedArb, (s1, s2) => {
        fc.pre(s1 !== s2);
        const a = createBetaSampler(s1).betaSample(1, 1);
        const b = createBetaSampler(s2).betaSample(1, 1);
        expect(a).not.toBe(b);
      }),
    );
  });
});

describe('replay-stable uniform consumption', () => {
  it('Beta(alpha, beta) consumes exactly alpha+beta uniforms', () => {
    const s = createBetaSampler(SEED_A);
    s.betaSample(3, 4);
    expect(s.uniformsConsumed()).toBe(7);
    s.betaSample(1, 1);
    expect(s.uniformsConsumed()).toBe(9);
  });

  it('drawPosteriors consumption follows input order — prefix draws match', () => {
    const posteriors: PosteriorEntry[] = [
      { candidateId: 'x', alpha: 2, beta: 3 },
      { candidateId: 'y', alpha: 1, beta: 1 },
    ];
    const batch = createBetaSampler(SEED_A).drawPosteriors(posteriors);
    const manual = createBetaSampler(SEED_A);
    expect(batch[0]!.sample).toBe(manual.betaSample(2, 3));
    expect(batch[1]!.sample).toBe(manual.betaSample(1, 1));
  });
});

describe('exactness — distribution sanity under a fixed seed', () => {
  const N = 20_000;

  const meanOf = (alpha: number, beta: number, seed: string): number => {
    const s = createBetaSampler(seed);
    let sum = 0;
    for (let i = 0; i < N; i += 1) sum += s.betaSample(alpha, beta);
    return sum / N;
  };

  it('Beta(1,1) is uniform: mean ≈ 1/2, quartiles balanced', () => {
    const s = createBetaSampler(SEED_A);
    const counts = [0, 0, 0, 0];
    let sum = 0;
    for (let i = 0; i < N; i += 1) {
      const v = s.betaSample(1, 1);
      sum += v;
      const bucket = Math.min(3, Math.floor(v * 4));
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    expect(sum / N).toBeCloseTo(0.5, 1);
    for (const c of counts) {
      expect(c / N).toBeGreaterThan(0.23);
      expect(c / N).toBeLessThan(0.27);
    }
  });

  it('posterior means match alpha/(alpha+beta)', () => {
    expect(meanOf(3, 1, SEED_A)).toBeCloseTo(0.75, 1);
    expect(meanOf(1, 4, SEED_B)).toBeCloseTo(0.2, 1);
    expect(meanOf(10, 10, SEED_A)).toBeCloseTo(0.5, 1);
  });
});

describe('parameter validation — posterior integers only', () => {
  it.each([
    ['zero alpha', 0, 1],
    ['negative beta', 1, -2],
    ['fractional alpha', 1.5, 1],
    ['NaN beta', 1, Number.NaN],
  ])('rejects %s', (_label, alpha, beta) => {
    const s = createBetaSampler(SEED_A);
    expect(() => s.betaSample(alpha, beta)).toThrow(/positive integer/);
  });
});
