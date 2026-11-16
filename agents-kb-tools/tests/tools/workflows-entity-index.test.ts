import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const core = pathToFileURL(join(project, 'src/tools/workflows-index/core.ts')).href;

function fixture(conf: string) {
  const root = mkdtempSync(join(tmpdir(), 'kb-entity-workflows-test-'));
  const put = (path: string, body = '') => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body);
  };
  put('knowledge.conf', conf);
  const run = (args: string[] = []) => {
    const script = `import { main } from ${JSON.stringify(core)}; try { process.exitCode = await main(process.argv.slice(1)); } catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const result = spawnSync(process.execPath, ['--import', join(project, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '--eval', script, '--', ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, KB_ROOT: root },
    });
    assert.ifError(result.error);
    return result;
  };
  return { root, put, run, clean: () => rmSync(root, { recursive: true, force: true }) };
}

const workflow = (name: string, entities?: string) =>
  `---\nname: ${name}\ndescription: d\nkind: runbook\ntags: [t]\n${entities ? `entities: ${entities}\n` : ''}domain: x\nenv: x\ntool: x\n---\nbody\n`;

test('entity index is off by default', () => {
  const f = fixture('');
  try {
    f.put('workflows/a.md', workflow('A', '[alpha]'));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(f.root, 'workflows/BY-ENTITY.md')), false);
  } finally { f.clean(); }
});

test('entity index groups workflows by entity, links entity pages, and keeps --json unchanged', () => {
  const f = fixture('KB_ENTITY_WORKFLOWS_OUT=workflows/BY-ENTITY.md\n');
  try {
    f.put('wiki/services/alpha/alpha.md', '---\nkind: entity\n---\n# alpha\n');
    f.put('workflows/runbooks/a.md', workflow('A', '[alpha, beta]'));
    f.put('workflows/flows/b.md', workflow('B [x]', 'alpha'));
    f.put('workflows/runbooks/c.md', workflow('C'));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /BY-ENTITY/);
    const out = readFileSync(join(f.root, 'workflows/BY-ENTITY.md'), 'utf8');
    assert.match(out, /^# Workflows by entity\n/);
    assert.match(out, /## alpha\n\nEntity page: \[alpha\]\(<\.\.\/wiki\/services\/alpha\/alpha\.md>\)\n\n- \[B \[x\\\]\]\(<flows\/b\.md>\) — `runbook`\n- \[A\]\(<runbooks\/a\.md>\) — `runbook`\n/);
    assert.match(out, /## beta\n\n- \[A\]\(<runbooks\/a\.md>\)/);
    assert.ok(out.trimEnd().endsWith('## _(no entity)_\n\n- [C](<runbooks/c.md>) — `runbook`'), out);
    const again = f.run();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(join(f.root, 'workflows/BY-ENTITY.md'), 'utf8'), out);
    const json = f.run(['--json']);
    assert.equal(json.status, 0, json.stderr);
    for (const item of JSON.parse(json.stdout)) assert.deepEqual(Object.keys(item), ['name', 'description', 'kind', 'tags', 'path']);
  } finally { f.clean(); }
});
