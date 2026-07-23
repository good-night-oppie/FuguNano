/**
 * Closed vocabularies for the AgentDex PR-review slice (frozen baseline
 * 2026-07-23). One module, imported by both the config loader and the
 * profile validator, so the two fail-closed surfaces can never drift apart
 * (routing-config ↔ task-profile would otherwise need a circular import).
 *
 * WORKER_LINEAGES exists because §B5's same-lineage exclusion is frozen as
 * EXACT string inequality: if the config spelled a lineage `claude-code`
 * while the façade's author marker said `claude`, an agent family would
 * silently review its own code. Closing both ends to the same three family
 * tokens makes exact inequality equal family inequality — the drift is
 * refused at load/parse time instead of silently passing the filter.
 * Candidate NAMES stay free-form; only the lineage field is closed.
 */

export const CANONICAL_LANGUAGES = [
  'python',
  'typescript',
  'javascript',
  'rust',
  'go',
  'java',
  'kotlin',
  'swift',
  'csharp',
  'c',
  'cpp',
  'ruby',
  'php',
  'scala',
  'shell',
  'sql',
  'terraform',
  'protobuf',
  'config',
  'docs',
  'other',
] as const;
export type CanonicalLanguage = (typeof CANONICAL_LANGUAGES)[number];

export const RISK_TAGS = [
  'auth_security',
  'database_migration',
  'ci_config',
  'dependency_change',
  'infrastructure',
  'public_api',
  'generated_vendor',
  'large_diff',
  'binary_diff',
  'unknown_language',
] as const;
export type RiskTag = (typeof RISK_TAGS)[number];

/** The v1 worker families (§B5 example set). Adding a family is a config-schema change. */
export const WORKER_LINEAGES = ['claude', 'codex', 'gemini'] as const;
export type WorkerLineage = (typeof WORKER_LINEAGES)[number];

/**
 * Validate one capability token: `pr-review`, a `lang:`/`risk:` wildcard, or
 * a `lang:`/`risk:` member of the closed enums. Anything else is a typo that
 * would otherwise silently narrow (or never match) the eligible pool.
 */
export const isValidCapability = (token: string): boolean => {
  if (token === 'pr-review') return true;
  if (token === 'lang:*' || token === 'risk:*') return true;
  if (token.startsWith('lang:')) {
    return (CANONICAL_LANGUAGES as ReadonlyArray<string>).includes(token.slice(5));
  }
  if (token.startsWith('risk:')) {
    return (RISK_TAGS as ReadonlyArray<string>).includes(token.slice(5));
  }
  return false;
};
