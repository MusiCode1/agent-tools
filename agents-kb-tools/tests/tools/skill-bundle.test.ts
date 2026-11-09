import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {packageSkills} from '../../src/tools/skill-bundle/core.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'kb-skill-export-'));
  const source = path.join(root,'product'), output = path.join(root,'export');
  fs.mkdirSync(path.join(source,'src/method'),{recursive:true});
  fs.writeFileSync(path.join(source,'src/method/method.md'),'# Method\nShared unique information.\n');
  for (const skill of ['kb-use','kb-install']) {
    fs.mkdirSync(path.join(source,'src/skills',skill),{recursive:true});
    fs.writeFileSync(path.join(source,'src/skills',skill,'SKILL.md'),`---\nname: ${skill}\ndescription: Test\n---\nRead [method](../../method/method.md).\n`);
  }
  return {root,source,output};
}

test('export is relocatable, deterministic and check does not write',()=>{
  const f=fixture();
  try {
    packageSkills(f.source,f.output);
    const text=fs.readFileSync(path.join(f.output,'kb-use/SKILL.md'),'utf8');
    assert.match(text,/references\/method.md/);
    assert.equal(fs.readFileSync(path.join(f.output,'kb-use/references/method.md'),'utf8'),'# Method\nShared unique information.\n');
    const before=fs.statSync(path.join(f.output,'skills-manifest.json')).mtimeMs;
    packageSkills(f.source,f.output,true);
    assert.equal(fs.statSync(path.join(f.output,'skills-manifest.json')).mtimeMs,before);
    fs.renameSync(f.output,path.join(f.root,'moved'));
    assert.ok(fs.existsSync(path.join(f.root,'moved/kb-use/references/method.md')));
    fs.writeFileSync(path.join(f.source,'src/method/method.md'),'Updated\n');
    assert.throws(()=>packageSkills(f.source,path.join(f.root,'moved'),true),/stale/);
    packageSkills(f.source,path.join(f.root,'moved'));
    assert.equal(fs.readFileSync(path.join(f.root,'moved/kb-use/references/method.md'),'utf8'),'Updated\n');
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('complete skill folders preserve binary bytes, helper permissions and local edits',()=>{
  const f=fixture();
  try {
    const folder=path.join(f.source,'src/skills/kb-use');
    fs.mkdirSync(path.join(folder,'scripts'));
    fs.mkdirSync(path.join(folder,'assets'));
    const helper=path.join(folder,'scripts/helper.sh');
    const asset=path.join(folder,'assets/probe.bin');
    const bytes=Buffer.from([0,255,128,10]);
    fs.writeFileSync(helper,'#!/bin/sh\nprintf synthetic\\n\n');
    fs.chmodSync(helper,0o755);
    fs.writeFileSync(asset,bytes);
    fs.appendFileSync(path.join(folder,'SKILL.md'),'Run `scripts/helper.sh`. Read [asset](assets/probe.bin).\n');
    packageSkills(f.source,f.output);
    const exportedHelper=path.join(f.output,'kb-use/scripts/helper.sh');
    const exportedAsset=path.join(f.output,'kb-use/assets/probe.bin');
    assert.equal(fs.readFileSync(exportedHelper,'utf8'),fs.readFileSync(helper,'utf8'));
    assert.equal(fs.statSync(exportedHelper).mode & 0o777,0o755);
    assert.deepEqual(fs.readFileSync(exportedAsset),bytes);
    packageSkills(f.source,f.output,true);
    packageSkills(f.source,f.output);
    fs.chmodSync(exportedHelper,0o644);
    assert.throws(()=>packageSkills(f.source,f.output,true),/stale/);
    assert.throws(()=>packageSkills(f.source,f.output),/edited/);
    fs.chmodSync(exportedHelper,0o755);
    fs.writeFileSync(exportedAsset,Buffer.from([0,254,128,10]));
    assert.throws(()=>packageSkills(f.source,f.output),/edited/);
    assert.deepEqual(fs.readFileSync(exportedAsset),Buffer.from([0,254,128,10]));
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('broken references fail before any output and unique output edits survive',()=>{
  const f=fixture();
  try {
    const source=path.join(f.source,'src/method/method.md');
    fs.writeFileSync(source,'[broken](missing.md)');
    assert.throws(()=>packageSkills(f.source,f.output));
    assert.ok(!fs.existsSync(f.output));
    fs.writeFileSync(source,'Original');
    packageSkills(f.source,f.output);
    const file=path.join(f.output,'kb-use/references/method.md');
    fs.writeFileSync(file,'Unique local edit');
    assert.throws(()=>packageSkills(f.source,f.output),/edited/);
    assert.equal(fs.readFileSync(file,'utf8'),'Unique local edit');
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});

test('obsolete owned resources are removed, unowned files and escaping links are preserved',()=>{
  const f=fixture();
  try {
    packageSkills(f.source,f.output);
    for (const skill of ['kb-use','kb-install']) fs.writeFileSync(path.join(f.source,'src/skills',skill,'SKILL.md'),'# Simple skill\n');
    assert.throws(()=>packageSkills(f.source,f.output,true),/stale|Obsolete/);
    packageSkills(f.source,f.output);
    assert.ok(!fs.existsSync(path.join(f.output,'kb-use/references/method.md')));
    fs.writeFileSync(path.join(f.output,'unique.txt'),'unique');
    assert.throws(()=>packageSkills(f.source,f.output),/Unowned/);
    assert.equal(fs.readFileSync(path.join(f.output,'unique.txt'),'utf8'),'unique');
    fs.symlinkSync(path.join(f.root,'outside'),path.join(f.source,'src/method/escape.md'));
    fs.writeFileSync(path.join(f.root,'outside'),'private');
    fs.writeFileSync(path.join(f.source,'src/skills/kb-use/SKILL.md'),'[escape](../../method/escape.md)');
    assert.throws(()=>packageSkills(f.source,path.join(f.root,'second')),/leaves/);
  } finally {fs.rmSync(f.root,{recursive:true,force:true});}
});
