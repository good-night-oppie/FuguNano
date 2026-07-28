#!/usr/bin/env node
// Fixture suite for scripts/check-workflows.ts.
//
// Deliberately asserts NO absolute ref count. `status === 0` already carries
// every security signal the gate has; pinning "14 refs" instead turns any
// future correctly-pinned workflow step into a red build in an unrelated PR.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSuite, makeTempDir, run } from "../orchestration/fuguectl/fuguectl-testlib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const runTs = join(repoRoot, "scripts", "run-ts.mjs");
const gate = join(repoRoot, "scripts", "check-workflows.ts");

const PINNED = "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0";

const suite = createSuite("check-workflows");

const fixture = (name, body) => {
  const dir = join(makeTempDir(), name);
  mkdirSync(dir, { recursive: true });
  if (body !== null) writeFileSync(join(dir, "w.yml"), body);
  return dir;
};

const check = (dir) => {
  const result = run(process.execPath, [runTs, gate, dir]);
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

const step = (ref) => `jobs:\n  a:\n    steps:\n      - uses: ${ref}\n`;

// Accepts what it should.
suite.ok("pinned ref passes", () => check(fixture("pinned", step(PINNED))).status === 0);

// Rejects what it should.
suite.ok(
  "mutable major tag fails",
  () => check(fixture("unpinned", step("actions/checkout@v5"))).status === 1,
);
suite.ok(
  "a mutable ref among pinned ones still fails",
  () =>
    check(fixture("mixed", `${step(PINNED)}      - uses: actions/setup-node@v5\n`)).status === 1,
);
suite.ok(
  "branch and short-sha refs fail",
  () =>
    check(fixture("branch", step("actions/checkout@main"))).status === 1 &&
    check(fixture("shortsha", step("actions/checkout@fbc6f39"))).status === 1,
);

// The shape a `- uses:`-only rule silently skips: `uses:` nested under a
// `- name:` step. That is exactly how gitleaks is declared in ci.yml, so a
// gate that misses it would report green while the riskiest action floats.
suite.ok(
  "nested uses under a named step is still checked",
  () =>
    check(
      fixture(
        "nested",
        "jobs:\n  a:\n    steps:\n      - name: scan\n        uses: gitleaks/gitleaks-action@v3\n",
      ),
    ).status === 1,
);

// Local and docker actions have no commit SHA to pin.
suite.ok(
  "local action refs are exempt",
  () => check(fixture("local", step("./.github/actions/thing"))).status === 0,
);

// Misconfiguration must be loud, not silently green.
suite.ok("empty workflow dir exits 2", () => check(fixture("empty", null)).status === 2);
suite.ok(
  "missing workflow dir exits 2",
  () => check(join(makeTempDir(), "does-not-exist")).status === 2,
);

// The repository itself must satisfy the gate.
suite.ok("this repo is fully pinned", () => {
  const result = run(process.execPath, [runTs, gate]);
  return result.status === 0;
});

suite.done();
