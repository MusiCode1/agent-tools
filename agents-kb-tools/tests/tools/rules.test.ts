import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { build, historical, load, note, render, RuleError, scopesFor, select, triggerRegistry, validate } from '../../src/tools/rules/core.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'כללים עם רווחים '));
  const config: Record<string, any> = { version: 1, sources: ['rules'], machine_aliases: { oldbox: 'box' }, context: { machine: 'box' }, budgets: { session: { bytes: 30000 }, auto_review: { chars: 12000 } } };
  const profile = join(root, 'profile.json');
  const save = () => writeFileSync(profile, JSON.stringify(config));
  const rule = (rel: string, id: string, scope: string[], session: unknown, auto_review: unknown, extra: Record<string, unknown> = {}) => {
    const meta = { id, title: id, audience: ['agents'], scope, injection: { session, auto_review }, summary: 'תמצית ' + id, read_when: 'לפני הפעולה', ...extra };
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '---\n' + stringify(meta, { version: '1.1' }) + '---\n\nUNIQUE_FULL_BODY_' + id + '\n');
    return path;
  };
  save();
  rule('rules/one.md', 'one', ['machine:box'], true, true, { summary: 'אישור קיים תקף בגבולותיו', review_summary: 'שמור היתר קודם; מיזוג נדרש לאישור ייעודי' });
  rule('rules/two.md', 'two', ['project:demo'], true, false);
  rule('rules/service.md', 'service', ['service:mail'], true, true);
  rule('rules/empty.md', 'empty', [], true, true);
  rule('rules/always.md', 'always', [], true, false, { inject: 'always' });
  rule('rules/off.md', 'off', ['machine:box'], false, false, { inject: false });
  return { root, profile, config, save, rule, loaded: () => load(root, profile), clean: () => rmSync(root, { recursive: true, force: true }) };
}
const ids = (rules: ReturnType<typeof load>[1]) => rules.map(rule => rule.meta.id).sort();

test('scopes, machine aliases, services, always and independent targets', t => {
  const f = fixture(); t.after(f.clean);
  const [c, rs] = f.loaded(), scopes = scopesFor(c, 'oldbox', 'demo', []);
  assert.deepEqual(ids(select(c, rs, scopes, 'session')), ['always', 'one', 'two']);
  assert.deepEqual(ids(select(c, rs, scopes, 'auto_review')), ['one']);
  assert.ok(ids(select(c, rs, scopesFor(c, 'box', '', ['mail']), 'auto_review')).includes('service'));
  f.rule('rules/alias-scope.md', 'alias-scope', ['machine:oldbox'], true, true);
  assert.ok(ids(select(...f.loaded(), new Set(['machine:box']), 'session')).includes('alias-scope'));
});

test('review preserves authorization conditions, references, and never falls back to body', t => {
  const f = fixture(); t.after(f.clean);
  const [c, rs] = f.loaded(), [text] = render(f.root, c, rs, new Set(['machine:box']), 'auto_review');
  assert.match(text, /שמור היתר קודם/u); assert.match(text, /מיזוג נדרש לאישור ייעודי/u);
  assert.ok(text.includes(join(f.root, 'rules/one.md')));
  assert.doesNotMatch(text, /UNIQUE_FULL_BODY|## two/u);
  assert.doesNotMatch(render(f.root, c, rs, new Set(['machine:box']), 'session', { references: false })[0], /מקור:/u);
});

test('required metadata, duplicate IDs, invalid typed scopes and booleans are rejected', t => {
  const f = fixture(); t.after(f.clean);
  const path = join(f.root, 'rules/one.md'), original = readFileSync(path, 'utf8');
  for (const key of ['summary', 'injection', 'scope', 'read_when']) {
    const [meta, body] = note(path); delete meta[key];
    writeFileSync(path, '---\n' + stringify(meta, { version: '1.1' }) + '---\n' + body);
    assert.throws(f.loaded, RuleError); writeFileSync(path, original);
  }
  const [meta] = note(path);
  for (const extra of [{ id: 'one\n' }, { scope: ['untyped'] }, { scope: ['machine:a/b'] }, { scope: ['machine:box\n'] }, { scope: ['machine:box\x85'] }, { order: true }, { order: 1.5 }, { injection: { session: 'true', auto_review: false } }, { injection: { session: true, auto_review: false, extra: false } }, { inject: false }, { inject: true }, { review_summary: '' }, { audience: ['agents', 'human'] }]) assert.throws(() => validate({ ...meta, ...extra }, 'one.md'), RuleError);
  f.rule('rules/duplicate.md', 'one', [], false, false);
  assert.throws(f.loaded, /id כפול/u);
});

test('historical notes are excluded before validation and symlink aliases are not duplicate sources', t => {
  const f = fixture(); t.after(f.clean);
  f.rule('rules/היסטוריה/old.md', 'one', [], true, true, { inject: 'always' });
  f.rule('rules/metadata.md', 'one', [], true, true, { lifecycle: 'history', inject: 'always' });
  mkdirSync(join(f.root, 'rules/archive'), { recursive: true });
  writeFileSync(join(f.root, 'rules/archive/invalid.md'), '---\nstatus: historical\n---\nold');
  symlinkSync('one.md', join(f.root, 'rules/alias.md'));
  symlinkSync('rules', join(f.root, 'rules-alias'));
  f.config.sources.push('rules', 'rules-alias'); f.save();
  assert.equal(f.loaded()[1].length, 6);
  for (const key of ['kind', 'type', 'status', 'lifecycle', 'content_status']) assert.equal(historical('x.md', { [key]: 'superseded' }), true);
});

test('source/output escape symlinks and final output symlinks fail without writing', t => {
  const f = fixture(); t.after(f.clean);
  const outside = mkdtempSync(join(tmpdir(), 'rules-outside-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  const escape = join(f.root, 'rules/escape.md'); symlinkSync(join(outside, 'private.md'), escape);
  assert.throws(f.loaded); rmSync(escape);
  const [c, rs] = f.loaded(); symlinkSync(outside, join(f.root, 'out'));
  assert.throws(() => build(f.root, join(f.root, 'out'), c, rs, new Set(['machine:box'])));
  assert.deepEqual(readdirSync(outside), []);
  mkdirSync(join(f.root, 'generated')); symlinkSync(join(f.root, 'rules/one.md'), join(f.root, 'generated/AGENTS.md'));
  assert.throws(() => build(f.root, join(f.root, 'generated'), c, rs, new Set(['machine:box'])));
  assert.equal(existsSync(join(f.root, 'generated/auto-review.md')), false);
});

test('directory symlinks are not traversed and overlapping sources are deduplicated', t => {
  const f = fixture(); t.after(f.clean);
  const outside = mkdtempSync(join(tmpdir(), 'rules-directory-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'invalid.md'), 'not a rule');
  symlinkSync(outside, join(f.root, 'rules/external-directory'));
  f.config.sources.push('rules/one.md'); f.save();
  assert.equal(f.loaded()[1].length, 6);
});

test('budget failure is atomic before all writes, hook never truncates, Unicode counts code points', t => {
  const f = fixture(); t.after(f.clean);
  const [c, rs] = f.loaded(); c.budgets.auto_review.chars = 1;
  assert.throws(() => build(f.root, join(f.root, 'generated'), c, rs, new Set(['machine:box'])), /אין חיתוך/u);
  assert.equal(existsSync(join(f.root, 'generated')), false);
  c.budgets.auto_review.chars = 30000;
  rs[0].meta.summary = '😀'.repeat(10000);
  assert.throws(() => render(f.root, c, rs, new Set(['machine:box']), 'session', { hook: true }), /אין חיתוך/u);
  rs[0].meta.summary = '😀';
  const [text] = render(f.root, c, rs, new Set(['machine:box']), 'session');
  c.budgets.session = { chars: Array.from(text).length, bytes: Buffer.byteLength(text) };
  assert.equal(render(f.root, c, rs, new Set(['machine:box']), 'session')[0], text);
  c.budgets.session.chars--;
  assert.throws(() => render(f.root, c, rs, new Set(['machine:box']), 'session'), /chars/u);
});

test('reference root makes isolated snapshot build check reproducible', t => {
  const f = fixture(); t.after(f.clean);
  const [c, rs] = f.loaded(), canonical = '/canonical/instance';
  build(f.root, join(f.root, 'generated'), c, rs, new Set(['machine:box']), false, canonical);
  assert.ok(readFileSync(join(f.root, 'generated/AGENTS.md'), 'utf8').includes(canonical + '/rules/one.md'));
  const snapshot = mkdtempSync(join(tmpdir(), 'rules-snapshot-')); t.after(() => rmSync(snapshot, { recursive: true, force: true }));
  cpSync(f.root, snapshot, { recursive: true });
  const [cc, cr] = load(snapshot, join(snapshot, 'profile.json'));
  build(snapshot, join(snapshot, 'generated'), cc, cr, new Set(['machine:box']), true, canonical);
});

test('check reads only, detects stale or absent products, and manifest records selections and sizes', t => {
  const f = fixture(); t.after(f.clean);
  const [c, rs] = f.loaded(), output = join(f.root, 'generated'), scopes = new Set(['machine:box']);
  assert.throws(() => build(f.root, output, c, rs, scopes, true)); assert.equal(existsSync(output), false);
  const manifest = build(f.root, output, c, rs, scopes);
  const before = readFileSync(join(output, 'manifest.json')), mtime = statSync(join(output, 'manifest.json')).mtimeMs;
  build(f.root, output, c, rs, scopes, true);
  assert.deepEqual(readFileSync(join(output, 'manifest.json')), before); assert.equal(statSync(join(output, 'manifest.json')).mtimeMs, mtime);
  assert.deepEqual(manifest.rules.filter((r: any) => r.selected.auto_review).map((r: any) => r.id), ['one']);
  assert.match(manifest.engine_sha256, /^[a-f0-9]{64}$/u);
  for (const [name, size] of Object.entries(manifest.sizes)) {
    const value = readFileSync(join(output, name), 'utf8');
    assert.deepEqual(size, { chars: [...value].length, bytes: Buffer.byteLength(value) });
  }
  writeFileSync(join(output, 'AGENTS.md'), 'stale');
  assert.throws(() => build(f.root, output, c, rs, scopes, true), /תוצר חסר\/ישן/u);
  assert.equal(readFileSync(join(output, 'AGENTS.md'), 'utf8'), 'stale');
});

test('profile fields reject wrong types, unknown budgets, empty/absolute/escaping sources', t => {
  const f = fixture(); t.after(f.clean);
  for (const [key, value] of [['version', true], ['sources', []], ['sources', ['/outside']], ['sources', ['../outside']], ['sources', ['']], ['machine_aliases', []], ['machine_aliases', null], ['machine_aliases', { 'a/b': 'c' }], ['budgets', null], ['budgets', { session: { bytes: '3000' } }], ['budgets', { wrong: {} }], ['context', null], ['context', { machine: null }], ['context', { machine: [] }], ['context', []]] as const) {
    const original = f.config[key]; f.config[key] = value; f.save(); assert.throws(f.loaded); f.config[key] = original; f.save();
  }
  f.rule('rules/typed.md', 'typed', [], 'true', false); assert.throws(f.loaded, /בוליאניים/u);
});

test('native adapters, project delta and trigger registry preserve fields and source summaries', t => {
  const f = fixture(); t.after(f.clean);
  const [c, rs] = f.loaded(), output = join(f.root, 'generated');
  writeFileSync(join(f.root, 'registry.json'), JSON.stringify({ rules: [{ id: 'one', trigger: 'git', paths: ['one.md'], text: 'STALE' }] }));
  c.trigger_registry = 'registry.json';
  build(f.root, output, c, rs, new Set(['machine:box', 'project:demo']));
  const review = readFileSync(join(output, 'auto-review.md'), 'utf8');
  assert.equal(JSON.parse(readFileSync(join(output, 'codex-auto-review.toml'), 'utf8').split('extra_policy = ')[1]), review);
  assert.deepEqual(readFileSync(join(output, 'AGENTS.md')), readFileSync(join(output, 'claude/rules/session.md')));
  assert.ok(readFileSync(join(output, 'cursor/machine-agents.mdc'), 'utf8').startsWith('---\nalwaysApply: true'));
  const entry = JSON.parse(readFileSync(join(output, 'rule-triggers.json'), 'utf8')).rules[0];
  assert.doesNotMatch(entry.text, /STALE/u); assert.match(entry.text, /אישור קיים/u); assert.deepEqual(entry.paths, ['one.md']);
  const delta = readFileSync(join(output, 'project/AGENTS.md'), 'utf8');
  assert.match(delta, /## two/u); assert.doesNotMatch(delta, /## one|## always/u);
  assert.match(triggerRegistry(f.root, 'registry.json', rs, '/canonical').rules[0].text, /\/canonical\/rules\/one.md/u);
});

test('YAML 1.1 booleans, merge keys, quoted strings, Unicode and dates follow safe-load semantics', t => {
  const f = fixture(); t.after(f.clean);
  const path = f.rule('rules/typed.md', 'typed', ['machine:box'], true, false);
  let text = readFileSync(path, 'utf8').replace('session: true', 'session: YES').replace('auto_review: false', 'auto_review: OFF');
  text = text.replace('summary: תמצית typed', 'defaults: &defaults\n  summary: "😀"\n<<: *defaults');
  writeFileSync(path, text);
  const [meta] = note(path); assert.equal(meta.injection.session, true); assert.equal(meta.injection.auto_review, false); assert.equal(meta.summary, '😀');
  f.loaded();
  writeFileSync(path, text.replace('title: typed', 'title: 2026-01-01'));
  assert.throws(f.loaded, /title\/audience/u);
});

test('lexical YAML/JSON floats fail integer-only fields, including integral float values', t => {
  const f = fixture(); t.after(f.clean);
  const rule = f.rule('rules/float.md', 'float', [], false, false);
  const base = readFileSync(rule, 'utf8');
  for (const fields of ['order: 1.0', 'order: 1:20.0', 'defaults: &defaults {order: 1.0}\n<<: *defaults']) {
    writeFileSync(rule,base.replace('title: float',`title: float\n${fields}`));
    assert.throws(f.loaded,/order/u);
  }
  writeFileSync(rule,base.replace('title: float','title: float\ndefaults: &defaults {order: 1.0}\n<<: *defaults\norder: 1'));
  assert.doesNotThrow(f.loaded);
  rmSync(rule);
  const original = readFileSync(f.profile, 'utf8');
  writeFileSync(f.profile, original.replace('"version":1', '"version":1.0'));
  assert.throws(f.loaded, /גרסת/u);
  writeFileSync(f.profile, original.replace('"bytes":30000', '"bytes":30000.0'));
  assert.throws(f.loaded, /תקציב/u);
});

test('CLI commands use explicit root despite foreign cwd/env, report operation errors and usage errors', t => {
  const f = fixture(); t.after(f.clean);
  const tool = new URL('../../src/tools/rules/core.ts', import.meta.url).href;
  const tsx = resolve(fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url)));
  const harness = `import { main } from ${JSON.stringify(tool)}; try { process.exitCode = main(process.argv.slice(1)); } catch (error) { console.error('kb-rules: ' + error.message); process.exitCode = error.exitCode ?? 1; }`;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', tsx, '--input-type=module', '--eval', harness, '--', ...args], { cwd: tmpdir(), env: { ...process.env, KB_ROOT: '/no/such/instance', MACHINE: '/foreign' }, encoding: 'utf8' });
  const args = ['--root', f.root, '--profile', 'profile.json'];
  const rendered = run('render', ...args, '--machine', 'oldbox'); assert.equal(rendered.status, 0, rendered.stderr); assert.match(rendered.stdout, /## one/u); assert.doesNotMatch(rendered.stdout, /UNIQUE_FULL_BODY/u);
  assert.equal(run('validate', ...args).stdout, 'אומתו 6 כללים\n');
  assert.equal(run('list', ...args, '--target', 'auto_review').stdout, 'rules/one.md\n');
  assert.equal(run('build', ...args, '--output', 'generated').status, 0);
  assert.equal(run('build', ...args, '--output', 'generated', '--check').status, 0);
  const error = run('build', ...args); assert.equal(error.status, 1); assert.equal(error.stdout, ''); assert.match(error.stderr, /kb-rules: .*--output/u);
  assert.equal(run('render', '--root', f.root).status, 2);
  assert.equal(run('render', ...args, '--target', 'wrong').status, 2);
  assert.equal(run('--help').status, 0);
});
