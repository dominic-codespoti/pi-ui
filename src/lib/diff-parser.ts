/**
 * Unified diff parser — splits raw diff text into structured file/hunk/line
 * objects for rendering in the DiffViewer component.
 */

export type DiffLineType = 'context' | 'add' | 'delete';

export interface DiffLine {
  type: DiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLineCount: number;
  newStart: number;
  newLineCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** Parse a unified diff string into an array of DiffFile objects. */
export function parseDiff(raw: string): DiffFile[] {
  const lines = raw.split('\n');
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  function commitHunk() {
    if (hunk && current) {
      current.hunks.push(hunk);
      hunk = null;
    }
  }

  function commitFile() {
    commitHunk();
    if (current) {
      files.push(current);
      current = null;
    }
  }

  for (const line of lines) {
    // File header: --- a/path or --- /dev/null
    if (line.startsWith('--- ')) {
      commitFile();
      const path = line.slice(4).replace(/\t.*$/, '').replace(/^a\//, '').trim();
      current = { oldPath: path, newPath: path, hunks: [], additions: 0, deletions: 0 };
      continue;
    }

    // File header: +++ b/path or +++ /dev/null
    if (line.startsWith('+++ ') && current) {
      const path = line.slice(4).replace(/\t.*$/, '').replace(/^b\//, '').trim();
      current.newPath = path || current.oldPath;
      continue;
    }

    // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
    if (hunkMatch) {
      commitHunk();
      hunk = {
        header: line,
        oldStart: parseInt(hunkMatch[1]),
        oldLineCount: hunkMatch[2] ? parseInt(hunkMatch[2]) : 1,
        newStart: parseInt(hunkMatch[3]),
        newLineCount: hunkMatch[4] ? parseInt(hunkMatch[4]) : 1,
        lines: [],
      };
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }

    // Diff lines (must be inside a hunk)
    if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ type: 'add', oldLineNumber: null, newLineNumber: newLine, content: line.slice(1) });
        newLine++;
        current!.additions++;
      } else if (line.startsWith('-')) {
        hunk.lines.push({ type: 'delete', oldLineNumber: oldLine, newLineNumber: null, content: line.slice(1) });
        oldLine++;
        current!.deletions++;
      } else if (line.startsWith(' ') || line === '') {
        // Context line (leading space) or empty line
        hunk.lines.push({ type: 'context', oldLineNumber: oldLine, newLineNumber: newLine, content: line.slice(1) });
        oldLine++;
        newLine++;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" — skip
      }
    }
  }

  commitFile();
  return files;
}
