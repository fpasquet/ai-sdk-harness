import type { Tool } from '@ai-sdk/provider-utils';

import { tool } from '@ai-sdk/provider-utils';

import type { ToolDefinition } from '../definitions/plugin.js';

import { toolInputSchema } from './input-schema.js';
import { clip, MAX_OUTPUT } from './sandbox-command-tool.js';

/** What the agent reads of a request it made. */
export type HttpToolResult = { body: unknown; ok: boolean; status: number } | { error: string };

type HttpDefinition = Extract<ToolDefinition, { type: 'http' }>;

/** Methods whose input goes in the query string rather than a body. */
const NO_BODY = new Set(['DELETE', 'GET']);

/**
 * The AI SDK tool of an `http` tool of a manifest: on your server, it makes the request, with the
 * headers given — secrets already resolved — and hands the agent the status and the body.
 */
export function httpTool(definition: HttpDefinition, headers: Record<string, string>): Tool {
  const { description, timeoutSeconds = 30 } = definition;
  return tool({
    description,
    inputSchema: toolInputSchema(definition.inputSchema),
    execute: async (input, { abortSignal }): Promise<HttpToolResult> => {
      const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
      try {
        const [url, init] = requestOf(definition, { headers, input: input ?? {} });
        const signal = abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline;
        const response = await fetch(url, { ...init, signal });
        return { ok: response.ok, status: response.status, body: await bodyOf(response) };
      } catch (error) {
        if (!deadline.aborted || abortSignal?.aborted) throw error;
        return { error: `No answer after ${timeoutSeconds} s.` };
      }
    },
  });
}

/** The URL and the request of a call: the input in the query string, or as a JSON body. */
function requestOf(
  { method = 'GET', url: template }: HttpDefinition,
  { headers, input }: { headers: Record<string, string>; input: Record<string, unknown> },
): [URL, RequestInit] {
  const { url, rest } = requestUrl(template, input);
  const withBody = !NO_BODY.has(method) && Object.keys(rest).length > 0;
  if (!withBody)
    for (const [key, value] of Object.entries(rest)) url.searchParams.set(key, text(value));
  const init: RequestInit = {
    method,
    headers: {
      accept: 'application/json',
      ...(withBody && { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(withBody && { body: JSON.stringify(rest) }),
  };
  return [url, init];
}

/**
 * The URL of `template` with each `{key}` replaced by the input's `key`, URL-encoded, and the
 * properties of the input it did not use.
 */
export function requestUrl(
  template: string,
  input: Record<string, unknown>,
): { url: URL; rest: Record<string, unknown> } {
  const used = new Set<string>();
  const filled = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => {
    used.add(key);
    return encodeURIComponent(text(input[key] ?? ''));
  });
  const rest = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !used.has(key) && value !== undefined),
  );
  return { url: new URL(filled), rest };
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

/** The body as JSON when it is, as text otherwise; a long one cut, as text. */
async function bodyOf(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length <= MAX_OUTPUT && (response.headers.get('content-type') ?? '').includes('json')) {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      // Not JSON after all: handed over as text.
    }
  }
  return clip(body);
}
