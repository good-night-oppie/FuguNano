import { createBetaSampler, type PosteriorEntry } from './beta-sampler.js';
import { OutcomeLogError, type OutcomeEvent } from './outcome-log.js';
import { foldPosteriors, type PolicyArm } from './route-posterior.js';
import type { CandidateConfig } from './routing-config.js';

/**
 * Eligibility filter + ranking for the AgentDex PR-review slice
 * (frozen baseline 2026-07-23, §B5 eligibility + §B2 rank + §B1 explain).
 *
 * Eligibility (ALL must hold; availability preflight is the dispatch
 * machine's job, not this module's):
 *   - enabled = true;
 *   - capabilities contain "pr-review";
 *   - candidate lineage differs from the PR author's agent family
 *     (an agent family never reviews its own code);
 *   - every task language is covered by "lang:<x>" or "lang:*";
 *   - every task risk tag is covered by "risk:<x>" or "risk:*".
 *
 * Canonical order (frozen): static_priority ascending, then candidate name
 * by UTF-8 byte order. This order is load-bearing twice: it fixes the
 * Thompson sampler's uniform-consumption order (replay stability) and it is
 * the static arm's whole ranking policy.
 *
 * Never widen the pool: zero eligible candidates is a typed
 * NO_ELIGIBLE_AGENT condition surfaced to the caller, not a fallback.
 */

export interface ReviewTaskFacts {
  readonly authorLineage: string;
  readonly languages: ReadonlyArray<string>;
  readonly riskTags: ReadonlyArray<string>;
}

export interface RankResult {
  readonly policyArm: PolicyArm;
  /** Eligible candidates in rank order; index 0 is the selection. */
  readonly ranked: ReadonlyArray<CandidateConfig>;
  /** Frozen one-sentence, no hidden state, no confidence numbers. */
  readonly reason: string;
  /**
   * The folded posterior the Thompson draw consumed (canonical order), so a
   * route.decided event can carry a self-contained replay tuple even if the
   * log gains events between our read and our append. Null for the static
   * arm, which consumes no posterior.
   */
  readonly posteriors: ReadonlyArray<PosteriorEntry> | null;
}

const covered = (
  needs: ReadonlyArray<string>,
  capabilities: ReadonlyArray<string>,
  prefix: 'lang' | 'risk',
): boolean =>
  needs.every(
    (need) => capabilities.includes(`${prefix}:${need}`) || capabilities.includes(`${prefix}:*`),
  );

/** Frozen canonical order: static_priority asc, then name UTF-8 byte order. */
export const canonicalOrder = (
  candidates: ReadonlyArray<CandidateConfig>,
): ReadonlyArray<CandidateConfig> =>
  [...candidates].sort(
    (a, b) =>
      a.static_priority - b.static_priority ||
      (Buffer.from(a.name, 'utf8') < Buffer.from(b.name, 'utf8') ? -1 : 1),
  );

/** Apply the eligibility rules; result keeps canonical order. */
export const eligibleReviewers = (
  candidates: ReadonlyArray<CandidateConfig>,
  task: ReviewTaskFacts,
): ReadonlyArray<CandidateConfig> =>
  canonicalOrder(candidates).filter(
    (candidate) =>
      candidate.enabled &&
      candidate.capabilities.includes('pr-review') &&
      candidate.lineage !== task.authorLineage &&
      covered(task.languages, candidate.capabilities, 'lang') &&
      covered(task.riskTags, candidate.capabilities, 'risk'),
  );

const explain = (name: string, arm: PolicyArm): string =>
  arm === 'thompson'
    ? `Selected ${name} because it was eligible and ranked first under Thompson sampling for this PR.`
    : `Selected ${name} because it was eligible and holds the highest fixed priority.`;

/**
 * Rank the eligible pool. Static: canonical order as-is. Thompson: fold the
 * posterior from the event log, draw one exact Beta sample per candidate in
 * canonical order (fixing PRNG stream positions for replay), sort by sample
 * descending with the frozen tie-break (static_priority asc, then name).
 */
export const rankReviewers = (
  eligible: ReadonlyArray<CandidateConfig>,
  policyArm: PolicyArm,
  options: { readonly seed?: string; readonly events?: ReadonlyArray<OutcomeEvent> } = {},
): RankResult => {
  if (eligible.length === 0) {
    throw new OutcomeLogError('INVALID_EVENT', 'rankReviewers requires a non-empty eligible pool');
  }
  const ordered = canonicalOrder(eligible);
  if (policyArm === 'static') {
    return {
      policyArm,
      ranked: ordered,
      reason: explain(ordered[0]!.name, 'static'),
      posteriors: null,
    };
  }
  if (!options.seed) {
    throw new OutcomeLogError('INVALID_EVENT', 'thompson rank requires the route seed');
  }
  const { posteriors } = foldPosteriors(
    options.events ?? [],
    ordered.map((c) => c.name),
  );
  const draws = createBetaSampler(options.seed).drawPosteriors(posteriors);
  const sampleByName = new Map(draws.map((d) => [d.candidateId, d.sample]));
  const byName = new Map(ordered.map((c) => [c.name, c]));
  const ranked = [...ordered]
    .sort((a, b) => {
      const diff = sampleByName.get(b.name)! - sampleByName.get(a.name)!;
      if (diff !== 0) return diff;
      return (
        a.static_priority - b.static_priority ||
        (Buffer.from(a.name, 'utf8') < Buffer.from(b.name, 'utf8') ? -1 : 1)
      );
    })
    .map((c) => byName.get(c.name)!);
  return { policyArm, ranked, reason: explain(ranked[0]!.name, 'thompson'), posteriors };
};
