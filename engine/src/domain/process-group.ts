import type { ChildProcess } from 'node:child_process';

/**
 * Process-group termination, shared by every place that spawns a child under a
 * timeout.
 *
 * Killing only the direct child bounds neither effects nor wall clock: a
 * grandchild survives and keeps running, and because it inherits the stdout
 * pipe the parent stays open waiting on a descriptor nobody will close. The
 * fix is to make the child a group leader (`detached: true`) and signal the
 * whole group with a negative pid.
 *
 * Windows has no process groups in this sense, so the guard is part of the
 * contract rather than an afterthought — callers must use `shouldUseProcessGroup`
 * to decide whether to pass `detached`, and pass the SAME answer here.
 */
export const shouldUseProcessGroup = (timeoutMs: number | undefined): boolean =>
  timeoutMs !== undefined && timeoutMs > 0 && process.platform !== 'win32';

/**
 * Signal the child's whole process group, falling back to the child alone.
 *
 * The fallback is not optional: between the timeout firing and the signal
 * landing the child may already have exited, at which point its group no
 * longer exists and `process.kill(-pid)` throws ESRCH.
 */
export const killProcessGroup = (
  child: ChildProcess,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
): void => {
  if (useProcessGroup && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group already gone — fall through to the direct kill below.
    }
  }
  child.kill(signal);
};
