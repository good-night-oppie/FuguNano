import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertNoSecretMaterial, OutcomeLogError } from './outcome-log.js';
import { isValidCapability, WORKER_LINEAGES } from './review-vocab.js';

/**
 * Plain-JSON routing config for the AgentDex PR-review slice
 * (frozen baseline 2026-07-23, §B5 as amended by R4-1: JSON, not YAML).
 *
 * Fail-closed by construction:
 * - one canonical path, one absolute-only env override — no cwd/repo
 *   fallback, no `~` expansion, no third config authority;
 * - strict schema: unknown fields, wrong types, out-of-range values are
 *   errors, never warnings;
 * - duplicate keys are rejected at ANY depth BEFORE JSON.parse runs —
 *   JSON.parse silently keeps the last duplicate (an R4 review catch), so a
 *   scanner walks the raw text first;
 * - `config_sha256` is the SHA-256 of the exact file bytes; it rides along
 *   in every route.decided event, so a mid-cohort config edit is detectable.
 */

export const CONFIG_FORMAT = 1;
export const CONFIG_ENV_OVERRIDE = 'AGENTDEX_ROUTING_CONFIG';

const ROOT_FIELDS = new Set([
  'format',
  'dispatch_timeout_seconds',
  'slot_wait_seconds',
  'max_attempts',
  'max_in_flight',
  'candidates',
]);

const CANDIDATE_FIELDS = new Set([
  'name',
  'argv',
  'lineage',
  'capabilities',
  'static_priority',
  'enabled',
]);

export interface CandidateConfig {
  readonly name: string;
  readonly argv: ReadonlyArray<string>;
  readonly lineage: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly static_priority: number;
  readonly enabled: boolean;
}

export interface RoutingConfig {
  readonly format: typeof CONFIG_FORMAT;
  readonly dispatch_timeout_seconds: number;
  readonly slot_wait_seconds: number;
  readonly max_attempts: number;
  readonly max_in_flight: number;
  readonly candidates: ReadonlyArray<CandidateConfig>;
}

export interface LoadedConfig {
  readonly config: RoutingConfig;
  /** SHA-256 hex of the exact file bytes; recorded in every route.decided. */
  readonly configSha256: string;
  readonly configPath: string;
}

const invalid = (message: string): OutcomeLogError =>
  new OutcomeLogError('INVALID_EVENT', `config: ${message}`);

// --- path resolution (R4-1 rules) ------------------------------------------

export const resolveConfigPath = (env: Record<string, string | undefined>): string => {
  const override = env[CONFIG_ENV_OVERRIDE];
  if (override !== undefined) {
    if (override.length === 0 || !path.isAbsolute(override) || override.startsWith('~')) {
      throw invalid(`${CONFIG_ENV_OVERRIDE} must be a non-empty absolute path`);
    }
    return override;
  }
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.length > 0) {
    if (!path.isAbsolute(xdg)) throw invalid('XDG_CONFIG_HOME must be absolute');
    return path.join(xdg, 'agentdex', 'pr-review-routing-v1.json');
  }
  const home = env['HOME'];
  if (!home || !path.isAbsolute(home)) {
    throw invalid('cannot resolve config dir: HOME missing or not absolute');
  }
  return path.join(home, '.config', 'agentdex', 'pr-review-routing-v1.json');
};

// --- duplicate-key pre-scan -------------------------------------------------

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/**
 * Reject duplicate object keys at any depth. JSON.parse is last-wins on
 * duplicates, which would let a stale key silently shadow a live one —
 * "strict fail-closed is not free with JSON.parse" (R4-1). String-aware
 * scanner: tracks object scopes and the key set of each. Keys are compared
 * DECODED, exactly as JSON.parse compares them — raw escape text would treat
 * `"pr"` and `"pr"` as different keys and let the duplicate through
 * (an adversarial-review catch; raw comparison is looser, not stricter).
 */
export const assertNoDuplicateKeys = (raw: string): void => {
  type Scope = { kind: 'object'; keys: Set<string>; expectKey: boolean } | { kind: 'array' };
  const stack: Scope[] = [];
  let i = 0;
  const n = raw.length;

  const readString = (): string => {
    // raw[i] === '"' on entry; returns the JSON-decoded string.
    let out = '';
    i += 1;
    while (i < n) {
      const ch = raw[i]!;
      if (ch === '\\') {
        const esc = raw[i + 1];
        if (esc === undefined) throw invalid('unterminated string');
        if (esc === 'u') {
          const hex = raw.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw invalid('invalid unicode escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 6;
          continue;
        }
        const decoded = SIMPLE_ESCAPES[esc];
        if (decoded === undefined) throw invalid('invalid escape');
        out += decoded;
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return out;
      }
      out += ch;
      i += 1;
    }
    throw invalid('unterminated string');
  };

  while (i < n) {
    const ch = raw[i]!;
    const top = stack[stack.length - 1];
    if (ch === '"') {
      const isKey = top !== undefined && top.kind === 'object' && top.expectKey;
      const text = readString();
      if (isKey && top.kind === 'object') {
        // Reason hygiene (§D): never echo the key text — it is raw input.
        if (top.keys.has(text)) throw invalid('duplicate object key');
        top.keys.add(text);
        top.expectKey = false;
      }
      continue;
    }
    if (ch === '{') {
      stack.push({ kind: 'object', keys: new Set(), expectKey: true });
    } else if (ch === '[') {
      stack.push({ kind: 'array' });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',' && top !== undefined && top.kind === 'object') {
      top.expectKey = true;
    }
    i += 1;
  }
};

// --- schema validation ------------------------------------------------------

const requirePositiveInteger = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(`${name} must be a positive integer`);
  }
  return value;
};

const requireNonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${name} must be a non-empty string`);
  }
  return value;
};

const validateCandidate = (value: unknown, index: number): CandidateConfig => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`candidates[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!CANDIDATE_FIELDS.has(key)) throw invalid(`candidates[${index}]: unknown field ${key}`);
  }
  const name = requireNonEmptyString(record['name'], `candidates[${index}].name`);
  const lineage = requireNonEmptyString(record['lineage'], `candidates[${index}].lineage`);
  // Closed family vocabulary (see review-vocab.ts): a free-form lineage like
  // `claude-code` would defeat the frozen exact-inequality self-review filter.
  if (!(WORKER_LINEAGES as ReadonlyArray<string>).includes(lineage)) {
    throw invalid(`candidates[${index}].lineage must be a known worker family`);
  }
  const argv = record['argv'];
  if (!Array.isArray(argv) || argv.length === 0) {
    throw invalid(`candidates[${index}].argv must be a non-empty array`);
  }
  const argvStrings = argv.map((item, j) =>
    requireNonEmptyString(item, `candidates[${index}].argv[${j}]`),
  );
  if (!path.isAbsolute(argvStrings[0]!)) {
    throw invalid(`candidates[${index}].argv[0] must be an absolute path`);
  }
  // A credential pasted into argv would otherwise be accepted and handed to
  // spawn(), i.e. into /proc/<pid>/cmdline, readable by every same-uid
  // process. Rethrown through invalid() so the kind stays INVALID_EVENT: a
  // bad config value is caller fault (invalid_input, exit 2), not store
  // trouble (state_error, exit 74) — and the tripwire's message already
  // names only the field path, never the match.
  try {
    assertNoSecretMaterial(argvStrings, `candidates[${index}].argv`);
  } catch (error) {
    throw invalid((error as OutcomeLogError).message);
  }
  const capabilities = record['capabilities'];
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw invalid(`candidates[${index}].capabilities must be a non-empty array`);
  }
  const capStrings = capabilities.map((item, j) =>
    requireNonEmptyString(item, `candidates[${index}].capabilities[${j}]`),
  );
  // Tokens are validated against the closed enums: `lang:Python` or
  // `lang:pyton` would otherwise never match a (lowercase, closed) profile
  // language and silently narrow the pool to NO_ELIGIBLE_AGENT.
  capStrings.forEach((token, j) => {
    if (!isValidCapability(token)) {
      throw invalid(`candidates[${index}].capabilities[${j}] is not a known capability token`);
    }
  });
  if (!capStrings.includes('pr-review')) {
    throw invalid(`candidates[${index}].capabilities must include pr-review`);
  }
  const staticPriority = requirePositiveInteger(
    record['static_priority'],
    `candidates[${index}].static_priority`,
  );
  if (typeof record['enabled'] !== 'boolean') {
    throw invalid(`candidates[${index}].enabled must be a boolean`);
  }
  return {
    name,
    argv: argvStrings,
    lineage,
    capabilities: capStrings,
    static_priority: staticPriority,
    enabled: record['enabled'],
  };
};

export const parseRoutingConfig = (raw: string): RoutingConfig => {
  assertNoDuplicateKeys(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never interpolate the parser message: modern V8 embeds a snippet of
    // the input, and config bytes must not travel into reasons/logs.
    throw invalid('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('top level must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ROOT_FIELDS.has(key)) throw invalid(`unknown field ${key}`);
  }
  for (const key of ROOT_FIELDS) {
    if (!(key in record)) throw invalid(`missing field ${key}`);
  }
  if (record['format'] !== CONFIG_FORMAT) {
    throw invalid(`unknown format ${String(record['format'])} (fail closed)`);
  }
  const candidatesRaw = record['candidates'];
  if (!Array.isArray(candidatesRaw) || candidatesRaw.length === 0) {
    throw invalid('candidates must be a non-empty array');
  }
  const candidates = candidatesRaw.map(validateCandidate);
  const names = new Set<string>();
  const priorities = new Set<number>();
  for (const candidate of candidates) {
    if (names.has(candidate.name)) throw invalid(`duplicate candidate name ${candidate.name}`);
    names.add(candidate.name);
    if (priorities.has(candidate.static_priority)) {
      throw invalid(`duplicate static_priority ${candidate.static_priority}`);
    }
    priorities.add(candidate.static_priority);
  }
  return {
    format: CONFIG_FORMAT,
    dispatch_timeout_seconds: requirePositiveInteger(
      record['dispatch_timeout_seconds'],
      'dispatch_timeout_seconds',
    ),
    slot_wait_seconds: requirePositiveInteger(record['slot_wait_seconds'], 'slot_wait_seconds'),
    max_attempts: requirePositiveInteger(record['max_attempts'], 'max_attempts'),
    max_in_flight: requirePositiveInteger(record['max_in_flight'], 'max_in_flight'),
    candidates,
  };
};

/** Load + validate the config file; hash is over the exact file bytes. */
export const loadRoutingConfig = (env: Record<string, string | undefined>): LoadedConfig => {
  const configPath = resolveConfigPath(env);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(configPath);
  } catch {
    throw invalid(`cannot read ${configPath}`);
  }
  const config = parseRoutingConfig(bytes.toString('utf8'));
  return {
    config,
    configSha256: createHash('sha256').update(bytes).digest('hex'),
    configPath,
  };
};
