import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWrite, inside} from '../../shared/fs.js';
import {compareCodePoints} from '../../shared/text.js';

const skills = ['kb-use', 'kb-install'];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const within = (root: string, file: string) => {const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);};

interface Manifest {version: number; files: Record<string,string>; modes?: Record<string,number>;}
interface Resource {data: Buffer; mode: number;}
const generated = (value: unknown): Resource => ({data: Buffer.from(json(value)), mode: 0o644});

function skillFiles(folder: string): string[] {
  const files: string[] = [];
  for (const item of fs.readdirSync(folder, {withFileTypes: true})) {
    const file = path.join(folder, item.name);
    if (item.isDirectory()) files.push(...skillFiles(file));
    else if (item.isFile()) files.push(file);
    else throw new Error(`Unsupported skill resource (files and directories only): ${file}`);
  }
  return files.sort(compareCodePoints);
}

/** Copy complete skill folders and referenced method resources; no runtime installation. */
export function renderBundles(source: string): Map<string,Resource> {
  source = fs.realpathSync(source);
  const method = path.join(source, 'src/method');
  const result = new Map<string,Resource>();
  for (const skill of skills) {
    const folder = path.join(source, 'src/skills', skill);
    if (fs.lstatSync(folder).isSymbolicLink()) throw new Error(`Skill source must not be a symlink: ${folder}`);
    const queue = skillFiles(folder);
    if (!queue.includes(path.join(folder,'SKILL.md'))) throw new Error(`Missing SKILL.md: ${folder}`);
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
      let data = fs.readFileSync(file);
      if (path.extname(file) === '.md') {
        const body = data.toString('utf8').replace(/(\[[^\]]*\]\()(<[^>]+>|[^\s)]+)(\))/g, (match, start: string, link: string, end: string) => {
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
        data = Buffer.from(body);
      }
      result.set(`${skill}/${local}`, {data,mode: fs.statSync(file).mode & 0o777});
    }
    const entries = [...seen].sort((a,b)=>compareCodePoints(a[1],b[1])).map(([file, output]) => ({
      source: path.relative(source,file).split(path.sep).join('/'), output,
      source_sha256: hash(fs.readFileSync(file)), output_sha256: hash(result.get(`${skill}/${output}`)!.data),
      mode: result.get(`${skill}/${output}`)!.mode,
    }));
    if (result.has(`${skill}/manifest.json`)) throw new Error(`Reserved skill resource: ${skill}/manifest.json`);
    result.set(`${skill}/manifest.json`, generated({version: 1, skill, sources: entries}));
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
  const manifest: Manifest = {
    version: 1,
    files: Object.fromEntries([...rendered].map(([name,resource])=>[name,hash(resource.data)])),
    modes: Object.fromEntries([...rendered].map(([name,resource])=>[name,resource.mode])),
  };
  rendered.set('skills-manifest.json', generated(manifest));
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
      const modeChanged = previous.modes?.[name] !== undefined && (fs.statSync(file).mode & 0o777) !== previous.modes[name];
      if ((hash(fs.readFileSync(file)) !== known || modeChanged) && !check) throw new Error(`Exported resource was edited: ${name}; choose a new output directory`);
    }
  }
  for (const name of rendered.keys()) {
    inside(output,path.join(output,name));
    try { if (fs.lstatSync(path.join(output,name)).isSymbolicLink()) throw new Error(`Skill output is a symlink: ${name}`); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (check) {
    for (const [name,resource] of rendered) {
      const file = path.join(output,name);
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(resource.data) || (fs.statSync(file).mode & 0o777) !== resource.mode) throw new Error(`Missing/stale skill resource: ${name}`);
    }
    for (const name of Object.keys(previous.files)) if (!manifest.files[name]) throw new Error(`Obsolete skill resource: ${name}`);
  } else {
    for (const name of Object.keys(previous.files)) if (!manifest.files[name]) fs.unlinkSync(inside(output,path.join(output,name)));
    for (const [name,resource] of rendered) if (name !== 'skills-manifest.json') atomicWrite(path.join(output,name),resource.data,resource.mode);
    const markerResource = rendered.get('skills-manifest.json')!;
    atomicWrite(marker,markerResource.data,markerResource.mode);
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
