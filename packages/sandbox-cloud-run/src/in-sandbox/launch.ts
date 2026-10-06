import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Runs inside a sandbox: starts the program the service asks for. Cloud Run logs the command line
 * of everything it runs in a sandbox, so nothing that matters is on it: the program, its variables
 * and its working directory come on the first line of the standard input, as JSON, and the rest of
 * the standard input is the program's own.
 *
 * Usage: `node launch.js`, then `{ "argv": [...], "env": {...}, "cwd"?: "...", "pidFile"?: "..." }`
 * and a newline on its standard input. The program gets `env` and nothing else. With `pidFile`,
 * this process records its pid there while the program runs: stopping the tree under it stops the
 * program. Exits with the program's code.
 */
interface Launch {
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
  pidFile?: string;
}

let pidFile: string | undefined;

function finish(code: number): never {
  if (pidFile !== undefined) rmSync(pidFile, { force: true });
  process.exit(code);
}

function start({ argv, env, cwd, ...launch }: Launch, rest: Buffer): void {
  pidFile = launch.pidFile;
  if (pidFile !== undefined) {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(process.pid));
  }
  if (cwd !== undefined && !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`cd: ${cwd}: No such file or directory\n`);
    finish(2);
  }
  const [command = '/bin/true', ...args] = argv;
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'inherit', 'inherit'] });
  // A program that exits before reading its standard input must not take this one down.
  child.stdin.on('error', () => undefined);
  child.stdin.write(rest);
  process.stdin.pipe(child.stdin);
  child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    finish(127);
  });
  child.once('close', (code, signal) => finish(code ?? (signal === null ? 0 : 128 + 15)));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => child.kill(signal));
  }
}

let buffered = Buffer.alloc(0);
const onData = (chunk: Buffer): void => {
  buffered = Buffer.concat([buffered, chunk]);
  const newline = buffered.indexOf(0x0a);
  if (newline === -1) return;
  process.stdin.off('data', onData);
  process.stdin.pause();
  try {
    start(
      JSON.parse(buffered.subarray(0, newline).toString()) as Launch,
      buffered.subarray(newline + 1),
    );
  } catch (error) {
    process.stderr.write(
      `Could not launch: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    finish(127);
  }
};
process.stdin.on('data', onData);
process.stdin.once('end', () => {
  if (buffered.indexOf(0x0a) === -1) finish(127);
});
