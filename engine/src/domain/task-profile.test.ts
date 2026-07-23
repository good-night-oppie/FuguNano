import { describe, expect, it } from 'vitest';

import {
  assertLiteralLoopbackOnly,
  CANONICAL_LANGUAGES,
  parseTaskProfile,
  RISK_TAGS,
} from './task-profile.js';

const base = {
  repo: 'acme/widgets',
  pr: 7,
  head_sha: 'e'.repeat(40),
  author_lineage: 'human:alice',
  languages: ['python'],
  changed_paths: ['src/app.py'],
  risk_tags: [],
};

const profile = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...base, ...overrides });

describe('parseTaskProfile', () => {
  it('accepts a fully valid frozen profile', () => {
    const parsed = parseTaskProfile(profile());
    expect(parsed).toStrictEqual({
      repo: 'acme/widgets',
      pr: 7,
      headSha: 'e'.repeat(40),
      authorLineage: 'human:alice',
      languages: ['python'],
      changedPaths: ['src/app.py'],
      riskTags: [],
    });
  });

  it('rejects non-JSON, arrays, and duplicate keys', () => {
    expect(() => parseTaskProfile('nope')).toThrow(/not valid JSON/);
    expect(() => parseTaskProfile('[]')).toThrow(/top level/);
    expect(() => parseTaskProfile(profile().replace('{', `{"repo":"x/x",`))).toThrow(
      /duplicate object key/,
    );
  });

  it('rejects unknown and missing fields (exactly the frozen seven)', () => {
    expect(() => parseTaskProfile(profile({ extra: 1 }))).toThrow(/unknown field extra/);
    const missing = { ...base } as Record<string, unknown>;
    delete missing['risk_tags'];
    expect(() => parseTaskProfile(JSON.stringify(missing))).toThrow(/missing field risk_tags/);
  });

  it('repo must be lowercase owner/name', () => {
    for (const bad of ['Acme/widgets', 'acme', 'acme/', '/widgets', 'a cme/w', 'acme/wid/gets']) {
      expect(() => parseTaskProfile(profile({ repo: bad }))).toThrow(/repo/);
    }
  });

  it('pr must be a positive integer, head_sha 40 lowercase hex', () => {
    for (const bad of [0, -1, 1.5, '7']) {
      expect(() => parseTaskProfile(profile({ pr: bad }))).toThrow(/pr/);
    }
    for (const bad of ['E'.repeat(40), 'e'.repeat(39), 'g'.repeat(40)]) {
      expect(() => parseTaskProfile(profile({ head_sha: bad }))).toThrow(/head_sha/);
    }
  });

  it('languages: closed canonical set, unique, non-empty', () => {
    expect(() => parseTaskProfile(profile({ languages: [] }))).toThrow(/languages/);
    expect(() => parseTaskProfile(profile({ languages: ['klingon'] }))).toThrow(
      /not a canonical language/,
    );
    expect(() => parseTaskProfile(profile({ languages: ['python', 'python'] }))).toThrow(
      /duplicates/,
    );
    // never echo the offending value back
    try {
      parseTaskProfile(profile({ languages: ['klingon'] }));
    } catch (error) {
      expect((error as Error).message).not.toContain('klingon');
    }
    expect(CANONICAL_LANGUAGES).toContain('other');
  });

  it('changed_paths: POSIX-normalized, repo-relative, byte-sorted, unique', () => {
    for (const bad of [
      ['/abs/path.py'],
      ['a//b.py'],
      ['a/./b.py'],
      ['../up.py'],
      ['dir/'],
      ['back\\slash.py'],
    ]) {
      expect(() => parseTaskProfile(profile({ changed_paths: bad }))).toThrow(/changed_paths/);
    }
    expect(() => parseTaskProfile(profile({ changed_paths: ['b.py', 'a.py'] }))).toThrow(/sorted/);
    expect(() => parseTaskProfile(profile({ changed_paths: [] }))).toThrow(/non-empty/);
    expect(
      parseTaskProfile(profile({ changed_paths: ['a.py', 'b.py'] })).changedPaths,
    ).toStrictEqual(['a.py', 'b.py']);
  });

  it('risk_tags: closed set; may be empty', () => {
    expect(() => parseTaskProfile(profile({ risk_tags: ['made_up'] }))).toThrow(
      /not a known risk tag/,
    );
    expect(RISK_TAGS).toHaveLength(10);
    const tagged = parseTaskProfile(profile({ risk_tags: ['ci_config', 'large_diff'] }));
    expect(tagged.riskTags).toStrictEqual(['ci_config', 'large_diff']);
  });

  it('binds languages "other" and risk tag "unknown_language" together (both directions)', () => {
    expect(() => parseTaskProfile(profile({ languages: ['other'] }))).toThrow(/together/);
    expect(() => parseTaskProfile(profile({ risk_tags: ['unknown_language'] }))).toThrow(
      /together/,
    );
    const ok = parseTaskProfile(
      profile({ languages: ['other', 'python'], risk_tags: ['unknown_language'] }),
    );
    expect(ok.languages).toContain('other');
  });
});

describe('literal-loopback guard (assertLiteralLoopbackOnly)', () => {
  const rejects = (value: unknown): void => {
    expect(() => assertLiteralLoopbackOnly(value, 'config')).toThrow(
      /not literal 127\.0\.0\.1 or ::1/,
    );
  };
  const accepts = (value: unknown): void => {
    expect(() => assertLiteralLoopbackOnly(value, 'config')).not.toThrow();
  };

  it('accepts the two legal literal spellings', () => {
    accepts('http://127.0.0.1:3456/v1');
    accepts('http://[::1]:3456/v1');
    accepts('ws://127.0.0.1:8085');
  });

  it('rejects every non-literal local claim', () => {
    rejects('http://localhost:3456/v1');
    rejects('http://sub.localhost/v1');
    rejects('http://0.0.0.0:8080');
    rejects('http://127.0.0.2:3456'); // 127/8 but not the literal
    rejects('http://127.1.2.3/');
    rejects('http://[::]:8080');
    rejects('http://[0:0:0:0:0:0:0:1]:3456'); // expanded loopback spelling
    rejects('http://[::0:1]:3456'); // compressed-alternative loopback
    rejects('http://[::ffff:127.0.0.1]:3456'); // v4-mapped loopback
    rejects('HTTP://LOCALHOST:3456'); // case-insensitive
  });

  it('rejects numeric-IPv4 loopback spellings (inet_aton forms)', () => {
    rejects('http://127.1:8080'); // short form → 127.0.0.1
    rejects('http://127.0.1:8080'); // 3-label form
    rejects('http://2130706433/'); // decimal integer → 127.0.0.1
    rejects('http://0x7f000001/'); // hex integer
    rejects('http://017700000001/'); // octal integer
    rejects('http://0x7f.0.0.1/'); // mixed hex label
    rejects('http://0/'); // 0.0.0.0 shorthand
    rejects('http://0x0/');
  });

  it('passes remote hosts — the rule is spelling, not egress', () => {
    accepts('https://api.github.com/repos');
    accepts('https://api.deepseek.com/anthropic');
    accepts('http://10.0.0.5:9000'); // routable, not a local claim
    accepts('http://[2001:db8::1]/x');
    accepts('http://8.8.8.8/'); // numeric but not loopback
    accepts('http://192.168.1.1/'); // private ≠ loopback; not a local claim
  });

  it('walks nested structures and plain non-URL strings pass', () => {
    accepts({ a: ['no-url-here', { b: 'risk:*' }] });
    rejects({ candidates: [{ argv: ['/bin/x', '--endpoint', 'http://localhost:1'] }] });
  });

  it('rejects scheme-less local host:port endpoints (the natural CLI drift form)', () => {
    rejects('localhost:3456');
    rejects('--addr=localhost:3456');
    rejects('//localhost:3456');
    rejects('127.1:3456');
    rejects('0.0.0.0:8080');
    rejects('[::]:8080');
    rejects({ argv: ['/bin/x', '--addr', 'localhost:3456'] });
  });

  it('scheme-less literal spellings and non-endpoint colon tokens still pass', () => {
    accepts('127.0.0.1:3456');
    accepts('[::1]:8080');
    accepts('example.com:8080'); // hostname, not a local claim
    accepts('lang:*'); // capability token: port is not numeric
    accepts('sha256:1234'); // host part is not a local claim
    accepts('12:30'); // time-like: 12 is not loopback
  });

  it('rejects zoned loopback spellings (zone id ≠ the literal)', () => {
    rejects('http://[::1%25eth0]:8080/'); // pct-encoded zone id
    rejects('http://[::1%eth0]:8080/'); // raw zone id
    accepts('http://[fe80::1%25eth0]/'); // link-local, not a loopback claim
  });

  it('userinfo cannot hide the host (consumed through the LAST @)', () => {
    rejects('http://a@b@localhost:3456/'); // double-@ smuggle
    rejects('http://user:pass@localhost:3456/');
    accepts('http://user@api.github.com/repos');
  });
});
