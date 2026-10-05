import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Path of the fake `sbx` executable, to pass as the `binary` option. */
export const FAKE_SBX = fileURLToPath(new URL('./fake-sbx.mjs', import.meta.url));

export interface FakeSbxState {
  sandboxes: Record<string, { root: string; status: string; template: null | string }>;
  secrets: {
    format?: string;
    header?: string;
    name?: string;
    placeholder?: string;
    scope: string;
    targets: string[];
    value: string;
  }[];
  ports: { binding: string; name: string }[];
  templates: { repository: string; tag: string }[];
  cloudTemplates: string[];
  failOn: string[];
}

export interface FakeSbx {
  binary: string;
  home: string;
  /** The fake's current state, as its last call left it. */
  state(): FakeSbxState;
  /** Changes the state the next calls see. */
  update(change: (state: FakeSbxState) => void): void;
  /** Every call so far, its arguments as `sbx` received them. */
  calls(): string[][];
  /** The calls of one sub-command (`create`, `exec`…), local or `--cloud`. */
  callsOf(command: string): string[][];
  /** Adds a sandbox, as if `sbx create` had made it earlier. */
  addSandbox(name: string): string;
  dispose(): void;
}

/** A fresh fake `sbx`, its state in a temporary directory `FAKE_SBX_HOME` points at. */
export function createFakeSbx(): FakeSbx {
  chmodSync(FAKE_SBX, 0o755);
  const home = mkdtempSync(join(tmpdir(), 'fake-sbx-'));
  const statePath = join(home, 'state.json');
  const callsPath = join(home, 'calls.jsonl');
  const initial: FakeSbxState = {
    sandboxes: {},
    secrets: [],
    ports: [],
    templates: [],
    cloudTemplates: [],
    failOn: [],
  };
  writeFileSync(statePath, JSON.stringify(initial));
  writeFileSync(callsPath, '');
  process.env.FAKE_SBX_HOME = home;

  const state = (): FakeSbxState => JSON.parse(readFileSync(statePath, 'utf8')) as FakeSbxState;
  const update = (change: (current: FakeSbxState) => void): void => {
    const current = state();
    change(current);
    writeFileSync(statePath, JSON.stringify(current));
  };
  const calls = (): string[][] =>
    readFileSync(callsPath, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as string[]);

  return {
    binary: FAKE_SBX,
    home,
    state,
    update,
    calls,
    // `--cloud` comes before the sub-command: look past it.
    callsOf: (command) =>
      calls().filter((call) => (call[0] === '--cloud' ? call[1] : call[0]) === command),
    addSandbox: (name) => {
      const root = join(home, 'sandboxes', name);
      update((current) => {
        current.sandboxes[name] = { root, status: 'stopped', template: null };
      });
      return root;
    },
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}
