/**
 * Narrow filesystem port — just what the stores need. Injected so adapters are
 * testable with an in-memory fake and so we never reach for `node:fs` in domain
 * or application code.
 */
export interface WriteOptions {
  /**
   * Harden the destination for owner-only access: parent directories this call
   * creates get 0700, and the file is forced to 0600 (which also heals a file
   * an earlier, unhardened run left world-readable).
   *
   * Use it for the engine's private state tree, not for generic output an
   * operator asked for by path. Typed as `true` rather than `boolean` so that
   * under `exactOptionalPropertyTypes` a typo like `{ privat: true }` or a
   * meaningless `{ private: false }` is a compile error, not a silent no-op.
   */
  readonly private?: true;
}

export interface FileSystem {
  /** File contents, or null if it does not exist. */
  read(path: string): Promise<string | null>;
  /** Create a file only if absent, returning false when it already exists. */
  writeNew(path: string, content: string): Promise<boolean>;
  /**
   * Write atomically (temp + rename), creating parent dirs as needed.
   *
   * The destination's existing permissions are preserved across the replace —
   * without that, the fresh temp file's umask-derived mode would ride over the
   * destination and silently downgrade a file an operator had hardened.
   */
  write(path: string, content: string, options?: WriteOptions): Promise<void>;
  /** Append content, creating parent dirs as needed. */
  append(path: string, content: string): Promise<void>;
  /** Last-modified epoch millis, or null if absent. */
  mtime(path: string): Promise<number | null>;
  /** Remove a file; no-op if absent. */
  remove(path: string): Promise<void>;
  /** Entry names directly under a directory (not recursive); empty if absent. */
  list(dir: string): Promise<readonly string[]>;
}
