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
