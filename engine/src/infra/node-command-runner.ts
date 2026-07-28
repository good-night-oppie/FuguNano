import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import type { CommandOptions, CommandResult, CommandRunner } from './command-runner.js';
import { killProcessGroup, shouldUseProcessGroup } from '../domain/process-group.js';

/** Real subprocess runner (child_process.spawn) — the only place node:child_process is used. */
export class NodeCommandRunner implements CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve, reject) => {
      const env = options.env !== undefined ? { ...process.env, ...options.env } : process.env;
      const timeoutMs = options.timeoutMs;
      const useProcessGroup = shouldUseProcessGroup(timeoutMs);
      const child = spawn(command, [...args], {
        env,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(useProcessGroup ? { detached: true } : {}),
      });
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let forceKill: ReturnType<typeof setTimeout> | undefined;
      const killChild = (signal: NodeJS.Signals): void =>
        killProcessGroup(child, signal, useProcessGroup);
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true;
          killChild('SIGTERM');
          forceKill = setTimeout(() => killChild('SIGKILL'), 1000);
        }, timeoutMs);
      }

      const out: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      child.on('error', (error: Error) => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        reject(error);
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (timeout !== undefined) clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        // A signal-killed child reports code=null; map it to nonzero (bash: 128+signum),
        // never to 0 — otherwise a killed dispatch would look successful.
        let exit: number;
        if (code !== null) exit = code;
        else if (signal !== null) exit = 128 + (constants.signals[signal] ?? 0);
        else exit = 0;
        const stderr = Buffer.concat(errChunks).toString('utf8');
        resolve({
          code: timedOut ? 124 : exit,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr:
            timedOut && timeoutMs !== undefined
              ? `${stderr}${stderr.length > 0 && !stderr.endsWith('\n') ? '\n' : ''}command timed out after ${String(timeoutMs)}ms\n`
              : stderr,
        });
      });

      // A child may exit before draining stdin — a bad flag, missing auth, an
      // immediate crash, or simply an answer it produced without reading. That
      // surfaces as EPIPE on this pipe, and an unhandled 'error' event on a
      // stream takes down the whole process; it is NOT a rejected promise.
      // child.on('error') above does not cover it: that fires for spawn
      // failures on the ChildProcess, not for writes to its stdin pipe.
      //
      // Swallow it deliberately. The child's exit code, delivered via 'close',
      // is the authority on whether the dispatch failed — a write we could not
      // finish is subordinate to that verdict, never a separate failure.
      child.stdin.on('error', () => {});
      if (options.stdin !== undefined) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }
}
