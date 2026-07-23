import { randomBytes } from 'node:crypto';

/**
 * Exact Beta sampler for the AgentDex PR-review routing slice.
 *
 * Frozen contract (consolidated spec 2026-07-23, §B2 + R4 amendment):
 * - Every routing decision carries its own 128-bit OS-random seed, persisted
 *   with the `route.decided` event; replay MUST reuse the stored seed and
 *   reproduce the draw bit-for-bit.
 * - Sampling is EXACT Beta(α, β) — the pre-existing allocation-score path
 *   (κ=4 bench prior + clipped-Gaussian approximation) is explicitly not
 *   reusable here: under Beta(1,1) that approximation is not uniform.
 * - Posterior parameters are positive integers by construction: the prior is
 *   Beta(1,1) and every learnable outcome increments exactly one of α/β by 1.
 *   For integer parameters, Beta(α, β) = X/(X+Y) with X = Σ_α Exp(1) and
 *   Y = Σ_β Exp(1) is exact in distribution AND consumes a fixed, parameter-
 *   determined number of uniforms (α+β), which keeps replay stable: a replayed
 *   draw consumes exactly the same PRNG stream positions as the original.
 *
 * PRNG: xoshiro256++ seeded by one splitmix64 chain that absorbs the two
 * 64-bit seed halves sequentially (see expandSeed for why not two parallel
 * chains). Not cryptographic — it does not need to be; the seed is
 * attribution/replay material, not a secret. Zero runtime dependencies
 * (node:crypto only, for seed generation).
 */

const MASK64 = (1n << 64n) - 1n;

const SEED_HEX_RE = /^[0-9a-f]{32}$/;

export interface PosteriorEntry {
  readonly candidateId: string;
  /** Successes + 1 (prior). Positive integer. */
  readonly alpha: number;
  /** Failures + 1 (prior). Positive integer. */
  readonly beta: number;
}

export interface PosteriorDraw {
  readonly candidateId: string;
  /** Exact Beta(alpha, beta) sample in (0, 1). */
  readonly sample: number;
}

export interface BetaSampler {
  /** Draw one exact Beta(alpha, beta) sample. Consumes exactly alpha+beta uniforms. */
  betaSample(alpha: number, beta: number): number;
  /**
   * Draw one sample per posterior entry, in the exact order given. The caller
   * owns the ordering contract: the routing layer MUST pass candidates in the
   * frozen canonical order (static_priority ascending, then candidate name by
   * UTF-8 byte order) so that replay consumes identical stream positions.
   */
  drawPosteriors(entries: ReadonlyArray<PosteriorEntry>): ReadonlyArray<PosteriorDraw>;
  /** Uniforms consumed so far — audit/replay diagnostic. */
  uniformsConsumed(): number;
}

/** Generate a fresh 128-bit OS-random route seed (32 lowercase hex chars). */
export const newRouteSeed = (): string => randomBytes(16).toString('hex');

/** Strict validation: exactly 32 lowercase hex chars. Returns the seed or throws. */
export const parseRouteSeed = (seedHex: string): string => {
  if (!SEED_HEX_RE.test(seedHex)) {
    throw new Error(
      `invalid route seed: expected 32 lowercase hex characters, got ${JSON.stringify(seedHex)}`,
    );
  }
  return seedHex;
};

const splitmix64 = (state: bigint): { next: bigint; out: bigint } => {
  let z = (state + 0x9e3779b97f4a7c15n) & MASK64;
  const next = z;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return { next, out: z & MASK64 };
};

const rotl = (x: bigint, k: bigint): bigint => ((x << k) | (x >> (64n - k))) & MASK64;

interface XoshiroState {
  s0: bigint;
  s1: bigint;
  s2: bigint;
  s3: bigint;
}

const expandSeed = (seedHex: string): XoshiroState => {
  const hi = BigInt(`0x${seedHex.slice(0, 16)}`);
  const lo = BigInt(`0x${seedHex.slice(16, 32)}`);
  // One splitmix64 chain absorbing both halves SEQUENTIALLY. An earlier
  // draft ran two parallel chains (one per half) and XORed their outputs;
  // that construction cancels to the all-zero state whenever hi == lo — a
  // whole seed class collapsing onto one PRNG stream (caught by the seed-
  // divergence test). Sequential absorption cannot cancel: by the time `lo`
  // is folded in, the chain state is already a mixed function of `hi`.
  const words: bigint[] = [];
  let chain = hi;
  for (let i = 0; i < 2; i += 1) {
    const step = splitmix64(chain);
    chain = step.next;
    words.push(step.out);
  }
  chain ^= lo;
  for (let i = 0; i < 2; i += 1) {
    const step = splitmix64(chain);
    chain = step.next;
    words.push(step.out);
  }
  const state: XoshiroState = { s0: words[0]!, s1: words[1]!, s2: words[2]!, s3: words[3]! };
  if (state.s0 === 0n && state.s1 === 0n && state.s2 === 0n && state.s3 === 0n) {
    // xoshiro must never sit in the all-zero fixed point. Unreachable in
    // practice (splitmix64 output), guarded anyway.
    state.s0 = 0x9e3779b97f4a7c15n;
  }
  return state;
};

const nextU64 = (st: XoshiroState): bigint => {
  const result = (rotl((st.s0 + st.s3) & MASK64, 23n) + st.s0) & MASK64;
  const t = (st.s1 << 17n) & MASK64;
  st.s2 ^= st.s0;
  st.s3 ^= st.s1;
  st.s1 ^= st.s2;
  st.s0 ^= st.s3;
  st.s2 ^= t;
  st.s3 = rotl(st.s3, 45n);
  return result;
};

const assertPositiveInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${name} must be a positive integer (Beta(1,1) prior + unit increments), got ${value}`,
    );
  }
};

/**
 * Create a deterministic sampler from a stored route seed. Two samplers built
 * from the same seed produce identical draw sequences — this is the
 * exact-sampler-replay guarantee the pre-live test suite pins.
 */
export const createBetaSampler = (seedHex: string): BetaSampler => {
  const state = expandSeed(parseRouteSeed(seedHex));
  let consumed = 0;

  const nextUniform = (): number => {
    consumed += 1;
    // 53-bit mantissa in [0, 1).
    return Number(nextU64(state) >> 11n) / 2 ** 53;
  };

  // Exp(1) via inverse CDF; -log(1-u) maps [0,1) to [0, ∞) without ever
  // taking log(0).
  const nextExp = (): number => -Math.log(1 - nextUniform());

  const betaSample = (alpha: number, beta: number): number => {
    assertPositiveInteger(alpha, 'alpha');
    assertPositiveInteger(beta, 'beta');
    let x = 0;
    for (let i = 0; i < alpha; i += 1) x += nextExp();
    let y = 0;
    for (let i = 0; i < beta; i += 1) y += nextExp();
    const sample = x / (x + y);
    // Clamp the (measure-zero, float-edge) endpoints into the open interval so
    // downstream ranking never sees a hard 0/1 certainty from a single draw.
    if (sample <= 0) return Number.MIN_VALUE;
    if (sample >= 1) return 1 - Number.EPSILON;
    return sample;
  };

  const drawPosteriors = (entries: ReadonlyArray<PosteriorEntry>): ReadonlyArray<PosteriorDraw> =>
    entries.map((entry) => ({
      candidateId: entry.candidateId,
      sample: betaSample(entry.alpha, entry.beta),
    }));

  return { betaSample, drawPosteriors, uniformsConsumed: () => consumed };
};
