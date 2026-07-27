# ADX-v3 × Weco Product-Mirror Design Review

> Date: 2026-07-26
> Status: design recommendation
> Scope: Weco-informed self-hosted experiment workspace for ADX-v3. No product code is changed by this review.

## Outcome

ADX-v3 should mirror Weco's **operating grammar**, not its hosted surface:

> **Freeze a baseline → explore a visible lineage → steer by branching → inspect every node → independently verify → promote through receipts.**

The recommended first product is a **hard-narrowed Reviewer Lab** for one FuguNano router and one reviewer-improvement workspace. It wraps the existing FuguNano R1/R2 PR-review routing core as the first preset, imports local Weco artifacts when useful, and keeps FuguNano as the only online routing/dispatch/learning authority.

Do not build the broad control room first. The proof surface is one page with three evidence views—Managed lineage, Imported sequence, and Promotion gate—plus an explicit large-request review topology inside the workspace.

It is not a generic AI gateway dashboard, a Weco visual clone, a generalized fleet console, or a replacement allocator.

## Evidence status

| Evidence | Status | Use in this review |
|---|---|---|
| Current installed Weco CLI | Verified live | Command and interaction grammar |
| Official Weco public pages/docs | Verified public | Positioning, lineage, steering, local evaluation |
| User-provided Weco docs archive | Verified local | Dashboard capabilities and Observe model |
| Existing local Weco artifacts | Verified local | Import/provenance and immutable-snapshot requirements |
| FuguNano R1/R2 branch | Verified implementation | First preset and trust semantics |
| Authenticated Weco dashboard visuals | Pending | No pixel-level or screenshot claim |

See [`product-facts.md`](product-facts.md) for the complete fact ledger.

## The decisive design move

### Mirror

These Weco mechanics transfer directly:

1. **Baseline step 0** as a frozen comparison anchor.
2. **Visible experiment lineage** instead of a flat run list.
3. **Branch/derive steering** that preserves the parent and prior failures.
4. **Node inspection** with source snapshot, diff, evaluator output, and metric.
5. **Review/revise/submit** before an expensive or externally meaningful evaluation.
6. **Observe mode** for importing experiments driven by another loop.
7. **CLI/dashboard parity**: every visual action maps to a named command or typed API action.
8. **Failure visibility**: failed branches remain part of the knowledge tree.

### Adapt

Weco's code-optimization nouns must become router-improvement nouns:

| Weco | ADX-v3 |
|---|---|
| Source file(s) | Mutable surface: routing config, prompt, skill, harness adapter, evaluator |
| Evaluation command | Evaluator adapter + evidence contract |
| Metric | Objective with quality, cost, latency, safety, and provenance requirements |
| Run | Experiment |
| Step/node | Candidate version |
| Best solution | Best **verified eligible** candidate, never score-only winner |
| Derive | Branch from immutable candidate digest with new steering |
| Apply change | Propose promotion → approve → apply through FuguNano → verify receipt |
| Observe | Import external experiment events and snapshots |

### Reject

Do not copy these patterns into ADX-v3:

1. **Mutable working file as canonical best.** A local Weco example proved why: the working `optimize.py` had reverted to baseline while the saved best snapshot still scored 0.5667 held-out versus baseline 0.1333.
2. **One metric as complete truth.** Router promotion requires constraints and natural outcome evidence, not only a scalar objective.
3. **Hosted account/credit center as the product spine.** ADX-v3 is self-hosted and BYO-runtime.
4. **Remote destructive controls without typed receipts.** The browser never silently retries, reranks, or becomes routing authority.
5. **Hidden failed branches.** Failure is useful evidence and must remain inspectable.
6. **“Best” without evaluator identity, dataset/snapshot digest, sample size, and hard-gate state.**
7. **Authenticated Weco visual mimicry.** The dashboard was not accessible during this review; the concept is AgentDex-native.

## Product formula

```text
ADX-v3 = Weco-style experiment lineage
       + FuguNano evidence packets and spawn-boundary safety
       + AgentDex preset/onboarding UX
       + immutable local snapshots and receipts
```

## Large-request review topology

A single Reviewer Lab workspace must scale from a one-file candidate to a large PR/refactor without losing evidence per unit reviewed. Three explicit modes cover this; the workspace shows which mode is active and never blends them silently.

1. **Single** — one candidate, one evaluator pass. Default for small changes.
2. **Small-batch loop** — the candidate is split into an ordered sequence of small batches (e.g. files or logical hunks); each batch runs through generate → evaluate → human accept/reject before the next batch starts. This is the existing bounded review-fix loop applied per batch, not a new mechanism.
3. **Map → join barrier → reduce → verify** — for large, independently-reviewable units (e.g. many files or many PRs at once): each unit is *mapped* to its own evaluator run in parallel, a **join barrier** requires every mapped unit to reach a terminal state (`done | failed | timeout | censored`) before reduction starts, a *reduce* stage aggregates only the terminal results into one candidate-level verdict, and an independent verifier re-checks the reduced verdict against a sample of the raw per-unit evidence before promotion review.

Non-negotiable rules for the map/reduce mode:

- The join barrier is real: **N dispatched ⇒ N must return** a terminal state before reduce runs. A unit stuck pending is shown as blocking, never silently dropped.
- The reduce stage may aggregate (counts, pass rate, worst-case, cost sum) but must **never synthesize** a passing unit result for a unit that failed, timed out, or was censored.
- Every reduced verdict keeps a link back to every per-unit result; "reduced" is a view, not a replacement for the underlying evidence.
- If any unit could not be evaluated, the reduced verdict is `INCONCLUSIVE`, not a partial pass.
- Independent verification samples the reduce, not just the summary — at minimum, the worst-scoring unit and one random unit are re-inspected before promotion.

This gives Reviewer Lab a coherent answer to "how do we review 200 files" without inventing a second orchestration engine: it reuses FuguNano's existing join-barrier and bounded-loop concepts, scoped to review/evaluation rather than dispatch.

## Primary navigation

1. **Workspace 工作区** — project objective, mutable surfaces, evaluator, constraints, latest experiment.
2. **Experiments 实验** — lineage tree, node inspector, comparisons, derive/review flow.
3. **Presets 预设** — installed task adapters; first preset is `PR Review Routing` backed by existing R1/R2.
4. **Evidence 证据** — evaluator runs, route/attempt receipts, external signals, finalized outcomes, censored updates.
5. **Runtime 运行态** — read-only desired/effective/observed state, actual executor, health, config drift.
6. **System 系统** — adapters, storage, backup/export, secret references, CLI/API parity.

The home screen opens the last active experiment. It does not lead with vanity KPIs.

## North-star journey

1. Create or open a workspace.
2. Choose `PR Review Routing` or import an external Weco/Observe experiment.
3. Freeze objective, mutable surfaces, evaluator, constraints, and baseline snapshot.
4. Run or observe a candidate.
5. Inspect the lineage; failed, censored, and effect-unknown nodes stay visible.
6. Select a node to see exact diff, evaluator evidence, metric, cost/latency, and provenance.
7. Derive a branch with new steering; the parent is immutable.
8. Review and revise before evaluation when the workspace requires approval.
9. Propose promotion. The UI builds a typed proposal; it does not apply directly.
10. FuguNano applies the accepted config/preset and emits receipts.
11. Runtime verification marks the proposal `VERIFIED` or leaves it unresolved; online outcomes remain the learning authority.

## Three IA directions

### A — Weco-like Lab

Experiment tree is the entire product. Fastest to understand and closest to the mirror.

- Strength: focused, low implementation surface.
- Weakness: hides the distinction between experimental evidence and effective router state.
- Verdict: useful prototype, insufficient operating surface.

### B — Evidence-first Control Room — **recommended**

Experiment lineage remains the hero, but node inspection and promotion are organized around evidence and desired/effective/observed state.

- Strength: preserves Weco's exploration clarity while respecting FuguNano authority and operational safety.
- Weakness: denser information architecture; requires disciplined progressive disclosure.
- Verdict: build this.

### C — CLI-parity Workbench

Every view is organized around commands, packets, and machine JSON.

- Strength: easiest to implement honestly; excellent for expert operators.
- Weakness: feels like a visual terminal rather than a product and underserves visual comparison.
- Verdict: use as an expert mode inside B, not as the default product.

## Recommended screen inventory

### 1. Workspace Overview

- Objective and direction.
- Preset and authority owner.
- Mutable-surface manifest.
- Evaluator and evidence tier.
- Latest baseline, best verified candidate, and current effective deployment.
- Drift warning when mutable working copy differs from immutable best snapshot.

### 2. Experiment Lineage

- Directed tree with baseline, active, evaluated, failed, censored, effect-unknown, and promoted nodes.
- Shape + glyph + label + color; no color-only identity.
- Metric shown on one blue scale; status accents stay reserved.
- Failed branches remain visible.
- Keyboard navigation and table-view twin.

### 3. Node Inspector

- Candidate digest and parent.
- Plan/steering instruction.
- Semantic diff tabs: code/config/prompt/evaluator/dependencies.
- Evaluator result, source snapshot, sample size, failures, logs reference.
- Cost, latency, actual executor, requested versus served identity where available.
- Review/revise/submit or derive action.

### 4. Compare

- Two or three selected nodes only.
- One measure per chart; no dual axes.
- Side-by-side evidence table for quality, cost, latency, safety, and provenance.
- Explicit “incomparable” state when evaluators or snapshots differ.

### 5. Promotion Review

- Immutable source candidate digest.
- Target preset/environment.
- Semantic diff and blast radius.
- Required evidence checklist.
- Review and approval state.
- Apply action maps to a typed FuguNano command/API request.
- Receipt lifecycle: `PROPOSED → REVIEWED → APPLIED → VERIFIED`.

### 6. Evidence Ledger

- `route.decided`, `dispatch.terminal`, external signal, and `outcome.finalized` event views.
- Actual executor attribution.
- Learnable/static/censored classification.
- Duplicate/conflict diagnostics.
- No prompt, transcript, secret, or raw activation storage.

### 7. Runtime

- Desired, approved, effective, and observed state shown separately.
- Current config digest and drift.
- Active routes and terminal states.
- `EFFECT_UNKNOWN` is critical, non-retryable, and links to reconciliation.
- Browser is read-only unless an action can generate a typed reviewed proposal.

## Trust contract

Every candidate node must answer:

1. **What changed?** Immutable snapshot and semantic diff.
2. **Compared to what?** Parent and frozen baseline digest.
3. **Who/what evaluated it?** Evaluator ID/version and dataset/workload digest.
4. **How much evidence?** Sample count, excluded/censored count, and run status.
5. **What did it cost?** Tokens/credits/list-price equivalent and wall time when available.
6. **Who executed it?** Selected candidate, attempted candidate, actual executor, and served model when available.
7. **Can it be reproduced?** Command/API action, source refs, seed, config digest, and artifact refs.
8. **May it be promoted?** Constraint and safety gates, independent review, and target compatibility.

A missing answer is displayed as `UNKNOWN`, never omitted or inferred.

## Existing R1/R2 disposition

Preserve the current branch as preset `PR Review Routing · v1`:

- exact/replayable Beta sampler;
- strict config and frozen task profile;
- same-lineage/capability eligibility;
- static and Thompson ranking;
- one-line explain;
- selected versus actual executor;
- pre-spawn-only fallback;
- terminal `NO_ELIGIBLE_AGENT` and `EFFECT_UNKNOWN`;
- `route.decided` and `dispatch.terminal` append-only evidence;
- posterior fold from finalized attributable outcomes.

The UI imports these facts and renders them. It does not create a second ranker or retry path.

## First vertical prototype

The interactive concept in [`index.html`](index.html) prototypes Direction B:

1. Workspace `Bridges Quality Gate` imported from a real local Weco example.
2. Real baseline held-out score `0.1333`.
3. Real saved-best held-out score `0.5667`, node `80ed6627…`, parent step `1`.
4. Explicit drift: current mutable file evaluates as baseline while immutable best snapshot remains preserved.
5. PR Review preset panel backed by implemented R1/R2 facts.
6. Concept-only promotion and effect-unknown states, clearly labeled.

## Milestones

### D0 — Design proof

- Ship the evidence ledger, review, and interactive prototype.
- Validate with the user after authenticated Weco dashboard access becomes available.

### D1 — Read-only local artifact importer

- Import Weco `.weco/` task definitions, baseline, evaluator, mutable source, and `.runs/*/best/manifest.json`.
- Render one real lineage when local step metadata exists; show partial lineage honestly otherwise.
- No cloud dependency.

### D2 — FuguNano PR Review preset viewer

- Read machine JSON and the append-only R1/R2 event log.
- Render route, attempt, actual executor, terminal state, and fold classification.
- No writes.

### D3 — Typed experiment store

- Local SQLite metadata + content-addressed blob snapshots + immutable event log.
- Import Weco Observe-compatible events through an adapter.
- Backup/export and schema migration contract.

### D4 — Review and derive

- Local branch creation from immutable candidate snapshots.
- Human review/revise/submit states.
- Executor/evaluator adapters remain process boundaries.

### D5 — Promotion proposal

- Generate a typed FuguNano proposal/action certificate.
- Apply only through the existing authority after review.
- Verify desired/effective/observed state and keep rollback pointer.

## Critical risks

- **Metric theater:** a scalar score can hide evaluator weakness or incompatible snapshots.
- **Dual authority:** a browser-side rank/apply path would invalidate the routing-first decision.
- **Artifact incompleteness:** local Weco folders may not contain the full cloud lineage; importer must disclose partial evidence.
- **Mutable-copy drift:** working source can diverge from saved best, as observed locally.
- **Effect ambiguity:** conventional retry UX can create duplicate effects after spawn.
- **Visual cargo cult:** authenticated Weco visuals remain unverified; do not treat this concept as replication evidence.

## Design critique

**Overall score: 8.4/10 — strong direction, visual validation pending.**

- Philosophy alignment: 9/10 — lineage and evidence directly embody the product thesis.
- Visual hierarchy: 8/10 — tree-first composition is clear; dense inspector needs progressive disclosure.
- Craft quality: 8/10 — AgentDex tokens, explicit states, and real assets give a coherent system.
- Functionality: 9/10 — every surface maps to a workflow or trust question.
- Originality: 8/10 — Weco mechanics are adapted into a router evidence control room rather than copied.

### Keep

- Lineage as the hero, not decorative KPI cards.
- Immutable best snapshot separated from mutable working copy.
- Failed/censored/effect-unknown states visible in the same grammar.
- Promotion modeled as a receipt lifecycle, not a button.
- R1/R2 preserved as a preset and authority boundary.

### Fix after authenticated dashboard access

1. Compare Weco's real tree density, inspector placement, and branch controls against the concept.
2. Verify whether dashboard billing and run management deserve any mirrored interaction patterns.
3. Capture current Weco responsive, loading, stale, and failure states.
4. Re-score visual fidelity separately from product suitability.

### Quick wins

- Add a real imported Weco lineage once a full local/cloud export is available.
- Add an accessibility texture toggle for status nodes.
- Add a command preview drawer showing exact CLI/API parity for each action.
