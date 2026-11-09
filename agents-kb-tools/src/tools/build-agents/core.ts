import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { main as rulesMain } from '../rules/core.js';
import { alwaysRules, options, rulesFor } from '../wiki-index/core.js';
import { descendants, isDirectory } from '../../shared/legacy-filesystem.js';

const header = `<!-- GENERATED FILE — do not edit by hand.
     Sources: machine rules and selected wiki rules.
     Regenerate with kb-build-agents using the same MACHINE and KB_ROOT.
-->

`;

// GNU filevercmp orders suffixes separately (a.tar.gz follows a), handles ~
// before the empty string, and compares digit runs without numeric overflow.
function versionPart(a: Buffer, b: Buffer): number {
  let i = 0, j = 0;
  const digit = (c: number | undefined) => c !== undefined && c >= 48 && c <= 57;
  const order = (c: number | undefined) => c === 126 ? -1 : c === undefined || digit(c) ? 0 : (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? c : c + 256;
  while (i < a.length || j < b.length) {
    while ((i < a.length && !digit(a[i])) || (j < b.length && !digit(b[j]))) {
      const difference = order(a[i]) - order(b[j]);
      if (difference) return difference;
      i++; j++;
    }
    while (a[i] === 48) i++;
    while (b[j] === 48) j++;
    let difference = 0;
    while (digit(a[i]) && digit(b[j])) {
      if (!difference) difference = a[i]! - b[j]!;
      i++; j++;
    }
    if (digit(a[i])) return 1;
    if (digit(b[j])) return -1;
    if (difference) return difference;
  }
  return 0;
}

export function versionCompare(left: string, right: string): number {
  const a = Buffer.from(left), b = Buffer.from(right);
  if (!a.length || !b.length) return a.length - b.length;
  // GNU sort puts dot names before other names, with . and .. first.
  if (a[0] === 46 || b[0] === 46) {
    if (a[0] !== b[0]) return a[0] === 46 ? -1 : 1;
    for (const special of ['.', '..']) {
      if (left === special || right === special) return left === right ? 0 : left === special ? -1 : 1;
    }
  }
  const prefix = (s: string) => Buffer.from(s.replace(/(?<=.)(?:\.[A-Za-z~][A-Za-z0-9~]*)+$/, ''));
  return versionPart(prefix(left), prefix(right)) || versionPart(a, b) || Buffer.compare(a, b);
}

export function stripFrontmatter(text: string): string {
  // sed '/^---$/,/^---$/d' removes every paired range, including ranges in
  // the body; an unclosed range consumes the remainder of the file.
  let deleting = false;
  return text.match(/[^\n]*\n|[^\n]+$/g)?.filter(line => {
    if (line.replace(/\n$/, '') === '---') { deleting = !deleting; return false; }
    return !deleting;
  }).join('') ?? '';
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function main(argv: string[]): number | Promise<number> {
  if (argv.includes('--profile')) return rulesMain(['build', ...argv]);
  // Bash derived ROOT from the invocation path, not the script's realpath.
  // Wrappers preserve that path even when invoked via an instance symlink.
  const entrypoint = process.env.KB_ENTRYPOINT ?? process.argv[1]!;
  const root = resolve(dirname(entrypoint), '..');
  const machine = process.env.MACHINE || join(root, 'memory', 'machines', hostname());
  const rules = join(machine, 'rules');
  const out = join(machine, 'AGENTS.md');
  if (!isDirectory(rules)) { console.error(`error: rules dir missing: ${rules}`); return 1; }
  const files = descendants(rules).filter(path => dirname(path) === rules && basename(path).endsWith('.md') && !basename(path).startsWith('.')).sort(versionCompare);
  if (!files.length) {
    // nullglob + printf in the old script produces one empty filename. Its
    // cat then fails, preserving any previously generated destination.
    console.error("cat: '': No such file or directory");
    return 1;
  }
  let text = header;
  for (let index = 0; index < files.length; index++) {
    if (index) text += '\n---\n\n';
    const content = readFileSync(files[index]!, 'utf8');
    text += content;
    if (content && !content.endsWith('\n')) text += '\n';
  }
  const instance = process.env.KB_ROOT || join(root, 'knowledge');
  const entities = join(instance, 'wiki-entities.md');
  if (existsSync(entities) && !isDirectory(entities)) text += `\n---\n\n${readFileSync(entities, 'utf8')}`;
  let wikiRules: string[] = [];
  const indexEntrypoint = join(dirname(realpathSync(entrypoint)), 'kb-wiki-index');
  if (executable(indexEntrypoint)) {
    const o = options(resolve(instance));
    // Each subprocess was stderr-suppressed and allowed to fail independently.
    const scoped = (() => { try { return rulesFor(hostname(), o); } catch { return []; } })();
    const always = (() => { try { return alwaysRules(o); } catch { return []; } })();
    wikiRules = [...new Set([...scoped, ...always])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const file of wikiRules) {
      if (!existsSync(file) || isDirectory(file)) continue;
      text += `\n---\n\n${stripFrontmatter(readFileSync(file, 'utf8'))}`;
    }
    if (wikiRules.length) text += '\n';
  } else {
    // The original set -u script references wr in its final status line. Avoid
    // silently succeeding when the sibling CLI is absent or not executable.
    // It still installs the complete output before the status command fails.
    writeAtomically(out, text);
    console.error(`${entrypoint}: line 85: wr: unbound variable`);
    return 1;
  }
  writeAtomically(out, text);
  console.log(`wrote ${out} (${text.split('\n').length - 1} lines, ${files.length} rules + ${wikiRules.length} wiki-rules)`);
  return 0;
}

function writeAtomically(path: string, text: string) {
  // rename is atomic only within a filesystem; keep the temporary file beside
  // its destination rather than depending on TMPDIR's device or availability.
  const dir = mkdtempSync(join(dirname(path), '.kb-build-agents-'));
  const temp = join(dir, 'AGENTS.md');
  try { writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
