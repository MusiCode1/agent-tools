import { readFileSync } from 'node:fs';
import { basename, dirname, relative } from 'node:path';
import { findRoot, readConf } from '../../shared/instance.js';
import { isDirectory, markdownFiles, pythonPath } from '../../shared/legacy-filesystem.js';

export function check(root: string, c: Record<string, string>): number {
  const wiki = pythonPath(root, c.KB_WIKI ?? 'wiki');
  const history = pythonPath(root, c.KB_HISTORY ?? 'history');
  const pageMax = integer(c.KB_PAGE_MAX ?? '12288');
  const segmentMax = integer(c.KB_SEGMENT_MAX ?? '4096');
  const segmentFences = integer(c.KB_SEGMENT_FENCES ?? '4');
  const catalogMax = integer(c.KB_CATALOG_MAX ?? '32768');
  const structural = (c.KB_STRUCTURAL_SECTIONS ?? 'ראו גם').split(',').map(x => x.trim()).filter(Boolean);
  const catalogKinds = (c.KB_CATALOG_KINDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  const titles = new Map<string, string[]>();
  let problems = 0;
  const fail = (message: string) => { problems++; console.error(`  ✗ ${message}`); };
  const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
  for (const file of markdownFiles(wiki)) {
    const rel = relative(root, file);
    const body = read(file);
    if (basename(dirname(file)) === (c.KB_RULES_DIRNAME ?? 'rules') || basename(file) === 'README.md') continue;
    const stem = basename(file, '.md');
    if (!titles.has(stem)) titles.set(stem, []);
    titles.get(stem)!.push(rel);
    const kind = /^kind:\s*(\S+)/m.exec(Array.from(body).slice(0, 400).join(''));
    const cap = kind && catalogKinds.includes(kind[1]!.trim()) ? catalogMax : pageMax;
    if (Buffer.byteLength(body) > cap) fail(`${rel} — ${kib(Buffer.byteLength(body))}KB > ${Math.floor(cap / 1024)}KB, לפצל לתת-ישויות`);
    const segments = body.split(/^### /m);
    const head = segments[0]!.replace(/^---\n[\s\S]*?\n---\n/, '');
    const dated = head.split('\n').filter(line => line.trim()).slice(0, 10).join('\n').includes('⟨');
    for (const segment of segments.slice(1)) {
      const title = Array.from(segment.split('\n', 1)[0]!).slice(0, 44).join('').trim();
      if (structural.some(prefix => title.startsWith(prefix))) continue;
      if (!dated && !segment.split('\n').slice(1, 4).join('\n').includes('⟨')) fail(`${rel} § ${title} — מקטע בלי ⟨תאריך⟩`);
      const fences = segment.split('\n```').length - 1;
      if (Buffer.byteLength(segment) > segmentMax && fences >= segmentFences) fail(`${rel} § ${title} — ${kib(Buffer.byteLength(segment))}KB ו-${Math.floor(fences / 2)} בלוקי קוד, זה רנבוק`);
    }
  }
  for (const [title, paths] of titles) if (paths.length > 1) fail(`שם ישות כפול: ${title} — ${paths.join(', ')}`);
  if (isDirectory(history)) {
    for (const file of markdownFiles(history)) {
      if (basename(file) === 'README.md') continue;
      const head = Array.from(read(file)).slice(0, 600).join('');
      const rel = relative(root, file);
      if (!head.includes('⟨')) fail(`${rel} — רשומת היסטוריה בלי ⟨תאריך⟩`);
      if (!head.includes('#') && !head.includes('[[')) fail(`${rel} — בלי תגית ובלי [[ישות]]; הנתיב הוא תאריך, לא תימצא`);
    }
  }
  const names = (c.KB_NAME_LIST ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (c.KB_NAME_GATE === 'on' && names.length) {
    for (const base of [wiki, history, pythonPath(root, c.KB_WORKFLOWS ?? 'workflows')]) {
      if (!isDirectory(base)) continue;
      for (const file of markdownFiles(base)) {
        const body = read(file);
        for (const name of names) if (body.includes(name)) fail(`${relative(root, file)} — שם חסום: ${name}`);
      }
    }
  }
  if (!problems) { console.error('✅ נקי'); return 0; }
  console.error(`\n${problems} ממצאים (${c.KB_GATE_MODE === 'warn' ? 'אזהרה' : 'כישלון'})`);
  return c.KB_GATE_MODE === 'warn' ? 0 : 1;
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
export function main(_argv: string[]): number { const root = findRoot(); return check(root, readConf(root)); }
