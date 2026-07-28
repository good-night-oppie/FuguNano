import { describe, expect, it } from 'vitest';

import {
  LEGACY_FINGERPRINTS_FOR_TEST,
  SECRET_FINGERPRINTS,
  containsSecretMaterial,
} from './secret-fingerprint.js';

// Every literal here is assembled by concatenation so this source file does not
// itself trip scan-secrets.ts, matching the convention in experience-redact.test.ts.
const A26 = 'abcdefghijklmnopqrstuvwxyz';
const HEX32 = '0123456789abcdef0123456789abcdef';

describe('secret fingerprints', () => {
  // The load-bearing test. The original detector was three unanchored
  // patterns; a "widening" that adds \b to any of them silently REMOVES
  // coverage (`\bsk-` stops matching `xxsk-…`). Rather than trusting review to
  // notice, generate strings the old set matched and assert the new set still
  // matches every one.
  it('is a strict superset of the fingerprints it replaced', () => {
    const legacyPositives = [
      `here is sk-${A26} key`,
      `xxsk-${A26}`, // no word boundary — the case an anchor would drop
      `prefix_sk-${A26}_suffix`,
      `tp-${'abcdefghij0123456789abcdefghij01'}`,
      `zzztp-${'abcdefghij0123456789abcdefghij01'}`,
      `${HEX32}.${'ABCDEFGHIJ012345'}`,
      `embedded${HEX32}.${'ABCDEFGHIJ012345'}tail`,
    ];

    for (const sample of legacyPositives) {
      const matchedByLegacy = LEGACY_FINGERPRINTS_FOR_TEST.some((p) => p.test(sample));
      expect(matchedByLegacy).toBe(true); // the sample is a real legacy positive
      expect(containsSecretMaterial(sample)).toBe(true); // …and is still caught
    }
  });

  it('catches the vendor shapes the old three missed', () => {
    const samples: Record<string, string> = {
      'github pat': `gh${'p'}_${'A'.repeat(36)}`,
      'github fine-grained': `github${'_'}pat_${'B'.repeat(30)}`,
      'slack token': `xo${'xb'}-${'123456789012'}`,
      'slack webhook': `https://hooks.slack.com/services/T${'00000000'}/B${'00000000'}/${'abcdefghijklmnopqrstuvwx'}`,
      'aws access key id': `AK${'IA'}${'ABCDEFGHIJKLMNOP'}`,
      'aws secret assignment': `aws_secret_access_key = ${'A'.repeat(40)}`,
      'npm token': `np${'m_'}${'a'.repeat(36)}`,
      'google api key': `AI${'za'}${'a'.repeat(35)}`,
      'bearer header': `Authorization: Bearer ${'a'.repeat(20)}`,
      'private key block': '-----BEGIN RSA PRIVATE KEY-----',
      'credentialed url': `postgres://dbuser:${'hunter2hunter2'}@db.internal:5432/app`,
      'password assignment': `password = ${'s3cr3t-value-here'}`,
      'api_key assignment': `api_key: ${'abcdefgh12345678'}`,
    };

    for (const [label, sample] of Object.entries(samples)) {
      expect(`${label} -> ${String(containsSecretMaterial(sample))}`).toBe(`${label} -> true`);
    }
  });

  // This predicate REFUSES writes, so a false positive does not leak anything —
  // it makes the experience store unusable and teaches people to route around
  // it. Documentation, templates and secret REFERENCES must stay writable.
  it('does not flag documentation, placeholders or secret references', () => {
    const clean = [
      'a reusable method: cache the probe result',
      'set password = <your-password-here>',
      'export API_KEY=${API_KEY}',
      'password: ***',
      'api_key = xxxxxxxx',
      'token: changeme',
      'secret = your-secret',
      'password = placeholder',
      'read it with op://vault/item/credential',
      'the access_token is redacted in logs',
      'see https://example.com/docs/authentication for the Bearer flow',
      'git clone https://github.com/good-night-oppie/FuguNano.git',
      'rotate the api key monthly',
      'commit 0123456789abcdef0123456789abcdef01234567 landed',
    ];

    for (const sample of clean) {
      expect(`${sample} -> ${String(containsSecretMaterial(sample))}`).toBe(`${sample} -> false`);
    }
  });

  it('has no pattern with the global flag', () => {
    // A /g regex carries lastIndex across .test() calls, so the same input
    // would alternate true/false between invocations.
    for (const pattern of SECRET_FINGERPRINTS) {
      expect(pattern.global).toBe(false);
    }
  });
});
