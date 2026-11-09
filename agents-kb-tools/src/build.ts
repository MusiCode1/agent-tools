import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {packageSkills} from './tools/skill-bundle/core.js';
import {compareCodePoints} from './shared/text.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = ['rules','hygiene','wiki-index','workflows-index','build-agents','md-fields','installation','skill-bundle'];
const sources: Record<string,string> = {};
function scan(directory: string): void {
  for (const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>compareCodePoints(a.name,b.name))) {
    const file = path.join(directory,item.name);
    if (item.isSymbolicLink()) throw new Error(`Product source must not be a symlink: ${file}`);
    if (item.isDirectory()) scan(file);
    else sources[path.relative(root,file).split(path.sep).join('/')] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
}
scan(path.join(root,'src'));
for (const name of ['package.json','tsconfig.json']) sources[name] = createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
for (const tool of tools) {
  await build({entryPoints:[path.join(root,`src/tools/${tool}/cli.ts`)],outfile:path.join(root,`dist/tools/${tool}/cli.js`),
    platform:'node',target:'node22',format:'esm',bundle:true,packages:'bundle',logLevel:'warning',
    banner:{js:"import {createRequire as __kbCreateRequire} from 'node:module'; const require = __kbCreateRequire(import.meta.url);"}});
}
fs.writeFileSync(path.join(root,'dist/build-manifest.json'),JSON.stringify({version:1,sources},null,2)+'\n');
packageSkills(root,path.join(root,'dist/skills'));
console.log(`Built ${tools.length} commands and 2 portable skill bundles.`);
