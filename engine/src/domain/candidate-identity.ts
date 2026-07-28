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

const sha256Hex = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

const errnoCode = (error: unknown): string => {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'EIO';
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

  let argv0Sha256: string | null = null;
  let argv0DigestError: string | undefined;
  try {
    argv0Sha256 = sha256Hex(fs.readFileSync(argv0Realpath));
  } catch (error) {
    argv0Sha256 = null;
    argv0DigestError = errnoCode(error);
  }

  return {
    candidateId: candidate.name,
    argv0Realpath,
    argv0Sha256,
    argvSha256: sha256Hex(JSON.stringify(candidate.argv)),
    ...(argv0DigestError !== undefined ? { argv0DigestError } : {}),
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
      try {
        cached = { sha256: sha256Hex(fs.readFileSync(argv0Realpath)) };
      } catch (error) {
        cached = { sha256: null, error: errnoCode(error) };
      }
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
