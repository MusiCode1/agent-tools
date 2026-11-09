import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWrite, inside} from '../../shared/fs.js';
import {compareCodePoints} from '../../shared/text.js';

const skills = ['kb-use', 'kb-install'];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const within = (root: string, file: string) => {const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);};

interface Manifest {version: number; files: Record<string,string>;}

/** Export only explicit skill resources; no instance data or runtime installation. */
export function renderBundles(source: string): Map<string,string> {
  source = fs.realpathSync(source);
  const method = path.join(source, 'src/method');
  const result = new Map<string,string>();
  for (const skill of skills) {
    const folder = path.join(source, 'src/skills', skill);
    const queue = [path.join(folder, 'SKILL.md')];
    const seen = new Map<string,string>();
    const sourceFor = new Map<string,string>();
    const destination = (file: string): string => {
      const canonical = fs.realpathSync(file);
      if (!fs.statSync(canonical).isFile()) throw new Error(`Skill reference is not a file: ${file}`);
      let local: string;
      if (within(folder, canonical)) local = path.relative(folder, canonical);
      else if (within(method, canonical)) local = path.join('references', path.relative(method, canonical));
      else throw new Error(`Skill reference leaves its source bundle: ${file}`);
      const existing = sourceFor.get(local);
      if (existing && existing !== canonical) throw new Error(`Duplicate exported resource: ${local}`);
      sourceFor.set(local, canonical);
      return local.split(path.sep).join('/');
    };
    for (let index = 0; index < queue.length; index++) {
      const file = fs.realpathSync(queue[index]);
      if (seen.has(file)) continue;
      const local = destination(file);
      seen.set(file, local);
      let body = fs.readFileSync(file, 'utf8');
      if (path.extname(file) === '.md') {
        body = body.replace(/(\[[^\]]*\]\()(<[^>]+>|[^\s)]+)(\))/g, (match, start: string, link: string, end: string) => {
          const raw = link.startsWith('<') ? link.slice(1,-1) : link;
          if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(raw)) return match;
          const split = raw.indexOf('#');
          const filename = split < 0 ? raw : raw.slice(0, split);
          const fragment = split < 0 ? '' : raw.slice(split);
          const target = fs.realpathSync(path.resolve(path.dirname(file), decodeURIComponent(filename)));
          const output = destination(target);
          if (!seen.has(target)) queue.push(target);
          const relative = path.posix.relative(path.posix.dirname(local), output) || path.posix.basename(output);
          const value = relative + fragment;
          return start + (/\s/.test(value) ? `<${value}>` : value) + end;
        });
      }
      result.set(`${skill}/${local}`, body);
    }
    const entries = [...seen].sort((a,b)=>compareCodePoints(a[1],b[1])).map(([file, output]) => ({
      source: path.relative(source,file).split(path.sep).join('/'), output,
      source_sha256: hash(fs.readFileSync(file)), output_sha256: hash(result.get(`${skill}/${output}`)!),
    }));
    result.set(`${skill}/manifest.json`, json({version: 1, skill, sources: entries}));
  }
  return new Map([...result].sort((a,b)=>compareCodePoints(a[0],b[0])));
}

export function packageSkills(source: string, output: string, check = false): Manifest {
  source = fs.realpathSync(source);
  output = path.resolve(output);
  if (within(output, source) || (within(source, output) && !within(path.join(source,'dist'), output))) {
    throw new Error('Export output must not replace product sources; use dist/skills or a separate directory');
  }
  const rendered = renderBundles(source);
  const manifest: Manifest = {version: 1, files: Object.fromEntries([...rendered].map(([name,body])=>[name,hash(body)]))};
  rendered.set('skills-manifest.json', json(manifest));
  const marker = path.join(output, 'skills-manifest.json');
  let previous: Manifest = {version: 1, files: {}};
  if (fs.existsSync(output)) {
    if (fs.lstatSync(output).isSymbolicLink()) throw new Error('Skill output must not be a symlink');
    if (fs.existsSync(marker)) {
      previous = JSON.parse(fs.readFileSync(marker,'utf8')) as Manifest;
      if (previous.version !== 1 || !previous.files || typeof previous.files !== 'object') throw new Error('Invalid skill output ownership manifest');
    }
    const files = fs.readdirSync(output, {recursive: true, withFileTypes: true});
    for (const item of files) {
      if (item.isDirectory()) continue;
      const file = path.join(item.parentPath, item.name);
      const name = path.relative(output,file).split(path.sep).join('/');
      inside(output,file);
      if (item.isSymbolicLink()) throw new Error(`Skill output contains a symlink: ${name}`);
      if (name === 'skills-manifest.json') continue;
      const known = previous.files[name];
      if (!known) throw new Error(`Unowned file in skill output: ${name}`);
      if (hash(fs.readFileSync(file)) !== known && !check) throw new Error(`Exported resource was edited: ${name}; choose a new output directory`);
    }
  }
  for (const name of rendered.keys()) {
    inside(output,path.join(output,name));
    try { if (fs.lstatSync(path.join(output,name)).isSymbolicLink()) throw new Error(`Skill output is a symlink: ${name}`); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (check) {
    for (const [name,body] of rendered) {
      const file = path.join(output,name);
      if (!fs.existsSync(file) || fs.readFileSync(file,'utf8') !== body) throw new Error(`Missing/stale skill resource: ${name}`);
    }
    for (const name of Object.keys(previous.files)) if (!manifest.files[name]) throw new Error(`Obsolete skill resource: ${name}`);
  } else {
    for (const name of Object.keys(previous.files)) if (!manifest.files[name]) fs.unlinkSync(inside(output,path.join(output,name)));
    for (const [name,body] of rendered) if (name !== 'skills-manifest.json') atomicWrite(path.join(output,name),body);
    atomicWrite(marker,rendered.get('skills-manifest.json')!);
  }
  return manifest;
}

export function main(argv: string[]): number {
  let source = '', output = '', check = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') source = argv[++i] ?? '';
    else if (argv[i] === '--output') output = argv[++i] ?? '';
    else if (argv[i] === '--check') check = true;
    else if (argv[i] === '--help' || argv[i] === '-h') { console.log('kb-package-skills --source <product> --output <directory> [--check]'); return 0; }
    else throw Object.assign(new Error(`Unknown argument: ${argv[i]}`),{exitCode: 2});
  }
  if (!source || !output) throw Object.assign(new Error('--source and --output are required'),{exitCode: 2});
  const manifest = packageSkills(source,output,check);
  console.log(json({version: manifest.version,files: Object.keys(manifest.files)}).trimEnd());
  return 0;
}
