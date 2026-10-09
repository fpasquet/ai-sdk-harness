import { describe, expect, it } from 'vitest';

import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { defineItem, definePlugin, itemJsonSchema, pluginJsonSchema } from './define.js';

const manifest = {
  name: 'ticketing',
  description: 'Tickets, from the back office.',
  version: '3',
  tools: {
    countTodos: {
      type: 'sandbox-command',
      description: 'Count the TODOs',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      command: 'git grep -c TODO -- "${INPUT_PATH:-.}"',
      timeoutSeconds: 10,
    },
    createTicket: { type: 'registered', ref: 'tickets.create' },
  },
  commands: [{ name: 'triage', description: 'Triage', prompt: 'Triage $ARGUMENTS' }],
  hooks: [{ event: 'Stop', prompt: 'Done?' }],
  mcpServers: {
    tracker: {
      type: 'http',
      url: 'https://mcp.example.com',
      runIn: 'host',
      allowedTools: ['search'],
    },
    local: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server.mjs'] },
  },
};

/** The error definePlugin throws for `value`. */
function errorOf(value: unknown): InvalidPluginError {
  try {
    definePlugin(value);
  } catch (error) {
    if (error instanceof InvalidPluginError) return error;
    throw error;
  }
  throw new Error('No error.');
}

describe('definePlugin', () => {
  it('returns a valid manifest, as JSON a database gave back', () => {
    expect(definePlugin(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it('lists every mistake by field', () => {
    const error = errorOf({
      ...manifest,
      name: 'Ticketing',
      tools: {
        'bad name': { type: 'registered', ref: 'x' },
        ok: { type: 'sandbox-command', description: 'd' },
      },
      hooks: [{ event: 'Never', command: 'true' }, { event: 'Stop' }],
      mcpServers: { tracker: { type: 'http', url: 'not a url' } },
      extra: true,
    });
    expect(error.plugin).toBe('Ticketing');
    expect(error.message).toMatch(
      /^Plugin "Ticketing": name: must be a kebab-case slug \(and \d+ more\)\.$/,
    );
    expect(error.issues.map(({ path }) => path.join('.'))).toEqual(
      expect.arrayContaining([
        'name',
        'tools.bad name',
        'tools.ok.command',
        'hooks.0.event',
        'hooks.1',
        'mcpServers.tracker.url',
        '',
      ]),
    );
    expect(error.issues.find(({ path }) => path.join('.') === 'hooks.1')?.message).toBe(
      'needs exactly one of command and prompt',
    );
  });

  it('refuses two items of one name, which the schema cannot see', () => {
    const error = errorOf({
      ...manifest,
      commands: [
        { name: 'triage', description: '', prompt: 'a' },
        { name: 'triage', description: '', prompt: 'b' },
      ],
    });
    expect(error.message).toBe('Plugin "ticketing": it has two commands named "triage".');
    expect(error.issues).toEqual([{ path: [], message: 'it has two commands named "triage".' }]);
  });

  it('refuses what is not a plugin at all', () => {
    expect(errorOf(null).message).toMatch(/^Invalid input/);
    expect(errorOf(null).plugin).toBeUndefined();
  });

  it('gives the JSON Schema a back office builds its form from', () => {
    const schema = pluginJsonSchema() as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toEqual(['name', 'description']);
    expect(Object.keys(schema.properties)).toEqual([
      'name',
      'description',
      'version',
      'tools',
      'skills',
      'rules',
      'commands',
      'hooks',
      'subagents',
      'mcpServers',
      'files',
    ]);
  });

  it('shows the input schema of a tool as the JSON Schema JSON can hold', () => {
    const http = (
      itemJsonSchema('tool') as { oneOf: { properties: Record<string, unknown> }[] }
    ).oneOf.find(({ properties }) => 'url' in properties);
    expect(http?.properties.inputSchema).toEqual({
      type: 'object',
      description: 'The JSON Schema of the input: { "type": "object", "properties": … }',
      properties: { type: { const: 'object' } },
      required: ['type'],
    });
  });
});

describe('defineItem', () => {
  it('returns a valid item of each kind as it is', () => {
    const valid = [
      {
        kind: 'tool',
        name: 'npm-latest',
        type: 'http',
        description: 'd',
        url: 'https://registry.npmjs.org/{name}/latest',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        headers: { Authorization: { secret: 'NPM' } },
      },
      { kind: 'tool', name: 'count', type: 'sandbox-command', description: 'd', command: 'wc -l' },
      {
        kind: 'tool',
        name: 'create',
        type: 'registered',
        ref: 'tickets.create',
        requires: ['skill:style'],
      },
      { kind: 'skill', name: 'style', description: 'd', content: 'c' },
      {
        kind: 'command',
        name: 'npm',
        description: 'd',
        prompt: 'p',
        requires: ['tool:npm-latest'],
      },
      {
        kind: 'hook',
        name: 'guard',
        event: 'PreToolUse',
        command: '"${PLUGIN_ROOT}/g.sh"',
        files: [{ path: 'g.sh', content: 'exit 0' }],
      },
      { kind: 'subagent', name: 'reviewer', description: 'd', instructions: 'i', tools: ['Read'] },
      {
        kind: 'mcp-server',
        name: 'docs',
        type: 'stdio',
        command: 'node',
        env: { TOKEN: { secret: 'DOCS' } },
        runIn: 'host',
      },
    ];
    for (const item of valid) expect(defineItem(item)).toEqual(item);
  });

  it('lists the mistakes of an item by field, against the schema of its kind', () => {
    const error = (() => {
      try {
        defineItem({
          kind: 'tool',
          name: 'x',
          type: 'http',
          description: 'd',
          url: 'https://{host}.example.com/',
          inputSchema: { type: 'object', properties: { host: {} }, required: ['host'] },
        });
      } catch (caught) {
        return caught as InvalidPluginError;
      }
      throw new Error('No error.');
    })();
    expect(error.plugin).toBe('tool:x');
    expect(error.issues).toEqual([
      { path: ['url'], message: 'must be an http(s) URL whose origin holds no {placeholder}' },
    ]);
    expect(() => defineItem({ kind: 'hook', name: 'h', event: 'Stop' })).toThrow(
      'needs exactly one of command and prompt',
    );
    expect(() => defineItem({ kind: 'widget' })).toThrow('kind: must be one of');
    expect(() => defineItem(null)).toThrow('kind: must be one of');
  });

  it('gives the JSON Schema of each kind, for a form', () => {
    const schema = itemJsonSchema('command') as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual([
      'kind',
      'name',
      'description',
      'argumentHint',
      'prompt',
      'requires',
    ]);
    expect(itemJsonSchema('tool')).toHaveProperty('oneOf');
  });
});
