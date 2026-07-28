#!/usr/bin/env node
// Regression suite for scripts/scan-secrets.ts.
//
// The point of this file is the "never echoes" assertions. scan-secrets runs on
// three durable surfaces — .githooks/pre-commit, .pre-commit-config.yaml, and
// ci.yml's secret-scan job — so anything it prints persists in terminal
// scrollback, fleet pane snapshots, and public GitHub Actions logs. A scanner
// that reports the secret it found copies that secret onto all three.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSuite,
  makeTempDir,
  run,
  runGit,
} from "../orchestration/fuguectl/fuguectl-testlib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const runTs = join(repoRoot, "scripts", "run-ts.mjs");
const scanner = join(repoRoot, "scripts", "scan-secrets.ts");

// Built by concatenation so this source file does not itself trip
// scan-secrets.ts when `make ci` scans the repo. Same convention as
// engine/src/domain/experience-redact.test.ts:7-8.
const KEY_CANARY = ["sk", "-", "FAKECANARY", "0123456789abcdefghij"].join("");
const PROVIDER_CANARY = ["NOT", "A", "PLACEHOLDER", "fake", "canary"].join("-");
const LEAKY_SOURCE_LINE = `const token = "${KEY_CANARY}";`;

const suite = createSuite("scan-secrets");

// run-ts.mjs rewrites process.argv[1] to the resolved script path, and the
// scanner derives `root` from dirname(argv[1])/.. — so copying it into
// <tmp>/scripts/ makes <tmp> the scanned tree.
const buildFixture = ({ git, dirty }) => {
  const dir = makeTempDir();
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(scanner, join(dir, "scripts", "scan-secrets.ts"));
  writeFileSync(join(dir, "clean.ts"), "export const answer = 42;\n");
  if (dirty) {
    writeFileSync(join(dir, "leaky.ts"), `${LEAKY_SOURCE_LINE}\n`);
    mkdirSync(join(dir, "conf"), { recursive: true });
    writeFileSync(
      join(dir, "conf", "provider.config"),
      `key = "${PROVIDER_CANARY}"\n`,
    );
  }
  if (git) {
    runGit(["init"], { cwd: dir });
    runGit(["add", "-A"], { cwd: dir });
  }
  return dir;
};

const scan = (dir) => {
  const result = run(
    process.execPath,
    [runTs, join(dir, "scripts", "scan-secrets.ts")],
    { cwd: dir },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

// Both file-discovery branches are exercised: `git ls-files` (scan-secrets.ts
// :39-42, the branch pre-commit and CI actually take) and walkFiles (:43).
for (const git of [true, false]) {
  const mode = git ? "git" : "no-git";

  const { status, output } = scan(buildFixture({ git, dirty: true }));

  suite.ok(`${mode}: blocks with exit 1`, status === 1);

  // The three that fail against the pre-patch scanner. Everything else in this
  // file passes either way and exists to prove the change is non-breaking.
  suite.ok(
    `${mode}: never echoes the fingerprint canary`,
    !output.includes(KEY_CANARY),
  );
  suite.ok(
    `${mode}: never echoes the provider-key canary`,
    !output.includes(PROVIDER_CANARY),
  );
  suite.ok(
    `${mode}: never echoes the matched source line`,
    !output.includes(LEAKY_SOURCE_LINE),
  );

  // Still actionable: an engineer must be able to find and fix the hit.
  suite.ok(`${mode}: reports file:line for the fingerprint hit`, () =>
    /leaky\.ts:1\b/u.test(output),
  );
  suite.ok(`${mode}: reports file:line for the provider-key hit`, () =>
    /provider\.config:1\b/u.test(output),
  );
  suite.ok(
    `${mode}: names the suspected-key detector`,
    output.includes("suspected key"),
  );
  suite.ok(
    `${mode}: names the placeholder detector`,
    output.includes("key not a placeholder"),
  );
  suite.ok(
    `${mode}: still prints the blocking summary`,
    output.includes("scan-secrets: suspected key found, blocking."),
  );

  // A clean tree must stay silent and green — the contract every pre-commit
  // and CI run depends on.
  const clean = scan(buildFixture({ git, dirty: false }));
  suite.ok(`${mode}: clean tree exits 0`, clean.status === 0);
  suite.ok(
    `${mode}: clean tree reports 0 hits`,
    clean.output.includes("scan-secrets: 0 hits"),
  );
}

suite.done();
