import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function componentRoot(entry = process.argv[1]): string {
  let current = path.dirname(fs.realpathSync(entry));
  for (;;) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'agents-kb-tools') return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Cannot locate agents-kb-tools package root');
    current = parent;
  }
}

export function assertBuildFresh(root = componentRoot()): void {
  const manifest = path.join(root, 'dist/build-manifest.json');
  const help = 'Run npm ci and npm run build in agents-kb-tools before running this command.';
  if (!fs.existsSync(manifest)) throw new Error(`Missing JavaScript build. ${help}`);
  const data = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {version: number; sources: Record<string,string>};
  if (data.version !== 1) throw new Error(`Unsupported build manifest. ${help}`);
  const actualSources: string[] = [];
  const scan = (directory: string): void => {
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file = path.join(directory,entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Product source is a symlink: ${file}`);
      if (entry.isDirectory()) scan(file);
      else actualSources.push(path.relative(root,file).split(path.sep).join('/'));
    }
  };
  scan(path.join(root,'src'));
  if (actualSources.sort().join('\n') !== Object.keys(data.sources).filter(name=>name.startsWith('src/')).sort().join('\n')) {
    throw new Error(`Stale JavaScript build (source inventory changed). ${help}`);
  }
  for (const [name, hash] of Object.entries(data.sources)) {
    const file = path.join(root, name);
    if (!fs.existsSync(file) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) {
      throw new Error(`Stale JavaScript build (${name}). ${help}`);
    }
  }
}

export function runCli(name: string, fn: (argv: string[]) => unknown | Promise<unknown>): void {
  Promise.resolve().then(() => { assertBuildFresh(); return fn(process.argv.slice(2)); })
    .then(code => { if (typeof code === 'number') process.exitCode = code; })
    .catch((error: Error & {exitCode?: number}) => {
      console.error(`${name}: ${error.message}`);
      process.exitCode = error.exitCode ?? 1;
    });
}
