import { createHash } from 'node:crypto';
import { join as joinPath } from 'node:path';

import { Command, Option } from 'clipanion';

import { abandonReviewRoute, MACHINE_FORMAT } from '../../domain/review-dispatch.js';
import type { Candidate, SelectorConfig } from '../../domain/selector.js';
import { DEFAULT_SELECTOR_CONFIG, route } from '../../domain/selector.js';
import { parseTaskProfile } from '../../domain/task-profile.js';
import { OutcomeLogError } from '../../domain/outcome-log.js';
import { NodeCommandRunner } from '../../infra/node-command-runner.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';
import { defaultCacheRoot } from '../default-paths.js';
import { appendTaskAudit } from '../task-audit.js';

const TASK_ID_RE = /^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)#([1-9][0-9]*)@([0-9a-f]{40})$/u;

const parseTaskIdFlag = (
  raw: string,
): { readonly repo: string; readonly pr: number; readonly headSha: string } | string => {
  const match = TASK_ID_RE.exec(raw.trim());
  if (match === null) return 'task-id must be repo#pr@head_sha';
  return { repo: match[1]!, pr: Number(match[2]!), headSha: match[3]! };
};

const readStream = async (stream: AsyncIterable<Buffer | string>): Promise<string> => {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  }
  return chunks.join('');
};

interface RouteInput {
  readonly candidates: readonly Candidate[];
  readonly category?: string;
}

/**
 * Build candidates from a cache fan-out round. Each `done` task with a result
 * artifact becomes a candidate; `fail`/`pending` tasks are excluded (no
 * artifact to trust). Signals:
 * - with a --gate command: run `<gate> [gate-args...] <resultPath>` per
 *   artifact — exit 0 sets `verified: true`, non-zero `verified: false`. This
 *   is the executable-verifier rung of the ladder, live.
 * - without a gate: `label` = sha256 of the trimmed artifact, so identical
 *   outputs cluster and the Selector's consensus path works off artifact
 *   agreement alone (never clean TRUST — that stays gate-only).
 */
const loadRoundCandidates = async (
  fs: NodeFileSystem,
  cacheRoot: string,
  round: string,
  gate: readonly string[] | undefined,
  stderr: (line: string) => void,
): Promise<readonly Candidate[] | null> => {
  const dir = joinPath(cacheRoot, `round-${round}`);
  const manifest = await fs.read(joinPath(dir, 'manifest.tsv'));
  if (manifest === null) {
    stderr(`round-${round} not init (no manifest under ${dir})\n`);
    return null;
  }
  const runner = new NodeCommandRunner();
  const candidates: Candidate[] = [];
  for (const raw of manifest.split(/\r?\n/u)) {
    if (raw.length === 0) continue;
    const tab = raw.indexOf('\t');
    if (tab === -1) {
      // Contract is id<TAB>agent; a no-tab row would otherwise surface the
      // task id as a trusted pick, so skip it loudly instead.
      stderr(`route: skipping malformed manifest row (no tab): ${raw}\n`);
      continue;
    }
    const id = raw.slice(0, tab);
    const agent = raw.slice(tab + 1);
    const status = (await fs.read(joinPath(dir, `${id}.status`)))?.trim() ?? 'pending';
    if (status !== 'done') continue;
    const artifact = await fs.read(joinPath(dir, `${id}.result`));
    if (artifact === null) continue;
    if (gate !== undefined) {
      const [cmd, ...args] = gate;
      if (cmd === undefined) return null;
      let code: number;
      try {
        const result = await runner.run(cmd, [...args, joinPath(dir, `${id}.result`)], {
          timeoutMs: 60_000,
        });
        code = result.code;
      } catch (error) {
        // A gate that cannot run at all is an operator error, not a failed
        // verification — bail out instead of silently recording verified:false.
        stderr(`route: --gate failed to run (${String(error)})\n`);
        return null;
      }
      candidates.push({ agent, verified: code === 0 });
    } else {
      const label = createHash('sha256').update(artifact.trim()).digest('hex');
      candidates.push({ agent, label });
    }
  }
  return candidates;
};

/** Accepts either a bare candidate array or {candidates, category}. */
const parseInput = (raw: string): RouteInput | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'input is not valid JSON';
  }
  const body = Array.isArray(parsed) ? { candidates: parsed } : parsed;
  if (typeof body !== 'object' || body === null || !('candidates' in body))
    return 'input must be a candidate array or {candidates: [...]}';
  const { candidates, category } = body as { candidates: unknown; category?: unknown };
  if (!Array.isArray(candidates)) return 'candidates must be an array';
  if (category !== undefined && typeof category !== 'string') return 'category must be a string';
  for (const c of candidates) {
    if (typeof c !== 'object' || c === null) return 'every candidate must be an object';
    const { agent, verified, label } = c as {
      agent?: unknown;
      verified?: unknown;
      label?: unknown;
    };
    if (typeof agent !== 'string' || agent.length === 0)
      return 'every candidate needs a string `agent`';
    if (verified !== undefined && typeof verified !== 'boolean')
      return `candidate '${agent}': \`verified\` must be a boolean when present`;
    if (label !== undefined && typeof label !== 'string')
      return `candidate '${agent}': \`label\` must be a string when present`;
  }
  return {
    candidates: candidates as readonly Candidate[],
    ...(typeof category === 'string' ? { category } : {}),
  };
};

/**
 * Route one fan-out's candidates through the Selector: TRUST (exit 0),
 * TRUST_SPOT_CHECK (exit 10), or ESCALATE (exit 20) — same exit-code family as
 * `loop decide`, so shell pipelines can branch on the outcome directly.
 */
export class RouteCommand extends Command {
  static override paths = [['route']];

  file = Option.String({ required: false });
  round = Option.String('--round');
  cache = Option.String('--cache');
  gate = Option.Array('--gate-arg');
  gateCmd = Option.String('--gate');
  category = Option.String('--category');
  threshold = Option.String('--threshold');
  trustSingleton = Option.Boolean('--trust-singleton', false);
  forced = Option.String('--forced');
  task = Option.String('--task');

  override async execute(): Promise<number> {
    if (this.round !== undefined && this.file !== undefined) {
      this.context.stderr.write('route: pass a candidates file OR --round, not both\n');
      return 2;
    }
    if ((this.gateCmd !== undefined || this.gate !== undefined) && this.round === undefined) {
      this.context.stderr.write('route: --gate/--gate-arg require --round\n');
      return 2;
    }

    let input: RouteInput | string;
    if (this.round !== undefined) {
      const gateArgv =
        this.gateCmd === undefined ? undefined : [this.gateCmd, ...(this.gate ?? [])];
      const candidates = await loadRoundCandidates(
        new NodeFileSystem(),
        this.cache ?? defaultCacheRoot(import.meta.url),
        this.round,
        gateArgv,
        (line) => this.context.stderr.write(line),
      );
      if (candidates === null) return 2;
      input = { candidates };
    } else {
      const source = this.file ?? '-';
      const content =
        source === '-'
          ? await readStream(this.context.stdin as AsyncIterable<Buffer | string>)
          : await new NodeFileSystem().read(source);
      if (content === null) {
        this.context.stderr.write(`no candidates file ${source}\n`);
        return 2;
      }
      input = parseInput(content);
    }
    if (typeof input === 'string') {
      this.context.stderr.write(`route: ${input}\n`);
      return 2;
    }

    const threshold = this.threshold === undefined ? undefined : Number(this.threshold);
    if (
      threshold !== undefined &&
      !(Number.isFinite(threshold) && threshold > 0 && threshold < 1)
    ) {
      this.context.stderr.write('route: --threshold must be a number in (0, 1)\n');
      return 2;
    }
    const config: SelectorConfig = {
      trustThreshold: threshold ?? DEFAULT_SELECTOR_CONFIG.trustThreshold,
      trustSingleton: this.trustSingleton || DEFAULT_SELECTOR_CONFIG.trustSingleton,
      forcedEscalateCategories:
        this.forced === undefined
          ? DEFAULT_SELECTOR_CONFIG.forcedEscalateCategories
          : this.forced
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
    };

    const decision = route(input.candidates, config, this.category ?? input.category);
    this.context.stdout.write(`${JSON.stringify(decision)}\n`);

    if (this.task !== undefined) {
      const wrote = await appendTaskAudit(
        new NodeFileSystem(),
        this.task,
        `\nselector-decision: ${JSON.stringify(decision)}\n`,
      );
      if (!wrote) {
        this.context.stderr.write(`no TASK file ${this.task}\n`);
        return 2;
      }
      this.context.stderr.write(`→ written to ${this.task}\n`);
    }

    switch (decision.outcome) {
      case 'TRUST':
        return 0;
      case 'TRUST_SPOT_CHECK':
        return 10;
      case 'ESCALATE':
        return 20;
    }
  }
}

/**
 * `fugue route abandon` — seal a crash-window route.decided (no
 * dispatch.terminal) with CENSORED/operator_abandoned so a later
 * `dispatch --auto` may open the next retry epoch.
 *
 * Identity is always task content (repo + pr + head_sha), never a raw
 * route id. Accepts the same TaskProfile JSON on stdin as dispatch --auto,
 * or `--task-id repo#pr@head_sha`.
 */
export class RouteAbandonCommand extends Command {
  static override paths = [['route', 'abandon']];

  taskId = Option.String('--task-id');

  override async execute(): Promise<number> {
    let identity: { readonly repo: string; readonly pr: number; readonly headSha: string };
    if (this.taskId !== undefined) {
      const parsed = parseTaskIdFlag(this.taskId);
      if (typeof parsed === 'string') {
        this.context.stdout.write(
          `${JSON.stringify({
            format: MACHINE_FORMAT,
            status: 'invalid_input',
            reason: parsed,
          })}\n`,
        );
        return 2;
      }
      identity = parsed;
    } else {
      const raw = await readStream(this.context.stdin as AsyncIterable<Buffer | string>);
      try {
        const profile = parseTaskProfile(raw);
        identity = { repo: profile.repo, pr: profile.pr, headSha: profile.headSha };
      } catch (error) {
        const reason = error instanceof OutcomeLogError ? error.message : 'profile: not valid JSON';
        this.context.stdout.write(
          `${JSON.stringify({
            format: MACHINE_FORMAT,
            status: 'invalid_input',
            reason,
          })}\n`,
        );
        return 2;
      }
    }

    const outcome = abandonReviewRoute(identity, { env: process.env });
    this.context.stdout.write(`${JSON.stringify(outcome.machine)}\n`);
    return outcome.exitCode;
  }
}
