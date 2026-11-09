/** Rule selection and generated summaries. Never installs or edits consumer configuration. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, atomicWrite, resolveExistingParents } from '../../shared/fs.js';
import { parseYaml, isIntegerField } from '../../shared/yaml.js';
import { parseJson } from '../../shared/json.js';
import { charLength, compareCodePoints } from '../../shared/text.js';

export class RuleError extends Error {}
export type Target = 'session' | 'auto_review';
type ObjectValue = Record<string, any>;
export interface Rule { path: string; meta: ObjectValue; body: string; sha256: string }
export type Config = ObjectValue;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sorted = (values: Iterable<string>) => [...values].sort(compareCodePoints);
// Python str.strip/re \s include NEL and control separators, but exclude BOM.
const whitespace = '\\t\\n\\v\\f\\r\\x1c-\\x1f\\x85 \\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const trim = (value: string) => value.replace(new RegExp(`^[${whitespace}]+|[${whitespace}]+$(?![\\s\\S])`, 'gu'), '');
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!trim(value);
const token = new RegExp(`^[^/\\\\:${whitespace}]+$(?![\\s\\S])`, 'u');
const scopePattern = new RegExp(`^(?:machine|project|service):[^/\\\\:${whitespace}]+$(?![\\s\\S])`, 'u');
const pyPath = (root: string, child: string) => isAbsolute(child) ? child : join(root, child);
const machineName = (aliases: ObjectValue, name: string) => Object.hasOwn(aliases, name) ? aliases[name] : name;
const textFile = (path: string) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).replace(/\r\n?/g, '\n');

export function note(path: string): [ObjectValue, string] {
  const text = textFile(path);
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u.exec(text);
  if (!match) throw new RuleError(`חסר frontmatter: ${path}`);
  const meta = parseYaml(match[1]);
  if (!object(meta)) throw new RuleError(`frontmatter אינו mapping: ${path}`);
  return [meta, text.slice(match[0].length)];
}

export function historical(path: string, meta: ObjectValue): boolean {
  return path.split(sep).some(part => ['history', 'archive', 'היסטוריה'].includes(part)) ||
    ['kind', 'type', 'status', 'lifecycle', 'content_status'].some(key =>
      typeof meta[key] === 'string' && ['history', 'historical', 'archived', 'superseded', 'historical-source'].includes(meta[key]));
}

export function validate(meta: ObjectValue, path: string): void {
  if (typeof meta.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$(?![\s\S])/u.test(meta.id)) throw new RuleError(`id חסר/שגוי: ${path}`);
  if (!nonempty(meta.title) || !Array.isArray(meta.audience) || meta.audience.length !== 1 || meta.audience[0] !== 'agents') throw new RuleError(`title/audience חסר/שגוי: ${path}`);
  const flags = meta.injection;
  if (!object(flags) || sorted(Object.keys(flags)).join(',') !== 'auto_review,session' || Object.values(flags).some(v => typeof v !== 'boolean')) throw new RuleError(`נדרשים שני דגלי injection בוליאניים מפורשים: ${path}`);
  for (const key of ['summary', 'read_when']) if (!nonempty(meta[key])) throw new RuleError(`${key} חסר/ריק: ${path}`);
  if ('review_summary' in meta && !nonempty(meta.review_summary)) throw new RuleError(`review_summary חסר/שגוי: ${path}`);
  if ('inject' in meta && meta.inject !== false && meta.inject !== 'always') throw new RuleError(`inject חייב להיות always או false או חסר: ${path}`);
  if (meta.inject === false && Object.values(flags).some(Boolean)) throw new RuleError(`inject:false סותר יעד פעיל: ${path}`);
  if (!Array.isArray(meta.scope)) throw new RuleError(`scope חייב להיות רשימה מפורשת: ${path}`);
  if ('order' in meta && !isIntegerField(meta, 'order')) throw new RuleError(`order חייב להיות מספר שלם: ${path}`);
  for (const scope of meta.scope) if (typeof scope !== 'string' || !scopePattern.test(scope)) throw new RuleError(`scope אינו typed: ${path}: ${scope}`);
}

export function load(root: string, profile: string): [Config, Rule[]] {
  root = resolveExistingParents(root);
  const config = parseJson(textFile(inside(root, profile)));
  if (!object(config) || !isIntegerField(config, 'version') || config.version !== 1 || !Array.isArray(config.sources) || !config.sources.length) throw new RuleError('גרסת פרופיל או sources אינם תקינים');
  const aliases = 'machine_aliases' in config ? config.machine_aliases : {};
  if (!object(aliases) || Object.entries(aliases).some(([k, v]) => !token.test(k) || typeof v !== 'string' || !token.test(v))) throw new RuleError('machine_aliases אינו מיפוי שמות תקין');
  const context = 'context' in config ? config.context : {};
  if (!object(context) || typeof ('machine' in context ? context.machine : '') !== 'string') throw new RuleError('context.machine אינו שם מכונה');
  const budgets = 'budgets' in config ? config.budgets : {};
  if (!object(budgets) || Object.keys(budgets).some(k => !['session', 'auto_review'].includes(k))) throw new RuleError('budgets מכיל יעד לא מוכר');
  for (const [target, limits] of Object.entries(budgets)) {
    if (!object(limits) || Object.keys(limits).some(k => !['chars', 'bytes'].includes(k)) || Object.keys(limits).some(key => !isIntegerField(limits, key) || limits[key] <= 0)) throw new RuleError(`תקציב לא תקין: ${target}`);
  }
  const rules: Rule[] = [], seenPaths = new Set<string>(), seenIds = new Map<string, string>();
  for (const source of config.sources) {
    if (typeof source !== 'string' || !source || isAbsolute(source)) throw new RuleError('מקור חייב להיות נתיב יחסי לא ריק');
    const base = inside(root, join(root, source));
    if (!existsSync(base)) throw new RuleError(`מקור חסר: ${source}`);
    const candidates: string[] = [];
    if (statSync(base).isFile()) candidates.push(base);
    if (statSync(base).isDirectory()) {
      const walk = (directory: string) => {
        const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareCodePoints(a.name, b.name));
        for (const entry of entries) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            if (!['.git', '__pycache__'].includes(entry.name)) walk(path);
          } else if (!entry.isSymbolicLink() || !existsSync(path) || !statSync(path).isDirectory()) {
            if (entry.name.endsWith('.md')) candidates.push(path);
          }
        }
      };
      walk(base);
    }
    for (const path of sorted(candidates)) {
      const resolved = inside(root, path);
      if (lstatSync(path).isSymbolicLink() || seenPaths.has(resolved)) continue;
      seenPaths.add(resolved);
      const [meta, body] = note(path), rel = relative(root, path).split(sep).join('/');
      if (historical(rel, meta)) continue;
      validate(meta, rel);
      if (seenIds.has(meta.id)) throw new RuleError(`id כפול: ${meta.id}: ${seenIds.get(meta.id)} / ${path}`);
      seenIds.set(meta.id, path);
      rules.push({ path: rel, meta, body, sha256: hash(readFileSync(path)) });
    }
  }
  return [config, rules.sort((a, b) => (a.meta.order ?? 100) - (b.meta.order ?? 100) || compareCodePoints(a.meta.id, b.meta.id))];
}

export function scopesFor(config: Config, machine: string, project: string, services: string[]): Set<string> {
  const aliases = config.machine_aliases ?? {};
  return new Set([...(machine ? [`machine:${machineName(aliases, machine)}`] : []), ...(project ? [`project:${project}`] : []), ...services.map(s => `service:${s}`)]);
}

export function select(config: Config, rules: Rule[], scopes: Set<string>, target: Target): Rule[] {
  const aliases = config.machine_aliases ?? {};
  return rules.filter(({ meta: m }) => m.injection[target] && m.inject !== false && (m.inject === 'always' || m.scope.some((scope: string) => scopes.has(scope.startsWith('machine:') ? `machine:${machineName(aliases, scope.slice(8))}` : scope))));
}

export function render(root: string, config: Config, rules: Rule[], scopes: Set<string>, target: Target, options: { references?: boolean; hook?: boolean } = {}): [string, Rule[]] {
  const selected = select(config, rules, scopes, target);
  const lines = ['# ' + (target === 'session' ? 'הנחיות הסשן' : 'מדיניות נוספת למבקר ההרשאות'), ''];
  if (target === 'auto_review') lines.push('בדוק את הפעולה שהוגשה ואת אישורי המשתמש והראיות הזמינים. שמור היתרים קודמים בגבולותיהם; החלטת המבקר אינה מחליפה אישור משתמש שהכלל דורש במפורש. אם חסרה ראיה נדרשת, אין להסיק אישור מטענת המבצע.', '');
  for (const rule of selected) {
    const m = rule.meta, summary = target === 'auto_review' ? m.review_summary ?? m.summary : m.summary;
    lines.push(`## ${m.id} — ${m.title}`, trim(summary));
    if (options.references !== false) lines.push(`קריאה מלאה: ${m.read_when}. מקור: \`${join(root, rule.path)}\`.`);
    lines.push('');
  }
  const text = lines.join('\n').replace(new RegExp(`[${whitespace}]+$(?![\\s\\S])`, 'u'), '') + '\n';
  const limits = { ...(config.budgets?.[target] ?? {}) };
  if (options.hook) limits.chars = Math.min(limits.chars ?? 9000, 9000);
  for (const [unit, length] of [['chars', charLength(text)], ['bytes', Buffer.byteLength(text)]] as const) {
    const limit = limits[unit];
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0)) throw new RuleError(`תקציב ${unit} שגוי`);
    if (limit !== undefined && length > limit) throw new RuleError(`חריגה מתקציב ${target}: ${length} ${unit} > ${limit}; אין חיתוך אוטומטי`);
  }
  return [text, selected];
}

export function triggerRegistry(root: string, registryPath: string, rules: Rule[], referenceRoot = root): ObjectValue {
  const registry = JSON.parse(textFile(inside(root, pyPath(root, registryPath))));
  if (!object(registry) || !Array.isArray(registry.rules)) throw new RuleError('מרשם טריגרים אינו מכיל rules כרשימה');
  const byId = new Map(rules.map(rule => [rule.meta.id, rule]));
  for (const entry of registry.rules) {
    const source = byId.get(entry.id);
    if (!source) throw new RuleError(`כלל חסר במרשם: ${entry.id}`);
    entry.text = source.meta.summary + '\nפירוט: ' + join(referenceRoot, source.path);
  }
  return registry;
}

/** Labels and bytes, not absolute checkout paths, form the source fingerprint. */
export function engineSha256(): string {
  const current = fileURLToPath(import.meta.url), dir = dirname(current);
  // Sources ship with the release: the same engine fingerprint applies to
  // source tests, compiled commands and a relocated installation package.
  const sourceDir = join(dir, '../../../src/tools/rules');
  const files = [join(sourceDir, 'core.ts'), join(sourceDir, 'cli.ts'),
    ...['fs.ts', 'text.ts', 'yaml.ts', 'json.ts', 'cli.ts'].map(name => join(sourceDir, '../../shared', name)),
    join(sourceDir,'../../build.ts'),join(sourceDir,'../../../package.json')];
  const digest = createHash('sha256');
  for (const file of files.sort((a, b) => compareCodePoints(relative(sourceDir, a), relative(sourceDir, b)))) {
    digest.update(relative(sourceDir, file).split(sep).join('/') + '\0');
    digest.update(readFileSync(file));
    digest.update('\0');
  }
  return digest.digest('hex');
}

export function build(root: string, output: string, config: Config, rules: Rule[], scopes: Set<string>, check = false, referenceRoot?: string): ObjectValue {
  output = inside(root, output);
  const references = resolveExistingParents(referenceRoot || root);
  const [session, sr] = render(references, config, rules, scopes, 'session');
  const [review, rr] = render(references, config, rules, scopes, 'auto_review');
  const artifacts: Record<string, string> = {
    'AGENTS.md': session, 'auto-review.md': review,
    'codex-auto-review.toml': '[auto_review]\nextra_policy = ' + JSON.stringify(review) + '\n',
    'claude/rules/session.md': session,
    'cursor/machine-agents.mdc': '---\nalwaysApply: true\n---\n\n' + session,
  };
  if ([...scopes].some(scope => scope.startsWith('project:'))) {
    const baseScopes = new Set([...scopes].filter(scope => !scope.startsWith('project:')));
    const baseIds = new Set(select(config, rules, baseScopes, 'session').map(r => r.meta.id));
    const [delta] = render(references, config, rules.filter(r => !baseIds.has(r.meta.id)), scopes, 'session');
    artifacts['project/AGENTS.md'] = delta;
    artifacts['project/claude-rules/session.md'] = delta;
    artifacts['project/cursor-rules/project-agents.mdc'] = '---\nalwaysApply: true\n---\n\n' + delta;
  }
  if (config.trigger_registry) artifacts['rule-triggers.json'] = JSON.stringify(triggerRegistry(root, config.trigger_registry, rules, references), null, 2) + '\n';
  const manifest = {
    version: 1, scopes: sorted(scopes), root: references, engine_sha256: engineSha256(),
    rules: rules.map(r => ({ id: r.meta.id, source: r.path, sha256: r.sha256, injection: r.meta.injection, scope: r.meta.scope, selected: { session: sr.includes(r), auto_review: rr.includes(r) } })),
    sizes: Object.fromEntries(Object.entries(artifacts).map(([name, text]) => [name, { chars: charLength(text), bytes: Buffer.byteLength(text) }])),
  };
  artifacts['manifest.json'] = JSON.stringify(manifest, null, 2) + '\n';
  const paths = Object.fromEntries(Object.keys(artifacts).map(name => [name, inside(root, join(output, name))]));
  if (Object.keys(artifacts).some(name => { try { return lstatSync(join(output, name)).isSymbolicLink(); } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } })) throw new RuleError('יעד פלט הוא symlink');
  if (check) {
    for (const [name, path] of Object.entries(paths)) if (!existsSync(path) || !statSync(path).isFile() || textFile(path) !== artifacts[name]) throw new RuleError(`תוצר חסר/ישן: ${path}`);
  } else {
    for (const [name, path] of Object.entries(paths)) atomicWrite(path, artifacts[name]);
  }
  return manifest;
}

const description = 'בחירת כללים ויצירת תמציות; ללא התקנה או שינוי תצורת משתמש.';
const usage = 'usage: kb-rules {validate,render,build,list,trigger-registry} --root ROOT --profile PROFILE [options]';
const commands = ['validate', 'render', 'build', 'list', 'trigger-registry'];
const values = ['root', 'profile', 'machine', 'project', 'service', 'target', 'reference-root', 'output', 'registry'];
function argumentError(message: string): never { throw Object.assign(new Error(`${usage}\nkb-rules: error: ${message}`), { exitCode: 2 }); }

export function main(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage}\n\n${description}\n\n--machine MACHINE  --project PROJECT  --service SERVICE (repeatable)\n--target {session,auto_review}  --reference-root PATH  --output PATH\n--check  --hook (תקרת 9000 תווים; אין חיתוך)  --registry PATH\n`);
    return 0;
  }
  const options: Record<string, string> = { machine: '', project: '', target: 'session' }, services: string[] = [];
  let command = '', check = false, hook = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') { check = true; continue; }
    if (arg === '--hook') { hook = true; continue; }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('='), key = arg.slice(2, equals < 0 ? undefined : equals);
      if (!values.includes(key)) argumentError(`unrecognized arguments: ${arg}`);
      const value = equals < 0 ? argv[++i] : arg.slice(equals + 1);
      if (value === undefined || value.startsWith('--')) argumentError(`argument --${key}: expected one argument`);
      if (key === 'service') services.push(value); else options[key] = value;
      continue;
    }
    if (command) argumentError(`unrecognized arguments: ${arg}`);
    if (!commands.includes(arg)) argumentError(`argument command: invalid choice: '${arg}'`);
    command = arg;
  }
  const missing = [...(!command ? ['command'] : []), ...['root', 'profile'].filter(key => !(key in options)).map(key => `--${key}`)];
  if (missing.length) argumentError(`the following arguments are required: ${missing.join(', ')}`);
  if (!['session', 'auto_review'].includes(options.target)) argumentError(`argument --target: invalid choice: '${options.target}'`);
  const root = resolveExistingParents(options.root), path = (value: string) => isAbsolute(value) ? value : join(root, value);
  const [config, rules] = load(root, path(options.profile));
  const scopes = scopesFor(config, options.machine || config.context?.machine || '', options.project, services);
  const target = options.target as Target;
  if (command === 'validate') {
    for (const destination of ['session', 'auto_review'] as const) render(root, config, rules, scopes, destination);
    process.stdout.write(`אומתו ${rules.length} כללים\n`);
  } else if (command === 'render') process.stdout.write(render(root, config, rules, scopes, target, { hook })[0]);
  else if (command === 'list') process.stdout.write(select(config, rules, scopes, target).map(r => r.path).join('\n') + '\n');
  else if (command === 'build') {
    if (!options.output) throw new RuleError('build דורש --output מפורש בתוך המאגר');
    const result = build(root, path(options.output), config, rules, scopes, check, options['reference-root']);
    process.stdout.write(JSON.stringify(result.sizes) + '\n');
  } else {
    if (!options.registry) throw new RuleError('נדרש --registry מפורש');
    process.stdout.write(JSON.stringify(triggerRegistry(root, options.registry, rules), null, 2) + '\n');
  }
  return 0;
}
