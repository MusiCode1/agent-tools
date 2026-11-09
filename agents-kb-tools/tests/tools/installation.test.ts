import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { parse } from 'smol-toml';
import { makePlan, Plan, put, restore, state, tomlValues } from '../../src/tools/installation/index.js';
import { installationCommand } from '../../src/tools/installation/command.js';

function fixture(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-installation-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('TOML preserves multiline values, comments, unrelated values and root precedence', () => {
  const before = '# keep\ndeveloper_instructions = """old\npolicy"""\n[auto_review]\npolicy = "base"\nextra_policy = """previous\nrule""" # policy comment\n[other]\nx = 1\n';
  const values = { project_doc_max_bytes: 131072, 'auto_review.extra_policy': 'new\nrule' };
  const after = tomlValues(before, values);
  const data = parse(after) as Record<string, any>;
  assert.equal(data.developer_instructions, 'old\npolicy');
  assert.equal(data.auto_review.policy, 'base');
  assert.equal(data.auto_review.extra_policy, 'new\nrule');
  assert.equal(data.project_doc_max_bytes, 131072);
  assert.equal(data.other.x, 1);
  assert.match(after, /# keep/);
  assert.match(after, /# policy comment/);
  assert.equal(tomlValues(after, values), after);
});

test('TOML dotted quoted project keys match existing sections semantically', () => {
  const key = 'projects."/tmp/project.with.dots".trust_level';
  const before = "# unrelated\n[projects.'/tmp/project.with.dots']\ntrust_level = 'old' # retain\nextra = 42\n[other]\nx = 1\n";
  const after = tomlValues(before, { [key]: 'trusted' });
  assert.equal((parse(after) as any).projects['/tmp/project.with.dots'].trust_level, 'trusted');
  assert.match(after, /extra = 42/);
  assert.match(after, /# retain/);
  assert.equal(tomlValues(after, { [key]: 'trusted' }), after);
  const added = tomlValues('[other]\nx = 1\n', { [key]: 'trusted' });
  assert.equal((parse(added) as any).projects['/tmp/project.with.dots'].trust_level, 'trusted');
  assert.equal((parse(added) as any).other.x, 1);
});

test('TOML scanning ignores fake assignments in multiline strings and arrays', () => {
  const before = `description = '''literal\n[auto_review]\nextra_policy = "fake"\n'''\narray = [\n  "a#b", # keep array\n  "[auto_review]",\n]\nauto_review.extra_policy = 'old' # trailing\n[unrelated]\n"key=with.dot" = "# unchanged"\n`;
  const after = tomlValues(before, { 'auto_review.extra_policy': 'new' });
  assert.equal((parse(after) as any).auto_review.extra_policy, 'new');
  assert.match(after, /extra_policy = "fake"/);
  assert.match(after, /# keep array/);
  assert.match(after, /# trailing/);
  assert.match(after, /"key=with.dot" = "# unchanged"/);
});

test('TOML updates existing quoted keys, empty sections, and files without final newline', () => {
  assert.equal((parse(tomlValues('x = 1', { y: 2 })) as any).y, 2);
  const after = tomlValues('[x]\n# comment\n[y]\nz=3', { 'x."a.b"': 'value' });
  assert.equal((parse(after) as any).x['a.b'], 'value');
  assert.equal((parse(after) as any).y.z, 3);
  const existing = tomlValues('"a.b" = "old" # comment\n', { '"a.b"': 'new' });
  assert.equal(existing, '"a.b" = "new" # comment\n');
  assert.throws(() => tomlValues('x = [', { y: 1 }));
  assert.throws(() => tomlValues('', { x: 1.5 }), /safe integer/);
  assert.throws(() => tomlValues('x = { y = "old" }', { 'x.y': 'new' }), /inline TOML/);
});

test('files, binary data, modes, links, removals and missing targets round-trip in backup v1', t => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const fresh = path.join(root, 'new');
  const removed = path.join(root, 'removed');
  const link = path.join(root, 'old-link');
  const backup = path.join(root, 'backup.json');
  fs.writeFileSync(source, 'source');
  fs.writeFileSync(target, Buffer.from([0, 255, 10, 13]));
  fs.chmodSync(target, 0o640);
  fs.writeFileSync(removed, 'remove me');
  fs.symlinkSync('missing-relative-target', link);
  const plan = makePlan([
    { kind: 'link', path: target, target: source },
    { kind: 'text', path: fresh, text: 'new 😺\n' },
    { kind: 'remove', path: removed },
    { kind: 'text', path: link, text: 'replace dangling link' },
  ]);
  const oldUmask = process.umask(0);
  try { plan.apply(backup); } finally { process.umask(oldUmask); }
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o600);
  const data = JSON.parse(fs.readFileSync(backup, 'utf8'));
  assert.equal(data.version, 1);
  assert.deepEqual(data.changes[target].before, { kind: 'file', data: 'AP8KDQ==', mode: 0o640 });
  assert.deepEqual(data.changes[target].after, { kind: 'link', target: source });
  assert.equal(fs.readlinkSync(target), source);
  assert.equal(fs.existsSync(removed), false);
  restore(backup);
  assert.deepEqual(fs.readFileSync(target), Buffer.from([0, 255, 10, 13]));
  assert.equal(fs.statSync(target).mode & 0o777, 0o640);
  assert.equal(fs.existsSync(fresh), false);
  assert.equal(fs.readFileSync(removed, 'utf8'), 'remove me');
  assert.equal(fs.readlinkSync(link), 'missing-relative-target');
});

test('existing text permissions are kept, unchanged operations produce no changes', t => {
  const root = fixture(t);
  const name = path.join(root, 'config');
  fs.writeFileSync(name, 'old');
  fs.chmodSync(name, 0o644);
  const plan = makePlan([{ kind: 'text', path: name, text: 'new' }]);
  assert.equal((plan.changes[name]!.after as { mode: number }).mode, 0o644);
  assert.equal(Object.keys(makePlan([{ kind: 'text', path: name, text: 'old' }]).changes).length, 0);
  assert.equal(Object.keys(makePlan([{ kind: 'remove', path: path.join(root, 'absent') }]).changes).length, 0);
});

test('apply and restore preflight every target before changing any file', t => {
  const root = fixture(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const backup = path.join(root, 'backup.json');
  fs.writeFileSync(a, 'old a');
  fs.writeFileSync(b, 'old b');
  const plan = makePlan([{ kind: 'text', path: a, text: 'new a' }, { kind: 'text', path: b, text: 'new b' }]);
  const serialized = JSON.parse(JSON.stringify(plan));
  fs.writeFileSync(b, 'someone else');
  assert.throws(() => Plan.from(serialized).apply(backup), /changed since planning/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'old a');
  assert.equal(fs.existsSync(backup), false);
  fs.writeFileSync(b, 'old b');
  plan.apply(backup);
  fs.writeFileSync(b, 'later edit');
  assert.throws(() => restore(backup), /changed after installation/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'new a');
  fs.writeFileSync(b, 'new b');
  restore(backup);
  assert.equal(fs.readFileSync(a, 'utf8'), 'old a');
});

test('partial apply and partial restore failures roll back successfully changed entries', t => {
  const root = fixture(t);
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  const backup = path.join(root, 'backup.json');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  const plan = makePlan([{ kind: 'text', path: a, text: 'changed' }, { kind: 'text', path: b, text: 'changed' }]);
  assert.throws(() => plan.apply(backup, (name, value) => {
    if (name === b) throw new Error('fixture failure');
    put(name, value);
  }), /fixture failure/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'a');
  assert.equal(fs.readFileSync(b, 'utf8'), 'b');
  plan.apply(path.join(root, 'backup2.json'));
  assert.throws(() => restore(path.join(root, 'backup2.json'), (name, value) => {
    if (name === a) throw new Error('fixture restore failure');
    put(name, value);
  }), /fixture restore failure/);
  assert.equal(fs.readFileSync(a, 'utf8'), 'changed');
  assert.equal(fs.readFileSync(b, 'utf8'), 'changed');
});

test('directories and missing sources are refused; duplicate canonical destinations are refused', t => {
  const root = fixture(t);
  assert.throws(() => makePlan([{ kind: 'text', path: root, text: 'no' }]), /directory/);
  assert.throws(() => makePlan([{ kind: 'remove', path: root }]), /directory/);
  assert.throws(() => makePlan([{ kind: 'link', path: path.join(root, 'a'), target: path.join(root, 'missing') }]), /Missing installation source/);
  const name = path.join(root, 'new');
  assert.throws(() => makePlan([{ kind: 'text', path: name, text: 'a' }, { kind: 'remove', path: name }, { kind: 'text', path: name, text: 'b' }]), /Duplicate/);
});

test('parent symlinks resolve while final symlinks are replaced without following them', t => {
  const root = fixture(t);
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias);
  const source = path.join(root, 'source');
  fs.writeFileSync(source, 'protected');
  fs.symlinkSync(source, path.join(real, 'config'));
  const plan = makePlan([{ kind: 'text', path: path.join(alias, 'config'), text: 'replace' },
    { kind: 'text', path: path.join(alias, 'nested', 'new'), text: 'new' }]);
  assert.deepEqual(Object.keys(plan.changes), [path.join(real, 'config'), path.join(real, 'nested', 'new')]);
  assert.equal(fs.existsSync(path.join(real, 'nested')), false);
  plan.apply(path.join(root, 'backup.json'));
  assert.equal(fs.readFileSync(source, 'utf8'), 'protected');
  assert.equal(fs.lstatSync(path.join(real, 'config')).isSymbolicLink(), false);
  restore(path.join(root, 'backup.json'));
  assert.equal(fs.readlinkSync(path.join(real, 'config')), source);
});

test('backup is exclusive and rejects existing dangling links or installation destinations', t => {
  const root = fixture(t);
  const name = path.join(root, 'new');
  const backup = path.join(root, 'backup.json');
  const plan = makePlan([{ kind: 'text', path: name, text: 'new' }]);
  fs.symlinkSync(path.join(root, 'missing'), backup);
  assert.throws(() => plan.apply(backup), /EEXIST/);
  assert.equal(state(name).kind, 'absent');
  fs.unlinkSync(backup);
  assert.throws(() => plan.apply(name), /installation destination/);
  fs.writeFileSync(backup, 'keep');
  assert.throws(() => plan.apply(backup), /EEXIST/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'keep');
});

test('legacy Python backup v1 restores correctly and malformed backups are rejected', t => {
  const root = fixture(t);
  const name = path.join(root, 'legacy');
  const backup = path.join(root, 'backup.json');
  fs.writeFileSync(name, 'installed');
  fs.chmodSync(name, 0o600);
  fs.writeFileSync(backup, JSON.stringify({ version: 1, changes: { [name]: {
    before: { kind: 'file', data: Buffer.from('legacy').toString('base64'), mode: 0o640 },
    after: { kind: 'file', data: Buffer.from('installed').toString('base64'), mode: 0o600 },
  } } }));
  restore(backup);
  assert.equal(fs.readFileSync(name, 'utf8'), 'legacy');
  assert.equal(fs.statSync(name).mode & 0o777, 0o640);
  assert.throws(() => Plan.from({ version: 2, changes: {} }), /Unsupported backup/);
  assert.throws(() => Plan.from({ version: 1, changes: { relative: {} } }), /Invalid backup/);
  assert.throws(() => Plan.from({ version: 1, changes: { [name]: { before: { kind: 'file', data: 'invalid', mode: 0o600 }, after: { kind: 'absent' } } } }), /Invalid backup/);
});

test('TOML operations produce reversible plans, including absent config files', t => {
  const root = fixture(t);
  const name = path.join(root, 'config.toml');
  const backup = path.join(root, 'backup.json');
  const plan = makePlan([{ kind: 'toml', path: name, values: { 'auto_review.extra_policy': 'rule' } }]);
  plan.apply(backup);
  assert.equal((parse(fs.readFileSync(name, 'utf8')) as any).auto_review.extra_policy, 'rule');
  assert.equal(Object.keys(makePlan([{ kind: 'toml', path: name, values: { 'auto_review.extra_policy': 'rule' } }]).changes).length, 0);
  restore(backup);
  assert.equal(fs.existsSync(name), false);
});

test('JSON commands plan/check/apply/restore/toml preserve a planned guard', t => {
  const root = fixture(t);
  const name = path.join(root, 'new');
  const backup = path.join(root, 'backup.json');
  const run = (command: string, input: unknown) => installationCommand([command], JSON.parse(JSON.stringify(input)));
  const operations = [{ kind: 'text', path: name, text: 'new' }];
  const planned = run('plan', { operations });
  assert.equal(planned.exitCode, 0);
  const plan = JSON.parse(JSON.stringify(planned.result));
  assert.equal(plan.version, 1);
  assert.equal(fs.existsSync(name), false);
  const check = run('check', { operations });
  assert.equal(check.exitCode, 1);
  assert.equal((check.result as any).version, 1);
  fs.writeFileSync(name, 'edit');
  assert.throws(() => run('apply', { plan, backup }), /changed since planning/);
  fs.unlinkSync(name);
  const applied = run('apply', { plan, backup });
  assert.equal(applied.exitCode, 0);
  assert.equal((applied.result as any).version, 1);
  assert.equal(run('check', { operations }).exitCode, 0);
  const restored = run('restore', { backup });
  assert.equal(restored.exitCode, 0);
  assert.deepEqual(restored.result, { restored: true });
  assert.equal(fs.existsSync(name), false);
  const toml = run('toml', { text: '# keep\n', values: { x: 2 } });
  assert.equal(toml.exitCode, 0);
  assert.equal((parse((toml.result as any).text) as any).x, 2);
  assert.throws(() => run('apply', { operations }), /requires backup/);
  assert.throws(() => run('restore', {}), /requires backup/);
  assert.throws(() => run('unknown', {}), /Usage/);
  assert.throws(() => run('plan', null), /JSON object/);
});
