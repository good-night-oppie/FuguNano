/**
 * Byte-level credential fingerprints, shared so the admission boundaries that
 * must agree cannot drift apart.
 *
 * This is a tripwire, not a security boundary. It catches credential SHAPES;
 * it cannot catch a high-entropy string with no recognisable prefix. The real
 * boundary is not writing secrets into these surfaces in the first place.
 *
 * DESIGN RULE — this set only ever grows, and existing entries are copied
 * verbatim. Adding an anchor like `\b` to an existing pattern NARROWS it
 * (`\bsk-` stops matching `xxsk-…`), so a change presented as "widening
 * coverage" can quietly remove it. `isStrictSupersetOfLegacy` in the test
 * suite exists to make that failure impossible to ship silently.
 */

/**
 * The three fingerprints the experience store shipped with, byte-for-byte.
 * Unanchored on purpose — do not "tidy" them with \b.
 */
const LEGACY_EXPERIENCE_FINGERPRINTS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/u,
  /tp-[a-z0-9]{30,}/u,
  /[0-9a-f]{32}\.[A-Za-z0-9]{16}/u,
];

/**
 * The outcome log's set, copied verbatim from domain/outcome-log.ts. That file
 * keeps its own copy for now: switching it to this union would widen what it
 * REJECTS, which is a behaviour change that does not belong in the same commit
 * as a detector widening. Consolidating the two is tracked separately.
 */
const OUTCOME_LOG_FINGERPRINTS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/u,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
];

/**
 * Shapes neither set covered. Every one is prefix-anchored to a vendor's
 * documented credential format, because this predicate REFUSES writes: a
 * loose pattern here does not leak anything, it makes the store unusable.
 */
const ADDITIONAL_FINGERPRINTS: readonly RegExp[] = [
  // AWS access key id (AKIA/ASIA/AGPA/AIDA… + 16 uppercase alnum).
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/u,
  // AWS secret access key, only in an assignment — 40 base64 chars alone is
  // far too common a shape to flag on its own.
  /\baws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}/iu,
  // npm automation/publish token.
  /\bnpm_[A-Za-z0-9]{36}\b/u,
  // Google / Firebase API key.
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  // Slack webhook URL.
  /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+/u,
  // Credentials embedded in a URL: scheme://user:pass@host.
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/u,
  // A credential-ish key assigned a non-placeholder literal. The negative
  // lookahead keeps documentation and templates usable: <...>, ${...}, ***,
  // xxx, changeme, your-…, and op:// references all stay legal.
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*['"]?(?!['"]?(?:<|\$\{|\*{3,}|x{3,}|changeme|your[-_]|placeholder|redacted|example|op:\/\/|null\b|true\b|false\b|\s*$))[^\s'"]{8,}/iu,
];

/**
 * Union of every fingerprint. Order is irrelevant — the predicate is an OR.
 */
export const SECRET_FINGERPRINTS: readonly RegExp[] = [
  ...LEGACY_EXPERIENCE_FINGERPRINTS,
  ...OUTCOME_LOG_FINGERPRINTS,
  ...ADDITIONAL_FINGERPRINTS,
];

/** Exported for the superset-guard test only. */
export const LEGACY_FINGERPRINTS_FOR_TEST: readonly RegExp[] = LEGACY_EXPERIENCE_FINGERPRINTS;

/** True when `text` contains anything shaped like a credential. */
export const containsSecretMaterial = (text: string): boolean =>
  SECRET_FINGERPRINTS.some((pattern) => pattern.test(text));
