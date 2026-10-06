#!/usr/bin/env node
// @ts-check
/**
 * A stand-in for Cloud Run's `sandbox` CLI, for the tests. It isolates NOTHING: a "sandbox" is a
 * marker file of `FAKE_SANDBOX_STATE`, and its commands run on this machine, as this user, on its
 * network.
 *
 * `FAKE_SANDBOX_FILES` is the directory of a sandbox's files, `{sandbox}` its name: what stands
 * for its writable layer. It is removed with the sandbox, saved by `tar` and filled by
 * `--import-tar`. Every call is appended to `<state>/calls.jsonl`.
 *
 * It takes the subset of the real CLI the service uses:
 *
 *   sandbox run <name> --detach --write [--allow-egress] [--import-tar=<tar>] -- <command…>
 *     (the command is not run)
 *   sandbox exec <name> -- <command…>
 *   sandbox tar <name> --file=<tar>
 *   sandbox delete <name> --force
 */
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const state = process.env['FAKE_SANDBOX_STATE'] ?? '';
const [subcommand, name, ...rest] = process.argv.slice(2);

mkdirSync(state, { recursive: true });
appendFileSync(join(state, 'calls.jsonl'), `${JSON.stringify(process.argv.slice(2))}\n`);

const marker = join(state, `${name ?? ''}.sandbox`);
const files = (process.env['FAKE_SANDBOX_FILES'] ?? '').replaceAll('{sandbox}', name ?? '');

/** @param {string} flag */
const option = (flag) => rest.find((arg) => arg.startsWith(`--${flag}=`))?.slice(flag.length + 3);

/** @param {string} message */
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (name === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('A sandbox name is required.');

/** With FAKE_SANDBOX_NO_FIFO, tars only go to and come from regular files, as a stricter CLI might. */
const refusePipe = (/** @type {string | undefined} */ path) => {
  if (
    process.env['FAKE_SANDBOX_NO_FIFO'] === '1' &&
    path &&
    statSync(path, { throwIfNoEntry: false })?.isFIFO()
  ) {
    fail(`${path} is not a regular file.`);
  }
};

switch (subcommand) {
  case 'run': {
    if (existsSync(marker)) fail(`Sandbox ${name} already exists.`);
    const snapshot = option('import-tar');
    refusePipe(snapshot);
    writeFileSync(marker, '');
    mkdirSync(files, { recursive: true });
    if (snapshot) execFileSync('tar', ['-xf', snapshot, '-C', files]);
    break;
  }
  case 'tar': {
    if (!existsSync(marker)) fail(`Sandbox ${name} not found.`);
    const file = option('file') ?? '';
    refusePipe(file);
    execFileSync('tar', ['-cf', file, '-C', files, '.']);
    break;
  }
  case 'exec': {
    if (!existsSync(marker)) fail(`Sandbox ${name} not found.`);
    const [command = 'true', ...args] = rest.slice(rest.indexOf('--') + 1);
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', (error) => fail(error.message));
    // Like the real CLI: whatever fails comes out as 137, the service must carry the real code.
    child.once('close', (code) => process.exit(code === 0 ? 0 : 137));
    for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
      process.on(signal, () => child.kill(signal));
    }
    break;
  }
  case 'delete':
    rmSync(marker, { force: true });
    rmSync(files, { recursive: true, force: true });
    break;
  default:
    fail(`Unknown command: ${subcommand}`);
}
