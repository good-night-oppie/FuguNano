# Proposal: AgentDex V3 with FuguNano as sidecar (Topology B — RATIFIED)

Status: RATIFIED 2026-07-22 — operator (Eddie) + navigator binding ruling
"GO WITH AMENDMENTS" (verbatim: agentdex-cli
`.fleet-goal/evidence/navigator-rulings/2026-07-22-tui-stack-repo-topology.md`).
Per GOALS.md constraint, implementation is dispatched via `mroute execute`;
Fable does not write product code.
Date: 2026-07-22. Fork: good-night-oppie/FuguNano (= upstream 440b617).

## 1. Why this fit is unusually good

FuguNano's engine and AgentDex V3's gaps are near-complementary:

| AgentDex V3 gap (verified in adx-v3-interview) | FuguNano piece that closes it |
|---|---|
| `policy["gate"]` has **zero consumers** (#707 — "the single reason v3 may not yet claim to measure anything") | `route --gate` executable verifiers + `ReviewPacket` (deterministic, regex-parsed, sha256-pinned; `fugunano.review-packet.v1`) + the verifier ladder where **only the real executable gate yields TRUST** |
| Bridges quality is constant 0.5 → shortest-reply-wins degeneracy (#708) | Gate verdict becomes the quality axis; ungated runs are recorded as *simulated*, never ranked as *measured* |
| No baseline harness (#708 — no evidence selector beats random) | Engine allocator ships bench priors + persisted win/loss; comparisons are built in |
| `FrontierSeedLedger.best_model` is argmax-with-explore_rate | `BetaBernoulliAllocator` — bench prior + Beta-Bernoulli posterior, greedy or Thompson (explore_rate → Thompson), decay, persisted `stats.json` |
| M4 `adx evolve` promotion needs kill-gates + lineage | `EvolutionLoop`: propose k, score on held splits, promotion gate refuses safety-surface edits without evidence, lineage persisted |
| Receipts / two-tier trust ledger (M3) | Evidence-packet family: review, incident, runtime-guard, handoff, action-certificate |

The product thesis — "Know which model does a job better" — is literally what
`BetaBernoulliAllocator.rank(taskType)` computes.

## 2. Integration shape — Topology B (helios-style process boundary)

**Superseded framing:** an earlier draft of this section proposed a TS `adx`
CLI (`packages/adx`) wrapping `wireCoordinator` as the product surface. The
ratified topology reverses that: **the product CLI stays Python in
agentdex-cli; this fork ships a sidecar, not the product.** The agentdex-cli
repo itself documents both integration precedents — KAOS (vendored subtree)
vs helios ("a process you operate, not code you import") — and FuguNano
matches the helios precedent: independent upstream release cycle, and the TUI
is inherently a separate process owning the terminal.

Ownership (navigator ruling, binding — one authoritative owner per surface):

| Surface | Owner |
|---|---|
| policy, pre-run validation, dispatch, gate, final allocation, frontier ledger, receipts | **AgentDex Python** (agentdex-cli) |
| terminal/raw mode, projection, TUI reducer, cost/history adapters | **adx-top TS sidecar** (this fork) |
| Beta-Bernoulli ranking implementation | **FuguNano** (advisor-internal) |
| activation/router telemetry | **OpenFugu** |
| Anthropic account/quota/proxy state | **TeamClaude** |

```
agentdex-cli (Python uv, product + moat)          fugu-nano fork (TS platform sidecar)
 ├─ adx interview/run/openbox/measure              ├─ packages/adx-top  ← independent
 ├─ P1 #707 gate consumer (Python side)            │   build/package/release seam
 ├─ frontier ledger + receipts (final authority)   │   Ink TUI + TokenLens + G1/G2
 └─ adx top → exec checksum-pinned artifact ───────┘   + UDS client + ccusage adapters
      (argv exec, signal/exit passthrough;         engine/ stays upstream-mergeable
       no checkout-path dep, no runtime build)     (workspace import, never forked)
```

Four binding amendments (navigator, must hold at implementation):
1. `adx top` execs a **checksum-pinned TS artifact** via argv, passing through
   signals/exit codes — no dependency on a FuguNano checkout path, no runtime
   `npm install`/build.
2. `packages/adx-top` must be an **independent build/package/release seam** —
   a directory existing is not a package seam.
3. Artifact pinning = exact digest; **wire schemas** (ReviewPacket, UDS
   events, allocation) = producer-owned major/minor + feature handshake +
   schema digest. No bidirectional exact-version pin (additive fields must
   not force lockstep releases).
4. P2 consumes machine-readable **AllocationAdviceV1** only — never parse
   human stdout, never read raw allocation-stats.tsv. AgentDex applies the
   final budget/policy filter and writes the receipt. Fugu-side
   feedback/write stays **HOLD** until AllocationOutcomeV1 carries event_id,
   gate-receipt digest, and idempotency (`fugue allocate record` double-counts
   on retry today — not control-protocol grade).

The Python uv workspace (`adx_frontier`, openbox, candidate validation gates)
stays the **measurement + ledger substrate** — pre-run validation gate
(≤10 files / 200KB / 500KB), FRONTIER_AXES, FrontierRecord are untouched.
License: Apache-2.0 — keep NOTICE/attribution; engine/src never diverges so
`git merge upstream/main` stays viable.

**Measured/simulated/substituted semantics land in the DS.** The migrated
Mah Jong tokens already encode this: `--measured` (sage, a real receipt),
`--simulated` (grey on purpose, `--engine fake`), `--substituted` (clay,
quarantined #706). CLI output and the later TUI must use the same trichotomy —
the standing principle "the gate scores the REAL objective, not a proxy"
becomes a *visual* invariant.

## 3. TUI sidecar (`adx top`) — later phase, per the reviewed spec

The ChatGPT research (share/6a60120b) is adopted with these fleet corrections:

1. It targets `dhkts1/teamclaude-rs`; the fleet's live TeamClaude is the Node
   process in tmux `tc` on :3456 (not reboot-persistent, unauthenticated
   loopback). Either port the UDS telemetry design to the Node gateway or
   treat the -rs migration as a fleet-wide decision owned by the `tc` owner —
   not this lineage's call (same ruling as the dormant teamclaude.service).
2. Its three honesty corrections (Router Activation Projection not "live
   t-SNE"; heatmap = exact `c_{k,j} = W_{k,j} h_j` with selected-vs-runner-up
   delta; no faked Token Saliency) are ratified by our own measurements: the
   deployed TRINITY routing is **turn-parity-driven** (turn 1 → slot 0 mass
   0.853; turn 2 → slot 1 mass 0.949, argmax 40/40; agents 2/5 unreachable),
   and **68% of DeepSeek billed replies are discarded** (Thinker at final
   turn). A heatmap/timeline would have caught both instantly — that is the
   product: a decision debugger, not intelligence theater.
3. Fleet-specific security gap the spec misses: **watchtower pane snapshots**.
   Its "memory ring, short TTL, no disk persistence" rule for raw activations
   is defeated by the pane pipeline itself (panes are snapshotted to disk).
   The TUI must render aggregates only — projections, norms, contribution
   bars — never raw vectors or transcripts in a pane.
4. Controls are propose-only with `PROPOSED→SENT→ACKED→APPLIED→VERIFIED`
   receipts — this maps 1:1 onto the engine's `buildActionCertificate`.

## 3.5 TUI stack research verdict (2026-07-22) + gap register

Research (5-agent sweep, adversarially verified, zero refutals) found the
"tokscale is Rust ⇒ TUI must be Rust" coupling has dissolved upstream:

- **ccusage went Rust too** (v20: Rust core + npm binary shim; no `main`, no
  `exports`; live TUI removed in v18; TS library API removed in v19). The
  "standard TS token tool" no longer exists as TS.
- **tokscale-core is unpublished** on crates.io (git-dep only, fast-moving
  monorepo), and its ratatui TUI is snapshot-oriented (load-once, manual `r`,
  auto-refresh default 60s) — the live TUI would be written from scratch on
  either path.
- Viable TS primitives: **Ink v7** (Claude Code/Gemini CLI ship on it; 4-pane
  live dashboard ≈ 2d prototype / 4–6d solid), **TokenLens** (importable TS
  pricing/normalization, models.dev+OpenRouter catalogs, used by Vercel/Midday),
  **ccusage/tokscale as `--json` subprocesses** for historical rollups
  (language-neutral), and our own Node gateway as the live event source (no
  teamclaude-rs migration required). **tokentop** (only live TS TUI found; MIT,
  multi-agent) is prior art but Bun-only + app-only.
- teamclaude-rs license is effectively MIT (LICENSE file present; nonstandard
  preamble defeats GitHub's detector) but the repo is days old, 1 contributor.

Stack decision is the operator's; the register below applies **if the TS route
is taken** (features the TS ecosystem lacks — build them ourselves):

### G1 — Sakana (Fugu) subscription-quota provider (port of tokscale's)

How tokscale implements it (verified from source, `crates/tokscale-cli/src/
commands/usage/sakana.rs` + `docs/providers/sakana.md`):

1. **No public usage API exists** (their investigated, documented conclusion —
   nothing comparable to Claude's `/api/oauth/usage`). Sole data source: the
   authenticated billing console `https://console.sakana.ai/billing`.
2. **Cookie-auth HTML scrape**: NextAuth session cookie (chunked
   `__Secure-authjs.session-token.0/.1`, combined `; `-separated) from env
   `SAKANA_SESSION_COOKIE` or config file `sakana-session` (created 0600 via
   umask); plain authenticated GET; the Next.js page server-renders the values.
3. **Parses**: plan tier (Standard/Pro/Max), `$NN/mo`, next renewal, and
   rolling **5-hour + Weekly quota windows (% used + reset)** — quota windows,
   not dollars (flat subscription).
4. **Honesty contract worth porting verbatim**: layout-coupled plain-str
   parsing; logged-out detection keys on marker *absence* plus a strong
   positive signal (`>5-hour<`/`>Weekly<` label or `$NN/mo`); a windowless
   parse is treated as not-logged-in; cookie expiry → explicit refresh error,
   **never a bogus parse**.

TS port ≈ 150 lines (fetch + str scan) as an `adx top` usage provider. Fleet
secrets discipline applies: cookie file 0600, value never rendered in a pane
(watchtower snapshots), never in argv/env of long-lived shared processes.

### G2 — Fugu model pricing (absent from every TS catalog)

LiteLLM/OpenRouter/models.dev do not carry fugu models — tokscale hand-
maintains overrides (`pricing/mod.rs build_sakana_overrides`, rates from
console.sakana.ai/pricing + sakana.ai/fugu, accessed 2026-06-22):
`fugu-ultra` in $5/M, out $30/M, cache-read $0.50/M; >272K-context tier
$10/$45/$1. Port as a TokenLens custom-catalog entry, recording source + date
(hand-written prices drift — same risk class as the DS v2 preview prices).

**tokscale deliberately does NOT price bare `fugu`** — it is a router billed
at the underlying serving model's rate, unrecoverable from session logs
(log records only `model="fugu"`). Adopt that rule for log-derived costs —
**but our stack can do better**: the TeamClaude gateway *knows* which worker
served each request, so gateway-event provenance (exactly the DS v2
ProvenanceChip/RouteLedger contract: requested vs served, side by side) makes
bare-`fugu` cost computable in `adx top` where tokscale structurally cannot.
Provider identity rule to mirror: any model id containing `fugu` → provider
`sakana` (their `provider_identity.rs:178`).

## 4. Phasing (revised per navigator ruling 2026-07-22; mroute dispatch)

Pre-P1 sequence is **binding**: ledger provenance must be airtight before any
real gate score exists.

- **Pre-1** Land PR #710 (openbox↔bridges contract) — reviewed by its current
  owner (tc-fugu lineage); NOT re-done by mroute. Blocked on the operator's
  tiny-PR `Indivisible-Unit`/`Indivisible-Scope` declaration (943 LOC).
- **Pre-2 (atomic P0, first mroute work-order)** Extract a single
  `eligible_rows` seam so selection, budget mean aggregation, and
  `export_frontier` consume the *identical* provenance/quarantine set —
  verified defect: export iterates raw `_rows()` and republishes `-fake`
  rows into frontier.json.
- **P1** #707 gate consumer (Python, dispatch → gate → validated measurement
  → atomic commit → export). Merge gates verbatim in the ruling doc: GateResultV1
  quality∈[0,1] / GATE_ERROR≠quality=0, no neutral 0.5, receipts bind
  measurement_id + SHAs, exactly-once ledger effect, mixed-fixture test,
  shell:false sandboxing. Closes only the gate-consumer half; measurement-engine
  claim stays HOLD until #708.
- **P2** Allocation advisory via AllocationAdviceV1 (amendment 4); baseline
  comparisons (#708) + lexicographic/epsilon/weighted selection ruling.
- **P3** `adx evolve` on EvolutionLoop + bene mh bridge (M4).
- **P4** `adx top` read-only TUI slice per §3/§3.5 + ruling's TUI merge gates
  (v0 = /teamclaude/status aggregates only; v1 tap needs runtime-verified
  request_id+attempt+mapped_model+response_reported_model correlation), Mah
  Jong DS tokens.

## 5. Open questions for the operator

1. Gate semantics when the verifier itself fails to run (crash ≠ FAIL ≠
   skip): fail-closed proposed, but decide.
2. Where do allocator stats live — `~/.config/fugunano` (engine default) or
   `.agentdex/` (repo-local, BYO-creds-friendly)? Repo-local proposed.
3. Does P1 land in the Python repo (verify leg in run_cmd.py calling engine
   over a thin JSON boundary) or in the TS layer with Python bridges as
   harnesses? TS-side proposed for typed ReviewPacket, but this doubles the
   runtime requirement (Node ≥18.18) for `adx run`.
