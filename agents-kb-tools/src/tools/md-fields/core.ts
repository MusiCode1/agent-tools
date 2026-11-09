import { readFileSync, statSync } from 'node:fs';

/** This intentionally parses lines rather than YAML: recoll's existing filter
 * accepts a delimiter away from the start and preserves raw scalar spelling. */
export function fields(text: string): string {
  let delimiters = 0;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (/^---\s*$/.test(line)) { delimiters++; continue; }
    if (delimiters !== 1) continue;
    const match = /^(name|description|title|tags|kind|type|domain|env|tool|entities|verified_on):\s*([^\n]*)$/.exec(line);
    if (!match) continue;
    let key = match[1]!;
    const value = match[2]!.replace(/^["'\[]|["'\]]$/g, '');
    if (!value) continue;
    if (key === 'description' || key === 'title') key = 'rbdesc';
    if (key === 'type') key = 'kind';
    out.push(`${key} = ${value}`);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

export function main(argv: string[]): number {
  const file = argv[0];
  if (!file) return 0;
  try { if (!statSync(file).isFile()) return 0; } catch { return 0; }
  process.stdout.write(fields(readFileSync(file, 'utf8')));
  return 0;
}
