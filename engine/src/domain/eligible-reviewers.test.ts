import { describe, expect, it } from 'vitest';

import {
  canonicalOrder,
  eligibleReviewers,
  rankReviewers,
  type ReviewTaskFacts,
} from './eligible-reviewers.js';
import { buildOutcomeFinalized, buildRouteDecided } from './route-posterior.js';
import type { CandidateConfig } from './routing-config.js';

const SEED = '00112233445566778899aabbccddeeff';

const candidate = (
  name: string,
  priority: number,
  overrides: Partial<CandidateConfig> = {},
): CandidateConfig => ({
  name,
  argv: [`/opt/agentdex/bin/${name}-review`],
  lineage: name,
  capabilities: ['pr-review', 'lang:*', 'risk:*'],
  static_priority: priority,
  enabled: true,
  ...overrides,
});

const POOL = [candidate('codex', 10), candidate('claude', 20), candidate('gemini', 30)];

const task = (overrides: Partial<ReviewTaskFacts> = {}): ReviewTaskFacts => ({
  authorLineage: 'human:eddie',
  languages: ['python'],
  riskTags: [],
  ...overrides,
});

describe('canonical order — frozen', () => {
  it('static_priority ascending, then name UTF-8 byte order', () => {
    const shuffled = [candidate('bb', 5), candidate('aa', 5), candidate('zz', 1)];
    expect(canonicalOrder(shuffled).map((c) => c.name)).toStrictEqual(['zz', 'aa', 'bb']);
  });
});

describe('eligibility filter', () => {
  it('passes the full-wildcard pool untouched, in canonical order', () => {
    expect(eligibleReviewers(POOL, task()).map((c) => c.name)).toStrictEqual([
      'codex',
      'claude',
      'gemini',
    ]);
  });

  it('drops disabled and non-reviewer candidates', () => {
    const pool = [
      candidate('codex', 10, { enabled: false }),
      candidate('claude', 20, { capabilities: ['bug-triage', 'lang:*', 'risk:*'] }),
      candidate('gemini', 30),
    ];
    expect(eligibleReviewers(pool, task()).map((c) => c.name)).toStrictEqual(['gemini']);
  });

  it('requires every language and risk tag covered by token or wildcard', () => {
    const pool = [
      candidate('codex', 10, { capabilities: ['pr-review', 'lang:python', 'risk:*'] }),
      candidate('claude', 20, {
        capabilities: ['pr-review', 'lang:python', 'lang:rust', 'risk:auth_security'],
      }),
    ];
    expect(
      eligibleReviewers(pool, task({ languages: ['python', 'rust'] })).map((c) => c.name),
    ).toStrictEqual(['claude']);
    expect(
      eligibleReviewers(
        pool,
        task({ languages: ['python'], riskTags: ['database_migration'] }),
      ).map((c) => c.name),
    ).toStrictEqual(['codex']);
  });

  it('same-lineage-filter (pre-Task-1 test): the author family never reviews itself', () => {
    const eligible = eligibleReviewers(POOL, task({ authorLineage: 'codex' }));
    expect(eligible.map((c) => c.name)).toStrictEqual(['claude', 'gemini']);
    expect(
      eligibleReviewers(POOL, task({ authorLineage: 'claude' })).map((c) => c.name),
    ).not.toContain('claude');
    // human-authored PRs exclude nobody
    expect(eligibleReviewers(POOL, task({ authorLineage: 'human:eddie' }))).toHaveLength(3);
  });

  it('an empty pool result stays empty — never silently widened', () => {
    const pool = [candidate('codex', 10, { capabilities: ['pr-review', 'lang:go', 'risk:*'] })];
    expect(eligibleReviewers(pool, task({ languages: ['python'] }))).toHaveLength(0);
  });
});

describe('static rank', () => {
  it('first eligible in canonical order wins; frozen sentence', () => {
    const result = rankReviewers(POOL, 'static');
    expect(result.ranked[0]!.name).toBe('codex');
    expect(result.reason).toBe(
      'Selected codex because it was eligible and holds the best fixed priority (lowest number wins).',
    );
  });
});

describe('thompson rank', () => {
  it('requires a seed and is replay-identical for the same seed + events', () => {
    expect(() => rankReviewers(POOL, 'thompson')).toThrow(/requires the route seed/);
    const a = rankReviewers(POOL, 'thompson', { seed: SEED });
    const b = rankReviewers(POOL, 'thompson', { seed: SEED });
    expect(a.ranked.map((c) => c.name)).toStrictEqual(b.ranked.map((c) => c.name));
    expect(a.reason).toMatch(
      /^Selected \w+ because it was eligible and ranked first under Thompson sampling for this PR\.$/,
    );
  });

  it('learns: a candidate with overwhelming wins ranks first almost surely', () => {
    const events = Array.from({ length: 40 }, (_, i) => [
      buildRouteDecided({
        repo: 'acme/widgets',
        prNumber: i + 1,
        headSha: 'f'.repeat(40),
        policyArm: 'thompson',
        cohortIndex: null,
        candidateId: 'gemini',
        rankedCandidates: ['gemini'],
        candidateIdentities: [
          {
            candidateId: 'gemini',
            argv0Realpath: '/bin/gemini',
            argv0Sha256: 'a'.repeat(64),
            argvSha256: 'b'.repeat(64),
          },
        ],
        seed: SEED,
        configSha256: 'c'.repeat(64),
        profileSha256: 'a'.repeat(64),
        profileFacets: {
          authorLineage: 'human:alice',
          languages: ['python'],
          riskTags: [],
          changedPathCount: 1,
        },
        routedAt: '2026-07-23T12:00:00.000Z',
        deadlineAt: '2026-07-30T12:00:00.000Z',
        retryEpoch: 0,
        supersedesRouteId: null,
      }),
      buildOutcomeFinalized({
        repo: 'acme/widgets',
        prNumber: i + 1,
        headSha: 'f'.repeat(40),
        outcome: 'VERIFIED_SUCCESS',
        reasonCode: 'CLEAN_MERGE',
        actualExecutor: 'gemini',
        evidenceEventIds: [],
        verifiedAt: '2026-07-25T12:00:00.000Z',
        observedAt: '2026-07-25T12:00:00.000Z',
      }),
    ]).flat();
    // 40 wins for gemini vs flat priors for the rest: count wins over seeds
    let geminiFirst = 0;
    for (let s = 0; s < 20; s += 1) {
      const seed = s.toString(16).padStart(32, '0');
      const r = rankReviewers(POOL, 'thompson', { seed, events });
      if (r.ranked[0]!.name === 'gemini') geminiFirst += 1;
    }
    expect(geminiFirst).toBeGreaterThanOrEqual(17);
  });

  it('empty task languages fail loudly instead of vacuous-passing the lang filter (ER-5)', () => {
    expect(() =>
      eligibleReviewers(POOL, { authorLineage: 'human:alice', languages: [], riskTags: [] }),
    ).toThrow(/requires ≥1 task language/);
  });

  it('empty risk_tags vacuously pass risk coverage BY DESIGN (ER-4, §B5 wording)', () => {
    const noRiskCap = [
      {
        name: 'codex',
        argv: ['/bin/x'],
        lineage: 'codex',
        capabilities: ['pr-review', 'lang:*'],
        static_priority: 10,
        enabled: true,
      },
    ];
    expect(
      eligibleReviewers(noRiskCap, {
        authorLineage: 'human:alice',
        languages: ['python'],
        riskTags: [],
      }),
    ).toHaveLength(1);
    expect(
      eligibleReviewers(noRiskCap, {
        authorLineage: 'human:alice',
        languages: ['python'],
        riskTags: ['ci_config'],
      }),
    ).toHaveLength(0);
  });

  it('no hidden state in the reason — no numbers, no samples', () => {
    const r = rankReviewers(POOL, 'thompson', { seed: SEED });
    expect(r.reason).not.toMatch(/[0-9]\.[0-9]/);
    expect(r.reason).not.toMatch(/confidence|posterior|sample/i);
  });

  it('empty eligible pool is a typed error, not a guess', () => {
    expect(() => rankReviewers([], 'static')).toThrow(/non-empty eligible pool/);
  });
});
