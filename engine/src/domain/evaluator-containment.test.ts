import { describe, expect, it } from 'vitest';

import { assertEvaluatorContained, isPathContainedBy } from './evaluator-containment.js';
import { OutcomeLogError } from './outcome-log.js';

describe('isPathContainedBy', () => {
  it('treats a directory as containing itself', () => {
    expect(isPathContainedBy('/work', '/work')).toBe(true);
  });

  it('detects a nested path', () => {
    expect(isPathContainedBy('/work/spec.json', '/work')).toBe(true);
    expect(isPathContainedBy('/work/a/b/spec.json', '/work')).toBe(true);
  });

  it('rejects a sibling', () => {
    expect(isPathContainedBy('/other/spec.json', '/work')).toBe(false);
  });

  it('rejects a parent', () => {
    expect(isPathContainedBy('/work', '/work/nested')).toBe(false);
  });

  // The whole reason this is segment-wise and not a string prefix test.
  it('does not treat a name-prefixed sibling as contained', () => {
    expect(isPathContainedBy('/work-secrets/spec.json', '/work')).toBe(false);
    expect(isPathContainedBy('/workspace/spec.json', '/work')).toBe(false);
  });

  it('is insensitive to trailing and duplicate separators', () => {
    expect(isPathContainedBy('/work/spec.json', '/work/')).toBe(true);
    expect(isPathContainedBy('/work//spec.json', '/work')).toBe(true);
  });
});

describe('assertEvaluatorContained (probe 6 / D13)', () => {
  it('rejects a spec inside the dispatch cwd', () => {
    expect(() => assertEvaluatorContained('/work/spec.json', '/work')).toThrow(OutcomeLogError);
  });

  // The default-invocation case: `cd <ws>; run --spec ./spec.json` with the
  // spec sitting in the very directory the candidate is spawned in.
  it('rejects the documented canonical invocation shape', () => {
    expect(() => assertEvaluatorContained('/ws/self-harness.json', '/ws')).toThrow(
      /candidate can read every gate/,
    );
  });

  it('accepts a spec outside the dispatch cwd', () => {
    expect(() => assertEvaluatorContained('/evaluator/spec.json', '/work')).not.toThrow();
  });

  it('accepts a spec in a name-prefixed sibling directory', () => {
    expect(() => assertEvaluatorContained('/work-secrets/spec.json', '/work')).not.toThrow();
  });

  it('names directories only and never echoes spec contents', () => {
    try {
      assertEvaluatorContained('/work/spec.json', '/work');
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = (error as OutcomeLogError).message;
      expect(message).toContain('--cwd');
      // The gate strings live in the spec; the error must not invite echoing them.
      expect(message).not.toContain('gate:');
      expect(message).not.toContain('test -f');
    }
  });

  it('throws INVALID_EVENT so the caller maps it to caller-fault', () => {
    try {
      assertEvaluatorContained('/work/spec.json', '/work');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as OutcomeLogError).kind).toBe('INVALID_EVENT');
    }
  });
});
