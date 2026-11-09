import * as fs from 'node:fs';
import { runCli } from '../../shared/cli.js';
import { installationCommand } from './command.js';

runCli('kb-installation', async (argv: string[]) => {
  const { result, exitCode } = installationCommand(argv, JSON.parse(fs.readFileSync(0, 'utf8')));
  process.stdout.write(JSON.stringify(result) + '\n');
  return exitCode;
});
