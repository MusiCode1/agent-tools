import fs from 'node:fs';
import path from 'node:path';
import {resolveExistingParents} from './fs.js';

export function findRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  if (env.KB_ROOT) return resolveExistingParents(env.KB_ROOT);
  let current = resolveExistingParents(cwd);
  for (;;) {
    if (fs.existsSync(path.join(current, 'knowledge.conf'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('knowledge: לא נמצא knowledge.conf. הריצו מתוך מופע, או הגדירו $KB_ROOT.');
    current = parent;
  }
}

export function readConf(root: string): Record<string, string> {
  const file = path.join(root, 'knowledge.conf');
  if (!fs.existsSync(file)) return {};
  const result: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const split = line.indexOf('=');
    result[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  return result;
}
