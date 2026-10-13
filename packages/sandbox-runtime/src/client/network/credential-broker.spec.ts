import { describe, expect, it } from 'vitest';

import { credentialsOf } from './credential-broker.js';

describe('credentialsOf', () => {
  it('swaps the exact value a rule matches for the value it sets, at its host', () => {
    expect(
      credentialsOf([
        {
          match: {
            host: 'api.example.com',
            path: { startsWith: '/v1' },
            headers: [
              { key: { exact: 'Other' }, value: { exact: 'x' } },
              { key: { startsWith: 'X-' }, value: { exact: 'y' } },
              { key: { exact: 'x-api-key' }, value: { exact: 'placeholder' } },
            ],
          },
          transform: { headers: { 'X-Api-Key': 'real' } },
        },
      ]),
    ).toEqual([{ placeholder: 'placeholder', value: 'real', hosts: ['api.example.com'] }]);
  });

  it('refuses a rule that does not match the exact value of the header it sets', () => {
    expect(() =>
      credentialsOf([
        {
          match: {
            host: 'api.example.com',
            headers: [{ key: { exact: 'X-Api-Key' }, value: { startsWith: 'aisdkhc_' } }],
          },
          transform: { headers: { 'X-Api-Key': 'real' } },
        },
      ]),
    ).toThrow('exact value of the X-Api-Key header');
  });

  it('leaves out a header it cannot add, when the rule protects a credential otherwise', () => {
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => void warnings.push(warning.message);
    process.on('warning', onWarning);
    const rule = {
      match: {
        host: 'chatgpt.com',
        headers: [{ key: { exact: 'Authorization' }, value: { exact: 'Bearer placeholder' } }],
      },
      transform: { headers: { Authorization: 'Bearer real', 'ChatGPT-Account-ID': 'account' } },
    };

    expect(credentialsOf([rule])).toEqual([
      { placeholder: 'Bearer placeholder', value: 'Bearer real', hosts: ['chatgpt.com'] },
    ]);
    expect(credentialsOf([rule])).toHaveLength(1);

    return new Promise<void>((resolve) =>
      setImmediate(() => {
        process.off('warning', onWarning);
        expect(warnings).toEqual([
          expect.stringContaining('The ChatGPT-Account-ID header of chatgpt.com is left out'),
        ]);
        resolve();
      }),
    );
  });

  it('accepts a rule that sets nothing', () => {
    expect(credentialsOf([{ match: { host: 'example.com' }, transform: { headers: {} } }])).toEqual(
      [],
    );
  });
});
