# Security Policy

## Secret Handling (core security constraint of this repo)

This workflow orchestrates several model providers and **will touch API keys**. The repo's hard constraints:

- **Real keys never enter the repo.** They live only in `~/.config/cc-model-secrets.env` (read by the launcher, highest priority) or in your project-local `.fugue-cc/provider.config` (ignored by `.gitignore`).
- The repo only tracks `orchestration/fugue-cc/provider.config.example`, whose `key=` values are always `<...>` placeholders.
- `.gitignore` ignores `**/.fugue-cc/provider.config`, `*secrets*.env`, `.env*`.
- Every commit/push passes three gates:
  1. `npm run scan` / `scripts/scan-secrets.ts` — plaintext key fingerprints (`sk-`/`tp-`/zhipu format) + `provider.config*`'s `key=` must be a placeholder. Hits report `file:line` and the detector name only: never the matched text, never a digest of it, never its length. Scanner output persists in terminal scrollback, agent pane snapshots and public Actions logs, so a hit that quoted the secret would copy it onto every one of them. Pinned by `npm run test:scripts`.
  2. `gitleaks` (`.gitleaks.toml`) — scans the full git history. **Note:** gitleaks runs on the same two surfaces and, in `.pre-commit-config.yaml`, runs *before* `scan-secrets` — and its own default output is not redacted here. Gate 1's redaction does not cover gate 2.
  3. CI's `secret-scan` job runs both; red blocks the merge.
- Enable locally: `pipx install pre-commit && pre-commit install`, and it scans automatically on commit.

### If a key leaks

1. Immediately **revoke/rotate** that key in the corresponding provider console.
2. Clean history with `git filter-repo` or BFG, then force-push.
3. Don't just delete one commit — once a key is pushed to a public repo it must be considered compromised and must be rotated.

## Reporting Vulnerabilities

If you find a security issue (key-leak path, injection, permission bypass, etc.), please **do not open a public issue**.
Report privately via GitHub Security Advisory (repo Security -> Report a vulnerability),
or email the repo owner. We will respond as soon as possible.

## Support Scope

This is a personally maintained workflow tool repo, maintained best-effort, with no SLA.
