import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, sep } from 'node:path';
import { findRoot, readConf } from '../../shared/instance.js';
import { charLength, compareCodePoints } from '../../shared/text.js';
import { comparePaths, descendants, isDirectory, pythonPath } from '../../shared/legacy-filesystem.js';

export interface WikiOptions { root: string; conf: Record<string, string> }
export function options(root = findRoot()): WikiOptions { return { root, conf: readConf(root) }; }
const parts = (path: string) => path.split(sep);
const sorted = (paths: string[]) => paths.sort(compareCodePoints);
function wiki(o: WikiOptions): string { return pythonPath(o.root, o.conf.KB_WIKI ?? 'wiki'); }

export function collect(o: WikiOptions): string[][] {
  const root = wiki(o);
  const categories = new Set((o.conf.KB_CATEGORIES ?? 'machines,services,projects,rules,wiki').split(','));
  const rules = o.conf.KB_RULES_DIRNAME ?? 'rules';
  return descendants(root).sort(comparePaths).filter(path => isDirectory(path) && !categories.has(basename(path)) && basename(path) !== rules && existsSync(pythonPath(path, `${basename(path)}.md`))).map(path => parts(relative(root, path)));
}

export function rulesFor(scope: string, o: WikiOptions): string[] {
  const root = wiki(o);
  const rules = o.conf.KB_RULES_DIRNAME ?? 'rules';
  const result: string[] = [];
  for (const path of descendants(root)) {
    if (basename(path) === rules && isDirectory(path) && parts(relative(root, path)).includes(scope)) {
      result.push(...descendants(path).filter(f => dirname(f) === path && f.endsWith('.md')).sort(comparePaths));
    }
  }
  return result;
}

export function alwaysRules(o: WikiOptions): string[] {
  const rules = o.conf.KB_RULES_DIRNAME ?? 'rules';
  // pathlib's multi-component rglob matches rules-directory symlinks even
  // though recursive descent itself never follows arbitrary symlinks.
  const paths = descendants(wiki(o)).filter(path => basename(path) === rules && isDirectory(path)).flatMap(path => descendants(path).filter(file => dirname(file) === path && file.endsWith('.md')));
  if (o.conf.KB_RULES) {
    const layer = pythonPath(o.root, o.conf.KB_RULES);
    if (isDirectory(layer)) paths.push(...descendants(layer).filter(path => dirname(path) === layer && path.endsWith('.md')));
  }
  const marker = o.conf.KB_ALWAYS_MARKER ?? 'inject: always';
  return [...new Set(paths)].filter(path => Array.from(readFileSync(path, 'utf8')).slice(0, 400).join('').includes(marker)).sort(comparePaths);
}

const header = ['## ישויות ידועות', '', "*מה קיים, לא מה נכון. לפרטים: `recollq -c ~/.recoll '<שם>'`*", ''];
export function renderFlat(entities: string[][]): string {
  const key = (p: string[]) => JSON.stringify(p);
  const kids = new Map<string, number>();
  for (const p of entities) kids.set(key(p.slice(0, -1)), (kids.get(key(p.slice(0, -1))) ?? 0) + 1);
  const groups = new Map<string, Set<string>>();
  for (const p of entities) {
    const group = p.length > 1 ? p[0]! : 'wiki';
    const count = kids.get(key(p)) ?? 0;
    if (!groups.has(group)) groups.set(group, new Set());
    groups.get(group)!.add(`${p.at(-1)}${count ? `(${count})` : ''}`);
  }
  const out = [...header];
  for (const group of sorted([...groups.keys()])) out.push(`**${group}** · ${sorted([...groups.get(group)!]).join(' · ')}`);
  out.push('');
  return out.join('\n');
}

export function renderTree(entities: string[][]): string {
  type Node = Map<string, Node>;
  const roots: Node = new Map();
  for (const p of entities) {
    const cat = p.length > 1 ? p[0]! : 'wiki';
    if (!roots.has(cat)) roots.set(cat, new Map());
    let node = roots.get(cat)!;
    for (const name of p.length > 1 ? p.slice(1) : p) {
      if (!node.has(name)) node.set(name, new Map());
      node = node.get(name)!;
    }
  }
  const out = [...header];
  out[2] = "*מה קיים, לא מה נכון. העץ = היררכיית התיקיות. לפרטים: `recollq -c ~/.recoll '<שם>'`*";
  function walk(node: Node, depth: number) {
    for (const name of sorted([...node.keys()])) {
      out.push(`${'  '.repeat(depth)}- ${name}`);
      walk(node.get(name)!, depth + 1);
    }
  }
  for (const cat of sorted([...roots.keys()])) { out.push(`**${cat}**`); walk(roots.get(cat)!, 0); out.push(''); }
  return out.join('\n');
}

export function main(argv: string[]): number {
  const o = options();
  if (argv.includes('--always')) { for (const f of alwaysRules(o)) console.log(f); return 0; }
  if (argv.includes('--rules')) {
    const scope = argv[argv.indexOf('--rules') + 1];
    if (scope === undefined) throw new Error('--rules requires a scope');
    for (const f of rulesFor(scope, o)) console.log(f);
    return 0;
  }
  const entities = collect(o);
  const tree = ['1', 'true', 'yes'].includes((o.conf.KB_INDEX_TREE ?? '').trim().toLowerCase());
  const text = tree ? renderTree(entities) : renderFlat(entities);
  if (argv.includes('--stdout')) console.log(text);
  else {
    const out = pythonPath(o.root, o.conf.KB_ENTITIES_OUT ?? 'wiki-entities.md');
    writeFileSync(out, text, 'utf8');
    const size = charLength(text);
    console.error(`wiki-index: ${entities.length} ישויות · ${size} bytes ≈ ${Math.floor(size / 4)} טוקנים → ${basename(out)}`);
  }
  return 0;
}
