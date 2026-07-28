import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import type { FileSystem, WriteOptions } from './file-system.js';

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const isNotFound = (error: unknown): boolean => isErrnoException(error) && error.code === 'ENOENT';

const isAlreadyExists = (error: unknown): boolean =>
  isErrnoException(error) && error.code === 'EEXIST';

const isMissing = (error: unknown): boolean =>
  isNotFound(error) || (isErrnoException(error) && error.code === 'ENOTDIR');

// Per-write counter so overlapping writes to the same path never share a temp file.
let writeSeq = 0;

// Same numbers the outcome log already uses for its private state.
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Permission bits of `path`, or null when it does not exist. */
const modeOf = async (path: string): Promise<number | null> => {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
};

/**
 * Create the parent directory. For a private write, directories THIS call
 * creates get 0700; `mkdir` applies its mode only to newly created entries, so
 * a directory that already existed keeps whatever mode the operator gave it.
 */
const ensureParent = async (path: string, isPrivate: boolean): Promise<void> => {
  await mkdir(
    dirname(path),
    isPrivate ? { recursive: true, mode: PRIVATE_DIR_MODE } : { recursive: true },
  );
};

export class NodeFileSystem implements FileSystem {
  async read(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async writeNew(path: string, content: string): Promise<boolean> {
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  }

  async write(path: string, content: string, options: WriteOptions = {}): Promise<void> {
    const isPrivate = options.private === true;
    await ensureParent(path, isPrivate);
    writeSeq += 1;
    const tempPath = `${path}.${process.pid}.${writeSeq}.tmp`;
    // The temp file is created fresh under the ambient umask, and `rename`
    // carries ITS mode onto the destination — so without this the replace
    // destroys the destination's permissions. A private destination has exactly
    // one correct mode; otherwise carry the destination's current mode across.
    // null means "no destination yet", where letting umask decide is right.
    const target = isPrivate ? PRIVATE_FILE_MODE : await modeOf(path);
    await writeFile(tempPath, content, 'utf8');
    if (target !== null) await chmod(tempPath, target);
    await rename(tempPath, path);
  }

  async append(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, content, 'utf8');
  }

  async mtime(path: string): Promise<number | null> {
    try {
      const stats = await stat(path);
      return Math.floor(stats.mtimeMs);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async remove(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
  }

  async list(dir: string): Promise<readonly string[]> {
    try {
      return await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
}
