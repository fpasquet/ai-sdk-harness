#!/usr/bin/env node
// A stand-in for the `sbx` CLI, for the unit tests: it keeps its sandboxes, secrets, ports and
// templates in a JSON file, and runs `sbx exec` on this host, in a directory of its own per
// sandbox, so files and processes behave as they do in a real sandbox.
//
// FAKE_SBX_HOME points at its state. Every call is appended to `calls.jsonl` there, and a call
// whose command line contains one of the state's `failOn` strings exits with 1.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.FAKE_SBX_HOME;
if (!home) {
  process.stderr.write('FAKE_SBX_HOME is not set\n');
  process.exit(2);
}
const statePath = join(home, 'state.json');
// `sbx --cloud …` addresses Docker Sandboxes Cloud: same verbs, a few different behaviours.
const cloud = process.argv[2] === '--cloud';
const args = process.argv.slice(cloud ? 3 : 2);
const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
const save = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2));
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const flags = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));

appendFileSync(
  join(home, 'calls.jsonl'),
  `${JSON.stringify(cloud ? ['--cloud', ...args] : args)}\n`,
);
const state = load();
const line = args.join(' ');
if ((state.failOn ?? []).some((pattern) => line.includes(pattern)))
  fail(`failing on purpose: ${line}`);

/** The environment Docker Sandboxes gives a sandbox, credentials left to its proxy. */
const SANDBOX_ENV = {
  ANTHROPIC_API_KEY: 'proxy-managed',
  GH_TOKEN: 'gho_sbxproxymanaged000',
  MCP_SENTINEL_TOKEN_NAME: 'proxy-managed',
};

/** A cloud sandbox is addressed by its name or by its `sbx_*` id. */
const sandboxName = (target) => (cloud && target?.startsWith('sbx_') ? target.slice(4) : target);

/** The options of `sbx exec`, up to the sandbox name. */
function execOptions(rest) {
  const env = { PATH: process.env.PATH, HOME: home, ...SANDBOX_ENV };
  let workdir;
  while (rest[0]?.startsWith('-')) {
    const option = rest.shift();
    if (option === '-i') continue;
    const value = rest.shift();
    if (cloud && option === '--user') fail('--user is not supported with --cloud');
    if (option === '-w') workdir = value;
    if (option === '-e') env[value] = process.env[value] ?? '';
  }
  return { workdir, env, rest };
}

const commands = {
  ttl() {
    if (!cloud) fail('ttl is cloud-only');
  },
  ls() {
    const sandboxes = Object.entries(state.sandboxes).map(([name, sandbox]) => ({
      name,
      status: sandbox.status,
      ...(cloud ? { id: `sbx_${name}` } : {}),
    }));
    process.stdout.write(JSON.stringify({ sandboxes }));
  },
  create() {
    const name = flag('--name');
    if (state.sandboxes[name]) fail(`sandbox ${name} already exists`);
    const root = join(home, 'sandboxes', name);
    mkdirSync(root, { recursive: true });
    state.sandboxes[name] = { status: 'running', root, template: flag('--template') ?? null };
    save(state);
  },
  exec() {
    const { workdir, env, rest } = execOptions(args.slice(1));
    // Each fake keeps the pid files of its processes apart, so test files running side by side
    // never stop one another's processes.
    const processes = join(home, 'processes');
    const [target, command, ...commandArgs] = rest.map((arg) =>
      arg.replaceAll('/tmp/.ai-sdk-sbx-processes', processes),
    );
    const name = sandboxName(target);
    const sandbox = state.sandboxes[name];
    if (!sandbox) fail(`no sandbox ${target}`);
    sandbox.status = 'running';
    save(state);
    mkdirSync(workdir ?? sandbox.root, { recursive: true });
    const child = spawn(command, commandArgs, {
      cwd: workdir ?? sandbox.root,
      env,
      stdio: 'inherit',
    });
    child.on('close', (code, signal) => process.exit(code ?? (signal ? 137 : 0)));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  },
  stop() {
    if (state.sandboxes[args[1]]) state.sandboxes[args[1]].status = 'stopped';
    save(state);
  },
  rm() {
    for (const name of args.slice(1).filter((arg) => !arg.startsWith('-'))) {
      delete state.sandboxes[name];
      state.secrets = state.secrets.filter(({ scope }) => scope !== name);
    }
    save(state);
  },
  ports() {
    const name = args[1];
    if (cloud && args.includes('--json')) {
      // The control plane assigns each exposed port a public URL.
      const ports = state.ports
        .filter((port) => port.name === name)
        .map(({ binding }) => ({
          sandbox_port: Number(binding),
          url: `https://${name}-${binding}.sbx.example/`,
        }));
      process.stdout.write(JSON.stringify({ ports }));
      return;
    }
    for (const binding of flags('--publish')) state.ports.push({ name, binding });
    for (const binding of flags('--unpublish')) {
      state.ports = state.ports.filter((port) => !(port.name === name && port.binding === binding));
    }
    save(state);
  },
  secret() {
    const scope = flag('--sandbox');
    if (args[1] === 'set-custom' && cloud) {
      // In the cloud, the proxy sets a header; a secret with the same name is replaced.
      const name = flag('--name');
      state.secrets = state.secrets.filter((secret) => secret.name !== name);
      state.secrets.push({
        scope,
        name,
        header: flag('--header'),
        format: flag('--format'),
        targets: flags('--host'),
        value: flag('--value'),
      });
    } else if (args[1] === 'set-custom') {
      state.secrets.push({
        scope,
        placeholder: flag('--placeholder'),
        targets: flags('--host'),
        value: flag('--value'),
      });
    } else if (args[1] === 'rm' && cloud) {
      state.secrets = state.secrets.filter((secret) => secret.name !== args[2]);
    } else if (args[1] === 'rm') {
      const placeholder = flag('--placeholder');
      state.secrets = state.secrets.filter(
        (secret) => !(secret.scope === scope && secret.placeholder === placeholder),
      );
    } else if (args[1] === 'ls') {
      const custom_secrets = state.secrets
        .filter((secret) => secret.scope === scope)
        .map(({ scope, placeholder, targets }) => ({ scope, placeholder, targets }));
      process.stdout.write(JSON.stringify({ secrets: [], custom_secrets }));
    }
    save(state);
  },
  template() {
    if (args[1] === 'ls' && cloud) {
      process.stdout.write(
        JSON.stringify({
          templates: state.cloudTemplates.map((name) => ({ id: `tmpl_${name}`, name })),
        }),
      );
    } else if (args[1] === 'ls') {
      process.stdout.write(JSON.stringify({ images: state.templates }));
    } else if (args[1] === 'save' && cloud) {
      state.cloudTemplates.push(args[3]);
      save(state);
    } else if (args[1] === 'save') {
      if (state.sandboxes[args[2]]?.status !== 'stopped') fail('cannot save a running sandbox');
      const [repository, tag] = args[3].split(':');
      state.templates.push({ repository: `docker.io/library/${repository}`, tag });
      save(state);
    }
  },
};

const command = commands[args[0]];
if (!command) fail(`unknown command ${args[0]}`);
command();
