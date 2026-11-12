import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { findRoot, readConf } from '../../shared/instance.js';
import { isDirectory, markdownFiles, pythonPath } from '../../shared/legacy-filesystem.js';
import { charLength } from '../../shared/text.js';

/** A finding names the files it concerns, so `--only` can scope reporting without parsing messages. */
interface Finding { message: string; files: string[] }

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

export function check(root: string, c: Record<string, string>, only: string[] = []): number {
  const wiki = pythonPath(root, c.KB_WIKI ?? 'wiki');
  const history = pythonPath(root, c.KB_HISTORY ?? 'history');
  const workflows = pythonPath(root, c.KB_WORKFLOWS ?? 'workflows');
  const rulesDir = c.KB_RULES_DIRNAME ?? 'rules';
  const pageMax = integer(c.KB_PAGE_MAX ?? '12288');
  const segmentMax = integer(c.KB_SEGMENT_MAX ?? '4096');
  const segmentFences = integer(c.KB_SEGMENT_FENCES ?? '4');
  const catalogMax = integer(c.KB_CATALOG_MAX ?? '32768');
  const structural = list(c.KB_STRUCTURAL_SECTIONS ?? 'ראו גם');
  const catalogKinds = list(c.KB_CATALOG_KINDS ?? '');
  const caps = parseCaps(c.KB_CAPS ?? '');
  const requireKind = c.KB_REQUIRE_KIND === 'on';
  const descMax = integer(c.KB_DESC_MAX ?? '0');
  const claimSource = (c.KB_VERIFIED_PATTERNS ?? '').trim();
  const claim = c.KB_VERIFIED_MODE === 'on' && claimSource ? compileClaim(claimSource) : undefined;
  const titles = new Map<string, string[]>();
  const findings: Finding[] = [];
  const fail = (message: string, ...files: string[]) => { findings.push({ message, files }); };
  const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');

  for (const file of markdownFiles(wiki)) {
    const rel = relative(root, file);
    const body = read(file);
    if (basename(dirname(file)) === rulesDir || basename(file) === 'README.md') continue;
    const stem = basename(file, '.md');
    if (!titles.has(stem)) titles.set(stem, []);
    titles.get(stem)!.push(rel);
    // `kind` is read from the frontmatter block itself. A fixed byte window
    // misses it when a long `description` precedes it, which silently applies
    // the wrong cap and would make KB_REQUIRE_KIND flag a valid page.
    const frontmatter = FRONTMATTER.exec(body);
    const kind = frontmatter ? /^kind:\s*(\S+)/m.exec(frontmatter[1]!)?.[1]?.trim() ?? '' : '';
    // A page's cap follows what the page is: a set of claims stays small, a
    // procedure read end to end may not. KB_CAPS, when it defines at least one
    // kind, replaces KB_CATALOG_*; an unlisted kind gets KB_PAGE_MAX; 0 = no cap.
    const cap = caps.size ? caps.get(kind) ?? pageMax : kind && catalogKinds.includes(kind) ? catalogMax : pageMax;
    if (requireKind && !kind && basename(file) !== 'INDEX.md') fail(`${rel} — בלי \`kind:\`; התקרה נגזרת ממנו, ואין ברירת-מחדל שקטה`, rel);
    if (cap && Buffer.byteLength(body) > cap) fail(`${rel} — ${kib(Buffer.byteLength(body))}KB > ${Math.floor(cap / 1024)}KB, לפצל לתת-ישויות`, rel);
    const segments = body.split(/^### /m);
    const head = segments[0]!.replace(/^---\n[\s\S]*?\n---\n/, '');
    const dated = head.split('\n').filter(line => line.trim()).slice(0, 10).join('\n').includes('⟨');
    for (const segment of segments.slice(1)) {
      const title = Array.from(segment.split('\n', 1)[0]!).slice(0, 44).join('').trim();
      if (structural.some(prefix => title.startsWith(prefix))) continue;
      if (!dated && !segment.split('\n').slice(1, 4).join('\n').includes('⟨')) fail(`${rel} § ${title} — מקטע בלי ⟨תאריך⟩`, rel);
      const fences = segment.split('\n```').length - 1;
      if (Buffer.byteLength(segment) > segmentMax && fences >= segmentFences) fail(`${rel} § ${title} — ${kib(Buffer.byteLength(segment))}KB ו-${Math.floor(fences / 2)} בלוקי קוד, זה רנבוק`, rel);
    }
  }
  for (const [title, paths] of titles) if (paths.length > 1) fail(`שם ישות כפול: ${title} — ${paths.join(', ')}`, ...paths);

  // History records carry no size cap on purpose: a transcript cannot be split
  // without falsifying it, and the layer is append-only.
  if (isDirectory(history)) {
    for (const file of markdownFiles(history)) {
      if (basename(file) === 'README.md') continue;
      const head = Array.from(read(file)).slice(0, 600).join('');
      const rel = relative(root, file);
      if (!head.includes('⟨')) fail(`${rel} — רשומת היסטוריה בלי ⟨תאריך⟩`, rel);
      if (!head.includes('#') && !head.includes('[[')) fail(`${rel} — בלי תגית ובלי [[ישות]]; הנתיב הוא תאריך, לא תימצא`, rel);
    }
  }

  // `verified` gate: a page whose prose carries a concrete identifier must
  // state when the claim was last checked; `updated` records an edit, not a
  // check. The gate is structural: it asks whether a date exists, not whether
  // it is fresh. What counts as an identifier is instance content, so there is
  // no default pattern. History is exempt (a record is true for its date), and
  // fenced code blocks are removed first: an example payload documents a
  // format and is not a claim.
  if (claim) {
    for (const base of [wiki, workflows]) {
      if (!isDirectory(base)) continue;
      for (const file of markdownFiles(base)) {
        if (basename(file) === 'README.md') continue;
        const body = read(file);
        const rel = relative(root, file);
        const frontmatter = FRONTMATTER.exec(body);
        const fields = frontmatter ? frontmatter[1]! : '';
        const prose = (frontmatter ? body.slice(frontmatter[0].length) : body).replace(/^```[\s\S]*?^```/gm, '');
        const verified = /^verified:\s*(\S+)/m.exec(fields);
        if (verified) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(verified[1]!)) fail(`${rel} — \`verified\` חייב YYYY-MM-DD: ${verified[1]}`, rel);
          continue;
        }
        const hit = claim.exec(prose);
        if (hit) fail(`${rel} — טענה חיה (${Array.from(hit[0]).slice(0, 24).join('')}) בלי \`verified:\` בפרונטמטר`, rel);
      }
    }
  }

  // `description` is copied verbatim into the scan index, where each entry is
  // one line to decide what to open; a long one turns skimming into reading.
  // The threshold is instance content; 0 disables the check.
  if (descMax) {
    for (const base of [wiki, workflows]) {
      if (!isDirectory(base)) continue;
      for (const file of markdownFiles(base)) {
        if (['README.md', 'INDEX.md'].includes(basename(file)) || basename(dirname(file)) === rulesDir) continue;
        const frontmatter = FRONTMATTER.exec(read(file));
        if (!frontmatter) continue;
        const description = /^description:\s*(.*)$/m.exec(frontmatter[1]!);
        const length = description ? charLength(description[1]!) : 0;
        if (description && length > descMax) {
          const rel = relative(root, file);
          fail(`${rel} — \`description\` ${length} תווים > ${descMax}; הוא נכנס כלשונו לאינדקס. משפט אחד — מה זה ומתי לקרוא בו`, rel);
        }
      }
    }
  }

  const names = list(c.KB_NAME_LIST ?? '');
  if (c.KB_NAME_GATE === 'on' && names.length) {
    for (const base of [wiki, history, workflows]) {
      if (!isDirectory(base)) continue;
      for (const file of markdownFiles(base)) {
        const body = read(file);
        const rel = relative(root, file);
        for (const name of names) if (body.includes(name)) fail(`${rel} — שם חסום: ${name}`, rel);
      }
    }
  }

  // `--only` narrows reporting, not scanning: a whole-corpus gate lets one old
  // defect block every commit, but checks such as duplicate names still need
  // the whole tree. A finding stays in scope when any file it names is in
  // scope, so a collision introduced by a staged file is still reported.
  const scope = only.flatMap(path => scopeCandidates(root, path));
  const shown = only.length ? findings.filter(f => f.files.some(file => inScope(file, scope))) : findings;
  const hidden = findings.length - shown.length;
  for (const finding of shown) console.error(`  ✗ ${finding.message}`);
  if (!shown.length) {
    console.error(`✅ נקי${hidden ? ` (${hidden} ממצאים קיימים מחוץ להיקף)` : ''}`);
    return 0;
  }
  const warn = c.KB_GATE_MODE === 'warn';
  console.error(`\n${shown.length} ממצאים (${warn ? 'אזהרה' : 'כישלון'})${hidden ? ` · ${hidden} נוספים מחוץ להיקף` : ''}`);
  return warn ? 0 : 1;
}

function list(value: string): string[] { return value.split(',').map(x => x.trim()).filter(Boolean); }

function parseCaps(value: string): Map<string, number> {
  const caps = new Map<string, number>();
  for (const part of value.split(',')) {
    const split = part.indexOf(':');
    if (split >= 0) caps.set(part.slice(0, split).trim(), integer(part.slice(split + 1)));
  }
  return caps;
}

function compileClaim(source: string): RegExp {
  try { return new RegExp(source); }
  catch (error) { throw new Error(`KB_VERIFIED_PATTERNS אינו ביטוי רגולרי תקין: ${(error as Error).message}`); }
}

/** A path from `--only` is accepted relative to the instance root or to the cwd. */
function scopeCandidates(root: string, path: string): string[] {
  const candidates = new Set<string>();
  if (!isAbsolute(path)) candidates.add(normalize(path));
  const fromCwd = relative(root, resolve(path));
  if (fromCwd !== '..' && !fromCwd.startsWith(`..${sep}`) && !isAbsolute(fromCwd)) candidates.add(normalize(fromCwd));
  return [...candidates];
}

function normalize(path: string): string {
  const parts = path.split(sep).join('/').split('/').filter(part => part && part !== '.');
  return parts.join('/');
}

function inScope(file: string, scope: string[]): boolean {
  const target = normalize(file);
  return scope.some(path => !path || target === path || target.startsWith(`${path}/`));
}

function integer(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) throw new Error(`invalid literal for int() with base 10: '${value}'`);
  return Number(value);
}
function kib(bytes: number): string {
  const scaled = bytes * 10 / 1024, floor = Math.floor(scaled);
  const rounded = scaled - floor === 0.5 ? floor + floor % 2 : Math.round(scaled);
  return (rounded / 10).toFixed(1);
}

/** Paths after `--only`; without any, the whole corpus is reported. */
export function parseOnly(argv: string[]): string[] {
  const at = argv.indexOf('--only');
  return at < 0 ? [] : argv.slice(at + 1).map(x => x.trim()).filter(Boolean);
}

export function main(argv: string[]): number { const root = findRoot(); return check(root, readConf(root), parseOnly(argv)); }
