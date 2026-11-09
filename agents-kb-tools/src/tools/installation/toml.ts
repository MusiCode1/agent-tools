import { parse } from 'smol-toml';

type Table = Record<string, unknown>;
interface Assignment { parts: string[]; start: number; end: number }
interface Section { parts: string[]; start: number; end: number }

/** Decode dotted and quoted TOML keys using the actual TOML grammar. */
function keyParts(key: string): string[] {
  let node: unknown = parse(`${key} = 0`);
  const parts: string[] = [];
  while (node && typeof node === 'object' && !Array.isArray(node)) {
    const entries = Object.entries(node);
    if (entries.length !== 1) throw new Error(`Invalid TOML key: ${key}`);
    const [part, next] = entries[0]!;
    parts.push(part);
    node = next;
  }
  if (!parts.length || node !== 0) throw new Error(`Invalid TOML key: ${key}`);
  return parts;
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, i) => part === b[i]);
}
function prefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((part, i) => part === b[i]);
}
function lookup(parsed: unknown, parts: string[]): unknown {
  let node = parsed;
  for (const part of parts) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, part)) return undefined;
    node = (node as Table)[part];
  }
  return node;
}

function quoteEnd(text: string, start: number): number {
  const quote = text[start]!;
  const triple = text.slice(start, start + 3) === quote.repeat(3);
  let i = start + (triple ? 3 : 1);
  while (i < text.length) {
    if (quote === '"' && text[i] === '\\') { i += 2; continue; }
    if (triple ? text.slice(i, i + 3) === quote.repeat(3) : text[i] === quote) {
      if (!triple) return i + 1;
      while (text[i] === quote) i++;
      return i;
    }
    i++;
  }
  throw new Error('Unclosed TOML string');
}

/** Locate one complete value, including multiline strings, arrays and inline tables. */
function valueEnd(text: string, start: number): { end: number; next: number } {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") { i = quoteEnd(text, i); continue; }
    if (c === '#' || c === '\n') {
      const next = text.indexOf('\n', i);
      if (!depth) {
        const end = start + text.slice(start, i).trimEnd().length;
        return { end, next: next < 0 ? text.length : next + 1 };
      }
      i = next < 0 ? text.length : next + 1;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    i++;
  }
  return { end: start + text.slice(start).trimEnd().length, next: text.length };
}

/** Source spans are lexical; semantic key identity comes from the parser. */
function scan(text: string): { assignments: Assignment[]; sections: Section[] } {
  const assignments: Assignment[] = [];
  const sections: Section[] = [{ parts: [], start: 0, end: text.length }];
  let section: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
    if (i === text.length) break;
    if (text[i] === '#') {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (text[i] === '[') {
      const start = i;
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      const keyStart = i;
      while (i < text.length && text[i] !== ']') {
        if (text[i] === '"' || text[i] === "'") i = quoteEnd(text, i);
        else i++;
      }
      const parts = keyParts(text.slice(keyStart, i).trim());
      // Array-of-table members are not addressable by string/integer dotted keys.
      section = array ? ['\0array', ...parts] : parts;
      sections[sections.length - 1]!.end = start;
      sections.push({ parts: section, start, end: text.length });
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline + 1;
      continue;
    }
    const start = i;
    while (i < text.length && text[i] !== '=') {
      if (text[i] === '"' || text[i] === "'") i = quoteEnd(text, i);
      else i++;
    }
    if (i === text.length) throw new Error('Invalid TOML assignment');
    const parts = [...section, ...keyParts(text.slice(start, i).trim())];
    i++;
    while (text[i] === ' ' || text[i] === '\t') i++;
    const valueStart = i;
    const value = valueEnd(text, i);
    assignments.push({ parts, start: valueStart, end: value.end });
    i = value.next;
  }
  return { assignments, sections };
}

function renderKey(parts: string[]): string {
  return parts.map(part => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join('.');
}

/** Change explicit string/integer keys without serializing unrelated configuration. */
export function tomlValues(text: string, values: Record<string, string | number>): string {
  if (typeof text !== 'string' || !values || typeof values !== 'object' || Array.isArray(values))
    throw new Error('TOML update requires text and a values object');
  let parsed: unknown = parse(text);
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value)))
      throw new Error(`TOML value must be a string or safe integer: ${key}`);
    const parts = keyParts(key);
    if (lookup(parsed, parts) === value) continue;
    const { assignments, sections } = scan(text);
    const existing = assignments.find(assignment => same(assignment.parts, parts));
    const rendered = JSON.stringify(value);
    if (existing) {
      text = text.slice(0, existing.start) + rendered + text.slice(existing.end);
    } else {
      // Do not silently discard unrelated children of inline-table assignments.
      if (assignments.some(assignment => prefix(assignment.parts, parts)))
        throw new Error(`Cannot extend an inline TOML value: ${key}`);
      const table = parts.slice(0, -1);
      // Reuse the deepest containing explicit table; otherwise add a root dotted key.
      const section = sections.filter(candidate => prefix(candidate.parts, table))
        .sort((a, b) => b.parts.length - a.parts.length)[0]!;
      const line = `${renderKey(parts.slice(section.parts.length))} = ${rendered}\n`;
      const before = text.slice(0, section.end);
      text = before + (before && !before.endsWith('\n') ? '\n' : '') + line + text.slice(section.end);
    }
    parsed = parse(text);
    if (lookup(parsed, parts) !== value) throw new Error(`TOML update failed: ${key}`);
  }
  return text;
}
