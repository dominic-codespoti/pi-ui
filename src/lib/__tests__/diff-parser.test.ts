import { describe, it, expect } from 'vitest';
import { parseDiff } from '../diff-parser';

const SINGLE_FILE_DIFF = [
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,5 +1,7 @@',
  ' line1',
  '-line2-old',
  '+line2-new',
  ' line3',
  ' line4',
  '+line5-new',
  ' line6',
].join('\n');

const CREATE_DIFF = [
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,3 @@',
  '+new1',
  '+new2',
  '+new3',
].join('\n');

const DELETE_DIFF = [
  '--- a/src/old.ts',
  '+++ /dev/null',
  '@@ -1,3 +0,0 @@',
  '-gone1',
  '-gone2',
  '-gone3',
].join('\n');

const MULTI_FILE_DIFF = [SINGLE_FILE_DIFF, CREATE_DIFF, DELETE_DIFF].join('\n');

describe('parseDiff', () => {
  it('parses a single-file diff with additions and deletions', () => {
    const files = parseDiff(SINGLE_FILE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe('src/foo.ts');
    expect(files[0].newPath).toBe('src/foo.ts');
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(1);
    expect(files[0].hunks).toHaveLength(1);
  });

  it('parses hunk header correctly', () => {
    const files = parseDiff(SINGLE_FILE_DIFF);
    const hunk = files[0].hunks[0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLineCount).toBe(5);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLineCount).toBe(7);
    expect(hunk.header).toContain('@@');
  });

  it('assigns correct line numbers to context/add/delete lines', () => {
    const files = parseDiff(SINGLE_FILE_DIFF);
    const lines = files[0].hunks[0].lines;
    expect(lines[0].type).toBe('context');
    expect(lines[0].oldLineNumber).toBe(1);
    expect(lines[0].newLineNumber).toBe(1);

    expect(lines[1].type).toBe('delete');
    expect(lines[1].oldLineNumber).toBe(2);
    expect(lines[1].newLineNumber).toBeNull();

    expect(lines[2].type).toBe('add');
    expect(lines[2].oldLineNumber).toBeNull();
    expect(lines[2].newLineNumber).toBe(2);
  });

  it('parses "new file" (create) diffs', () => {
    const files = parseDiff(CREATE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe('/dev/null');
    expect(files[0].newPath).toBe('src/new.ts');
    expect(files[0].additions).toBe(3);
    expect(files[0].deletions).toBe(0);
  });

  it('parses "deleted file" diffs', () => {
    const files = parseDiff(DELETE_DIFF);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe('src/old.ts');
    expect(files[0].newPath).toBe('/dev/null');
    expect(files[0].additions).toBe(0);
    expect(files[0].deletions).toBe(3);
  });

  it('parses multiple files in one diff string', () => {
    const files = parseDiff(MULTI_FILE_DIFF);
    expect(files).toHaveLength(3);
    expect(files[0].oldPath).toBe('src/foo.ts');
    expect(files[1].oldPath).toBe('/dev/null');
    expect(files[2].oldPath).toBe('src/old.ts');
  });

  it('handles empty diff string', () => {
    const files = parseDiff('');
    expect(files).toHaveLength(0);
  });

  it('skips "No newline at end of file" lines', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+c',
      ' d',
      '\\ No newline at end of file',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files[0].hunks[0].lines).toHaveLength(4);
  });

  it('handles hunk headers without line counts', () => {
    const diff = [
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files[0].hunks[0].oldLineCount).toBe(1);
    expect(files[0].hunks[0].newLineCount).toBe(1);
  });
});
