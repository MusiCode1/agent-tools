import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function resolveExistingParents(input: string, seen = new Set<string>()): string {
  const absolute = path.resolve(input);
  let info: fs.Stats;
  try {
    info = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(resolveExistingParents(parent, seen), path.basename(absolute));
  }
  if (info.isSymbolicLink()) {
    if (seen.has(absolute)) throw new Error(`Symlink loop: ${absolute}`);
    seen.add(absolute);
    return resolveExistingParents(path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)), seen);
  }
  return fs.realpathSync(absolute);
}

export function inside(root: string, input: string): string {
  const base = resolveExistingParents(root);
  const resolved = resolveExistingParents(path.isAbsolute(input) ? input : path.join(base, input));
  const relative = path.relative(base, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`נתיב יוצא מהמאגר: ${input}`);
  }
  return resolved;
}

export function atomicWrite(file: string, text: string, mode = 0o600): void {
  try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`פלט הוא symlink: ${file}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.kb-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
