import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { describe, expect, it } from 'vitest';

import type { OutgoingRequest } from './egress-policy.js';

import { hostsOf, proxyRoute, routeTarget } from '../protocol/proxy-routes.js';
import {
  appliesTo,
  carriesStrayPlaceholder,
  injectedCredentials,
  isListedHost,
  isRoutable,
  transformHeaders,
  withoutCredentials,
  withTransformations,
} from './egress-policy.js';

const bearer = (placeholder: string, secret: string): HarnessV1RequestTransformation => ({
  match: {
    host: 'api.anthropic.com',
    headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${placeholder}` } }],
  },
  transform: { headers: { Authorization: `Bearer ${secret}` } },
});

const request = (authorization: string, path = '/v1/messages'): OutgoingRequest => ({
  host: 'api.anthropic.com',
  method: 'POST',
  path,
  headers: { authorization, 'content-type': 'application/json' },
});

describe('request transformations', () => {
  it('swap the placeholder the sandbox sent for the secret', () => {
    expect(transformHeaders([bearer('ph', 'sk-real')], request('Bearer ph'))).toEqual({
      authorization: 'Bearer sk-real',
      'content-type': 'application/json',
    });
  });

  it('leave a request that does not carry the placeholder as it is', () => {
    const sent = request('Bearer something-else');

    expect(transformHeaders([bearer('ph', 'sk-real')], sent)).toEqual(sent.headers);
  });

  it('only apply to their host, path and method', () => {
    const rule: HarnessV1RequestTransformation = {
      ...bearer('p', 's'),
      match: { ...bearer('p', 's').match, path: { startsWith: '/v1' }, method: ['post'] },
    };

    expect(appliesTo(rule, request('Bearer p'))).toBe(true);
    expect(appliesTo(rule, { ...request('Bearer p'), host: 'example.com' })).toBe(false);
    expect(appliesTo(rule, request('Bearer p', '/v2/messages'))).toBe(false);
    expect(appliesTo(rule, { ...request('Bearer p'), method: 'GET' })).toBe(false);
  });

  it('match a header name whatever its case, values by regex, and the query string', () => {
    const rule: HarnessV1RequestTransformation = {
      match: {
        host: 'API.anthropic.com',
        headers: [{ key: { exact: 'X-API-KEY' }, value: { regex: '^ph_' } }],
        queryString: [{ key: { exact: 'beta' }, value: { startsWith: 'tr' } }],
      },
      transform: { headers: { 'x-api-key': 'real' } },
    };
    const sent = { ...request('', '/v1?beta=true'), headers: { 'x-api-key': ['ph_123'] } };

    expect(transformHeaders([rule], sent)).toEqual({ 'x-api-key': 'real' });
    expect(appliesTo(rule, { ...sent, path: '/v1?beta=false' })).toBe(false);
    expect(appliesTo(rule, { ...sent, headers: { 'x-api-key': undefined } })).toBe(false);
  });
});

describe('allowed hosts', () => {
  const allowed = ['registry.npmjs.org', '*.pythonhosted.org'];

  it('allow the hosts listed, those under a wildcard, and any under *', () => {
    expect(isListedHost(allowed, 'registry.npmjs.org')).toBe(true);
    expect(isListedHost(allowed, 'files.pythonhosted.org')).toBe(true);
    expect(isListedHost(allowed, 'REGISTRY.npmjs.org')).toBe(true);
    expect(isListedHost(['*'], 'anything.example.com')).toBe(true);
  });

  it('refuse anything else', () => {
    expect(isListedHost(allowed, 'github.com')).toBe(false);
    expect(isListedHost(allowed, 'pythonhosted.org')).toBe(false);
    expect(isListedHost(allowed, 'evil-registry.npmjs.org.example.com')).toBe(false);
    expect(isListedHost(allowed, '169.254.169.254')).toBe(false);
  });

  it('let a base URL route out to an allowed host, an upstream, or a brokered host', () => {
    const policy = {
      allowedHosts: ['allowed.example.com'],
      upstreamHosts: ['api.openai.com'],
      transformations: [bearer('p', 's')],
      allowPrivateNetwork: false,
    };

    expect(isRoutable(policy, 'allowed.example.com')).toBe(true);
    expect(isRoutable(policy, 'api.openai.com')).toBe(true);
    expect(isRoutable(policy, 'API.anthropic.com')).toBe(true);
    expect(isRoutable(policy, 'metadata.google.internal')).toBe(false);
  });
});

describe('proxy routes', () => {
  const origin = 'http://127.0.0.1:3128';

  it('carry the scheme, host and path of a base URL', () => {
    expect(proxyRoute('https://api.openai.com/v1/', origin)).toBe(
      `${origin}/https/api.openai.com/v1`,
    );
    expect(routeTarget('/https/api.openai.com/v1/responses?x=1')?.toString()).toBe(
      'https://api.openai.com/v1/responses?x=1',
    );
    expect(routeTarget('/http/localhost:8080')?.toString()).toBe('http://localhost:8080/');
  });

  it('leave alone what is not an HTTP URL, or already a route', () => {
    expect(proxyRoute('not a url', origin)).toBeUndefined();
    expect(proxyRoute('ftp://files.example.com', origin)).toBeUndefined();
    expect(proxyRoute(`${origin}/https/api.openai.com`, origin)).toBeUndefined();
    expect(routeTarget('/v1/messages')).toBeUndefined();
  });

  it('name the hosts of the base URLs, skipping what is no URL', () => {
    expect(hostsOf({ A: 'https://api.anthropic.com', B: 'nonsense' })).toEqual([
      'api.anthropic.com',
    ]);
  });
});

describe('injected credentials', () => {
  it('are the values a transformation put in the request, with and without their scheme', () => {
    expect(injectedCredentials([bearer('ph', 'sk-real-value')], request('Bearer ph'))).toEqual([
      'Bearer sk-real-value',
      'sk-real-value',
    ]);
    expect(injectedCredentials([bearer('ph', 'sk-real-value')], request('Bearer other'))).toEqual(
      [],
    );
  });

  it('never come back in the headers of a response', () => {
    const answered = withoutCredentials(
      {
        'content-type': 'application/json',
        'x-echo-authorization': 'Bearer sk-real-value',
        'x-debug': ['ok', 'token=sk-real-value'],
      },
      ['Bearer sk-real-value', 'sk-real-value'],
    );

    expect(answered).toEqual({ 'content-type': 'application/json' });
  });

  it('leave short values alone, which a response could hold by chance', () => {
    expect(injectedCredentials([bearer('ph', 'abc')], request('Bearer ph'))).toEqual([
      'Bearer abc',
    ]);
  });
});

describe('the rules of a Git read', () => {
  const placeholder = `Basic ${Buffer.from('x-access-token:ai-sdk-harness-placeholder').toString('base64')}`;
  const headers = [{ key: { exact: 'Authorization' }, value: { exact: placeholder } }];
  const transform = { headers: { Authorization: 'Basic real-token-value' } };
  const rules: HarnessV1RequestTransformation[] = [
    {
      match: {
        host: 'github.com',
        path: { exact: '/acme/api.git/info/refs' },
        method: ['GET'],
        queryString: [{ key: { exact: 'service' }, value: { exact: 'git-upload-pack' } }],
        headers,
      },
      transform,
    },
    {
      match: {
        host: 'github.com',
        path: { exact: '/acme/api.git/git-upload-pack' },
        method: ['POST'],
        headers,
      },
      transform,
    },
  ];
  const sent = (method: string, path: string, host = 'github.com'): OutgoingRequest => ({
    host,
    method,
    path,
    headers: { authorization: placeholder },
  });

  it('take a parameter they name with no other value beside it', () => {
    const [advertisement] = rules;

    expect(
      appliesTo(advertisement!, sent('GET', '/acme/api.git/info/refs?service=git-upload-pack')),
    ).toBe(true);
    for (const query of [
      'service=git-upload-pack&service=git-receive-pack',
      'service=git-receive-pack&service=git-upload-pack',
      'service=git-receive-pack',
      'other=git-upload-pack',
      '',
    ]) {
      expect(appliesTo(advertisement!, sent('GET', `/acme/api.git/info/refs?${query}`))).toBe(
        false,
      );
    }
  });

  it('let a request carrying the placeholder through only where one of them applies', () => {
    const stray = (request: OutgoingRequest) => carriesStrayPlaceholder(rules, request);

    expect(stray(sent('GET', '/acme/api.git/info/refs?service=git-upload-pack'))).toBe(false);
    expect(stray(sent('POST', '/acme/api.git/git-upload-pack'))).toBe(false);
    for (const request of [
      sent('POST', '/acme/api.git/git-receive-pack'),
      sent('GET', '/acme/api.git/info/refs?service=git-receive-pack'),
      sent('GET', '/acme/api.git/info/refs?service=git-upload-pack&service=git-receive-pack'),
      sent('GET', '/acme/api.git/git-upload-pack'),
      sent('POST', '/acme/api-other.git/git-upload-pack'),
      sent('POST', '/acme/api.git-other/git-upload-pack'),
      sent('POST', '//acme/api.git/git-upload-pack'),
      sent('POST', '/acme%2Fapi.git/git-upload-pack'),
      sent('POST', '/ACME/api.git/git-upload-pack'),
      sent('POST', '/acme/api.git/git-upload-pack', 'gitlab.com'),
      // In another header, the placeholder is refused all the same.
      { ...sent('POST', '/acme/api.git/git-receive-pack'), headers: { 'x-token': placeholder } },
    ]) {
      expect(stray(request)).toBe(true);
    }
    // A request without the placeholder is none of their business.
    expect(stray({ ...sent('POST', '/acme/api.git/git-receive-pack'), headers: {} })).toBe(false);
  });

  it('take as a placeholder only a long value of a header they replace', () => {
    const rule = (headers: HarnessV1RequestTransformation['match']['headers']) => ({
      match: { host: 'api.example.com', path: { exact: '/v1' }, headers },
      transform: { headers: { authorization: 'Bearer real' } },
    });
    const elsewhere: OutgoingRequest = {
      host: 'api.example.com',
      method: 'GET',
      path: '/v2',
      headers: { 'content-type': 'application/json-of-the-api', authorization: 'Bearer short' },
    };

    expect(
      carriesStrayPlaceholder(
        [
          rule([
            { key: { exact: 'content-type' }, value: { exact: 'application/json-of-the-api' } },
          ]),
          rule([{ key: { exact: 'authorization' }, value: { exact: 'Bearer short' } }]),
        ],
        elsewhere,
      ),
    ).toBe(false);
  });

  it('replace the rules registered before for the same match, rather than pile up', () => {
    const renewed = rules.map((rule) => ({
      ...rule,
      transform: { headers: { Authorization: 'Basic renewed-token' } },
    }));
    const other = bearer('other-placeholder', 'sk-other');

    const merged = withTransformations([other, ...rules], renewed);

    expect(merged).toEqual([other, ...renewed]);
    // Whatever the order of the keys of a match.
    const reordered = {
      match: {
        headers,
        method: ['POST'],
        path: { exact: '/acme/api.git/git-upload-pack' },
        host: 'github.com',
      },
      transform: { headers: { Authorization: 'Basic third-token' } },
    };
    expect(withTransformations(merged, [reordered])).toEqual([other, renewed[0], reordered]);
  });
});
