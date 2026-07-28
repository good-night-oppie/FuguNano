/**
 * Redaction + slug helpers for experience memory (pure).
 *
 * `containsSecret` is the experience store's admission boundary: a plaintext
 * credential must never enter the store. It used to carry its own copy of the
 * three fingerprints in scripts/scan-secrets.ts, which meant common GitHub,
 * Slack, AWS, npm and credentialed-URL shapes walked straight in. It now
 * delegates to the shared fingerprint set, which is a strict superset of those
 * original three — see domain/secret-fingerprint.ts for why that direction is
 * enforced by a test rather than left to review.
 */
import { containsSecretMaterial } from './secret-fingerprint.js';

export const containsSecret = (text: string): boolean => containsSecretMaterial(text);

/** space/slash → '-', drop quotes/backticks (bash `slugify`). */
export const slugify = (title: string): string =>
  title.replace(/[ /]/gu, '-').replace(/["'`]/gu, '');
