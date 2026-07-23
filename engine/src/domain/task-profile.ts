import { OutcomeLogError } from './outcome-log.js';
import {
  CANONICAL_LANGUAGES,
  RISK_TAGS,
  WORKER_LINEAGES,
  type CanonicalLanguage,
  type RiskTag,
} from './review-vocab.js';
import { assertNoDuplicateKeys } from './routing-config.js';

export { CANONICAL_LANGUAGES, RISK_TAGS, type CanonicalLanguage, type RiskTag };

/**
 * Frozen 7-field TaskProfile for the AgentDex PR-review slice
 * (frozen baseline 2026-07-23, §B4), plus the literal-loopback guard the
 * wiring applies to config strings (§D "local endpoint 只接受 literal
 * 127.0.0.1 / ::1").
 *
 * The profile is BUILT by the AgentDex façade (languages from diff
 * extensions, risk tags from the closed trigger table, paths normalized,
 * sorted, deduplicated); this module only decides valid/invalid — fail
 * closed, exit-2 territory, never repair. Error messages name field paths
 * and (for the unknown-field case) caller-supplied key names — never field
 * VALUES; the machine-JSON envelope additionally withholds any reason that
 * trips the credential-shape scan, so even a key spelled like a token
 * cannot reach stdout or a log line.
 */

const PROFILE_FIELDS = new Set([
  'repo',
  'pr',
  'head_sha',
  'author_lineage',
  'languages',
  'changed_paths',
  'risk_tags',
]);

export interface TaskProfile {
  readonly repo: string;
  readonly pr: number;
  readonly headSha: string;
  readonly authorLineage: string;
  readonly languages: ReadonlyArray<CanonicalLanguage>;
  readonly changedPaths: ReadonlyArray<string>;
  readonly riskTags: ReadonlyArray<RiskTag>;
}

const invalid = (message: string): OutcomeLogError =>
  new OutcomeLogError('INVALID_EVENT', `profile: ${message}`);

const REPO_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

const requireUniqueStrings = (value: unknown, name: string): string[] => {
  if (!Array.isArray(value)) throw invalid(`${name} must be an array`);
  const items = value.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw invalid(`${name}[${i}] must be a non-empty string`);
    }
    return item;
  });
  if (new Set(items).size !== items.length) throw invalid(`${name} must not contain duplicates`);
  return items;
};

const validatePath = (item: string, name: string): void => {
  if (item.length > 4096) throw invalid(`${name} too long`);
  if (CONTROL_RE.test(item)) throw invalid(`${name} contains control characters`);
  if (item.includes('\\')) throw invalid(`${name} must use POSIX separators`);
  if (item.startsWith('/')) throw invalid(`${name} must be repo-relative`);
  if (item.endsWith('/') || item.includes('//')) throw invalid(`${name} is not normalized`);
  const segments = item.split('/');
  if (segments.some((s) => s === '.' || s === '..')) {
    throw invalid(`${name} must not contain . or .. segments`);
  }
};

/** Parse + validate the frozen 7-field profile; anything off-spec fails closed. */
export const parseTaskProfile = (raw: string): TaskProfile => {
  assertNoDuplicateKeys(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('top level must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PROFILE_FIELDS.has(key)) throw invalid(`unknown field ${key}`);
  }
  for (const key of PROFILE_FIELDS) {
    if (!(key in record)) throw invalid(`missing field ${key}`);
  }

  const repo = record['repo'];
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    throw invalid('repo must be lowercase owner/name');
  }
  const pr = record['pr'];
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) {
    throw invalid('pr must be a positive integer');
  }
  const headSha = record['head_sha'];
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) {
    throw invalid('head_sha must be 40 lowercase hex chars');
  }
  const authorLineage = record['author_lineage'];
  if (
    typeof authorLineage !== 'string' ||
    authorLineage.length === 0 ||
    authorLineage.length > 256 ||
    CONTROL_RE.test(authorLineage)
  ) {
    throw invalid('author_lineage must be a non-empty printable string');
  }
  // Closed at both ends (see review-vocab.ts): a façade emitting an alias
  // like `claude-code` would defeat the exact-inequality same-lineage filter,
  // so anything that is neither `human:<login>` nor a family token is
  // refused here rather than silently passing eligibility.
  const isHuman = authorLineage.startsWith('human:') && authorLineage.length > 'human:'.length;
  if (!isHuman && !(WORKER_LINEAGES as ReadonlyArray<string>).includes(authorLineage)) {
    throw invalid('author_lineage must be human:<login> or a known worker family');
  }

  const languages = requireUniqueStrings(record['languages'], 'languages');
  if (languages.length === 0) throw invalid('languages must be non-empty');
  languages.forEach((lang, i) => {
    if (!(CANONICAL_LANGUAGES as ReadonlyArray<string>).includes(lang)) {
      throw invalid(`languages[${i}] is not a canonical language`);
    }
  });

  const changedPaths = requireUniqueStrings(record['changed_paths'], 'changed_paths');
  if (changedPaths.length === 0) throw invalid('changed_paths must be non-empty');
  changedPaths.forEach((p, i) => {
    validatePath(p, `changed_paths[${i}]`);
  });
  for (let i = 1; i < changedPaths.length; i += 1) {
    if (Buffer.compare(Buffer.from(changedPaths[i - 1]!), Buffer.from(changedPaths[i]!)) >= 0) {
      throw invalid('changed_paths must be sorted by byte order');
    }
  }

  const riskTags = requireUniqueStrings(record['risk_tags'], 'risk_tags');
  riskTags.forEach((tag, i) => {
    if (!(RISK_TAGS as ReadonlyArray<string>).includes(tag)) {
      throw invalid(`risk_tags[${i}] is not a known risk tag`);
    }
  });

  // The frozen trigger table binds these two: `unknown_language` fires iff
  // languages contain `other`. A profile violating that is builder drift.
  const hasOther = languages.includes('other');
  const hasUnknownTag = riskTags.includes('unknown_language');
  if (hasOther !== hasUnknownTag) {
    throw invalid('languages "other" and risk tag "unknown_language" must appear together');
  }

  return {
    repo,
    pr,
    headSha,
    authorLineage,
    languages: languages as CanonicalLanguage[],
    changedPaths,
    riskTags: riskTags as RiskTag[],
  };
};

// --- literal-loopback guard -------------------------------------------------

/**
 * §D: a local endpoint may only ever be written as literal `127.0.0.1` or
 * `::1`. Any other local-claiming host — `localhost`, `0.0.0.0`, `::`, other
 * 127/8 addresses, alternative IPv6 loopback spellings, v4-mapped loopback —
 * fails closed. Hosts that are not local claims (real DNS names, routable
 * IPs) pass: the rule governs how LOCAL endpoints are spelled, it is not an
 * egress firewall. This is a config tripwire against our own config drifting
 * onto resolver-dependent local names, not a defense against an adversarial
 * config author.
 */

// Userinfo is consumed greedily through the LAST `@` (whatwg semantics), so
// `http://a@b@localhost/` cannot smuggle the real host into a fake userinfo.
const URL_HOST_RE = /[a-z][a-z0-9+.-]*:\/\/(?:[^/\s]*@)?(\[[^\]\s]*\]|[^\s/:?#]+)/gi;

/**
 * Scheme-less endpoint spelling: `--addr localhost:3456`, `127.1:8080`,
 * `//localhost:3456`, `[::]:8080`. The most likely real-world drift form is
 * a bare host:port flag value, so the gate must see those too. The numeric
 * port (1–5 digits) keeps capability tokens like `lang:*` and free text out
 * of scope; hostnames that are not local claims still pass.
 */
const BARE_ENDPOINT_RE =
  /(?:^|[\s"'=@(,;/])(\[[^\]\s]*\]|[a-z0-9._-]+):(\d{1,5})(?=$|[\s"',;)?#/])/gi;

const parseIpv6Groups = (host: string): number[] | null => {
  // Returns 8 16-bit groups, folding a trailing v4 tail into two groups.
  let body = host;
  let v4Tail: string | null = null;
  const lastColon = body.lastIndexOf(':');
  if (lastColon !== -1 && body.slice(lastColon + 1).includes('.')) {
    v4Tail = body.slice(lastColon + 1);
    body = body.slice(0, lastColon + 1);
    if (body.endsWith('::') === false && body.endsWith(':')) body = body.slice(0, -1);
  }
  const tailGroups: number[] = [];
  if (v4Tail !== null) {
    const quads = v4Tail.split('.').map((q) => Number(q));
    if (quads.length !== 4 || quads.some((q) => !Number.isInteger(q) || q < 0 || q > 255)) {
      return null;
    }
    tailGroups.push(quads[0]! * 256 + quads[1]!, quads[2]! * 256 + quads[3]!);
  }
  const parts = body.split('::');
  if (parts.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const groups: number[] = [];
    for (const piece of side.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };
  const head = parseSide(parts[0]!);
  if (head === null) return null;
  const tail = parts.length === 2 ? parseSide(parts[1]!) : [];
  if (tail === null) return null;
  if (parts.length === 2) {
    const known = head.length + tail.length + tailGroups.length;
    if (known > 8) return null;
    return [...head, ...Array<number>(8 - known).fill(0), ...tail, ...tailGroups];
  }
  const groups = [...head, ...tailGroups];
  return groups.length === 8 ? groups : null;
};

/**
 * inet_aton-style numeric host parse: 1–4 dot-separated labels, each
 * decimal / 0x-hex / 0-octal; the last label fills the remaining bytes.
 * `http://127.1`, `http://0x7f000001`, `http://2130706433` all resolve to
 * loopback without ever spelling it — that is exactly the class the literal
 * rule exists to refuse. Returns the 32-bit address, or null when any label
 * is non-numeric (a DNS name, handled elsewhere).
 */
const parseNumericIpv4 = (host: string): number | null => {
  const labels = host.split('.');
  if (labels.length < 1 || labels.length > 4) return null;
  const values: number[] = [];
  for (const label of labels) {
    if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(label)) return null;
    const value = /^0x/i.test(label)
      ? Number.parseInt(label, 16)
      : /^0[0-7]*$/.test(label)
        ? Number.parseInt(label, 8)
        : Number.parseInt(label, 10);
    if (!Number.isFinite(value) || value < 0) return null;
    values.push(value);
  }
  const last = values[values.length - 1]!;
  const prefix = values.slice(0, -1);
  if (prefix.some((v) => v > 255)) return null;
  const restBytes = 4 - prefix.length;
  if (last >= 2 ** (restBytes * 8)) return null;
  let addr = 0;
  for (const v of prefix) addr = addr * 256 + v;
  return addr * 2 ** (restBytes * 8) + last;
};

const isForbiddenLocalHost = (rawHost: string): boolean => {
  const host = rawHost.toLowerCase().replace(/\.$/, '');
  if (host === '127.0.0.1') return false; // the one legal IPv4 spelling
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (!host.includes(':')) {
    const addr = parseNumericIpv4(host);
    if (addr !== null && (addr >>> 24 === 127 || addr === 0)) return true; // 127/8 or 0.0.0.0 in any numeric spelling
  }
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === '::1') return false; // the one legal IPv6 spelling
  // A zone id (raw `%` or pct-encoded `%25`) is stripped before the address
  // check: `::1%eth0` / `[::1%25eth0]` are loopback claims that are NOT the
  // literal `::1`, so they must be refused, not skipped as unparseable.
  const zoneIdx = bare.indexOf('%');
  const addrPart = zoneIdx === -1 ? bare : bare.slice(0, zoneIdx);
  if (addrPart.includes(':')) {
    const groups = parseIpv6Groups(addrPart);
    if (groups === null) return false; // not parseable as IPv6 → hostname-ish, not a local claim
    const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
    const isUnspecified = groups.every((g) => g === 0);
    const isV4MappedLoopback =
      groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff && groups[6]! >> 8 === 127;
    return isLoopback || isUnspecified || isV4MappedLoopback;
  }
  return false;
};

/**
 * Walk every string in `value`; any URL whose host makes a local claim in a
 * non-literal spelling fails closed. Names the field path, never the value.
 */
export const assertLiteralLoopbackOnly = (value: unknown, keyPath: string): void => {
  if (typeof value === 'string') {
    for (const re of [URL_HOST_RE, BARE_ENDPOINT_RE]) {
      for (const match of value.matchAll(re)) {
        if (isForbiddenLocalHost(match[1]!)) {
          throw invalid(
            `${keyPath} refers to a local endpoint that is not literal 127.0.0.1 or ::1`,
          );
        }
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertLiteralLoopbackOnly(item, `${keyPath}[${i}]`);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertLiteralLoopbackOnly(v, `${keyPath}.${k}`);
  }
};
