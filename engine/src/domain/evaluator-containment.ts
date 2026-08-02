/**
 * Evaluator containment for Self-Harness (probe 6 / D13, 2026-07-31).
 *
 * The scored candidate is dispatched with the loop's working directory, and
 * `sh -c <gate>` runs in that same directory (`app/wire.ts` passes one `cwd` to
 * both). So anything reachable from that directory is readable by the very
 * agent being scored — including the spec, which carries every gate string and
 * therefore every answer.
 *
 * Measured, not assumed: a stub candidate that never performed the task and
 * only grepped its working directory for gate material scored a perfect 2/2 on
 * BOTH the held-in and held-out splits. Moving the spec out of that directory
 * closed it completely, and honest candidates were unaffected. Evidence:
 * `~/.harness/tcfugu20/probe6-evaluator-leakage/`.
 *
 * The sharp case is the DEFAULT invocation: `--cwd` has no default, so omitting
 * it makes both the dispatch and the gate inherit the operator's shell
 * directory — and the documented canonical invocation (`cd <ws>; fuguectl
 * self-harness run --spec ./spec.json`) puts the spec exactly there. The leak
 * is what happens when the docs are followed, not a misconfiguration.
 *
 * Held-out is the split that suffers most: a candidate that reads the spec
 * games BOTH splits equally, so the split whose entire purpose is to be
 * un-gameable stops being evidence at all.
 */

import { OutcomeLogError } from './outcome-log.js';

/**
 * True when `child` is `parent` itself or lies underneath it.
 *
 * Compares normalized absolute paths segment-wise rather than by string
 * prefix: a `startsWith` test would call `/work-secrets` a child of `/work`.
 * Callers pass realpath-resolved inputs so a symlink cannot smuggle the spec
 * back inside the dispatch directory.
 */
export const isPathContainedBy = (child: string, parent: string): boolean => {
  const split = (p: string): string[] => p.split('/').filter((s) => s.length > 0);
  const c = split(child);
  const p = split(parent);
  if (p.length > c.length) return false;
  return p.every((segment, i) => segment === c[i]);
};

/**
 * Fail closed when the spec is readable from the dispatch working directory.
 *
 * Both paths must already be absolute and realpath-resolved by the caller —
 * this module is pure and does not touch the filesystem, so it cannot resolve
 * them itself and must not be handed raw operator input.
 *
 * The error names directories only. The spec's own contents are the secret
 * here, so nothing from inside it is ever echoed.
 */
export const assertEvaluatorContained = (specPath: string, dispatchCwd: string): void => {
  if (isPathContainedBy(specPath, dispatchCwd)) {
    throw new OutcomeLogError(
      'INVALID_EVENT',
      'self-harness spec is inside the dispatch working directory, so the scored ' +
        'candidate can read every gate; move the spec outside --cwd (see docs/SELF_HARNESS.md)',
    );
  }
};
