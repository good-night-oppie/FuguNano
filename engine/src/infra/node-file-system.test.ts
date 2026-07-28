import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from './node-file-system.js';

describe('NodeFileSystem', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('implements read, writeNew, write, append, mtime, remove, and list against a real temp dir', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fugue-engine-'));
    tempDirs.push(tempDir);
    const fs = new NodeFileSystem();
    const dir = join(tempDir, 'nested');
    const file = join(dir, 'artifact.txt');
    const newFile = join(dir, 'new.txt');

    expect(await fs.writeNew(newFile, 'first')).toBe(true);
    expect(await fs.writeNew(newFile, 'second')).toBe(false);
    expect(await fs.read(newFile)).toBe('first');
    await fs.write(file, 'hello');
    await fs.append(file, ' world');

    expect(await fs.read(file)).toBe('hello world');
    expect((await fs.list(dir)).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(await fs.read(join(dir, 'missing.txt'))).toBeNull();
    expect(await fs.mtime(file)).not.toBeNull();
    expect(await fs.list(dir)).toEqual(['artifact.txt', 'new.txt']);

    await fs.remove(file);
    await fs.remove(file);

    expect(await fs.read(file)).toBeNull();
  });

  it('treats a file used as a directory as an empty listing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fugue-engine-'));
    tempDirs.push(tempDir);
    const fs = new NodeFileSystem();
    const file = join(tempDir, 'not-a-dir.txt');

    await fs.write(file, 'hello');

    expect(await fs.list(file)).toEqual([]);
  });

  // Permissions. `write` replaces via temp + rename, and rename carries the
  // TEMP file's mode onto the destination — so without explicit handling every
  // write silently re-permissions whatever it replaces. These pin both halves:
  // an operator's hardening must survive, and private state must be private.
  // The umask is pinned so the assertions mean the same thing on any host.
  describe('permissions', () => {
    let previousUmask: number;

    beforeEach(() => {
      previousUmask = process.umask(0o022);
    });

    afterEach(() => {
      process.umask(previousUmask);
    });

    const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

    it('preserves an operator-hardened mode across an atomic replace', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'fugue-engine-'));
      tempDirs.push(tempDir);
      const fs = new NodeFileSystem();
      const file = join(tempDir, 'hardened.txt');

      await fs.write(file, 'first');
      await chmod(file, 0o600);
      await fs.write(file, 'second');

      expect(await fs.read(file)).toBe('second');
      expect(await modeOf(file)).toBe(0o600);
    });

    it('creates private state 0600 under a 0700 directory', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'fugue-engine-'));
      tempDirs.push(tempDir);
      const fs = new NodeFileSystem();
      const dir = join(tempDir, 'private-store');
      const file = join(dir, 'state.json');

      await fs.write(file, '{}', { private: true });

      expect(await modeOf(file)).toBe(0o600);
      expect(await modeOf(dir)).toBe(0o700);
    });

    it('heals a private file an earlier unhardened run left world-readable', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'fugue-engine-'));
      tempDirs.push(tempDir);
      const fs = new NodeFileSystem();
      const file = join(tempDir, 'legacy.json');

      await fs.write(file, 'old');
      expect(await modeOf(file)).toBe(0o644);

      await fs.write(file, 'new', { private: true });

      expect(await modeOf(file)).toBe(0o600);
    });

    it('leaves a non-private new file to the umask', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'fugue-engine-'));
      tempDirs.push(tempDir);
      const fs = new NodeFileSystem();
      const file = join(tempDir, 'generic.txt');

      await fs.write(file, 'hello');

      expect(await modeOf(file)).toBe(0o644);
    });

    it('does not re-permission a directory it did not create', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'fugue-engine-'));
      tempDirs.push(tempDir);
      const fs = new NodeFileSystem();
      const dir = join(tempDir, 'operator-owned');
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o755);

      await fs.write(join(dir, 'state.json'), '{}', { private: true });

      expect(await modeOf(dir)).toBe(0o755);
    });
  });
});
