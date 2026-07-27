# ADX-v3 × Weco Product Facts

> Collected: 2026-07-26
> Purpose: evidence source of truth for the ADX-v3 Weco product-mirror design review.
> Scope: product/design research only; no Weco run was started, changed, shared, stopped, deleted, or billed.

## Evidence levels

- **CLI-LIVE** — verified from the installed `weco` CLI help on this host on 2026-07-26.
- **OFFICIAL-PUBLIC** — verified from public `weco.ai` / `docs.weco.ai` pages via `WebFetch`.
- **ARCHIVED-DOCS** — verified from the user-provided Weco documentation archive at `/tmp/claude-1000/-home-admin/b934f993-e0af-4a12-8297-03db7610540e/scratchpad/weco-docs-archive`.
- **LOCAL-ARTIFACT** — verified from existing local `.weco/` and `.runs/` files; no inference from absent files.
- **AUTH-VISUAL-PENDING** — authenticated dashboard inspection was attempted twice through Claude-in-Chrome, but the extension was disconnected both times. No authenticated visual claim is permitted.

## Verified Weco product facts

1. **Installed version** — the isolated uv tool environment reports Weco CLI `0.3.40`. **[CLI-LIVE]**
2. **Positioning** — Weco describes itself as a steerable, traceable autoresearch engine that iteratively rewrites code to improve a user-defined metric. It uses LLMs plus tree search (AIDE) and keeps a lineage of variants. **[OFFICIAL-PUBLIC, ARCHIVED-DOCS]**
3. **Local evaluation** — code and data remain on the user's hardware; the local machine runs evaluation commands. **[OFFICIAL-PUBLIC]**
4. **Optimization contract** — the user selects one file or up to ten files, provides an evaluation command, names a metric, and chooses maximize/minimize. Weco mutates the selected source during the run. **[CLI-LIVE, ARCHIVED-DOCS]**
5. **Baseline and lineage** — Weco Observe creates baseline step 0; subsequent steps may name a parent step, creating explicit branches rather than a flat history. **[CLI-LIVE, ARCHIVED-DOCS]**
6. **Lineage inspection** — current CLI exposes `run status --lineage` and `run overview`, including lineage-wide status, best result, derived runs, optional source code, and an ASCII metric trajectory. **[CLI-LIVE]**
7. **Steering** — current CLI supports `instruct` for a live run and `derive --from-step best|run-best|N` to create a new branch with inherited or replacement instructions. **[CLI-LIVE]**
8. **Human review** — current CLI supports `--require-review`, `run review`, `run revise`, and `run submit`; proposed code can be revised before evaluation. **[CLI-LIVE]**
9. **Single evaluation consumer** — derived branches in one working tree queue behind one evaluator/file-swap consumer rather than evaluating concurrently against the same mutable files. **[CLI-LIVE, LOCAL PACKAGE AUDIT]**
10. **External loops** — `weco observe init/log` tracks externally driven experimentation in the same baseline/step/parent-step model. **[CLI-LIVE, ARCHIVED-DOCS]**
11. **Agent bridge** — `weco start claude` launches Claude Code with a bidirectional dashboard bridge. It supports local Claude billing or Weco billing, optional headless mode, seeded prompts, tool auto-approval, and reasoning streaming. **[CLI-LIVE]**
12. **Evaluation backends** — current CLI supports shell, LangSmith, and Langfuse evaluation backends, including managed/dashboard evaluators and custom metric aggregation. **[CLI-LIVE]**
13. **Dashboard functions documented publicly** — centralized run history, real-time progress, solution-tree exploration, per-step cost visibility, remote stop/delete, credits, billing history, and auto top-up. **[ARCHIVED-DOCS]**
14. **Cost dimensions** — product design must keep Weco/LLM generation credits, local evaluator compute/time, and evaluator-internal API spend separate. No verified universal credit-to-dollar conversion is available. **[CLI-LIVE, LOCAL PACKAGE AUDIT]**
15. **Cloud persistence** — the dashboard stores run history across devices; this is useful Weco behavior but is not a requirement for self-hosted ADX-v3. **[ARCHIVED-DOCS]**
16. **Public visual evidence** — public Weco pages expose an official logo but no current dashboard screenshots in fetched content. **[OFFICIAL-PUBLIC]**

## Verified local Weco artifacts

- `/home/admin/gh/adx-child-e2e/.weco/bridges-quality-gate/`
  - baseline, mutable `optimize.py`, evaluator, fixtures, wrapper, and a local `.runs/3edf773c-e306-435d-965a-ea7a9832ded9/` snapshot store.
  - the snapshot store contains frozen steps `0–6` plus a separate `best` snapshot; each has a manifest and exact file bytes.
  - evaluator uses external held-out fixtures and reports discrimination plus separation; no paid call is required.
  - the current mutable `optimize.py` is byte-identical to baseline/step 0, while `best` is byte-identical to step 6. This proves that mutable working state can diverge from the preserved best snapshot.
  - historical per-step metrics are not retained in the inspected snapshot store. `recomputed-lineage.json` records a **new 2026-07-26 recomputation**, not historical Weco results: baseline held-out `0.1333`; steps 1, 2, 4, 6 and `best` held-out `0.5667`; step 3 `0.5239`; step 5 `0.4492`.
- `/home/admin/gh/ready-player-one-ptcg/.weco/ptcg-policy/`
  - baseline, mutable policy, evaluator, and wrapper.
  - evaluator plays seat-alternated games, treats agent errors as losses, and includes an evaluator-exploit guard.
- `/home/admin/gh/ready-player-one-ptcg/.runs/9ddd12e2-eb18-45fd-a32f-e949cc46d215/best/manifest.json`
  - saved `best_code_snapshot` manifest with timestamp, file count, source path, artifact path, and byte count.

These artifacts prove a useful self-hosted import seam: mutable source, frozen baseline, numbered snapshots, evaluation contract, best snapshot, and provenance manifest. They do **not** prove parentage, original plans/instructions, historical metric values, model identity, cost, or the full Weco dashboard lineage. Without explicit parent metadata, the numbered snapshots must be presented as an **Imported sequence**, not an inferred tree.

## ADX-v3 facts that constrain the design

- The current FuguNano branch implements the R1/R2 PR-review routing core: strict config/profile validation, exact Beta sampling, eligibility, static/Thompson ranking, spawn-boundary dispatch semantics, append-only outcome events, posterior folding, machine JSON, and black-box tests.
- Frozen-but-unbuilt narrow work remains R3–R5: AgentDex CLI façade, PRELIVE benchmark execution, outcome timer, and live 50-task gate.
- FuguNano must remain the sole online routing/dispatch/learning authority for the existing slice. The design may wrap or visualize it; it must not create a second allocator or Python/browser-side fallback.
- Existing R1/R2 becomes the first preset/plugin (`PR review routing`), not discarded code and not the universal domain model.

## Design claim boundary

The accompanying concept screens are **ADX-v3 proposals informed by Weco mechanics**. They are not screenshots of Weco, do not claim pixel-level parity, and do not reproduce authenticated dashboard details. Any Weco visual comparison remains **AUTH-VISUAL-PENDING** until the Chrome extension is connected and the user is already authenticated.

## Primary sources

- https://weco.ai/
- https://docs.weco.ai/
- Installed `weco --help` and subcommand help, captured 2026-07-26
- Local Weco docs archive listed above
- `/home/admin/gh/agentdex-cli-worktrees/adx-v3-interview/.fleet-goal/evidence/navigator-rulings/2026-07-23-consolidated-spec-r3.md`
- `/home/admin/gh/fugu-nano/docs/proposals/adx-v3-on-fugunano.md`
