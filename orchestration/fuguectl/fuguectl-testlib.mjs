import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));

export const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "fuguectl-test-"));
  process.on("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

// Git repo-discovery env vars leak from git hooks into their children: a
// pre-push hook runs with GIT_DIR (and sometimes GIT_WORK_TREE/GIT_INDEX_FILE)
// exported and pointing at the HOST repo. `make ci` runs these selftests from
// exactly that context, so any scratch-repo git operation that inherits them
// re-targets the host repo — every test commit/branch/config write lands on
// the repo the operator is pushing FROM (2026-07-30 incident: 12 bogus
// commits on main, core.bare flipped, a feature branch deleted). Strip them
// from EVERY spawned child's env — including caller-supplied options.env,
// because the common `{ ...process.env, EXTRA }` spread would re-import the
// hostile values. A test that genuinely needs one must call spawnSync
// directly, in a fixture repo, with a comment saying why.
const GIT_DISCOVERY_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

export const sanitizedEnv = (base = process.env) => {
  const env = { ...base };
  for (const key of GIT_DISCOVERY_ENV_VARS) delete env[key];
  return env;
};

export const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    encoding: "utf8",
    ...options,
    env: sanitizedEnv(options.env ?? process.env),
  });

export const runGit = (args, options = {}) =>
  run(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    options,
  );

export const writeExecutable = (file, lines) =>
  writeFileSync(file, [...lines, ""].join("\n"), { mode: 0o755 });

export const countLines = (text) =>
  text.split(/\r?\n/u).filter((line) => line.length > 0).length;

export const createSuite = (name) => {
  let pass = 0;
  let fail = 0;
  console.log(`${name} tests`);
  return {
    ok(label, condition) {
      let passed = false;
      try {
        passed =
          typeof condition === "function"
            ? Boolean(condition())
            : Boolean(condition);
      } catch {
        passed = false;
      }
      if (passed) {
        console.log(`  ✓ ${label}`);
        pass += 1;
      } else {
        console.log(`  ✗ ${label}`);
        fail += 1;
      }
    },
    done() {
      console.log(`${name}: ${pass} passed, ${fail} failed`);
      if (fail > 0) process.exit(1);
    },
  };
};
