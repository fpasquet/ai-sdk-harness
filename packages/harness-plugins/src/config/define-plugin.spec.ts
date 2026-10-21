import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { InvalidPluginError } from '../errors/invalid-plugin-error.js';
import { definePlugin } from './define.js';

describe('definePlugin', () => {
  it('checks a tool: an AI SDK tool, or a definition', () => {
    const plugin = {
      name: 'kit',
      description: '',
      tools: {
        code: { description: 'Code', inputSchema: {}, execute: () => 'done' },
        api: {
          type: 'http',
          description: 'Api',
          url: 'https://api.example.com/{id}',
          // In code, the input schema may be zod: JSON holds a JSON Schema.
          inputSchema: z.object({ id: z.string() }),
        },
      },
    };
    expect(definePlugin(plugin)).toBe(plugin);
    expect(() =>
      definePlugin({ name: 'kit', description: '', tools: { bad: { description: 'no schema' } } }),
    ).toThrow(
      'tools.bad: must be an AI SDK tool, or a tool definition of type http, sandbox-command or registered.',
    );
    expect(() =>
      definePlugin({
        name: 'kit',
        description: '',
        tools: { api: { type: 'http', description: 'd' } },
      }),
    ).toThrow('tools.api.url:');
  });

  it('refuses an http tool whose url takes what its input schema does not require', () => {
    const api = (inputSchema?: unknown) =>
      definePlugin({
        name: 'kit',
        description: '',
        tools: {
          api: { type: 'http', description: 'd', url: 'https://a.dev/{org}/{id}', inputSchema },
        },
      });
    const refused =
      'tools.api.inputSchema: must declare {org}, {id} of the url as required properties: the model fills only what the schema shows.';
    expect(() => api()).toThrow(refused);
    expect(() => api(z.object({ org: z.string(), id: z.string().optional() }))).toThrow(
      'must declare {id} of the url',
    );
    expect(() =>
      api({ type: 'object', properties: { org: { type: 'string' } }, required: ['org'] }),
    ).toThrow('must declare {id} of the url');
    expect(() =>
      api({
        type: 'object',
        properties: { org: { type: 'string' }, id: { type: 'string' } },
        required: ['org', 'id'],
      }),
    ).not.toThrow();
  });

  it('refuses a sandbox-command that reads a variable its input schema does not set', () => {
    const run = (command: string, inputSchema?: unknown) =>
      definePlugin({
        name: 'kit',
        description: '',
        tools: { test: { type: 'sandbox-command', description: 'd', command, inputSchema } },
      });
    const service = { type: 'object', properties: { service: { type: 'string' } } };
    expect(() => run('cd /workspace/$INPUT_SERVICE && npm test')).toThrow(
      'tools.test.command: reads $INPUT_SERVICE, which no property of the input schema sets',
    );
    expect(() => run('cd "${INPUT_SERVCE:-.}" && printenv INPUT_X', service)).toThrow(
      'reads $INPUT_SERVCE, $INPUT_X, which',
    );
    // Upper case, as `environmentOf()` sets them.
    expect(() => run('echo $INPUT_service', service)).toThrow('reads $INPUT_service');
    expect(() =>
      run('git log -n "$INPUT_MAX_COUNT" "${INPUT_SERVICE}" | echo "$INPUT"', {
        type: 'object',
        properties: { service: { type: 'string' }, 'max-count': { type: 'number' } },
      }),
    ).not.toThrow();
    // Set by the command itself, read from a zod schema, or an input left open.
    expect(() => run('INPUT_DIR=/tmp; cd $INPUT_DIR && ls $INPUT_SERVICE', service)).not.toThrow();
    expect(() => run('cd $INPUT_SERVICE', z.object({ service: z.string() }))).not.toThrow();
    expect(() => run('cd $INPUT_OTHER', { ...service, additionalProperties: true })).not.toThrow();
    expect(() =>
      run('cd $INPUT_SERVICE', {
        type: 'object',
        anyOf: [{ properties: { service: { type: 'string' } } }, { properties: {} }],
      }),
    ).not.toThrow();
  });

  it('refuses a sandbox-command that cites ${PLUGIN_ROOT}, which it never replaces', () => {
    expect(() =>
      definePlugin({
        name: 'kit',
        description: '',
        tools: { t: { type: 'sandbox-command', description: 'd', command: '${PLUGIN_ROOT}/a.sh' } },
      }),
    ).toThrow('tools.t.command: must not cite ${PLUGIN_ROOT}');
  });

  it('refuses an input schema that requires a property it does not declare', () => {
    const inputSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name', 'depot'],
    };
    expect(() =>
      definePlugin({
        name: 'kit',
        description: '',
        tools: {
          run: { type: 'sandbox-command', description: 'd', command: 'true', inputSchema },
          api: { type: 'http', description: 'd', url: 'https://a.dev', inputSchema },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        issues: [
          {
            path: ['tools', 'run', 'inputSchema', 'required', 1],
            message:
              'must be one of the properties: the model is asked for "depot" but never sees it',
          },
          {
            path: ['tools', 'api', 'inputSchema', 'required', 1],
            message:
              'must be one of the properties: the model is asked for "depot" but never sees it',
          },
        ],
      }),
    );
  });

  it('returns a valid plugin as it is', () => {
    const plugin = {
      name: 'review-kit',
      description: 'Reviews.',
      commands: [{ name: 'git:review', description: 'Review', prompt: 'Review $ARGUMENTS' }],
      hooks: [{ event: 'Stop' as const, prompt: 'Done?' }],
      files: [{ path: 'scripts/a.sh', content: 'echo' }],
    };
    expect(definePlugin(plugin)).toBe(plugin);
  });

  it('accepts what a plugin requires outside itself', () => {
    const plugin = {
      name: 'kit',
      description: '',
      skills: [{ name: 'review', description: '', content: '' }],
      requires: ['tool:npm-latest', 'other/skill:review', 'plugin:other'],
    };
    expect(definePlugin(plugin)).toBe(plugin);
  });

  it.each([
    [{ name: 'Not A Slug' }, 'Plugin "Not A Slug": name: must be a kebab-case slug.'],
    [
      { skills: [{ name: 'Bad Name', description: '', content: '' }] },
      'skills.0.name: must be a kebab-case slug.',
    ],
    [
      {
        subagents: [
          { name: 'a', description: '', instructions: '' },
          { name: 'a', description: '', instructions: '' },
        ],
      },
      'it has two subagents named "a".',
    ],
    [
      { mcpServers: { 'a b': { type: 'http' as const, url: 'https://x.example.com' } } },
      'mcpServers.a b: must be letters, digits, _ or -.',
    ],
    [
      { files: [{ path: '../escape.sh', content: '' }] },
      'files.0.path: must be a relative path that stays in the plugin.',
    ],
    [
      { files: [{ path: '/etc/passwd', content: '' }] },
      'files.0.path: must be a relative path that stays in the plugin.',
    ],
    [{ hooks: [{ event: 'Stop' as const }] }, 'hooks.0: needs exactly one of command and prompt.'],
    [
      { hooks: [{ event: 'Stop' as const, command: 'true', prompt: 'p' }] },
      'needs exactly one of command and prompt.',
    ],
  ])('refuses %j', (part, message) => {
    expect(() => definePlugin({ name: 'kit', description: '', ...part })).toThrow(
      InvalidPluginError,
    );
    expect(() => definePlugin({ name: 'kit', description: '', ...part })).toThrow(message);
  });
});
