// Git repo-discovery env leaks from git hooks into their children: pre-push
// runs `make ci` with GIT_DIR exported at the HOST repo's gitdir, so any test
// that spawns git in a scratch dir (cli.test.ts integrate suite,
// candidate-identity.test.ts) would re-target the host repo — test commits
// and branches land on the repo the operator is pushing FROM (2026-07-30
// incident). The fuguectl selftests strip these in fuguectl-testlib; this is
// the engine-side twin, applied once per vitest worker.
const GIT_DISCOVERY_ENV_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

for (const key of GIT_DISCOVERY_ENV_VARS) {
  delete process.env[key];
}
