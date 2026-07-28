// A release artifact is only reproducible if the tool that built it is pinned.
// `npx --yes electron-builder@^25` resolved the packaging toolchain fresh at
// build time, outside any lockfile, so two builds of the same commit could ship
// different bytes. These pin the fix.
//
// Paths resolve from THIS FILE, never from process.cwd(): `npm test` runs with
// cwd = desktop/, but that is a property of how CI happens to invoke vitest, not
// something this file should depend on.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, '..');

const readJson = (...segments: string[]): Record<string, unknown> =>
  JSON.parse(readFileSync(join(desktopDir, ...segments), 'utf8')) as Record<string, unknown>;

describe('packaging toolchain is pinned', () => {
  const scriptsOf = (manifest: Record<string, unknown>): Record<string, string> =>
    (manifest['scripts'] ?? {}) as Record<string, string>;

  it('never resolves the packager at build time via npx', () => {
    const scripts = scriptsOf(readJson('package.json'));

    for (const [name, body] of Object.entries(scripts)) {
      expect(`${name}: ${body}`).not.toContain('npx');
    }
  });

  it('invokes the locked electron-builder binary, not a version range', () => {
    const scripts = scriptsOf(readJson('package.json'));

    for (const name of ['package', 'package:dir']) {
      expect(scripts[name]).toContain('packaging/node_modules/.bin/electron-builder');
      // A caret in the invocation would re-open the resolution the lockfile closes.
      expect(scripts[name]).not.toMatch(/electron-builder@/u);
    }
  });

  it('pins electron-builder to an exact version in its own lockfile', () => {
    const manifest = readJson('packaging', 'package.json');
    const declared = (manifest['devDependencies'] as Record<string, string>)['electron-builder'];

    // Exact: no caret, tilde, or range syntax.
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/u);

    const lock = readJson('packaging', 'package-lock.json');
    const packages = lock['packages'] as Record<string, { version?: string; integrity?: string }>;
    const entry = packages['node_modules/electron-builder'];

    expect(entry?.version).toBe(declared);
    expect(entry?.integrity).toMatch(/^sha\d+-/u);
  });

  it('records an integrity hash for every resolved package', () => {
    const lock = readJson('packaging', 'package-lock.json');
    const packages = lock['packages'] as Record<
      string,
      { resolved?: string; integrity?: string }
    >;

    // Without integrity a registry or mirror could serve different bytes for the
    // same version and `npm ci` would accept them.
    const unverifiable = Object.entries(packages)
      .filter(([, meta]) => meta.resolved !== undefined && meta.integrity === undefined)
      .map(([name]) => name);

    expect(unverifiable).toEqual([]);
  });
});
