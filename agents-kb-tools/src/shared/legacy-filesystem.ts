import { opendirSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { compareCodePoints } from './text.js';

/** pathlib.rglob visits a directory before its descendants, and does not follow
 * directory symlinks. opendir preserves scandir's filesystem order where the
 * compatibility tools deliberately did not request sorting. */
export function descendants(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries: { path: string; recurse: boolean }[] = [];
  const dir = opendirSync(root);
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      entries.push({ path: join(root, entry.name), recurse: entry.isDirectory() });
    }
  } finally { dir.closeSync(); }
  return [...entries.map(x => x.path), ...entries.filter(x => x.recurse).flatMap(x => descendants(x.path))];
}

export function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

export function markdownFiles(root: string): string[] {
  return descendants(root).filter(path => path.endsWith('.md'));
}

export function pythonPath(root: string, value: string): string {
  // pathlib's / operator discards the left operand for an absolute right side.
  return isAbsolute(value) ? value : join(root, value);
}

/** pathlib sorts path components, not the separator-containing spelling. */
export function comparePaths(left: string, right: string): number {
  const a = left.split(sep), b = right.split(sep);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const cmp = compareCodePoints(a[i]!, b[i]!);
    if (cmp) return cmp;
  }
  return a.length - b.length;
}
