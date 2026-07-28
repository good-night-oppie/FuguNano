# ADX-v3 Weco Product-Mirror · Brand Spec

> Collected: 2026-07-26
> Design owner: AgentDex
> Reference product: Weco
> Asset completeness: AgentDex complete; Weco logo only; authenticated Weco UI screenshots pending.

## Core assets

### AgentDex logo

- Mark: `assets/agentdex-mark.svg`
- Wordmark: `assets/agentdex-wordmark.svg`
- Use: top bar, document lockup, favicon-like identity, screen chrome.
- Rule: never recolor away from the AgentDex lime system; never stretch or redraw.

### Weco reference logo

- File: `assets/weco-logo.svg`
- Source: official `docs.weco.ai` public logo URL, fetched 2026-07-26.
- Use: evidence citation and “informed by” reference only.
- Rule: do not use Weco branding as the primary product identity and do not present ADX concept screens as Weco screenshots.

### UI screenshots

- AgentDex UI context: design system and Arena kit under `/home/admin/.claude/skills/agentdex-design/`.
- Weco authenticated dashboard screenshots: **not available** because Claude-in-Chrome was disconnected on two attempts.
- Fallback: use clearly labeled `ADX CONCEPT` screens built from AgentDex tokens; no counterfeit Weco chrome.

## Color system

Use the real AgentDex Arena tokens:

- App background: `#0B0D10`
- Card: `#12151D`
- Raised: `#181D29`
- Header: `#1E2335`
- Hairline: `#232A3A`
- Strong hairline: `#2E3750`
- Ink: `#E8EDF5`
- Body: `#9BA5B8`
- Muted: `#606B80`
- Primary / active / verified: `#A6E22E`
- Evidence / data / route A: `#4A9EF5`
- Failure / rejected / route B: `#C84B2C`
- Promotion / best / caution: `#F4B731`
- Critical / live blocker: `#FF4655`

No purple SaaS gradients. Purple is not used in this concept even though a legacy meta token exists.

## Typography

- Display/UI: Chakra Petch
- Data/code/meta: IBM Plex Mono
- CJK: Noto Sans SC
- Editorial flavor: Bitter italic, used at most once.
- Technical labels: uppercase mono with wide tracking.
- Bilingual copy: English canonical, 中文 trailing gloss.

## Visual philosophy

**AgentDex Arena control-room**

- Dense, operational, evidence-first.
- Experiment lineage is the hero visualization.
- Cards are moderate-radius bounded instruments, not bubbly SaaS tiles.
- Active selections use a lime hairline/glow; best/promoted uses gold.
- Failed branches remain visible in rust; unknown effects use critical red and disable retry actions.
- Every metric shows provenance state before value.

## Interaction signatures

- Snappy 90–280ms transitions; no ambient looping.
- Branch selection updates node inspector and evidence drawer.
- `Derive` creates a new lineage branch; it never overwrites history.
- `Promote` is not a single click: review → evidence gate → receipt → applied → verified.
- `EFFECT_UNKNOWN` is terminal and visibly non-retryable until reconciled.
- Respect `prefers-reduced-motion`.

## Signature detail

The 120% detail is the **lineage rail**: every node displays status, parent edge, metric direction, evaluator state, and provenance tier in one compact, keyboard-addressable grammar. Failed nodes stay in place instead of disappearing.

## Prohibited patterns

- Counterfeit Weco dashboard screenshots.
- Generic purple AI gradients or neon cyber backgrounds.
- Decorative emoji or icon-per-label clutter.
- Fake statistics or unlabeled concept data.
- “Best” without evaluator provenance and hard-gate status.
- Browser/UI authority that re-ranks, retries, or writes canonical routing state.
