import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fields } from '../../src/tools/md-fields/core.js';
import { versionCompare, stripFrontmatter } from '../../src/tools/build-agents/core.js';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/tools');
const project = resolve(source, '../..');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-tools-legacy-test-'));
  const put = (path: string, body = '') => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body); return target;
  };
  put('knowledge.conf');
  const cli = (tool: string, args: string[] = [], env: NodeJS.ProcessEnv = {}, cwd = root) => {
    const script = `import { main } from ${JSON.stringify(pathToFileURL(join(source, tool, 'core.ts')).href)}; try { process.exitCode = await main(process.argv.slice(1)); } catch (error) { console.error(error.message); process.exitCode = error.exitCode ?? 1; }`;
    const result = spawnSync(process.execPath, ['--import', join(project, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '--eval', script, '--', ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, KB_ROOT: root, ...env },
    });
    assert.ifError(result.error);
    return result;
  };
  return { root, put, cli, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('md-fields retains the line parser, raw scalar spellings, aliases and delimiter ranges', () => {
  const input = `preamble\n---\nname: demo\ndescription: "words"\ntitle: old title\ntags: [one, two]\ntype: flow\nenv: '\nentities: "[a]"\nverified_on: 2026-01-01\nignored: x\n nested: x\n---\nname: body\n---\nname: later\n`;
  assert.equal(fields(input), 'name = demo\nrbdesc = words\nrbdesc = old title\ntags = one, two\nkind = flow\nentities = [a]\nverified_on = 2026-01-01\n');
  assert.equal(fields('name: body\n'), '');
  assert.equal(fields('---\nname: unclosed\n'), 'name = unclosed\n');
  assert.equal(fields('---\r\nname: "value"\r\n---\r\n'), 'name = value"\r\n');
});

test('legacy instance tools discover knowledge.conf from nested cwd and honor KB_ROOT', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, 'nested/child'), { recursive: true });
    for (const tool of ['hygiene', 'wiki-index', 'workflows-index']) {
      const result = f.cli(tool, tool === 'workflows-index' ? ['--json'] : tool === 'wiki-index' ? ['--stdout'] : [], { KB_ROOT: undefined }, join(f.root, 'nested/child'));
      assert.equal(result.status, 0, result.stderr);
    }
  } finally { f.clean(); }
});

test('md-fields missing arguments and missing files succeed without finding a root', () => {
  const f = fixture();
  try {
    for (const args of [[], ['/definitely-missing-kb-file']]) {
      const result = f.cli('md-fields', args, { KB_ROOT: undefined });
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout + result.stderr, '');
    }
  } finally { f.clean(); }
});

test('hygiene keeps exclusions, page dates, byte limits, duplicates, history and names gates', () => {
  const f = fixture();
  try {
    f.put('knowledge.conf', 'KB_PAGE_MAX=120\nKB_SEGMENT_MAX=30\nKB_SEGMENT_FENCES=4\nKB_CATALOG_KINDS=catalog\nKB_CATALOG_MAX=1000\nKB_NAME_GATE=on\nKB_NAME_LIST=blocked\nKB_STRUCTURAL_SECTIONS=See also\n');
    f.put('wiki/a/README.md', '### no date\n');
    f.put('wiki/b/README.md', '### no date\n');
    f.put('wiki/a/rules/rule.md', '### no date\n');
    f.put('wiki/dated.md', '---\ntitle: date\naudience: [agents]\n---\n# Dated\n⟨2026-01-01⟩\n### one\ncontents\n');
    f.put('wiki/a/duplicate.md', '# Duplicate\n### missing\nblocked\n');
    f.put('wiki/b/duplicate.md', '# Duplicate\n⟨2026-01-01⟩\n### See also\nlinks\n');
    f.put('wiki/catalog.md', `kind: catalog\n⟨2026-01-01⟩\n${'א'.repeat(100)}\n`);
    f.put('history/README.md', 'layer');
    f.put('history/day.md', 'entry');
    f.put('workflows/a.md', 'blocked');
    const result = f.cli('hygiene');
    assert.equal(result.status, 1, result.stderr); assert.equal(result.stdout, '');
    assert.match(result.stderr, /wiki\/a\/duplicate.md § missing — מקטע בלי ⟨תאריך⟩/);
    assert.match(result.stderr, /שם ישות כפול: duplicate/);
    assert.match(result.stderr, /history\/day.md — רשומת היסטוריה בלי/);
    assert.match(result.stderr, /history\/day.md — בלי תגית/);
    assert.match(result.stderr, /wiki\/a\/duplicate.md — שם חסום: blocked/);
    assert.match(result.stderr, /workflows\/a.md — שם חסום: blocked/);
    assert.match(result.stderr, /6 ממצאים \(כישלון\)/);
    assert.doesNotMatch(result.stderr, /catalog.md|README|dated.md|rules\/rule/);
    f.put('knowledge.conf', readFileSync(join(f.root, 'knowledge.conf'), 'utf8') + 'KB_GATE_MODE=warn\n');
    const warning = f.cli('hygiene'); assert.equal(warning.status, 0, warning.stderr); assert.match(warning.stderr, /6 ממצאים \(אזהרה\)/);
  } finally { f.clean(); }
});

test('hygiene counts UTF-8 bytes and detects long procedural segments', () => {
  const f = fixture();
  try {
    f.put('knowledge.conf', 'KB_PAGE_MAX=20\nKB_SEGMENT_MAX=20\n');
    f.put('wiki/long.md', '# Entity\n⟨2026-01-01⟩\n### task\n```\na\n```\n```\nb\n```\n');
    const result = f.cli('hygiene'); assert.equal(result.status, 1); assert.match(result.stderr, /לפצל לתת-ישויות/); assert.match(result.stderr, /2 בלוקי קוד, זה רנבוק/);
  } finally { f.clean(); }
});

test('wiki-index renders flat and tree indexes and selects only scope/always rules', () => {
  const f = fixture();
  try {
    f.put('wiki/projects/demo/demo.md');
    f.put('wiki/projects/demo/child/child.md');
    f.put('wiki/projects/demo/child/rules/nested.md', '# nested\n');
    const scoped = f.put('wiki/projects/demo/rules/scoped.md', '# scoped\n');
    const nested = join(f.root, 'wiki/projects/demo/child/rules/nested.md');
    const always = f.put('wiki/services/service/rules/always.md', 'inject: always\n');
    f.put('wiki/services/service/rules/late.md', 'א'.repeat(401) + 'inject: always\n');
    f.put('wiki/single/single.md');
    f.put('top-rules/top.md', 'inject: always\n');
    f.put('knowledge.conf', 'KB_RULES=top-rules\n');
    const flat = f.cli('wiki-index', ['--stdout']); assert.equal(flat.status, 0, flat.stderr);
    assert.equal(flat.stdout, "## ישויות ידועות\n\n*מה קיים, לא מה נכון. לפרטים: `recollq -c ~/.recoll '<שם>'`*\n\n**projects** · child · demo(1)\n**wiki** · single\n\n");
    assert.equal(existsSync(join(f.root, 'wiki-entities.md')), false);
    const rules = f.cli('wiki-index', ['--rules', 'demo']); assert.equal(rules.status, 0, rules.stderr); assert.deepEqual(new Set(rules.stdout.trim().split('\n')), new Set([scoped, nested]));
    const all = f.cli('wiki-index', ['--always', '--rules', 'demo']); assert.equal(all.stdout, `${join(f.root, 'top-rules/top.md')}\n${always}\n`);
    f.put('knowledge.conf', 'KB_RULES=top-rules\nKB_INDEX_TREE=yes\nKB_ENTITIES_OUT=entities.md\n');
    const tree = f.cli('wiki-index'); assert.equal(tree.status, 0, tree.stderr);
    assert.match(readFileSync(join(f.root, 'entities.md'), 'utf8'), /\*\*projects\*\*\n- demo\n  - child\n/);
    assert.match(tree.stderr, /3 ישויות · \d+ bytes ≈ \d+ טוקנים → entities.md/);
  } finally { f.clean(); }
});

test('workflows-index reads closed YAML mappings only, preserves schema warnings and output basename', () => {
  const f = fixture();
  try {
    f.put('knowledge.conf', 'KB_WORKFLOWS=procedures\nKB_WORKFLOWS_INDEX=unrelated/custom.md\nKB_KINDS=flow\n');
    f.put('procedures/nested/a.md', '---\nname: Demo\ndescription: |\n  first\n  second\nkind: flow\ntags: [one, true]\ndomain: test\nenv: test\ntool: test\n---\nname: body is ignored\n');
    f.put('procedures/nested/custom.md', '---\nname: excluded\n---\n');
    f.put('procedures/invalid.md', '---\n[unterminated\n---\n');
    f.put('procedures/open.md', '---\nname: unfinished\n');
    f.put('procedures/scalar.md', '---\nhello\n---\n');
    f.put('procedures/legacy.md', '---\ntitle: Legacy\ntype: runbook\ndescription: false\ntags: label\nkind: other\n---\n');
    const json = f.cli('workflows-index', ['--json']); assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), [
      { name: 'legacy', description: 'False', kind: 'other', tags: 'label', path: 'legacy.md' },
      { name: 'Demo', description: 'first\nsecond', kind: 'flow', tags: ['one', true], path: 'nested/a.md' },
    ]);
    assert.match(json.stderr, /`type:` is not indexed — use `kind:`/);
    assert.match(json.stderr, /`title:` is not indexed — use `name:`/);
    assert.match(json.stderr, /kind `other` outside \['flow'\]/);
    assert.match(json.stderr, /skipping .*invalid.md \(no valid frontmatter\)/);
    const names = f.cli('workflows-index', ['--names']); assert.equal(names.stdout, 'legacy\nDemo\n');
    const generated = f.cli('workflows-index'); assert.equal(generated.status, 0, generated.stderr);
    const index = readFileSync(join(f.root, 'procedures/custom.md'), 'utf8');
    assert.match(index, /- tags: one, True/); assert.match(index, /- path: `nested\/a.md`/);
    assert.equal(generated.stdout, `Wrote ${join(f.root, 'procedures/custom.md')} (2 workflow(s))\n`);
  } finally { f.clean(); }
});

test('workflows-index empty read-only listings succeed while generation fails', () => {
  const f = fixture();
  try {
    const json = f.cli('workflows-index', ['--json']); assert.equal(json.status, 0, json.stderr); assert.equal(json.stdout, '[]\n');
    const names = f.cli('workflows-index', ['--names']); assert.equal(names.status, 0, names.stderr); assert.equal(names.stdout, '');
    const generate = f.cli('workflows-index'); assert.equal(generate.status, 1); assert.equal(generate.stderr, `No workflows found in ${join(f.root, 'workflows')}\n`);
  } finally { f.clean(); }
});

test('workflows-index preserves Python scalar formatting for YAML floats and timestamps', () => {
  const f = fixture();
  try {
    f.put('workflows/numeric.md', '---\nname: 1.0\ndescription: [1.0, 0.00001, .nan, .inf, -0.0]\nkind: runbook\ntags: [1.0, 2, 1.0e+20]\n---\n');
    f.put('workflows/timestamp.md', '---\nname: Timestamp\ndescription: 2026-01-01T12:34:56.123456+02:00\nkind: runbook\ntags: []\n---\n');
    const json = f.cli('workflows-index', ['--json']); assert.equal(json.status, 0, json.stderr);
    assert.match(json.stdout, /"name": 1\.0,/);
    assert.match(json.stdout, /"description": "\[1\.0, 1e-05, nan, inf, -0\.0\]"/);
    assert.match(json.stdout, /"description": "2026-01-01 12:34:56\.123456\+02:00"/);
    const render = f.cli('workflows-index'); assert.equal(render.status, 0, render.stderr);
    assert.match(readFileSync(join(f.root, 'workflows/INDEX.md'), 'utf8'), /- tags: 1\.0, 2, 1e\+20/);
    assert.equal(f.cli('workflows-index', ['--names']).stdout, '1.0\nTimestamp\n');
  } finally { f.clean(); }
});

test('build-agents uses GNU version ordering and sed-compatible delimiter removal', () => {
  const names = ['a10.md', 'a2.md', 'a1.md', 'a01.md', 'a~.md', 'a.md', 'a.tar.gz', 'a1a.md', 'a1+.md'];
  assert.deepEqual(names.sort(versionCompare), ['a~.md', 'a.md', 'a.tar.gz', 'a01.md', 'a1.md', 'a1a.md', 'a1+.md', 'a2.md', 'a10.md']);
  assert.deepEqual(['.a', '.~1', '.0', '.', '..'].sort(versionCompare), ['.', '..', '.~1', '.0', '.a']);
  assert.equal(stripFrontmatter('---\na: b\n---\nbody\n---\nremove\n---\nend'), 'body\nend');
  assert.equal(stripFrontmatter('body\n---\nunclosed'), 'body\n');
});

test('build-agents preserves invocation symlink context, machine order and wiki selection', () => {
  const f = fixture();
  try {
    const entry = f.put('tools/bin/kb-build-agents', '# fixture\n');
    const sibling = f.put('tools/bin/kb-wiki-index', '# fixture\n'); chmodSync(sibling, 0o755);
    mkdirSync(join(f.root, 'instance/scripts'), { recursive: true });
    const invoked = join(f.root, 'instance/scripts/build-machine-agents.sh'); symlinkSync(entry, invoked);
    const machine = join(f.root, 'instance/memory/machines', hostname());
    f.put(`instance/memory/machines/${hostname()}/rules/10-rule.md`, '# ten');
    f.put(`instance/memory/machines/${hostname()}/rules/2-rule.md`, '# two\n');
    f.put(`instance/memory/machines/${hostname()}/rules/.hidden.md`, '# hidden\n');
    f.put('instance/knowledge/wiki-entities.md', '## Entities\n');
    f.put('instance/knowledge/knowledge.conf');
    f.put(`instance/knowledge/wiki/machines/${hostname()}/rules/host.md`, '---\ntitle: host\n---\n# host\n');
    f.put('instance/knowledge/wiki/services/service/rules/always.md', '---\ninject: always\n---\n# always\n');
    f.put('instance/knowledge/wiki/services/service/rules/unused.md', '# unrelated\n');
    const result = f.cli('build-agents', [], { KB_ENTRYPOINT: invoked, KB_ROOT: undefined, MACHINE: undefined });
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(join(machine, 'AGENTS.md'), 'utf8');
    assert.ok(content.indexOf('# two') < content.indexOf('# ten'));
    assert.match(content, /# ten\n\n---\n\n## Entities\n/);
    assert.match(content, /# host\n/); assert.match(content, /# always\n/);
    assert.doesNotMatch(content, /title:|inject:|# unrelated|# hidden/);
    assert.equal(result.stdout, `wrote ${join(machine, 'AGENTS.md')} (${content.split('\n').length - 1} lines, 2 rules + 2 wiki-rules)\n`);
  } finally { f.clean(); }
});

test('build-agents errors preserve previous output for missing and empty rules', () => {
  const f = fixture();
  try {
    const machine = join(f.root, 'machine');
    const entry = f.put('bin/kb-build-agents');
    const previous = f.put('machine/AGENTS.md', 'previous');
    let result = f.cli('build-agents', [], { MACHINE: machine, KB_ENTRYPOINT: entry });
    assert.equal(result.status, 1); assert.equal(result.stderr, `error: rules dir missing: ${join(machine, 'rules')}\n`);
    mkdirSync(join(machine, 'rules'));
    result = f.cli('build-agents', [], { MACHINE: machine, KB_ENTRYPOINT: entry });
    assert.equal(result.status, 1); assert.equal(result.stderr, "cat: '': No such file or directory\n");
    assert.equal(readFileSync(previous, 'utf8'), 'previous');
  } finally { f.clean(); }
});

test('build-agents --profile explicitly dispatches to the scoped rules engine', () => {
  const f = fixture();
  try {
    f.put('profile.json', JSON.stringify({ version: 1, sources: ['rules'], context: { machine: 'box' } }));
    f.put('rules/one.md', '---\nid: one\ntitle: One\naudience: [agents]\nscope: [machine:box]\ninjection: {session: true, auto_review: true}\nsummary: Scoped summary\nread_when: Before action\n---\nFull source body\n');
    const result = f.cli('build-agents', ['--root', f.root, '--profile', 'profile.json', '--output', 'generated'], { MACHINE: '/not-used-by-profile' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(f.root, 'generated/AGENTS.md'), 'utf8'), /Scoped summary/);
    assert.doesNotMatch(readFileSync(join(f.root, 'generated/AGENTS.md'), 'utf8'), /Full source body/);
    assert.ok(existsSync(join(f.root, 'generated/auto-review.md')));
    const checked = f.cli('build-agents', ['--root', f.root, '--profile', 'profile.json', '--output', 'generated', '--check']);
    assert.equal(checked.status, 0, checked.stderr);
  } finally { f.clean(); }
});
