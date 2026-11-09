import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {engineSha256} from '../../src/tools/rules/core.js';

const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
function run(command: string, args: string[] = [], cwd = product, env: NodeJS.ProcessEnv = {}) {
  const result=spawnSync(command,args,{cwd,encoding:'utf8',env:{...process.env,...env}});
  assert.ifError(result.error);
  return result;
}
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kb release with spaces '));
  const instance=path.join(root,'instance');
  fs.cpSync(path.join(product,'examples/rules'),instance,{recursive:true});
  return {root,instance,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}

test('built wrappers preserve explicit roots, reference roots, project deltas and source fingerprints',()=>{
  const f=fixture();
  try {
    const command=path.join(product,'bin/kb-rules');
    const args=['build','--root',f.instance,'--profile','profile.json','--project','demo','--reference-root','/synthetic/instance','--output','generated'];
    const result=run(command,args,os.tmpdir(),{KB_ROOT:'/foreign',MACHINE:'/foreign'});
    assert.equal(result.status,0,result.stderr);
    const manifest=JSON.parse(fs.readFileSync(path.join(f.instance,'generated/manifest.json'),'utf8'));
    assert.equal(manifest.engine_sha256,engineSha256());
    const delta=fs.readFileSync(path.join(f.instance,'generated/project/AGENTS.md'),'utf8');
    assert.match(delta,/approve-release/); assert.doesNotMatch(delta,/find-before-create/);
    assert.match(delta,/\/synthetic\/instance\/rules\/approve-release.md/);
    assert.equal(run(command,[...args,'--check']).status,0);
    const wrapper=run(path.join(product,'bin/kb-build-agents'),args.slice(1));
    assert.equal(wrapper.status,0,wrapper.stderr);
  } finally {f.cleanup();}
});

test('a relocated runtime works without node_modules, rejects missing, modified and new source files',()=>{
  const f=fixture();
  try {
    const moved=path.join(f.root,'package'); fs.mkdirSync(moved);
    for (const name of ['bin','dist','src','package.json','tsconfig.json']) fs.cpSync(path.join(product,name),path.join(moved,name),{recursive:true});
    const command=path.join(moved,'bin/kb-rules');
    const args=['validate','--root',f.instance,'--profile','profile.json'];
    assert.equal(fs.existsSync(path.join(moved,'node_modules')),false);
    let result=run(command,args); assert.equal(result.status,0,result.stderr);
    const file=path.join(moved,'src/shared/text.ts'), before=fs.readFileSync(file,'utf8');
    fs.appendFileSync(file,'\n// edited\n');
    result=run(command,args); assert.equal(result.status,1); assert.match(result.stderr,/Stale JavaScript/);
    fs.writeFileSync(file,before);
    fs.writeFileSync(path.join(moved,'src/shared/new.ts'),'export {};');
    result=run(command,args); assert.equal(result.status,1); assert.match(result.stderr,/inventory changed/);
    fs.unlinkSync(path.join(moved,'src/shared/new.ts'));
    fs.unlinkSync(path.join(moved,'dist/tools/rules/cli.js'));
    result=run(command,args); assert.equal(result.status,1); assert.match(result.stderr,/missing JavaScript build/);
  } finally {f.cleanup();}
});

test('portable skill export and every legacy wrapper work against synthetic examples',()=>{
  const f=fixture();
  try {
    const output=path.join(f.root,'skills');
    const command=path.join(product,'bin/kb-package-skills');
    const args=['--source',product,'--output',output];
    let result=run(command,args); assert.equal(result.status,0,result.stderr);
    result=run(command,[...args,'--check']); assert.equal(result.status,0,result.stderr);
    const body=fs.readFileSync(path.join(output,'kb-install/SKILL.md'),'utf8');
    assert.match(body,/references\/installation.md/);
    const legacy=path.join(f.root,'legacy'); fs.cpSync(path.join(product,'examples/legacy'),legacy,{recursive:true});
    for(const [name,flags] of [['kb-hygiene',[]],['kb-wiki-index',['--stdout']],['kb-workflows-index',['--json']],['kb-md-fields',[path.join(legacy,'workflows/demo.md')]]] as const) {
      result=run(path.join(product,'bin',name),[...flags],legacy,{KB_ROOT:legacy});
      assert.equal(result.status,0,`${name}: ${result.stderr}`);
    }
    const machine=path.join(f.root,'machine'); fs.mkdirSync(path.join(machine,'rules'),{recursive:true});
    fs.writeFileSync(path.join(machine,'rules/1.md'),'# Synthetic rule\n');
    result=run(path.join(product,'bin/kb-build-agents'),[],legacy,{KB_ROOT:legacy,MACHINE:machine});
    assert.equal(result.status,0,result.stderr); assert.ok(fs.existsSync(path.join(machine,'AGENTS.md')));
  } finally {f.cleanup();}
});

test('npm pack preserves verifiable built-in skill bundles after normalizing source permissions',()=>{
  const f=fixture();
  try {
    const copied=path.join(f.root,'source');
    fs.mkdirSync(copied);
    for(const name of ['bin','src','package.json','package-lock.json','tsconfig.json','examples','docs','README.md','AGENTS.md']) {
      fs.cpSync(path.join(product,name),path.join(copied,name),{recursive:true});
    }
    const sourceSkill=path.join(copied,'src/skills/kb-use/SKILL.md');
    const sourceMethod=path.join(copied,'src/method/knowledge-method.md');
    const sourceHelper=path.join(copied,'src/skills/kb-use/scripts/mode-probe.sh');
    fs.chmodSync(sourceSkill,0o664);
    fs.chmodSync(sourceMethod,0o664);
    fs.mkdirSync(path.dirname(sourceHelper),{recursive:true});
    fs.writeFileSync(sourceHelper,'#!/bin/sh\ntrue\n'); fs.chmodSync(sourceHelper,0o770);
    fs.symlinkSync(fs.realpathSync(path.join(product,'node_modules')),path.join(copied,'node_modules'));
    const env={npm_config_cache:process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? path.join(f.root,'npm-cache')};
    let result=run('npm',['run','build'],copied,env);
    assert.equal(result.status,0,result.stderr);
    assert.equal(fs.statSync(sourceSkill).mode & 0o777,0o664);
    assert.equal(fs.statSync(sourceMethod).mode & 0o777,0o664);
    assert.equal(fs.statSync(sourceHelper).mode & 0o777,0o770);
    result=run('npm',['pack','--ignore-scripts','--json','--pack-destination',f.root],copied,env);
    assert.equal(result.status,0,result.stderr);
    const tarball=path.join(f.root,JSON.parse(result.stdout)[0].filename);
    const extracted=path.join(f.root,'extracted'); fs.mkdirSync(extracted);
    result=run('tar',['-xzf',tarball,'-C',extracted]); assert.equal(result.status,0,result.stderr);
    const installed=path.join(extracted,'package');
    assert.equal(fs.statSync(path.join(installed,'src/skills/kb-use/SKILL.md')).mode & 0o777,0o644);
    assert.equal(fs.statSync(path.join(installed,'src/method/knowledge-method.md')).mode & 0o777,0o644);
    assert.ok(fs.statSync(path.join(installed,'src/skills/kb-use/scripts/mode-probe.sh')).mode & 0o111);
    assert.equal(fs.statSync(path.join(installed,'dist/skills/kb-use/scripts/mode-probe.sh')).mode & 0o777,0o755);
    assert.equal(fs.existsSync(path.join(installed,'node_modules')),false);
    result=run(path.join(installed,'bin/kb-package-skills'),['--source',installed,'--output',path.join(installed,'dist/skills'),'--check']);
    assert.equal(result.status,0,result.stderr);
  } finally {f.cleanup();}
});
