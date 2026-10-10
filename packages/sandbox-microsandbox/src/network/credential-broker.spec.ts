import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FakeSandbox } from '../../test/fake-microsandbox.js';

import { fake } from '../../test/fake-microsandbox.js';
import { MicrosandboxConnection } from '../transport/microsandbox-connection.js';
import { secretBroker, secretName } from './credential-broker.js';

/** What `@ai-sdk/harness-claude-code` asks for an API key: swap the placeholder of `x-api-key`. */
const apiKey = (placeholder: string, key: string): HarnessV1RequestTransformation => ({
  match: {
    host: 'api.anthropic.com',
    headers: [{ key: { exact: 'x-api-key' }, value: { exact: placeholder } }],
  },
  transform: { headers: { 'x-api-key': key } },
});

describe('secretBroker', () => {
  let sandbox: FakeSandbox;
  let connection: MicrosandboxConnection;

  beforeEach(() => {
    sandbox = fake.addSandbox('box', { interceptTls: true });
    connection = new MicrosandboxConnection('box');
  });
  afterEach(() => fake.reset());

  it('names a secret after its host and header, as a variable name', () => {
    expect(secretName('api.anthropic.com', 'x-api-key')).toBe('AISDK_API_ANTHROPIC_COM_X_API_KEY');
  });

  it('registers the placeholder and the real value, for the host only', async () => {
    await secretBroker(connection).add([apiKey('aisdkhc_123', 'sk-ant-real')]);

    expect(sandbox.secrets.get('AISDK_API_ANTHROPIC_COM_X_API_KEY')).toEqual({
      placeholder: 'aisdkhc_123',
      value: 'sk-ant-real',
      allowedHosts: ['api.anthropic.com'],
    });
  });

  it('registers only the part of a header that differs from the placeholder', async () => {
    await secretBroker(connection).add([
      {
        match: {
          host: 'api.anthropic.com',
          headers: [{ key: { exact: 'Authorization' }, value: { exact: 'Bearer aisdkhc_abc' } }],
        },
        transform: { headers: { Authorization: 'Bearer sk-ant-oat-real' } },
      },
    ]);

    expect(sandbox.secrets.get('AISDK_API_ANTHROPIC_COM_AUTHORIZATION')).toMatchObject({
      placeholder: 'aisdkhc_abc',
      value: 'sk-ant-oat-real',
    });
  });

  it('restarts the microVM for a new placeholder, not for a new value of a known one', async () => {
    const broker = secretBroker(connection);

    await broker.add([apiKey('aisdkhc_123', 'first')]);
    await broker.add([apiKey('aisdkhc_123', 'refreshed')]);

    expect(sandbox.restarts).toBe(1);
    expect(sandbox.secrets.get('AISDK_API_ANTHROPIC_COM_X_API_KEY')?.value).toBe('refreshed');
  });

  it('adds nothing for no transformation', async () => {
    await secretBroker(connection).add([]);

    expect(sandbox.restarts).toBe(0);
  });

  it('leaves out, with a warning, a header the request carries no placeholder for', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const codex: HarnessV1RequestTransformation = {
      match: {
        host: 'chatgpt.com',
        headers: [{ key: { exact: 'authorization' }, value: { exact: 'Bearer aisdkhc_x' } }],
      },
      transform: { headers: { authorization: 'Bearer real', 'ChatGPT-Account-ID': 'account' } },
    };

    await secretBroker(connection).add([codex]);
    await secretBroker(connection).add([codex]);

    expect([...sandbox.secrets.keys()]).toEqual(['AISDK_CHATGPT_COM_AUTHORIZATION']);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('ChatGPT-Account-ID');
    warn.mockRestore();
  });

  it('refuses a transformation that protects no credential', async () => {
    const add = secretBroker(connection).add([
      { match: { host: 'example.com' }, transform: { headers: { 'x-extra': 'value' } } },
    ]);

    await expect(add).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
  });

  it('withdraws its own secrets on release', async () => {
    sandbox.secrets.set('OTHER', { value: 'v', placeholder: 'p', allowedHosts: [] });
    const broker = secretBroker(connection);
    await broker.add([apiKey('aisdkhc_123', 'real')]);

    await broker.release();
    await broker.release();

    expect([...sandbox.secrets.keys()]).toEqual(['OTHER']);
  });

  it("replaces the secrets of this package, a previous process's included, in one change", async () => {
    sandbox.secrets.set('OTHER', { value: 'v', placeholder: 'p', allowedHosts: [] });
    sandbox.secrets.set('AISDK_OLD', { value: 'v', placeholder: 'p', allowedHosts: [] });
    const broker = secretBroker(connection);
    await broker.add([apiKey('aisdkhc_123', 'first')]);

    await broker.replace([apiKey('aisdkhc_123', 'second')]);

    expect([...sandbox.secrets.keys()].sort()).toEqual([
      'AISDK_API_ANTHROPIC_COM_X_API_KEY',
      'OTHER',
    ]);
    expect(sandbox.secrets.get('AISDK_API_ANTHROPIC_COM_X_API_KEY')?.value).toBe('second');
    // The placeholder was known: the new value went in live.
    expect(sandbox.restarts).toBe(1);
  });

  it('replaces nothing with nothing without a change', async () => {
    await secretBroker(connection).replace([]);

    expect(sandbox.restarts).toBe(0);
  });

  it('withdraws, on release, what replace registered', async () => {
    const broker = secretBroker(connection);
    await broker.replace([apiKey('aisdkhc_123', 'real')]);

    await broker.release();

    expect(sandbox.secrets.size).toBe(0);
  });
});
