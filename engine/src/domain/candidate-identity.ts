import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

import type { CandidateConfig } from './routing-config.js';

/**
 * Observed-at-route-time identity of a ranked candidate's implementation.
 *
 * A candidate `name` is an alias, not a treatment version: `config_sha256`
 * hashes only config file bytes, and `argv[0]` is checked merely `isAbsolute`.
 * Recording these digests at route time keeps every future identity policy
 * computable from the log alone. Audit-only in v1 — the fold stays name-keyed.
 *
 * REJECTED: any version-string field. Obtaining one would execute the
 * candidate at route time — a spawn-boundary breach. Do not add one.
 */
export interface CandidateIdentity {
  readonly candidateId: string;
  readonly argv0Realpath: string;
  readonly argv0Sha256: string | null;
  /** errno code ONLY ('EACCES'|'ENOENT'|'ELOOP'|...); present iff argv0Sha256 is null. */
  readonly argv0DigestError?: string;
  readonly argvSha256: string;
}

/** Hard cap on argv[0] bytes digested into memory. Generous; the tripwire is unbounded read. */
export const MAX_ARGV0_DIGEST_BYTES = 256 * 1024 * 1024;

/** Test-only override for MAX_ARGV0_DIGEST_BYTES. Production never sets this. */
let argv0DigestBytesCapForTest: number | undefined;

/** Test seam: shrink the digest cap without a multi-GB fixture. Pass undefined to clear. */
export const setArgv0DigestBytesCapForTest = (bytes: number | undefined): void => {
  argv0DigestBytesCapForTest = bytes;
};

const sha256Hex = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

const errnoCode = (error: unknown): string => {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'EIO';
};

/**
 * Digest argv[0] after a regular-file + size-cap gate. Never throws: non-regular
 * (FIFO/dir/device) → ENOTSUP; oversize → EFBIG; other fs errors → errno.
 * Skipping the open on non-regular paths is load-bearing — open(2) on a FIFO
 * with no writer blocks forever and hangs the one-shot CLI.
 */
const digestArgv0 = (argv0Realpath: string): { sha256: string | null; error?: string } => {
  try {
    const st = fs.statSync(argv0Realpath);
    if (!st.isFile()) {
      return { sha256: null, error: 'ENOTSUP' };
    }
    const cap = argv0DigestBytesCapForTest ?? MAX_ARGV0_DIGEST_BYTES;
    if (st.size > cap) {
      return { sha256: null, error: 'EFBIG' };
    }
    return { sha256: sha256Hex(fs.readFileSync(argv0Realpath)) };
  } catch (error) {
    return { sha256: null, error: errnoCode(error) };
  }
};

/** Compute the observed identity for one candidate. Never throws. */
export const computeCandidateIdentity = (candidate: CandidateConfig): CandidateIdentity => {
  const argv0 = candidate.argv[0] ?? '';
  let argv0Realpath: string;
  try {
    argv0Realpath = fs.realpathSync(argv0);
  } catch {
    argv0Realpath = argv0;
  }

  const digested = digestArgv0(argv0Realpath);

  return {
    candidateId: candidate.name,
    argv0Realpath,
    argv0Sha256: digested.sha256,
    argvSha256: sha256Hex(JSON.stringify(candidate.argv)),
    ...(digested.error !== undefined ? { argv0DigestError: digested.error } : {}),
  };
};

/**
 * Identities for a ranked list, memoized per `argv0Realpath` so two candidates
 * that share a binary pay for one file read.
 */
export const computeCandidateIdentities = (
  ranked: ReadonlyArray<CandidateConfig>,
): CandidateIdentity[] => {
  const digestByRealpath = new Map<string, { sha256: string | null; error?: string }>();
  return ranked.map((candidate) => {
    const argv0 = candidate.argv[0] ?? '';
    let argv0Realpath: string;
    try {
      argv0Realpath = fs.realpathSync(argv0);
    } catch {
      argv0Realpath = argv0;
    }

    let cached = digestByRealpath.get(argv0Realpath);
    if (cached === undefined) {
      cached = digestArgv0(argv0Realpath);
      digestByRealpath.set(argv0Realpath, cached);
    }

    return {
      candidateId: candidate.name,
      argv0Realpath,
      argv0Sha256: cached.sha256,
      argvSha256: sha256Hex(JSON.stringify(candidate.argv)),
      ...(cached.error !== undefined ? { argv0DigestError: cached.error } : {}),
    };
  });
};
