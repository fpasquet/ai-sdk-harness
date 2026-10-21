import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import type { InputSchema, Plugin, PluginCommand } from '../definitions/plugin.js';

import { citedArguments, hintedArguments } from '../commands/command-arguments.js';
import { citedInputVariables, inputVariable } from './input-variables.js';
import { lintItem, lintPlugin } from './lint-plugin.js';
import { environmentOf } from './sandbox-command-tool.js';

const service = {
  type: 'object',
  properties: { service: { type: 'string' }, max_count: { type: 'number' } },
};

/** The codes and paths of what `lintPlugin` finds in a plugin of one sandbox-command. */
const sandboxCommand = (
  command: string,
  inputSchema: InputSchema = service,
  extra: Partial<Plugin> = {},
) =>
  lintPlugin({
    name: 'kit',
    description: '',
    tools: { test: { type: 'sandbox-command', description: 'd', command, inputSchema } },
    ...extra,
  }).map(({ code, path }) => [code, path.join('.')]);

/** The codes and paths of what `lintPlugin` finds in a plugin of one command. */
const command = (prompt: string, argumentHint?: string) =>
  lintPlugin({
    name: 'kit',
    description: '',
    commands: [{ name: 'c', description: '', prompt, ...(argumentHint && { argumentHint }) }],
  }).map(({ code, path }) => [code, path.join('.')]);

describe('inputVariable', () => {
  it('names each property as environmentOf() sets it', () => {
    expect(inputVariable('max_count')).toBe('INPUT_MAX_COUNT');
    expect(inputVariable('max-count')).toBe('INPUT_MAX_COUNT');
    expect(Object.keys(environmentOf({ 'a.b': 1 }))).toEqual(['INPUT', inputVariable('a.b')]);
  });
});

describe('citedInputVariables', () => {
  it('reads every INPUT_<KEY>, with or without a $, but not one the command sets', () => {
    expect(
      citedInputVariables(
        'X=1 INPUT_DIR=/tmp; cd ${INPUT_DIR} && ls $INPUT_A ${INPUT_B:-.} ${#INPUT_C}; printenv INPUT_A MY_INPUT_D',
      ),
    ).toEqual({ all: false, names: ['INPUT_A', 'INPUT_B', 'INPUT_C'] });
    expect(citedInputVariables('echo "$INPUT" | jq .a').all).toBe(true);
    expect(citedInputVariables('echo ${INPUT}').all).toBe(true);
    expect(citedInputVariables('echo $INPUT_A').all).toBe(false);
  });
});

describe('citedArguments and hintedArguments', () => {
  it('read a prompt and a hint', () => {
    expect(citedArguments('Fix $2 then $1, $2 again')).toEqual({ all: false, positions: [1, 2] });
    expect(citedArguments('Plan $ARGUMENTS')).toEqual({ all: true, positions: [] });
    expect(hintedArguments('<issue> [focus]')).toBe(2);
    expect(hintedArguments('[files...]')).toBe(Infinity);
    expect(hintedArguments('a file path')).toBeUndefined();
  });
});

describe('lintPlugin', () => {
  it('finds a property of a sandbox-command nothing reads', () => {
    // A typo: definePlugin refuses $INPUT_SERVCE, and service is never read.
    expect(sandboxCommand('npm test -- $INPUT_SERVCE ${INPUT_MAX_COUNT}')).toEqual([
      ['unread-input', 'tools.test.inputSchema.properties.service'],
    ]);
    expect(sandboxCommand('cd "$INPUT_SERVICE" && npm test')).toEqual([
      ['unread-input', 'tools.test.inputSchema.properties.max_count'],
    ]);
    expect(sandboxCommand('git log -n ${INPUT_MAX_COUNT:-5} $INPUT_SERVICE')).toEqual([]);
    expect(sandboxCommand('echo "$INPUT" | node read.js')).toEqual([]);
    expect(sandboxCommand('true', z.object({ a: z.string() }))).toEqual([
      ['unread-input', 'tools.test.inputSchema.properties.a'],
    ]);
  });

  it('counts the files of the plugin the command names as readers', () => {
    const files = [
      { path: 'scripts/run.py', content: 'import os\nos.environ["INPUT_SERVICE"]' },
      { path: 'scripts/other.py', content: 'os.environ["INPUT_MAX_COUNT"]' },
    ];
    expect(sandboxCommand('python3 /work/scripts/run.py', service, { files })).toEqual([
      ['unread-input', 'tools.test.inputSchema.properties.max_count'],
    ]);
  });

  it('finds the arguments of a command its hint does not announce', () => {
    expect(command('Pay invoice $1', '<invoice>')).toEqual([]);
    expect(command('Answer $ARGUMENTS', '<library> <question>')).toEqual([]);
    expect(command('Review $1 then $2', '<invoice>')).toEqual([
      ['argument-beyond-hint', 'commands.0.prompt'],
    ]);
    expect(command('Review $1', '<pr> [focus]')).toEqual([
      ['unread-argument', 'commands.0.argumentHint'],
    ]);
    expect(command('Review the code', '<pr>')).toEqual([
      ['appended-arguments', 'commands.0.prompt'],
    ]);
    // A hint of free text, or one that takes the rest, is not counted; no hint, nothing to check.
    expect(command('Review $3', 'a file path')).toEqual([]);
    expect(command('Format $1 $2 $3', '[files...]')).toEqual([]);
    expect(command('Review $2')).toEqual([]);
  });

  it('says what is wrong', () => {
    const commands: PluginCommand[] = [
      { name: 'c', description: '', argumentHint: '<invoice>', prompt: 'Pay $2' },
    ];
    expect(lintPlugin({ name: 'kit', description: '', commands })).toEqual([
      {
        path: ['commands', 0, 'prompt'],
        code: 'argument-beyond-hint',
        message: 'reads $2, but the hint announces 1 argument',
      },
      {
        path: ['commands', 0, 'argumentHint'],
        code: 'unread-argument',
        message: 'announces $1, which the prompt never reads: dropped',
      },
    ]);
  });
});

describe('lintItem', () => {
  it('finds the same, at paths within the item', () => {
    expect(
      lintItem({
        kind: 'tool',
        name: 'test',
        type: 'sandbox-command',
        description: 'd',
        command: 'npm test',
        inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
      }).map(({ path }) => path),
    ).toEqual([['inputSchema', 'properties', 'service']]);
    expect(
      lintItem({ kind: 'command', name: 'c', description: '', argumentHint: '<a>', prompt: 'Go' }),
    ).toMatchObject([{ path: ['prompt'], code: 'appended-arguments' }]);
  });
});
