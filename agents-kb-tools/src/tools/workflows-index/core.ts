import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, relative } from 'node:path';
import { findRoot, readConf } from '../../shared/instance.js';
import { parseYaml, scalarSource } from '../../shared/yaml.js';
import { compareCodePoints } from '../../shared/text.js';
import { comparePaths, isDirectory, markdownFiles, pythonPath } from '../../shared/legacy-filesystem.js';

export interface Workflow { name: unknown; description: string; kind: unknown; tags: unknown; path: string }
const sources = new WeakMap<object, Record<string, string>>();
function sourceFor(parent?: object, key?: string): string | undefined {
  return parent && key !== undefined ? sources.get(parent)?.[key] ?? scalarSource(parent, key) : undefined;
}
function floatSource(source?: string): boolean { return !!source && !/^[-+]?0[xob]/i.test(source) && /[.eE]/.test(source); }
function pyNumber(value: number, float = false, json = false): string {
  if (Number.isNaN(value)) return json ? 'NaN' : 'nan';
  if (!Number.isFinite(value)) return `${value < 0 ? '-' : ''}${json ? 'Infinity' : 'inf'}`;
  if (!float && Number.isInteger(value)) return String(value);
  if (Object.is(value, -0)) return '-0.0';
  const exponent = value ? Math.floor(Math.log10(Math.abs(value))) : 0;
  if (exponent < -4 || exponent >= 16) {
    return value.toExponential().replace(/e([+-])(\d)$/, 'e$10$2');
  }
  const text = String(value);
  return Number.isInteger(value) ? `${text}.0` : text;
}
export function pyString(value: unknown, nested = false, parent?: object, key?: string): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value instanceof Date) {
    if ((value as Date & { __yamlDateOnly?: boolean }).__yamlDateOnly) return value.toISOString().slice(0, 10);
    const source = (value as Date & { __yamlSource?: string }).__yamlSource ?? '';
    const timestamp = /^(\d{4})-(\d\d?)-(\d\d?)(?:[Tt]|[ \t]+)(\d\d?):(\d\d):(\d\d)(?:\.(\d*))?(?:[ \t]*(Z|([-+])(\d\d?)(?::(\d\d))?))?$/.exec(source);
    if (timestamp) {
      const [, y, mo, d, h, mi, s, fraction, zone, sign, zh, zm] = timestamp;
      let text = `${y}-${mo!.padStart(2, '0')}-${d!.padStart(2, '0')} ${h!.padStart(2, '0')}:${mi}:${s}`;
      if (fraction && /[1-9]/.test(fraction.slice(0, 6))) text += `.${fraction.slice(0, 6).padEnd(6, '0')}`;
      if (zone) text += zone === 'Z' ? '+00:00' : `${sign}${zh!.padStart(2, '0')}:${(zm ?? '00').padStart(2, '0')}`;
      return text;
    }
    const iso = value.toISOString();
    let text = iso.slice(0, 19).replace('T', ' ');
    if (value.getUTCMilliseconds()) text += `.${iso.slice(20, 23)}000`;
    if (/[zZ]|[-+]\d\d?(?::\d\d)?\s*$/.test(source.replace(/^\d{4}-\d\d-\d\d/, ''))) text += '+00:00';
    return text;
  }
  if (typeof value === 'string') {
    if (!nested) return value;
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    return quote + value.replace(/\\/g, '\\\\').replaceAll(quote, `\\${quote}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + quote;
  }
  if (Array.isArray(value)) return `[${value.map((item, i) => pyString(item, true, value, String(i))).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([k, v]) => `${pyString(k, true)}: ${pyString(v, true, value, k)}`).join(', ')}}`;
  if (typeof value === 'number') return pyNumber(value, floatSource(sourceFor(parent, key)));
  return String(value);
}
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.keys(value).length > 0;
  return !!value;
}

export function readFrontmatter(path: string): Record<string, unknown> | undefined {
  // The old reader stops at the second delimiter, so invalid UTF-8 or YAML in
  // the Markdown body does not affect frontmatter extraction.
  const lines = readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return;
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (close < 0) return;
  try {
    const value = parseYaml(lines.slice(1, close).join('\n'));
    return value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) ? value as Record<string, unknown> : undefined;
  } catch { return; }
}

export function collect(root: string, conf: Record<string, string>): Workflow[] {
  const dir = pythonPath(root, conf.KB_WORKFLOWS ?? 'workflows');
  const indexFilename = basename(conf.KB_WORKFLOWS_INDEX ?? 'workflows/INDEX.md');
  if (!isDirectory(dir)) return [];
  const kinds = (conf.KB_KINDS ?? 'runbook,diagnostic,redirect').split(',').map(x => x.trim()).filter(Boolean).sort(compareCodePoints);
  const items: Workflow[] = [];
  for (const md of markdownFiles(dir).sort(comparePaths)) {
    if (basename(md) === indexFilename) continue;
    const fm = readFrontmatter(md);
    if (!fm) { console.error(`list-workflows: skipping ${md} (no valid frontmatter)`); continue; }
    const rel = relative(dir, md).replaceAll('\\', '/');
    for (const [old, current] of [['type', 'kind'], ['title', 'name']]) {
      if (Object.hasOwn(fm, old!)) console.error(`list-workflows: ${rel}: \`${old}:\` is not indexed — use \`${current}:\``);
    }
    const missing = ['name', 'description', 'tags', 'kind', 'domain', 'env', 'tool'].filter(key => !Object.hasOwn(fm, key));
    if (missing.length) console.error(`list-workflows: ${rel}: missing ${missing.join(', ')}`);
    if (truthy(fm.kind) && typeof fm.kind === 'object' && !(fm.kind instanceof Date)) throw new TypeError(`unhashable type: '${Array.isArray(fm.kind) ? 'list' : 'dict'}'`);
    if (truthy(fm.kind) && !kinds.includes(fm.kind as string)) console.error(`list-workflows: ${rel}: kind \`${pyString(fm.kind, false, fm, 'kind')}\` outside ${pyString(kinds)}`);
    const item: Workflow = {
      name: truthy(fm.name) ? fm.name : basename(md, extname(md)),
      description: pyString(Object.hasOwn(fm, 'description') ? fm.description : '', false, fm, 'description').trim(),
      kind: Object.hasOwn(fm, 'kind') ? fm.kind : '',
      tags: Object.hasOwn(fm, 'tags') ? fm.tags : [],
      path: rel,
    };
    sources.set(item, Object.fromEntries(['name', 'kind'].map(key => [key, scalarSource(fm, key)]).filter((pair): pair is [string, string] => pair[1] !== undefined)));
    items.push(item);
  }
  return items;
}

export function renderIndex(items: Workflow[]): string {
  const lines = ['# Workflow Index', '', '> Auto-generated by `kb-workflows-index`. Do not edit by hand.', '> Run `kb-workflows-index` from the instance, or set `KB_ROOT`.', ''];
  for (const item of items) {
    lines.push(`## ${pyString(item.name, false, item, 'name')}`, '');
    if (item.description) lines.push(item.description, '');
    lines.push(truthy(item.kind) ? `- kind: \`${pyString(item.kind, false, item, 'kind')}\`` : '- kind: _(none)_');
    const tags = Array.isArray(item.tags) ? item.tags : truthy(item.tags) ? [item.tags] : [];
    lines.push(`- tags: ${tags.length ? tags.map((x, i) => pyString(x, false, tags, String(i))).join(', ') : '_(none)_'}`, `- path: \`${item.path}\``, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function main(argv: string[]): number {
  const root = findRoot();
  const conf = readConf(root);
  const dir = pythonPath(root, conf.KB_WORKFLOWS ?? 'workflows');
  const items = collect(root, conf);
  if (argv.includes('--json')) {
    const assertJson = (value: unknown): void => {
      if (value instanceof Date) throw new TypeError('Object of type date is not JSON serializable');
      if (value && typeof value === 'object') for (const nested of Object.values(value)) assertJson(nested);
    };
    assertJson(items);
    console.log(pythonJson(items)); return 0;
  }
  if (argv.includes('--names')) { for (const item of items) console.log(pyString(item.name, false, item, 'name')); return 0; }
  if (!items.length) { console.error(`No workflows found in ${dir}`); return 1; }
  const path = pythonPath(dir, basename(conf.KB_WORKFLOWS_INDEX ?? 'workflows/INDEX.md'));
  writeFileSync(path, renderIndex(items), 'utf8');
  console.log(`Wrote ${path} (${items.length} workflow(s))`);
  return 0;
}

function pythonJson(value: unknown, level = 0, parent?: object, key?: string): string {
  if (typeof value === 'number') return pyNumber(value, floatSource(sourceFor(parent, key)), true);
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const array = Array.isArray(value);
  const entries = array ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  if (!entries.length) return array ? '[]' : '{}';
  const indent = '  '.repeat(level + 1);
  const content = entries.map(([k, v]) => indent + (array ? '' : `${JSON.stringify(k)}: `) + pythonJson(v, level + 1, value, k)).join(',\n');
  return `${array ? '[' : '{'}\n${content}\n${'  '.repeat(level)}${array ? ']' : '}'}`;
}
