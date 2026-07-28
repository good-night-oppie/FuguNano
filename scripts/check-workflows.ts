#!/usr/bin/env node
// Supply-chain gate: every GitHub Action must be pinned to a full commit SHA.
//
// A mutable tag like `actions/checkout@v5` is a promise the upstream owner can
// rewrite at any time, and a workflow runs with repository write scope. Pinning
// to a 40-hex commit means an upstream account compromise cannot silently
// change what executes in our CI.
//
// This is a static check on purpose: the fork has never run CI once, so a
// workflow change cannot be validated by pushing it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(
  dirname(process.argv[1] ?? "scripts/check-workflows.ts"),
  "..",
);

// argv[2] lets the test point the gate at a fixture tree. run-ts.mjs forwards
// extra args, so `node scripts/run-ts.mjs scripts/check-workflows.ts <dir>`
// arrives here as argv[2].
const workflowDir = process.argv[2] ?? join(root, ".github", "workflows");

if (!existsSync(workflowDir)) {
  console.log(`✗ check-workflows: no workflow directory at ${workflowDir}`);
  process.exit(2);
}

const files = readdirSync(workflowDir)
  .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
  .sort();

if (files.length === 0) {
  console.log(`✗ check-workflows: no workflow files in ${workflowDir}`);
  process.exit(2);
}

// Matches both `- uses: x@ref` and a bare `uses: x@ref` nested under `- name:`.
// The gitleaks step is the second shape; a rule written only for the first
// silently skips it.
// The trailing `(?:#.*)?` is load-bearing: a pinned ref carries a `# vX.Y.Z`
// version comment, so a pattern anchored straight to end-of-line matches only
// UNPINNED refs — and then reports success on a fully pinned repo because it
// found nothing to check.
const usesLine = /^\s*(?:-\s+)?uses:\s*(\S+)\s*(?:#.*)?$/u;
const pinned = /^[^@]+@[0-9a-f]{40}$/u;
// A local (./path) or docker:// action is not a registry ref and has no SHA.
const isRegistryRef = (ref) =>
  !ref.startsWith("./") && !ref.startsWith("docker://");

let unpinned = 0;
let checked = 0;

for (const file of files) {
  const path = join(workflowDir, file);
  const rel = relative(root, path);
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);

  lines.forEach((line, index) => {
    const match = usesLine.exec(line);
    if (match === null) return;
    const ref = match[1] ?? "";
    if (!isRegistryRef(ref)) return;
    checked += 1;
    if (pinned.test(ref)) return;
    console.log(`  ✗ ${rel}:${String(index + 1)}: ${ref} is not a full commit SHA`);
    unpinned += 1;
  });
}

if (unpinned > 0) {
  console.log(
    `✗ check-workflows: ${String(unpinned)} of ${String(checked)} action ref(s) use a mutable ref.`,
  );
  console.log(
    "  Resolve with: gh api repos/<owner>/<repo>/commits/<tag> --jq .sha",
  );
  console.log("  Then write: uses: owner/repo@<40-hex> # vX.Y.Z");
  process.exit(1);
}

console.log(
  `✓ check-workflows: ${String(checked)} action ref(s) pinned to full commit SHAs (${String(files.length)} workflow files)`,
);
