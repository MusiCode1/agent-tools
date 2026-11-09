import { makePlan, Plan, restore, tomlValues, type Operation } from './index.js';

/** JSON command contract shared by the executable and its in-process tests. */
export function installationCommand(argv: string[], input: unknown): { result: unknown; exitCode: number } {
  if (argv.length !== 1 || !['plan', 'check', 'apply', 'restore', 'toml'].includes(argv[0]!))
    throw new Error('Usage: kb-installation <plan|check|apply|restore|toml> (JSON on stdin)');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a JSON object');
  const data = input as { operations: Operation[]; plan?: unknown; backup?: string; text: string; values: Record<string, string | number> };
  const command = argv[0];
  if (command === 'toml') return { result: { text: tomlValues(data.text, data.values) }, exitCode: 0 };
  if (command === 'restore') {
    if (typeof data.backup !== 'string' || !data.backup) throw new Error('restore requires backup');
    restore(data.backup);
    return { result: { restored: true }, exitCode: 0 };
  }
  const plan = data.plan === undefined ? makePlan(data.operations) : Plan.from(data.plan);
  if (command === 'apply') {
    if (typeof data.backup !== 'string' || !data.backup) throw new Error('apply requires backup');
    plan.apply(data.backup);
  }
  return { result: plan.toJSON(), exitCode: command === 'check' && Object.keys(plan.changes).length ? 1 : 0 };
}
