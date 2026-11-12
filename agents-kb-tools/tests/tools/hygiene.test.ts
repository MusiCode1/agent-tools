import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const core = pathToFileURL(join(project, 'src/tools/hygiene/core.ts')).href;

function fixture(conf = '') {
  const root = mkdtempSync(join(tmpdir(), 'kb-hygiene-test-'));
  const put = (path: string, body = '') => {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body);
  };
  put('knowledge.conf', conf);
  const run = (args: string[] = [], cwd = root) => {
    const script = `import { main } from ${JSON.stringify(core)}; try { process.exitCode = await main(process.argv.slice(1)); } catch (error) { console.error(error.message); process.exitCode = 1; }`;
    const result = spawnSync(process.execPath, ['--import', join(project, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '--eval', script, '--', ...args], {
      cwd, encoding: 'utf8', env: { ...process.env, KB_ROOT: root },
    });
    assert.ifError(result.error);
    return result;
  };
  return { root, put, run, clean: () => rmSync(root, { recursive: true, force: true }) };
}

const dated = (frontmatter: string, body = '') => `---\n${frontmatter}\n---\n# Page\n⟨2026-01-01⟩\n${body}`;
const findings = (stderr: string) => stderr.split('\n').filter(line => line.startsWith('  ✗ '));

test('instance gates are off by default', () => {
  const f = fixture();
  try {
    f.put('wiki/no-kind.md', dated('name: no-kind', 'record 000000018 in prose\n'));
    f.put('wiki/long-description.md', dated(`kind: entity\ndescription: ${'x'.repeat(2000)}`));
    f.put('workflows/run.md', dated(`description: ${'x'.repeat(2000)}`, 'record 000000018\n'));
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /✅ נקי/);
  } finally { f.clean(); }
});

test('verified gate needs both the mode and instance patterns', () => {
  const page = dated('kind: entity', 'record 000000018 in prose\n');
  for (const conf of ['KB_VERIFIED_MODE=on\n', 'KB_VERIFIED_MODE=on\nKB_VERIFIED_PATTERNS=\n', 'KB_VERIFIED_PATTERNS=\\b\\d{9}\\b\n']) {
    const f = fixture(conf);
    try {
      f.put('wiki/page.md', page);
      const result = f.run();
      assert.equal(result.status, 0, `${conf}: ${result.stderr}`);
    } finally { f.clean(); }
  }
});

test('verified gate flags prose identifiers and keeps its exemptions', () => {
  const f = fixture('KB_VERIFIED_MODE=on\nKB_VERIFIED_PATTERNS=\\b\\d{9}\\b\n');
  try {
    f.put('wiki/claim.md', dated('kind: entity', 'record 000000018 in prose\n'));
    f.put('wiki/fenced.md', dated('kind: entity', 'payload format:\n```json\n{"id": "000000018"}\n```\n'));
    f.put('wiki/checked.md', dated('kind: entity\nverified: 2026-01-01', 'record 000000018\n'));
    f.put('wiki/bad-date.md', dated('kind: entity\nverified: last week', 'nothing concrete\n'));
    f.put('wiki/README.md', 'record 000000018\n');
    f.put('workflows/run.md', dated('kind: runbook', 'call 000000018\n'));
    f.put('history/2026-01-01.md', '⟨2026-01-01⟩ #tag record 000000018\n');
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    const lines = findings(result.stderr);
    assert.equal(lines.length, 3, result.stderr);
    assert.match(result.stderr, /wiki\/claim\.md — טענה חיה \(000000018\) בלי `verified:`/);
    assert.match(result.stderr, /workflows\/run\.md — טענה חיה/);
    assert.match(result.stderr, /wiki\/bad-date\.md — `verified` חייב YYYY-MM-DD: last/);
    assert.doesNotMatch(result.stderr, /fenced|checked|README|history/);
  } finally { f.clean(); }
});

test('invalid verified pattern is reported, not ignored', () => {
  const f = fixture('KB_VERIFIED_MODE=on\nKB_VERIFIED_PATTERNS=(unclosed\n');
  try {
    f.put('wiki/page.md', dated('kind: entity'));
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /KB_VERIFIED_PATTERNS/);
  } finally { f.clean(); }
});

test('KB_CAPS sets the cap per kind, 0 means none, and replaces KB_CATALOG_*', () => {
  const f = fixture('KB_PAGE_MAX=200\nKB_CAPS=entity:100,flow:0,catalog:400\nKB_CATALOG_KINDS=entity\nKB_CATALOG_MAX=100000\n');
  const filler = `${'a'.repeat(300)}\n`;
  try {
    f.put('wiki/entity.md', dated('kind: entity', filler));
    f.put('wiki/flow.md', dated('kind: flow', filler.repeat(20)));
    f.put('wiki/catalog.md', dated('kind: catalog', filler));
    f.put('wiki/other.md', dated('kind: other', filler));
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /wiki\/entity\.md — 0\.3KB > 0KB/);
    assert.match(result.stderr, /wiki\/other\.md — 0\.3KB > 0KB/);
    assert.equal(findings(result.stderr).length, 2, result.stderr);
  } finally { f.clean(); }
});

test('without KB_CAPS the catalog keys keep their meaning', () => {
  const f = fixture('KB_PAGE_MAX=200\nKB_CATALOG_KINDS=catalog\nKB_CATALOG_MAX=1000\n');
  try {
    f.put('wiki/catalog.md', dated('kind: catalog', `${'a'.repeat(300)}\n`));
    f.put('wiki/entity.md', dated('kind: entity', `${'a'.repeat(300)}\n`));
    const result = f.run();
    assert.equal(findings(result.stderr).length, 1, result.stderr);
    assert.match(result.stderr, /wiki\/entity\.md — /);
  } finally { f.clean(); }
});

test('kind is read from the whole frontmatter, not a fixed window, and never from the body', () => {
  const f = fixture('KB_PAGE_MAX=200\nKB_CATALOG_KINDS=catalog\nKB_CATALOG_MAX=100000\nKB_REQUIRE_KIND=on\n');
  try {
    f.put('wiki/late-kind.md', dated(`description: ${'d'.repeat(600)}\nkind: catalog`));
    f.put('wiki/body-kind.md', '# Page\nkind: catalog\n⟨2026-01-01⟩\n');
    const result = f.run();
    assert.equal(findings(result.stderr).length, 1, result.stderr);
    assert.match(result.stderr, /wiki\/body-kind\.md — בלי `kind:`/);
  } finally { f.clean(); }
});

test('KB_REQUIRE_KIND flags wiki pages without kind and skips INDEX, README and rules', () => {
  const f = fixture('KB_REQUIRE_KIND=on\n');
  try {
    f.put('wiki/missing.md', dated('name: missing'));
    f.put('wiki/present.md', dated('kind: entity'));
    f.put('wiki/INDEX.md', '# Index\n');
    f.put('wiki/README.md', '# Layer\n');
    f.put('wiki/topic/rules/rule.md', '# Rule\n');
    f.put('workflows/run.md', dated('name: run'));
    const result = f.run();
    assert.equal(findings(result.stderr).length, 1, result.stderr);
    assert.match(result.stderr, /wiki\/missing\.md — בלי `kind:`/);
  } finally { f.clean(); }
});

test('KB_DESC_MAX counts characters and keeps its exemptions', () => {
  const f = fixture('KB_DESC_MAX=10\n');
  try {
    f.put('wiki/hebrew-ok.md', dated('kind: entity\ndescription: אבגדהוזחטי'));
    f.put('wiki/long.md', dated('kind: entity\ndescription: אבגדהוזחטיכ'));
    f.put('workflows/run.md', dated('description: an overly long line'));
    f.put('workflows/INDEX.md', dated('description: an overly long line'));
    f.put('wiki/README.md', dated('description: an overly long line'));
    f.put('wiki/topic/rules/rule.md', dated('description: an overly long line'));
    f.put('wiki/no-frontmatter.md', '# Page\n⟨2026-01-01⟩\ndescription: an overly long line\n');
    const result = f.run();
    assert.equal(findings(result.stderr).length, 2, result.stderr);
    assert.match(result.stderr, /wiki\/long\.md — `description` 11 תווים > 10/);
    assert.match(result.stderr, /workflows\/run\.md — `description` 19 תווים > 10/);
  } finally { f.clean(); }
});

test('--only narrows reporting but keeps the full scan', () => {
  const f = fixture('KB_REQUIRE_KIND=on\n');
  try {
    f.put('wiki/old.md', dated('name: old'));
    f.put('wiki/a/new.md', dated('kind: entity'));
    f.put('wiki/b/new.md', dated('kind: entity'));
    f.put('wiki/clean.md', dated('kind: entity'));

    const all = f.run();
    assert.equal(findings(all.stderr).length, 2, all.stderr);

    const clean = f.run(['--only', 'wiki/clean.md']);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stderr, /✅ נקי \(2 ממצאים קיימים מחוץ להיקף\)/);

    const collision = f.run(['--only', 'wiki/a/new.md']);
    assert.equal(collision.status, 1);
    assert.equal(findings(collision.stderr).length, 1, collision.stderr);
    assert.match(collision.stderr, /שם ישות כפול: new — /);
    assert.match(collision.stderr, /1 ממצאים \(כישלון\) · 1 נוספים מחוץ להיקף/);

    const directory = f.run(['--only', 'wiki/b']);
    assert.equal(findings(directory.stderr).length, 1, directory.stderr);

    const fromCwd = f.run(['--only', 'old.md'], join(f.root, 'wiki'));
    assert.match(fromCwd.stderr, /wiki\/old\.md — בלי `kind:`/);

    const missing = f.run(['--only', 'wiki/missing.md']);
    assert.equal(missing.status, 0, missing.stderr);

    const emptyScope = f.run(['--only']);
    assert.equal(findings(emptyScope.stderr).length, 2, emptyScope.stderr);
  } finally { f.clean(); }
});
