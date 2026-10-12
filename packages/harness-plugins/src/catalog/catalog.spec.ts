import { jsonSchema, tool } from '@ai-sdk/provider-utils';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Plugin } from '../definitions/plugin.js';

import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { createCatalog } from './catalog.js';

const inspect = tool({
  description: 'Inspect the sandbox.',
  inputSchema: z.object({ deep: z.boolean().optional() }),
  execute: () => 'secret code',
});
const dynamic = tool({
  description: () => 'computed',
  inputSchema: jsonSchema({ type: 'object', properties: {} }),
  execute: () => 'secret code',
});
const createTicket = tool({
  description: 'Create a ticket.',
  inputSchema: z.object({ title: z.string() }),
  execute: () => 'created',
});

/** A plugin of code. */
const safety: Plugin = {
  name: 'safety',
  description: 'Guards.',
  version: '1.0.0',
  hooks: [
    {
      name: 'guard',
      event: 'PreToolUse',
      matcher: 'Bash',
      command: '"${PLUGIN_ROOT}/g.sh"',
      description: 'Blocks rm.',
    },
    { event: 'Stop', prompt: 'Secret prompt', requires: ['skill:checklist'] },
  ],
  skills: [{ name: 'checklist', description: 'A checklist.', content: 'Secret' }],
  subagents: [
    {
      name: 'auditor',
      description: 'Audits.',
      instructions: 'Secret',
      tools: ['Read'],
      model: 'haiku',
    },
  ],
  tools: { inspect, dynamic },
  files: [{ path: 'g.sh', content: 'exit 0' }],
};

/** A plugin as data. */
const tracker = {
  name: 'tracker',
  description: 'Tickets.',
  tools: {
    createTicket: { type: 'registered', ref: 'tickets.create' },
    countTodos: {
      type: 'sandbox-command',
      description: 'Count the TODOs',
      command: 'git grep -c TODO',
    },
  },
  mcpServers: {
    issues: {
      type: 'http',
      url: 'https://mcp.example.com',
      headers: { 'X-Team': 'tickets' },
      runIn: 'sandbox',
    },
  },
  commands: [
    {
      name: 'triage',
      description: 'Triage a ticket',
      prompt: 'Secret',
      requires: ['tool:createTicket'],
    },
  ],
};

/** Items as data, on their own. */
const items = [
  {
    kind: 'tool',
    name: 'npm-latest',
    type: 'http',
    description: 'The latest version of an npm package.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    url: 'https://registry.npmjs.org/{name}/latest',
    headers: { Authorization: { secret: 'NPM_TOKEN' } },
  },
  {
    kind: 'command',
    name: 'npm',
    description: 'Look an npm package up',
    argumentHint: '<package>',
    prompt: 'Secret',
    requires: ['tool:npm-latest'],
  },
  {
    kind: 'subagent',
    name: 'reviewer',
    description: 'Reviews the changes.',
    instructions: 'Secret',
    requires: ['tracker/command:triage'],
  },
  {
    kind: 'mcp-server',
    name: 'docs',
    description: 'Docs.',
    type: 'http',
    url: 'https://docs.example.com/mcp',
    runIn: 'host',
  },
];

const catalog = createCatalog({
  plugins: [safety, tracker],
  items,
  tools: { 'tickets.create': createTicket },
});

describe('createCatalog', () => {
  it('gives every plugin and item an id, and what it requires', () => {
    expect(catalog.entries()).toEqual([
      {
        id: 'plugin:safety',
        kind: 'plugin',
        name: 'safety',
        requires: [
          'safety/tool:inspect',
          'safety/tool:dynamic',
          'safety/skill:checklist',
          'safety/hook:guard',
          'safety/hook:stop-2',
          'safety/subagent:auditor',
        ],
      },
      { id: 'safety/tool:inspect', kind: 'tool', name: 'inspect', plugin: 'safety', requires: [] },
      { id: 'safety/tool:dynamic', kind: 'tool', name: 'dynamic', plugin: 'safety', requires: [] },
      {
        id: 'safety/skill:checklist',
        kind: 'skill',
        name: 'checklist',
        plugin: 'safety',
        requires: [],
      },
      { id: 'safety/hook:guard', kind: 'hook', name: 'guard', plugin: 'safety', requires: [] },
      {
        id: 'safety/hook:stop-2',
        kind: 'hook',
        name: 'stop-2',
        plugin: 'safety',
        requires: ['safety/skill:checklist'],
      },
      {
        id: 'safety/subagent:auditor',
        kind: 'subagent',
        name: 'auditor',
        plugin: 'safety',
        requires: [],
      },
      {
        id: 'plugin:tracker',
        kind: 'plugin',
        name: 'tracker',
        requires: [
          'tracker/tool:createTicket',
          'tracker/tool:countTodos',
          'tracker/command:triage',
          'tracker/mcp-server:issues',
        ],
      },
      {
        id: 'tracker/tool:createTicket',
        kind: 'tool',
        name: 'createTicket',
        plugin: 'tracker',
        requires: [],
      },
      {
        id: 'tracker/tool:countTodos',
        kind: 'tool',
        name: 'countTodos',
        plugin: 'tracker',
        requires: [],
      },
      {
        id: 'tracker/command:triage',
        kind: 'command',
        name: 'triage',
        plugin: 'tracker',
        requires: ['tracker/tool:createTicket'],
      },
      {
        id: 'tracker/mcp-server:issues',
        kind: 'mcp-server',
        name: 'issues',
        plugin: 'tracker',
        requires: [],
      },
      { id: 'tool:npm-latest', kind: 'tool', name: 'npm-latest', requires: [] },
      { id: 'command:npm', kind: 'command', name: 'npm', requires: ['tool:npm-latest'] },
      {
        id: 'subagent:reviewer',
        kind: 'subagent',
        name: 'reviewer',
        requires: ['tracker/command:triage'],
      },
      { id: 'mcp-server:docs', kind: 'mcp-server', name: 'docs', requires: [] },
    ]);
  });

  it('expands a selection with what it requires, in catalog order', () => {
    expect(catalog.expand(['subagent:reviewer', 'command:npm'])).toEqual([
      'tracker/tool:createTicket',
      'tracker/command:triage',
      'tool:npm-latest',
      'command:npm',
      'subagent:reviewer',
    ]);
    expect(catalog.expand(['plugin:tracker'])).toEqual([
      'plugin:tracker',
      'tracker/tool:createTicket',
      'tracker/tool:countTodos',
      'tracker/command:triage',
      'tracker/mcp-server:issues',
    ]);
  });

  it('refuses an unknown id, unless told to skip it', () => {
    expect(() => catalog.expand(['skill:gone', 'command:npm'])).toThrow(
      'The catalog has no skill:gone.',
    );
    expect(catalog.expand(['skill:gone', 'tool:npm-latest'], { ignoreUnknown: true })).toEqual([
      'tool:npm-latest',
    ]);
  });

  it('resolves a selection into plugins: filtered ones, and one per item on its own', async () => {
    const { plugins, close } = await catalog.resolve(
      ['safety/hook:stop-2', 'command:npm', 'tracker/mcp-server:issues'],
      { resolveSecret: (name) => `value-of-${name}` },
    );
    expect(plugins.map(({ name }) => name)).toEqual([
      'safety',
      'tracker',
      'tool-npm-latest',
      'command-npm',
    ]);
    const [code, data, npmTool, npmCommand] = plugins;
    expect(code).toMatchObject({
      skills: [{ name: 'checklist' }],
      hooks: [{ event: 'Stop' }],
      files: [{ path: 'g.sh' }],
    });
    expect(code).not.toHaveProperty('tools');
    expect(code).not.toHaveProperty('subagents');
    expect(data?.mcpServers).toEqual({
      issues: {
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { 'X-Team': 'tickets' },
        runIn: 'sandbox',
      },
    });
    expect(data).not.toHaveProperty('tools');
    expect(Object.keys(npmTool?.tools ?? {})).toEqual(['npm-latest']);
    expect(npmCommand?.commands?.[0]?.name).toBe('npm');
    await close();
  });

  it('refuses to resolve a secret without resolveSecret', async () => {
    await expect(catalog.resolve(['tool:npm-latest'])).rejects.toThrow(
      'Plugin "tool-npm-latest": it refers to the secret "NPM_TOKEN", and no resolveSecret was given.',
    );
  });

  it('fingerprints what a selection resolves to', () => {
    const before = catalog.fingerprint(['command:npm']);
    expect(catalog.fingerprint(['command:npm'])).toBe(before);
    expect(catalog.fingerprint(['tool:npm-latest'])).not.toBe(before);
    const edited = createCatalog({
      items: items.map((item) => (item.name === 'npm' ? { ...item, prompt: 'Edited' } : item)),
      plugins: [safety, tracker],
      tools: { 'tickets.create': createTicket },
    });
    expect(edited.fingerprint(['command:npm'])).not.toBe(before);
    expect(edited.fingerprint(['plugin:safety'])).toBe(catalog.fingerprint(['plugin:safety']));
  });

  it('describes plugins and items without their code, prompts, instructions or secrets', async () => {
    const { plugins, items: described } = await catalog.describe();
    expect(plugins.map(({ id }) => id)).toEqual(['plugin:safety', 'plugin:tracker']);
    expect(plugins[0]?.hooks).toEqual([
      { name: 'guard', event: 'PreToolUse', matcher: 'Bash', description: 'Blocks rm.' },
      { name: 'stop-2', event: 'Stop' },
    ]);
    expect(described.find(({ id }) => id === 'safety/hook:guard')).toEqual({
      id: 'safety/hook:guard',
      kind: 'hook',
      name: 'guard',
      plugin: 'safety',
      description: 'Blocks rm.',
      event: 'PreToolUse',
      matcher: 'Bash',
      requires: [],
      unsupportedOn: ['codex'],
    });
    expect(described.find(({ id }) => id === 'tool:npm-latest')).toMatchObject({
      kind: 'tool',
      description: 'The latest version of an npm package.',
      inputSchema: { type: 'object', required: ['name'] },
      unsupportedOn: [],
    });
    expect(described.find(({ id }) => id === 'tracker/tool:createTicket')).toMatchObject({
      description: 'Create a ticket.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    });
    expect(described.find(({ id }) => id === 'command:npm')).toMatchObject({
      invocation: '/npm',
      argumentHint: '<package>',
      requires: ['tool:npm-latest'],
    });
    expect(described.find(({ id }) => id === 'mcp-server:docs')).toMatchObject({
      type: 'http',
      runIn: 'host',
      description: 'Docs.',
      unsupportedOn: [],
    });
    expect(described.find(({ id }) => id === 'tracker/mcp-server:issues')).toMatchObject({
      runIn: 'sandbox',
      unsupportedOn: [],
    });
    expect(described.find(({ id }) => id === 'safety/subagent:auditor')).toMatchObject({
      tools: ['Read'],
      model: 'haiku',
      unsupportedOn: ['codex'],
    });
    expect(described).toHaveLength(14);
    expect(JSON.stringify({ plugins, described })).not.toMatch(
      /Secret|secret code|NPM_TOKEN|exit 0|git grep/,
    );
  });

  it('describes a registered tool your code does not have as one without input', async () => {
    const { items: described } = await createCatalog({ plugins: [tracker] }).describe();
    expect(described.find(({ id }) => id === 'tracker/tool:createTicket')).toMatchObject({
      description: '',
      inputSchema: { type: 'object', properties: {} },
    });
  });

  it('refuses two sources of one name, an invalid one, and a requirement the catalog lacks', () => {
    expect(() => createCatalog({ plugins: [safety, safety] })).toThrow(InvalidPluginError);
    expect(() => createCatalog({ plugins: [{ name: 'Bad', description: '' }] })).toThrow(
      'name: must be a kebab-case slug.',
    );
    expect(() =>
      createCatalog({
        items: [
          { kind: 'skill', name: 'x', description: '', content: '', requires: ['tool:nope'] },
        ],
      }),
    ).toThrow('skill:x requires tool:nope, which the catalog does not have.');
    expect(() => createCatalog({ items: [{ kind: 'widget', name: 'x' }] })).toThrow(
      'kind: must be one of tool, skill, rule, command, hook, subagent, mcp-server.',
    );
  });
});

describe('a rule in a catalog', () => {
  it('is described without its content, and resolves into a plugin of its own', async () => {
    const catalog = createCatalog({
      items: [
        {
          kind: 'rule',
          name: 'api-tests',
          description: 'Tests for the API.',
          paths: ['src/api/**/*.ts'],
          content: 'Write a test for each endpoint.',
        },
      ],
    });

    const { items } = await catalog.describe();
    expect(items).toEqual([
      {
        id: 'rule:api-tests',
        kind: 'rule',
        name: 'api-tests',
        description: 'Tests for the API.',
        paths: ['src/api/**/*.ts'],
        requires: [],
        unsupportedOn: [],
      },
    ]);
    const { plugins } = await catalog.resolve(['rule:api-tests']);
    expect(plugins).toEqual([
      {
        name: 'rule-api-tests',
        description: 'Tests for the API.',
        rules: [
          {
            name: 'api-tests',
            description: 'Tests for the API.',
            paths: ['src/api/**/*.ts'],
            content: 'Write a test for each endpoint.',
          },
        ],
      },
    ]);
  });
});
