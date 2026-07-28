import { Command, Option } from 'clipanion';

import { MACHINE_FORMAT, runReviewDispatch } from '../../domain/review-dispatch.js';

const readStream = async (stream: AsyncIterable<Buffer | string>): Promise<string> => {
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return out;
};

/**
 * `fugue dispatch --auto --task-type pr-review --policy-arm <arm> [--json]`
 * — the AgentDex PR-review routing seam (frozen baseline 2026-07-23, §D).
 *
 * One-shot: the frozen 7-field TaskProfile arrives on stdin, exactly one
 * machine-JSON object leaves on stdout, and the exit code is the frozen
 * taxonomy (0 completed / 2 invalid input / 7 no-eligible-or-never-started /
 * 8 effect unknown / 74 state error). FuguNano performs filter, rank,
 * fallback, and dispatch inside this single call; the Python façade only
 * parses the machine JSON — it never re-routes and never writes state.
 *
 * Shares the `dispatch` path with the prompt-centric DispatchCommand;
 * clipanion disambiguates on the required `--auto` flag versus the required
 * positional target. `--task-type`/`--policy-arm` are deliberately NOT
 * clipanion-required: a missing value must still produce the machine-JSON
 * envelope and exit 2, not clipanion's human usage error on exit 1. (A
 * misspelled flag NAME still falls to clipanion's usage error — argv is
 * caller-owned and carries no secrets by contract.) `--json` is accepted for
 * caller symmetry — machine JSON is the only output this mode has.
 */
export class DispatchAutoCommand extends Command {
  static override paths = [['dispatch']];

  auto = Option.Boolean('--auto', { required: true });
  taskType = Option.String('--task-type');
  policyArm = Option.String('--policy-arm');
  cohortIndex = Option.String('--cohort-index');
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    if (this.taskType !== 'pr-review') {
      this.context.stdout.write(
        `${JSON.stringify({
          format: MACHINE_FORMAT,
          status: 'invalid_input',
          reason: 'task-type must be "pr-review"',
        })}\n`,
      );
      return 2;
    }
    const taskRaw = await readStream(this.context.stdin as AsyncIterable<Buffer | string>);
    const outcome = await runReviewDispatch(
      taskRaw,
      this.policyArm ?? '',
      { env: process.env },
      this.cohortIndex,
    );
    this.context.stdout.write(`${JSON.stringify(outcome.machine)}\n`);
    return outcome.exitCode;
  }
}
