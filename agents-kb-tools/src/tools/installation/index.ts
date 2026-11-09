/** Explicit, reversible file installation. Importing this module changes nothing. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { tomlValues } from './toml.js';

export { tomlValues } from './toml.js';
export type FileState = { kind: 'absent' } | { kind: 'link'; target: string } |
  { kind: 'file'; data: string; mode: number };
export interface Change { before: FileState; after: FileState }
export interface Backup { version: 1; changes: Record<string, Change> }
export type Operation = { kind: 'text'; path: string; text: string } |
  { kind: 'link'; path: string; target: string } | { kind: 'remove'; path: string } |
  { kind: 'toml'; path: string; values: Record<string, string | number> };
export type Put = (name: string, value: FileState) => void;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export function state(name: string): FileState {
  let info: fs.Stats;
  try { info = fs.lstatSync(name); } catch (error) {
    if (missing(error)) return { kind: 'absent' };
    throw error;
  }
  if (info.isSymbolicLink()) return { kind: 'link', target: fs.readlinkSync(name) };
  if (!info.isFile()) throw new Error(`Refusing to replace a directory: ${name}`);
  return { kind: 'file', data: fs.readFileSync(name).toString('base64'), mode: info.mode & 0o7777 };
}

/** Resolve every existing parent, but never dereference the destination itself. */
function destination(name: string): string {
  const absolute = path.resolve(name);
  const suffix: string[] = [];
  let parent = path.dirname(absolute);
  while (true) {
    try { return path.join(fs.realpathSync(parent), ...suffix.reverse(), path.basename(absolute)); }
    catch (error) {
      if (!missing(error)) throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      suffix.push(path.basename(parent));
      parent = next;
    }
  }
}

/** Replace one entry atomically. Directories are never installation targets. */
export function put(name: string, value: FileState): void {
  state(name);
  fs.mkdirSync(path.dirname(name), { recursive: true });
  if (value.kind === 'absent') {
    try { fs.unlinkSync(name); } catch (error) { if (!missing(error)) throw error; }
    return;
  }
  const temporary = path.join(path.dirname(name), `.kb-install-${randomBytes(16).toString('hex')}`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  fs.closeSync(fd);
  try {
    if (value.kind === 'link') {
      fs.unlinkSync(temporary);
      fs.symlinkSync(value.target, temporary);
    } else {
      fs.writeFileSync(temporary, Buffer.from(value.data, 'base64'));
      fs.chmodSync(temporary, value.mode);
    }
    fs.renameSync(temporary, name);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
  }
}

function validateState(value: unknown): asserts value is FileState {
  if (!value || typeof value !== 'object') throw new Error('Invalid backup state');
  const v = value as Partial<FileState> & { data?: unknown; mode?: unknown; target?: unknown };
  if (v.kind === 'absent') return;
  if (v.kind === 'link' && typeof v.target === 'string') return;
  if (v.kind === 'file' && typeof v.data === 'string' && Number.isInteger(v.mode) &&
      (v.mode as number) >= 0 && (v.mode as number) <= 0o7777 &&
      Buffer.from(v.data, 'base64').toString('base64') === v.data) return;
  throw new Error('Invalid backup state');
}

export function validateBackup(value: unknown): Backup {
  if (!value || typeof value !== 'object' || (value as Backup).version !== 1)
    throw new Error('Unsupported backup version');
  const changes = (value as Backup).changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid backup changes');
  for (const [name, change] of Object.entries(changes)) {
    if (!path.isAbsolute(name) || !change || typeof change !== 'object') throw new Error('Invalid backup change');
    validateState(change.before);
    validateState(change.after);
  }
  return value as Backup;
}

/** A plan captures the before state once; apply never replans changed destinations. */
export class Plan {
  readonly changes: Record<string, Change> = Object.create(null) as Record<string, Change>;

  static from(value: unknown): Plan {
    const result = new Plan();
    Object.assign(result.changes, structuredClone(validateBackup(value).changes));
    return result;
  }

  private set(name: string, after: FileState): void {
    name = destination(name);
    const before = state(name);
    if (isDeepStrictEqual(before, after)) return;
    if (Object.hasOwn(this.changes, name)) throw new Error(`Duplicate installation destination: ${name}`);
    this.changes[name] = { before, after };
  }

  text(name: string, text: string): void {
    const before = state(name);
    this.set(name, { kind: 'file', data: Buffer.from(text).toString('base64'), mode: before.kind === 'file' ? before.mode : 0o600 });
  }

  link(name: string, target: string): void {
    target = path.resolve(target);
    if (!fs.existsSync(target)) throw new Error(`Missing installation source: ${target}`);
    this.set(name, { kind: 'link', target });
  }

  remove(name: string): void { this.set(name, { kind: 'absent' }); }
  toJSON(): Backup { return { version: 1, changes: this.changes }; }

  apply(backup: string, write: Put = put): void {
    // Check every target before creating a backup or modifying the first target.
    for (const [name, change] of Object.entries(this.changes)) {
      if (!isDeepStrictEqual(state(name), change.before))
        throw new Error(`Installation target changed since planning: ${name}`);
    }
    const backupName = destination(backup);
    if (Object.hasOwn(this.changes, backupName)) throw new Error('Backup cannot be an installation destination');
    fs.mkdirSync(path.dirname(backupName), { recursive: true });
    // wx also refuses dangling symlinks; chmod is private even under a permissive umask.
    const fd = fs.openSync(backupName, 'wx', 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(this.toJSON(), null, 2) + '\n');
    } finally { fs.closeSync(fd); }
    transact(Object.entries(this.changes), 'after', write);
  }
}

function transact(entries: [string, Change][], direction: 'before' | 'after', write: Put): void {
  const completed: [string, Change][] = [];
  try {
    for (const [name, change] of entries) {
      write(name, change[direction]);
      completed.push([name, change]);
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const [name, change] of completed.reverse()) {
      try { write(name, change[direction === 'after' ? 'before' : 'after']); }
      catch (rollback) { failures.push(rollback); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], 'Installation failed and rollback was incomplete');
    throw error;
  }
}

export function restore(backup: string, write: Put = put): void {
  const data = validateBackup(JSON.parse(fs.readFileSync(backup, 'utf8')));
  for (const [name, change] of Object.entries(data.changes)) {
    if (!isDeepStrictEqual(state(name), change.after))
      throw new Error(`Target changed after installation; inspect before restoring: ${name}`);
  }
  transact(Object.entries(data.changes).reverse(), 'before', write);
}

export function makePlan(operations: Operation[]): Plan {
  if (!Array.isArray(operations)) throw new Error('operations must be an array');
  const plan = new Plan();
  for (const operation of operations) {
    if (!operation || typeof operation.path !== 'string') throw new Error('Operation requires a path');
    switch (operation.kind) {
      case 'text':
        if (typeof operation.text !== 'string') throw new Error('Text operation requires text');
        plan.text(operation.path, operation.text); break;
      case 'link':
        if (typeof operation.target !== 'string') throw new Error('Link operation requires target');
        plan.link(operation.path, operation.target); break;
      case 'remove': plan.remove(operation.path); break;
      case 'toml': {
        state(operation.path); // refuse directories and propagate read errors
        const text = fs.existsSync(operation.path) ? fs.readFileSync(operation.path, 'utf8') : '';
        plan.text(operation.path, tomlValues(text, operation.values)); break;
      }
      default: throw new Error('Unknown installation operation');
    }
  }
  return plan;
}
