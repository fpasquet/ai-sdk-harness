import { describe, expect, it } from 'vitest';

import { importAiSdkMcp } from './connect-mcp-server.js';

/** The error Node throws for a package that is not installed. */
function notFound(specifier: string, code = 'ERR_MODULE_NOT_FOUND'): Error {
  return Object.assign(
    new Error(`Cannot find package '${specifier}' imported from /app/index.js`),
    {
      code,
    },
  );
}

describe('importAiSdkMcp', () => {
  it('gives what it loads', async () => {
    await expect(importAiSdkMcp(() => Promise.resolve({ ok: true }))).resolves.toEqual({
      ok: true,
    });
  });

  it.each([
    ['@ai-sdk/mcp', 'ERR_MODULE_NOT_FOUND'],
    ['@ai-sdk/mcp/mcp-stdio', 'ERR_MODULE_NOT_FOUND'],
    ['@ai-sdk/mcp', 'MODULE_NOT_FOUND'],
  ])('says to install @ai-sdk/mcp when %s is missing (%s)', async (specifier, code) => {
    const missing = notFound(specifier, code);
    const error = await importAiSdkMcp(() => Promise.reject(missing)).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('needs @ai-sdk/mcp');
    expect((error as Error).message).toContain('connectMcpServer');
    expect((error as Error).cause).toBe(missing);
  });

  it('lets any other error through: a missing dependency of @ai-sdk/mcp, a failure of its own', async () => {
    const transitive = notFound('pkce-challenge');
    await expect(importAiSdkMcp(() => Promise.reject(transitive))).rejects.toBe(transitive);
    const failure = new Error('boom');
    await expect(importAiSdkMcp(() => Promise.reject(failure))).rejects.toBe(failure);
  });
});
