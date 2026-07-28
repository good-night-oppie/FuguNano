# ADX-v3 outcome-log schema freeze v1

**Status:** in progress — decisions ratified 2026-07-28, implementation landing item by item.
**Scope:** the append-only outcome log for the AgentDex PR-review slice
(`engine/src/domain/outcome-log.ts`, `route-posterior.ts`, `review-dispatch.ts`,
`dispatch-machine.ts`).

## Why a freeze, and why now

Every field below is **free today and unrecoverable after the first cohort task
is admitted**. Event ids are content-derived and the log is append-only: an
event written without a field can never be amended, because re-emitting it with
a different payload is a `DUPLICATE_ID_CONFLICT` by design, and the frozen spec
forbids whole-file surgery while a cohort is live. So each item here is either
decided before admission or lost for that cohort.

The counterpart question — *what does the log have to answer later?* — is the
Q1 metric (disposition-resolution over PRs a human actually engaged with) and
the gate audit (25/25 arm balance, zero duplicate external effects).

## Standing constraints these decisions honor

1. **Fail closed to CENSORED.** An unresolvable disposition is censored, never
   a negative. No mechanism here can mint a negative outcome without complete
   evidence.
2. **The optimizer may not touch admission.** `enabled` / `capabilities` /
   candidate membership are outside the search surface; ranking parameters only.
3. **FuguNano is the sole online allocator.** Everything here records evidence;
   nothing here acquires routing authority.
4. **Facts are stored, judgments are derived.** The posterior is re-folded from
   the log, never stored. Delivery state follows the same rule.

## Decisions

### R1 — `profile_sha256` + `profile_facets` on `route.decided` (landed)

The facade builds the task profile from live GitHub diff state at route time,
and its derivation tie-breaks live outside this repo, so the profile the router
actually saw is not reliably re-derivable once head_sha diffs vanish.

- `profile_sha256`: SHA-256 over `"pr-review-profile-v1"` + NUL + canonical
  no-whitespace JSON, snake_case keys in the frozen `PROFILE_FIELDS` order.
  `languages` / `risk_tags` are sorted inside the digest function (their wire
  order is facade-determined and unvalidated); `changed_paths` is used as-is
  because byte-sortedness is enforced at parse.
- `profile_facets`: bounded projection (`author_lineage`, `languages`,
  `risk_tags`, `changed_path_count`) in that same canonical order, so Q1
  subgroup slicing is a pure log fold.
- The full `changed_paths` list rides **only inside the digest**. Paths are
  unbounded against the frozen 64 KiB line cap, so inlining them would fail
  exactly on `large_diff` PRs — systematically censoring a subgroup the
  optimizer must learn about — and credential-shaped path names would
  false-positive the secret tripwire.

Changing the canonicalization after the first event forks digest lineages
mid-log; old digests could never be re-verified, only annotated.

### R2 — `cohort_index` on `route.decided` (landed)

The 25/25 static/thompson alternation was enforced only by the unbuilt Python
admission layer, so the log could not prove cohort membership, arm balance, or
the gate's `/25` denominators after the fact.

- Integer `1..50`, or explicit `null` for non-cohort traffic (the key is always
  present — absence must not be confusable with "not a cohort task").
- The admission layer **assigns**; the engine **records and cross-checks**.
  Parity (`odd ⇒ static`, `even ⇒ thompson`) has one source,
  `armForCohortIndex`, and a mismatch fails closed before anything is appended
  or spawned. The engine never derives the arm from the index.
- An index is consumed **iff** `route.decided` was appended, so failures that
  write nothing release the reservation.
- Membership is byte-frozen at admission: replaying a task with a different
  index is a `DUPLICATE_ID_CONFLICT`.

Recording the index verbatim also preserves admission order, which is what
makes a later arrival-parity confound analysis possible without redesigning
assignment.

### D3 — `candidate_identities` on `route.decided` (landed)

Outcomes fold to the executor **name**, but a name is an alias, not a treatment
version: `config_sha256` hashes only the config file, and `argv[0]` was checked
merely for absoluteness, so editing a wrapper changed the served agent while the
name-keyed posterior carried over unchanged.

Per ranked candidate, in ranked order: `candidate_id`, `argv0_realpath`,
`argv0_sha256` (bytes of the resolved file), `argv_sha256`, and
`argv0_digest_error` (errno code only) when the binary is unreadable.

- An unreadable binary records `null` + errno and **proceeds** — identity is
  audit metadata, the dispatch preflight remains the runnability authority, and
  failing the route here would effectively alter candidate membership, which is
  reserved from automation.
- A resolved **version string was rejected**: obtaining one means executing the
  candidate at route time, which breaches the spawn-boundary discipline.
- Audit-only in v1 — the fold stays name-keyed, pinned by a non-consumption
  test. Delete that pin when an identity policy lands.

### D10 — clock authority (decision recorded; validation landing separately)

- **GitHub canonical time is the sole evidence clock.** Window membership and
  `verified_at` come from GitHub server timestamps; the local injectable clock
  stamps only `observed_at` — observation, never evidence. This is the same
  split already established for `dispatch.terminal`.
- `github.signal.source_timestamp_at` is frozen now, before any builder exists.
- Append-side validation (write path only, never the read path, so nothing on
  disk is retroactively invalidated): canonical millisecond `toISOString` form
  for every timestamp field, `deadline_at > routed_at`, and per-route
  `observed_at >= route.decided.observed_at`.
- `ROUTED_AT_SKEW_TOLERANCE_SECONDS = 300`: a route-bound signal predating
  `routed_at − 300s` censors the route (`CLOCK_SKEW_SUSPECT`). Timestamps are
  never "corrected".

### D4 — retry epoch in route identity (approved, pending)

A provably-never-started route (`DISPATCH_FAILED` — every candidate never
spawned, zero external effects) was terminally undispatchable after a config
repair, and the refusal was mislabeled `state_error`.

- `route_id` gains an epoch: epoch 0 keeps today's byte-identical formula;
  epoch *n* appends `"\0retry\0" + n`. Attempt / terminal / signal / final ids
  inherit the epoch for free, as does the GitHub marker.
- `route.decided` gains `retry_epoch` and `supersedes_route_id`.
- Retry unlocks **only** via a prior-epoch `dispatch.terminal` of
  `DISPATCH_FAILED`, or an explicit operator abandon (which itself refuses
  whenever any terminal exists — it covers exactly the crash window).
  `MAX_RETRY_EPOCHS = 3`.
- `EFFECT_UNKNOWN` is structurally non-retryable: both unlock lanes exclude any
  terminal that is not `DISPATCH_FAILED`. A duplicate review on a real PR is
  worse than a missing one.
- New typed `duplicate_route` status; exit code stays 74 in v1.

### D2 — `PRReviewReceiptV1` and derived delivery state (approved, pending)

`COMPLETED` is a process-level fact (exit 0 + parseable machine JSON + matching
executor). It does not establish that a review was delivered.

- Optional `receipt` on the agent's machine JSON: `review_id`, `actor`,
  `head_sha`, `body_sha256` — all-or-nothing; present-but-invalid or
  head-contradicting grades `EFFECT_UNKNOWN`.
- `dispatch.terminal` carries `receipt | null`.
- `github.signal`'s shape is frozen now (source kind/object id, actor,
  head-sha-at-signal, marker route/attempt, body digest).
- **DELIVERED is derived, never stored** — a pure function over
  (route.decided, dispatch.terminal, signals). No fifth event type; the verdict
  is memorialized only through `outcome.finalized.reason_code`.
- Only DELIVERED routes enter quality evaluation. Marker-only evidence does
  **not** qualify: the marker is leakable and repostable, so it cannot
  authenticate an actor.
- The 168 h timer stays route-scoped and unconditional; receipt state gates
  which close is reachable, not when the clock starts.

### D9 — bounded superseding amendments (approved, pending)

`outcome.finalized` is frozen per route by construction, so a late verified
signal would leave the posterior permanently wrong.

- Amendments are a superseding event with a derived amend id; the fold takes
  the maximum amend sequence, and the lattice is monotone: never away from
  VERIFIED, never into CENSORED, sequence ≤ 1.
- The finalizer never emits `NOT_VERIFIED` before `deadline_at + 24h` with
  complete coverage, and emits nothing at all on transient unresolvability.
- Amendments can only add resolution, so the censoring rule is satisfied
  structurally. Replay stays deterministic: the fold remains a pure,
  order-independent function of the log bytes.

### D17 — orphan enumeration (approved, pending)

A CLI death (SIGKILL/OOM) can leave the reviewer child alive, so a real review
may be posted for a route with **no** `dispatch.terminal` — a state the frozen
outcome table does not enumerate.

- Reconstructed at sync time inside the existing `outcome.finalized`:
  `CENSORED` with reason code `ORPHANED_EFFECT` / `ORPHANED_SILENT`, detected
  by terminal-event absence after `deadline_at`. No new event type, no fold
  change.
- **An orphan-burned slot is not replaceable.** CLI death correlates with task
  weight, so replacement would systematically evict large-diff PRs and bias
  both arms; and because route ids are content-derived and re-dispatch is
  forbidden, replacement would mean a 51st admission while the orphan's
  possibly-real review stays live, making "zero duplicate external effects"
  unauditable.
- Instead, a cohort-level tripwire: **≥3 orphan finalizations invalidate the
  cohort** as a machinery failure, mirroring the mid-cohort-config-edit restart
  lane. Per-slot integrity is preserved and the pathological case is capped.

## What is *not* frozen here

Anything that can be added later without losing data: new optional fields on
future events (readers are open-world), the machine-JSON echo shape, offline
analysis tooling, and every consumer of the audit-only fields above.
